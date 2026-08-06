import { queryExecutionClient } from "@dynatrace-sdk/client-query";
import type { ModuleId } from "../types/types";

/**
 * Tag-backed custom columns. Tags can live on any entity type, so this module
 * discovers tag keys across every entity type the app surfaces and resolves
 * per-entity tag values for whichever type a module is keyed on. Record-array
 * projection over `tags` is not valid DQL, so tags are expanded and split on
 * the first ":" client-side (same approach as host-filter.ts).
 */

/** Grail entity type that a module's findings are keyed on. */
export function moduleEntityType(module: ModuleId): string {
  switch (module) {
    case "disk":
    case "compute":
      return "dt.entity.host";
    case "kubernetes":
      return "dt.entity.cloud_application";
    case "scaling":
      return "dt.entity.auto_scaling_group";
  }
}

/** Entity types scanned for tag keys when building the column pickers. */
const DISCOVERY_ENTITY_TYPES = [
  "dt.entity.host",
  "dt.entity.cloud_application",
  "dt.entity.auto_scaling_group",
];

async function runQuery(query: string, label: string): Promise<any[]> {
  try {
    const initial: any = await queryExecutionClient.queryExecute({
      body: {
        query,
        requestTimeoutMilliseconds: 20_000,
        // API caps records at 1000 by default; raise it so tag-value lookups
        // don't miss values on large tenants.
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
    console.warn(`[tag-columns] ${label} failed`, err);
    return [];
  }
}

function escapeDql(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Split a `key:value` tag string on the FIRST colon. */
function splitTag(tag: string): { key: string; value: string } {
  const idx = tag.indexOf(":");
  if (idx < 0) return { key: tag, value: "" };
  return { key: tag.slice(0, idx), value: tag.slice(idx + 1) };
}

const _keysByType = new Map<string, Promise<string[]>>();

async function fetchTagKeysForType(entityType: string): Promise<string[]> {
  const existing = _keysByType.get(entityType);
  if (existing) return existing;
  const promise = (async () => {
    const records = await runQuery(
      `
      fetch ${entityType}
      | expand tags
      | filter isNotNull(tags)
      | fieldsAdd colon_idx = indexOf(tags, ":")
      | fieldsAdd tag_key = if(colon_idx >= 0, substring(tags, from: 0, to: colon_idx), else: tags)
      | filter isNotNull(tag_key) and tag_key != ""
      | summarize count(), by: { tag_key }
      | sort tag_key asc
      | limit 2000
    `,
      `tag-keys:${entityType}`
    );
    const keys = new Set<string>();
    for (const rec of records) {
      const k = rec.tag_key;
      if (typeof k === "string" && k.length > 0) keys.add(k);
    }
    return Array.from(keys);
  })();
  _keysByType.set(entityType, promise);
  return promise;
}

let _allKeysCache: Promise<string[]> | null = null;

/** De-duplicated tag keys across hosts, cloud applications, and ASGs. */
export async function fetchAllTagKeys(): Promise<string[]> {
  if (_allKeysCache) return _allKeysCache;
  _allKeysCache = (async () => {
    const lists = await Promise.all(
      DISCOVERY_ENTITY_TYPES.map((t) => fetchTagKeysForType(t))
    );
    const keys = new Set<string>();
    for (const list of lists) for (const k of list) keys.add(k);
    return Array.from(keys).sort((a, b) => a.localeCompare(b));
  })();
  return _allKeysCache;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetch the tags array for a set of entity ids within a window. Returns
 * `entityId -> tags[]` for every entity seen in that window (untagged ones map
 * to an empty array), so callers can tell "offline / outside window" (absent)
 * apart from "in window but untagged" (present, empty). `tags` is selected in
 * its native array form (not expanded), one row per entity.
 */
async function fetchEntityTags(
  entityType: string,
  ids: string[],
  fromExpr: string
): Promise<Map<string, string[]>> {
  const seen = new Map<string, string[]>();
  await Promise.all(
    chunk(ids, 500).map(async (idChunk) => {
      const idList = idChunk.map((id) => `"${escapeDql(id)}"`).join(", ");
      const records = await runQuery(
        `
        fetch ${entityType}, from: ${fromExpr}
        | filter in(id, ${idList})
        | fields id, tags
        | limit 100000
      `,
        `tag-values:${entityType}:${fromExpr}`
      );
      for (const rec of records) {
        const id = rec.id;
        if (typeof id !== "string") continue;
        const tags = Array.isArray(rec.tags)
          ? (rec.tags.filter((t: unknown) => typeof t === "string") as string[])
          : [];
        seen.set(id, tags);
      }
    })
  );
  return seen;
}

function extractTagValues(
  tags: string[],
  keySet: Set<string>
): Record<string, string> {
  const bag: Record<string, string> = {};
  for (const tag of tags) {
    const { key, value } = splitTag(tag);
    if (!keySet.has(key) || bag[key] !== undefined) continue;
    const v = value.trim();
    const low = v.toLowerCase();
    // Skip empty and placeholder values. An unresolved Dynatrace tag-rule
    // template shows up as the literal string "null"/"undefined", which should
    // read as blank, not print verbatim. Skipping (rather than storing "") lets
    // a real value for the same key still win.
    if (v === "" || low === "null" || low === "undefined") continue;
    bag[key] = value;
  }
  return bag;
}

/**
 * For a set of entity ids of one type, resolve the value of each
 * requested tag key. Returns `entityId -> { tagKey -> value }`.
 *
 * A default DQL fetch only sees the last 2h, so an entity that has gone quiet
 * (but is still in the findings via a longer timeframe) would drop out and
 * render blank. Pass 1 covers 30d; pass 2 retries only the ids not seen at all
 * (offline > 30d) over a 400d window, one extra query rather than one per host.
 * In-window entities that lack the tag stay blank.
 */
export async function resolveEntityTagValues(
  entityType: string,
  ids: string[],
  keys: string[]
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  if (uniqueIds.length === 0 || uniqueKeys.length === 0) return out;
  const keySet = new Set(uniqueKeys);

  const pass1 = await fetchEntityTags(entityType, uniqueIds, "now() - 30d");
  for (const [id, tags] of pass1) {
    const bag = extractTagValues(tags, keySet);
    if (Object.keys(bag).length > 0) out.set(id, bag);
  }

  const unseen = uniqueIds.filter((id) => !pass1.has(id));
  if (unseen.length > 0) {
    const pass2 = await fetchEntityTags(entityType, unseen, "now() - 400d");
    for (const [id, tags] of pass2) {
      const bag = extractTagValues(tags, keySet);
      if (Object.keys(bag).length > 0) out.set(id, bag);
    }
  }
  return out;
}

const _detectedNameCache = new Map<string, string>();

/**
 * Query detected names for a chunked id set within a window. Only returns ids
 * for which a real name (detected, else display) was found; ids absent from the
 * result weren't seen in this window and can be retried over a wider one.
 */
async function queryDetectedNames(
  ids: string[],
  fromExpr: string
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await Promise.all(
    chunk(ids, 500).map(async (idChunk) => {
      const idList = idChunk.map((id) => `"${escapeDql(id)}"`).join(", ");
      const records = await runQuery(
        `
        fetch dt.entity.host, from: ${fromExpr}
        | filter in(id, ${idList})
        | fields id, entity.detected_name, entity.name
        | limit 50000
      `,
        `detected-names:${fromExpr}`
      );
      for (const rec of records) {
        const id = rec.id;
        if (typeof id !== "string") continue;
        const detected = rec["entity.detected_name"];
        const display = rec["entity.name"];
        const name =
          (typeof detected === "string" && detected.length > 0 && detected) ||
          (typeof display === "string" && display.length > 0 && display) ||
          "";
        if (name) found.set(id, name);
      }
    })
  );
  return found;
}

/**
 * Resolve OneAgent-detected host names for the given host ids.
 *
 * A default DQL fetch only sees the last 2h, so a host that is currently
 * offline (but still in the findings via a longer timeframe) would not resolve
 * and would fall back to its display name. Pass 1 covers 30d; pass 2 retries
 * only the still-missing ids (offline > 30d) over a 400d window. Ids that never
 * resolve are omitted, and the caller keeps the display name it had.
 */
export async function resolveHostDetectedNames(
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const need: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (_detectedNameCache.has(id)) out.set(id, _detectedNameCache.get(id)!);
    else need.push(id);
  }
  const uniqueNeed = Array.from(new Set(need));
  if (uniqueNeed.length === 0) return out;

  const pass1 = await queryDetectedNames(uniqueNeed, "now() - 30d");
  for (const [id, name] of pass1) {
    _detectedNameCache.set(id, name);
    out.set(id, name);
  }

  const stillMissing = uniqueNeed.filter((id) => !pass1.has(id));
  if (stillMissing.length > 0) {
    const pass2 = await queryDetectedNames(stillMissing, "now() - 400d");
    for (const [id, name] of pass2) {
      _detectedNameCache.set(id, name);
      out.set(id, name);
    }
  }
  return out;
}

export function clearTagColumnCaches(): void {
  _keysByType.clear();
  _allKeysCache = null;
  _detectedNameCache.clear();
}
