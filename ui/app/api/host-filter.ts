import { queryExecutionClient } from "@dynatrace-sdk/client-query";
import type { HostFilter, TagFilter } from "../types/types";

// Tag / OS / cloud-provider discovery and filter-to-host-id resolution.
//
// After `expand tags`, each `tags` value is a STRING in "key:value" form (or
// bare "key" for value-less tags), not a record. Lambdas and `tags[].key`
// projection aren't valid DQL, so the array is expanded and the string is split
// on ":" client-side.

async function runQuery(query: string, label: string): Promise<any[]> {
  try {
    const initial: any = await queryExecutionClient.queryExecute({
      body: {
        query,
        requestTimeoutMilliseconds: 20_000,
        // API caps records at 1000 by default; a tag can match far more than
        // 1000 hosts, so raise the cap or filtering silently loses matches.
        maxResultRecords: 100_000,
        maxResultBytes: 100_000_000,
      },
    });
    let state = initial?.state ?? "UNKNOWN";
    let records: any[] = initial?.result?.records ?? [];
    let token = initial?.requestToken;
    let polls = 0;
    while (state === "RUNNING" && token && polls < 30) {
      await new Promise((r) => window.setTimeout(r, 1_000));
      const next: any = await queryExecutionClient.queryPoll({
        requestToken: token,
        requestTimeoutMilliseconds: 5_000,
      });
      state = next?.state ?? state;
      records = next?.result?.records ?? records;
      token = next?.requestToken ?? token;
      polls++;
    }
    return records;
  } catch (err) {
    console.warn(`[host-filter] ${label} failed`, err);
    return [];
  }
}

function escapeDql(s: string): string {
  return s.replace(/"/g, '\\"');
}

let _tagKeysCache: Promise<string[]> | null = null;

/** Returns the de-duplicated list of tag KEYS present on hosts. */
export async function fetchHostTagKeys(): Promise<string[]> {
  if (_tagKeysCache) return _tagKeysCache;
  _tagKeysCache = (async () => {
    // Extract the key portion before summarize so the limit applies to distinct
    // KEYS, not distinct "key:value" strings. Otherwise a tenant with thousands
    // of "host:server-001" tags fills the limit with one key family and misses
    // the rest.
    const records = await runQuery(
      `
      fetch dt.entity.host
      | expand tags
      | filter isNotNull(tags)
      | fieldsAdd colon_idx = indexOf(tags, ":")
      | fieldsAdd tag_key = if(colon_idx >= 0, substring(tags, from: 0, to: colon_idx), else: tags)
      | filter isNotNull(tag_key) and tag_key != ""
      | summarize count(), by: { tag_key }
      | sort tag_key asc
      | limit 2000
    `,
      "tag-keys"
    );
    console.log(`[host-filter] tag-keys raw rows: ${records.length}`);
    if (records[0]) console.log("[host-filter] sample row:", records[0]);
    const keys = new Set<string>();
    for (const rec of records) {
      const k = rec.tag_key ?? rec["tag_key"];
      if (typeof k === "string" && k.length > 0) keys.add(k);
    }
    console.log(`[host-filter] discovered ${keys.size} distinct tag keys`);
    return Array.from(keys).sort();
  })();
  return _tagKeysCache;
}

const _tagValuesCache = new Map<string, Promise<string[]>>();

/** Returns the distinct values for a single tag key. */
export async function fetchHostTagValues(key: string): Promise<string[]> {
  if (!key) return [];
  const existing = _tagValuesCache.get(key);
  if (existing) return existing;
  const escKey = escapeDql(key);
  const promise = (async () => {
    // Value-less tags (bare key, no colon) don't match the prefix, so a key
    // that is never given a value resolves to an empty value list.
    const records = await runQuery(
      `
      fetch dt.entity.host
      | expand tags
      | filter startsWith(tags, "${escKey}:")
      | summarize count(), by: { tags }
      | limit 5000
    `,
      `tag-values:${key}`
    );
    const values = new Set<string>();
    const prefix = key + ":";
    for (const rec of records) {
      const t = rec.tags;
      if (typeof t !== "string" || !t.startsWith(prefix)) continue;
      const value = t.slice(prefix.length);
      if (value.length > 0) values.add(value);
    }
    return Array.from(values).sort();
  })();
  _tagValuesCache.set(key, promise);
  return promise;
}

// Dynatrace host `osType` values, common ones first. HP-UX and Darwin (macOS)
// are omitted as effectively dead for server fleets; a host carrying one still
// shows in reports, it is not offered as an OS-filter option. "Other / Unknown"
// matches hosts with no reported osType.
export const OS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "LINUX", label: "Linux" },
  { value: "WINDOWS", label: "Windows" },
  { value: "AIX", label: "AIX" },
  { value: "SOLARIS", label: "Solaris" },
  { value: "ZOS", label: "z/OS" },
  { value: "__UNKNOWN__", label: "Other / Unknown" },
];

// Deployment = the underlying cloud provider (host `cloudType`). Kubernetes is
// NOT here: it is orthogonal to the provider (a host runs K8s or not, on any
// provider) and lives in its own filter section, resolved via
// `softwareTechnologies` (see kubernetesHostIds).
export const CLOUD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "AZURE", label: "Microsoft Azure" },
  { value: "EC2", label: "AWS (EC2)" },
  { value: "GOOGLE_CLOUD_PLATFORM", label: "Google Cloud" },
  { value: "OPENSTACK", label: "OpenStack" },
  { value: "OCI", label: "Oracle Cloud" },
  { value: "IBM_CLOUD", label: "IBM Cloud" },
  { value: "ON_PREM", label: "On-prem / Other" },
];

const _filterIdCache = new Map<string, Promise<string[] | null>>();

export function isEmptyHostFilter(f: HostFilter): boolean {
  return (
    (!f.tags || f.tags.length === 0) &&
    (!f.osTypes || f.osTypes.length === 0) &&
    (!f.cloudTypes || f.cloudTypes.length === 0) &&
    (!f.kubernetes || f.kubernetes === "include")
  );
}

// All host ids in the tenant, needed only to seed "exclude Kubernetes" when no
// other control positively constrains the set (all hosts minus the K8s ones).
// Cached for the session.
let _allHostIdsPromise: Promise<Set<string>> | null = null;
function allHostIds(): Promise<Set<string>> {
  if (_allHostIdsPromise) return _allHostIdsPromise;
  _allHostIdsPromise = (async () => {
    const records = await runQuery(
      `fetch dt.entity.host | fields id | limit 50000`,
      "all-hosts"
    );
    const set = new Set<string>();
    for (const rec of records) {
      const id = rec.id;
      if (typeof id === "string" && id.length > 0) set.add(id);
    }
    return set;
  })();
  return _allHostIdsPromise;
}

/**
 * Hosts satisfying ALL constraining tags at once: AND across distinct tag keys,
 * OR within a single key's values. One DQL query rather than per-tag sets
 * intersected client-side, so adding a tag can only narrow the result. Returns
 * null when nothing constrains (every tag is "all values").
 */
async function hostIdsMatchingAllTags(
  tags: TagFilter[]
): Promise<Set<string> | null> {
  const constraining = (tags ?? [])
    .map((t) => ({
      key: escapeDql(t.key ?? ""),
      values: (t.values ?? []).filter((v) => v && v !== "*"),
    }))
    .filter((t) => t.key.length > 0 && t.values.length > 0);
  if (constraining.length === 0) return null;

  // One 0/1 flag per tag: 1 on the expanded row whose value matches any of
  // that tag's wanted values. max() collapses a host's expanded rows, then
  // requiring every flag == 1 enforces the AND across keys.
  const flagFields = constraining
    .map((t, i) => {
      const ors = t.values
        .map((v) => `tags == "${t.key}:${escapeDql(v)}"`)
        .join(" or ");
      return `| fieldsAdd m${i} = if(${ors}, 1, else: 0)`;
    })
    .join("\n    ");
  const maxes = constraining.map((_, i) => `m${i} = max(m${i})`).join(", ");
  const allMatched = constraining.map((_, i) => `m${i} == 1`).join(" and ");

  const records = await runQuery(
    `
    fetch dt.entity.host
    | expand tags
    ${flagFields}
    | summarize ${maxes}, by: { id }
    | filter ${allMatched}
    | fields id
    | limit 50000
  `,
    "tag-match-all"
  );
  const set = new Set<string>();
  for (const rec of records) {
    const id = rec.id;
    if (typeof id === "string" && id.length > 0) set.add(id);
  }
  return set;
}

/**
 * Build one category clause (OS or cloud) honoring include/exclude mode.
 * `nullSentinel` maps the "unknown"/"on-prem" bucket to an isNull check.
 * Returns null when nothing is selected (no gate for that category).
 */
function categoryClause(
  field: "osType" | "cloudType",
  types: string[] | undefined,
  nullSentinel: string,
  mode: "include" | "exclude"
): string | null {
  if (!types || types.length === 0) return null;
  const concrete = types.filter((x) => x !== nullSentinel);
  const includesNull = types.includes(nullSentinel);
  const sub: string[] = [];
  if (concrete.length > 0) {
    sub.push(`in(${field}, ${concrete.map((x) => `"${x}"`).join(", ")})`);
  }
  if (includesNull) sub.push(`isNull(${field})`);
  if (sub.length === 0) return null;
  const inClause = sub.length === 1 ? sub[0] : `(${sub.join(" or ")})`;
  return mode === "exclude" ? `not ${inClause}` : inClause;
}

// Kubernetes isn't a host `cloudType` in Grail (that's the underlying provider,
// e.g. EC2/Azure). It lives in `softwareTechnologies`, an array of
// "type:...,edition:...,version:..." strings. `contains()` ignores arrays, so
// the array is expanded to one row per tech, substring-matched, then deduped
// back to host ids. Cached for the session.
let _k8sIdsPromise: Promise<Set<string>> | null = null;

function kubernetesHostIds(): Promise<Set<string>> {
  if (_k8sIdsPromise) return _k8sIdsPromise;
  _k8sIdsPromise = (async () => {
    const records = await runQuery(
      `
      fetch dt.entity.host
      | fieldsAdd softwareTechnologies
      | filter isNotNull(softwareTechnologies)
      | expand softwareTechnologies
      | filter contains(softwareTechnologies, "KUBERNETES")
      | dedup id
      | fields id
      | limit 50000
    `,
      "k8s-hosts"
    );
    const set = new Set<string>();
    for (const rec of records) {
      const id = rec.id;
      if (typeof id === "string" && id.length > 0) set.add(id);
    }
    return set;
  })();
  return _k8sIdsPromise;
}

/**
 * Cloud/Deployment clause. Real cloud providers filter on `cloudType`;
 * `ON_PREM` maps to `isNull`. Include/exclude wraps the whole OR. Returns null
 * for no gate. (Kubernetes is handled separately, not here.)
 */
function cloudDeploymentClause(
  cloudTypes: string[] | undefined,
  mode: "include" | "exclude"
): string | null {
  if (!cloudTypes || cloudTypes.length === 0) return null;
  const concrete = cloudTypes.filter((x) => x !== "ON_PREM");
  const sub: string[] = [];
  if (concrete.length > 0) {
    sub.push(`in(cloudType, ${concrete.map((x) => `"${x}"`).join(", ")})`);
  }
  if (cloudTypes.includes("ON_PREM")) sub.push(`isNull(cloudType)`);
  if (sub.length === 0) return null;
  const inClause = sub.length === 1 ? sub[0] : `(${sub.join(" or ")})`;
  return mode === "exclude" ? `not ${inClause}` : inClause;
}

/** Hosts matching the OS and/or cloud constraints (combined). */
async function hostIdsMatchingOsCloud(
  osTypes: string[] | undefined,
  osMode: "include" | "exclude",
  cloudTypes: string[] | undefined,
  cloudMode: "include" | "exclude"
): Promise<Set<string> | null> {
  const clauses: string[] = [];
  const oc = categoryClause("osType", osTypes, "__UNKNOWN__", osMode);
  if (oc) clauses.push(oc);
  const cc = cloudDeploymentClause(cloudTypes, cloudMode);
  if (cc) clauses.push(cc);

  if (clauses.length === 0) return null;
  const records = await runQuery(
    `
    fetch dt.entity.host
    | filter ${clauses.join(" and ")}
    | fields id
    | limit 50000
  `,
    "osCloud-match"
  );
  const set = new Set<string>();
  for (const rec of records) {
    const id = rec.id;
    if (typeof id === "string" && id.length > 0) set.add(id);
  }
  return set;
}

/**
 * Resolve a HostFilter to the set of `dt.entity.host` IDs it matches. Empty
 * filter returns null; an empty match returns []. Tags resolve in one query,
 * OS/cloud in another; the two sets are intersected. Cached per session.
 */
export async function resolveHostFilterIds(
  filter: HostFilter
): Promise<string[] | null> {
  if (isEmptyHostFilter(filter)) return null;
  const sig = signatureFor(filter);
  const cached = _filterIdCache.get(sig);
  if (cached) return cached;

  const promise = (async () => {
    const kmode = filter.kubernetes ?? "include";
    const [tagSet, osCloudSet, k8sSet] = await Promise.all([
      hostIdsMatchingAllTags(filter.tags ?? []),
      hostIdsMatchingOsCloud(
        filter.osTypes,
        filter.osMode ?? "include",
        filter.cloudTypes,
        filter.cloudMode ?? "include"
      ),
      kmode === "include"
        ? Promise.resolve(null as Set<string> | null)
        : kubernetesHostIds(),
    ]);

    const sets: Set<string>[] = [];
    if (tagSet) sets.push(tagSet);
    if (osCloudSet) sets.push(osCloudSet);
    if (kmode === "only" && k8sSet) sets.push(k8sSet);

    let base: Set<string> | null = null;
    if (sets.length > 0) {
      sets.sort((a, b) => a.size - b.size);
      base = sets[0];
      for (let i = 1; i < sets.length; i++) {
        const next = sets[i];
        const intersected = new Set<string>();
        for (const x of base) if (next.has(x)) intersected.add(x);
        base = intersected;
        if (base.size === 0) break;
      }
    } else if (kmode === "exclude") {
      base = await allHostIds();
    } else {
      // Nothing constrains; null is the caller's signal for "all hosts".
      return null;
    }

    if (kmode === "exclude" && k8sSet) {
      const filtered = new Set<string>();
      for (const x of base) if (!k8sSet.has(x)) filtered.add(x);
      base = filtered;
    }

    const ids = Array.from(base);
    console.log(`[host-filter] resolved ${ids.length} hosts for ${sig}`);
    return ids;
  })();

  _filterIdCache.set(sig, promise);
  return promise;
}

function signatureFor(filter: HostFilter): string {
  const norm = {
    tags: [...(filter.tags ?? [])]
      .map((t) => ({ key: t.key, values: [...(t.values ?? [])].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    osTypes: [...(filter.osTypes ?? [])].sort(),
    cloudTypes: [...(filter.cloudTypes ?? [])].sort(),
    osMode: filter.osMode ?? "include",
    cloudMode: filter.cloudMode ?? "include",
    kubernetes: filter.kubernetes ?? "include",
  };
  return JSON.stringify(norm);
}

export function clearHostFilterCaches(): void {
  _tagKeysCache = null;
  _tagValuesCache.clear();
  _filterIdCache.clear();
  _k8sIdsPromise = null;
  _allHostIdsPromise = null;
}
