import { queryExecutionClient } from "@dynatrace-sdk/client-query";
import { monitoredEntitiesClient } from "@dynatrace-sdk/client-classic-environment-v2";
import { fetchFindingState } from "./settings";
import { scopeToDqlFilter, scopeToEntitySelector } from "./scope";
import {
  buildFindingId,
  dedupeById,
  linearFit,
  formatBytes,
  formatPercent,
} from "../utils/helpers";
import type {
  DataResolution,
  DiskIopsFilter,
  FilterBundle,
  FilterCombine,
  Finding,
  HostFilter,
  HostNameSource,
  ModuleId,
  ScopeRef,
  Severity,
  SizeUnit,
  Thresholds,
  TimeframeRange,
  TimeUnit,
} from "../types/types";
import { EMPTY_HOST_FILTER } from "../types/types";
import { CLOUD_OPTIONS, OS_OPTIONS } from "./host-filter";
import { toDqlTimeRef, toEntityApiTimeRef, resolveTimeExprToDate } from "../utils/helpers";
import {
  moduleEntityType,
  resolveEntityTagValues,
  resolveHostDetectedNames,
} from "./tag-columns";

// DQL

/**
 * Terminal query states that mean the query produced no usable result. Hitting
 * one throws, so a failed query can't render as a clean zero; call sites decide
 * what to do (disk trend / IOPS catch and degrade, the primary queries bubble
 * to the module-level handler).
 */
const DQL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "TIMED_OUT", "ERROR"]);

async function runDqlQuery(
  query: string,
  label: string
): Promise<{ records: any[]; state: string }> {
  const initial: any = await queryExecutionClient.queryExecute({
    body: {
      query,
      requestTimeoutMilliseconds: 30_000,
      // The query API caps returned records at 1000 by default, and a DQL
      // `| limit N` sets only the logical limit, not how many records the API
      // hands back. Both caps have to be raised for large tenants.
      maxResultRecords: 100_000,
      maxResultBytes: 100_000_000,
    },
  });
  let state = initial?.state ?? "UNKNOWN";
  let records: any[] = initial?.result?.records ?? [];
  let token = initial?.requestToken;
  let polls = 0;
  while (state === "RUNNING" && token && polls < 60) {
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
  console.log(`[${label}] final state=${state}, records=${records.length}, polls=${polls}`);
  // Only known failure states throw: an unrecognized or absent state still
  // returns whatever records came back, so an SDK that omits `state` on an
  // immediate success keeps working.
  if (DQL_FAILURE_STATES.has(String(state).toUpperCase())) {
    throw new Error(`DQL query "${label}" ended in state ${state}`);
  }
  if (state === "RUNNING") {
    throw new Error(`DQL query "${label}" still running after ${polls} polls`);
  }
  return { records, state };
}

const _entityNameCache = new Map<string, string>();
function entityTypeFromId(id: string): string {
  const dash = id.indexOf("-");
  return dash > 0 ? id.slice(0, dash) : "";
}
async function resolveEntityNames(
  ids: string[],
  // Short on purpose: a caller that forgets to thread the selected timeframe
  // gets a narrow window rather than a stray 7-day one.
  fromExpr: string = "now-2h"
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missingByType = new Map<string, string[]>();
  for (const id of ids) {
    if (!id) continue;
    if (_entityNameCache.has(id)) {
      out.set(id, _entityNameCache.get(id)!);
      continue;
    }
    const type = entityTypeFromId(id);
    if (!type) continue;
    if (!missingByType.has(type)) missingByType.set(type, []);
    missingByType.get(type)!.push(id);
  }
  if (missingByType.size === 0) return out;
  const jobs: Array<{ type: string; chunk: string[] }> = [];
  for (const [type, missing] of missingByType) {
    for (let i = 0; i < missing.length; i += 50) {
      jobs.push({ type, chunk: missing.slice(i, i + 50) });
    }
  }
  await Promise.all(
    jobs.map(async ({ type, chunk }) => {
      try {
        const response = await monitoredEntitiesClient.getEntities({
          entitySelector: `type("${type}"),entityId(${chunk.join(",")})`,
          from: toEntityApiTimeRef(fromExpr),
          pageSize: 500,
        });
        for (const e of response.entities ?? []) {
          const id = (e as any).entityId ?? (e as any).id ?? "";
          const name = (e as any).displayName ?? id;
          if (id) {
            _entityNameCache.set(id, name);
            out.set(id, name);
          }
        }
      } catch (err) {
        console.warn(`resolveEntityNames(${type}) chunk failed`, err);
      }
    })
  );
  // Unresolved ids fall back to the raw id for THIS call and are deliberately
  // not cached: a flaky or rate-limited classic-API chunk would otherwise pin
  // that host to its raw id for the rest of the session. Uncached means the
  // next fetch retries them.
  for (const list of missingByType.values()) {
    for (const id of list) {
      if (!out.has(id)) out.set(id, id);
    }
  }
  return out;
}

// Host OS / cloud-provider attributes, resolved once per session for the
// details popup's "OS" and "Deployment" lines. Keyed by host id.
const _hostAttrCache = new Map<
  string,
  { osType: string | null; cloudType: string | null }
>();
async function resolveHostAttributes(
  ids: string[]
): Promise<Map<string, { osType: string | null; cloudType: string | null }>> {
  const out = new Map<string, { osType: string | null; cloudType: string | null }>();
  const missing: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (_hostAttrCache.has(id)) out.set(id, _hostAttrCache.get(id)!);
    else missing.push(id);
  }
  if (missing.length === 0) return out;
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    try {
      const { records } = await runDqlQuery(
        `fetch dt.entity.host
         | filter in(id, ${chunk.map((x) => `"${x}"`).join(", ")})
         | fields id, osType, cloudType
         | limit 50000`,
        "host-attrs"
      );
      for (const rec of records) {
        const id = typeof rec.id === "string" ? rec.id : "";
        if (!id) continue;
        const val = {
          osType: typeof rec.osType === "string" ? rec.osType : null,
          cloudType: typeof rec.cloudType === "string" ? rec.cloudType : null,
        };
        _hostAttrCache.set(id, val);
        out.set(id, val);
      }
    } catch (err) {
      console.warn("resolveHostAttributes chunk failed", err);
    }
  }
  // Hosts with no returned row: cache an empty attr so we don't re-query them.
  for (const id of missing) {
    if (!out.has(id)) {
      const val = { osType: null, cloudType: null };
      _hostAttrCache.set(id, val);
      out.set(id, val);
    }
  }
  return out;
}

const _OS_LABEL = new Map<string, string>(
  OS_OPTIONS.map((o) => [o.value, o.label] as const)
);
const _CLOUD_LABEL = new Map<string, string>(
  CLOUD_OPTIONS.map((o) => [o.value, o.label] as const)
);
/** OS code → display label; null/unknown → "Other / Unknown". */
function osLabel(v: string | null | undefined): string {
  if (!v) return _OS_LABEL.get("__UNKNOWN__") ?? "Other / Unknown";
  return _OS_LABEL.get(v) ?? v;
}
/** cloudType code → display label; null → "On-prem / Other" (the ON_PREM bucket). */
function deploymentLabel(v: string | null | undefined): string {
  if (!v) return _CLOUD_LABEL.get("ON_PREM") ?? "On-prem / Other";
  return _CLOUD_LABEL.get(v) ?? v;
}

/**
 * Per-entity last-seen (epoch ms) via the classic entities API, backing the
 * offline check. Batched by type in chunks of 50; unresolved ids are omitted,
 * and the caller treats a missing entry as online.
 */
async function resolveEntityLastSeen(
  ids: string[],
  fromExpr: string = "now-2h"
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byType = new Map<string, string[]>();
  for (const id of ids) {
    if (!id) continue;
    const type = entityTypeFromId(id);
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(id);
  }
  if (byType.size === 0) return out;
  const jobs: Array<{ type: string; chunk: string[] }> = [];
  for (const [type, list] of byType) {
    const uniq = Array.from(new Set(list));
    for (let i = 0; i < uniq.length; i += 50) {
      jobs.push({ type, chunk: uniq.slice(i, i + 50) });
    }
  }
  await Promise.all(
    jobs.map(async ({ type, chunk }) => {
      try {
        const response = await monitoredEntitiesClient.getEntities({
          entitySelector: `type("${type}"),entityId(${chunk.join(",")})`,
          from: toEntityApiTimeRef(fromExpr),
          fields: "+lastSeenTms",
          pageSize: 500,
        });
        for (const e of response.entities ?? []) {
          const id = (e as any).entityId ?? (e as any).id ?? "";
          const ls = (e as any).lastSeenTms;
          if (id && typeof ls === "number" && Number.isFinite(ls)) out.set(id, ls);
        }
      } catch (err) {
        console.warn(`resolveEntityLastSeen(${type}) chunk failed`, err);
      }
    })
  );
  return out;
}

// API
interface FindingsRequest {
  module: ModuleId;
  scope: ScopeRef;
  timeframe: TimeframeRange;
  thresholds: Thresholds;
  /**
   * Tag / OS / cloud filter intersected with the scope at query time.
   * An empty filter applies no host filter. `filter.attrs` takes precedence
   * when `filter` is present.
   */
  hostFilter?: HostFilter;
  /**
   * The resolved Filters-menu bundle for this (module, view): name rules, tag /
   * OS / deployment attrs, and disk toggles. When present it fully supplies the
   * scope; when absent the engine falls back to `thresholds` + `hostFilter`.
   */
  filter?: FilterBundle;
  /**
   * Which host name to render. `detected` overlays the OneAgent-detected
   * name onto host-keyed findings; anything else keeps the resolved
   * display name. Default (undefined) = display name.
   */
  hostNameSource?: HostNameSource;
  /**
   * Tag keys backing the custom columns configured for this module
   * (global + page-level). Their values are resolved per entity and
   * attached as `finding.tagValues`. Empty / omitted = no extra queries.
   */
  tagColumnKeys?: string[];
  /** Trend window (days) for disk fill forecasting. Default 14. */
  forecastWindowDays?: number;
  /** Look-back window (days) for descriptive resource stats. Default 14. */
  resourceWindowDays?: number;
  /** When true, the resource-stats window follows the page timeframe. */
  resourceWindowSync?: boolean;
  /** Timeseries resolution vs. cost (default "balanced"). Live queries only. */
  dataResolution?: DataResolution;
  /**
   * Also emit in-scope records that tripped no threshold as `severity: "normal"`
   * findings (the module table's Normal tab). Off for the Overview, which only
   * needs counts, so its payload stays small.
   */
  includeNormal?: boolean;
}

/** The effective Filters-menu bundle for a request: the resolved `filter` when
 *  the caller supplies it, else the top-level threshold / hostFilter fields. */
function reqFilterBundle(req: FindingsRequest): FilterBundle {
  if (req.filter) return req.filter;
  return {
    hostNameFilter: req.thresholds.hostNameFilter ?? { mode: "exclude", rules: [] },
    diskNameFilter: req.thresholds.diskNameFilter ?? { mode: "exclude", rules: [] },
    attrs: req.hostFilter ?? EMPTY_HOST_FILTER,
    includeNonProvisioned: req.thresholds.includeNonProvisioned ?? false,
    excludeStagnantDisks: req.thresholds.excludeStagnantDisks ?? false,
  };
}

export async function fetchFindings(req: FindingsRequest): Promise<{
  findings: Finding[];
  dataAsOf?: string;
  notApplicable?: boolean;
  /** Records evaluated before threshold filtering (disk/compute only):
   *  the denominator for the Overview "nominal" bar. */
  scanned?: number;
  /** Records past every non-usage filter (disk/compute). */
  inScope?: InScopeCounts;
}> {
  const filter = reqFilterBundle(req);
  const result = await computeFindingsLive(req);
  const decorated = await decorateFindings(
    req.module,
    result.findings,
    req.hostNameSource,
    req.tagColumnKeys
  );
  const deduped = dedupeById(decorated);
  // Rules match against the entity name shown in the Host column.
  const nameFiltered = applyHostNameFilter(deduped, filter.hostNameFilter);
  const withLiveness = await applyOfflineState(nameFiltered, req);
  return { ...result, findings: withLiveness };
}

// A host counts as offline once it's been dark longer than this. Hosts report
// about every minute, so a 15-minute grace keeps normal gaps from reading as
// outages.
const OFFLINE_GRACE_MS = 15 * 60 * 1000;

/**
 * Flag host-keyed findings whose host has gone dark past the grace window so
 * the table can dim them and show how long they've been offline. Findings are
 * never dropped; a tighter timeframe is how stale hosts get excluded.
 */
async function applyOfflineState(
  findings: Finding[],
  req: FindingsRequest
): Promise<Finding[]> {
  if (findings.length === 0) return findings;

  const hostIds = Array.from(
    new Set(
      findings
        .filter((f) => f.entity.entityType === "HOST")
        .map((f) => f.entity.entityId)
    )
  );
  if (hostIds.length === 0) return findings;

  const lastSeen = await resolveEntityLastSeen(hostIds, req.timeframe.from);
  const now = Date.now();
  for (const f of findings) {
    if (f.entity.entityType !== "HOST") continue;
    const ls = lastSeen.get(f.entity.entityId);
    if (ls == null) continue; // unknown last-seen, treat as online
    const offlineForMs = now - ls;
    if (offlineForMs > OFFLINE_GRACE_MS) {
      f.offline = true;
      f.offlineForMs = offlineForMs;
    }
  }
  return findings;
}

/**
 * Overlay detected host names and attach custom-column tag values. Both are
 * additive and fail soft: a query error leaves findings rendering with their
 * default names and no tag columns rather than blanking the table.
 */
async function decorateFindings(
  module: ModuleId,
  findings: Finding[],
  hostNameSource?: HostNameSource,
  tagColumnKeys?: string[]
): Promise<Finding[]> {
  if (findings.length === 0) return findings;
  const entityType = moduleEntityType(module);
  const ids = findings.map((f) => f.entity.entityId);
  let out = findings;

  if (hostNameSource === "detected" && entityType === "dt.entity.host") {
    try {
      const names = await resolveHostDetectedNames(ids);
      out = out.map((f) => {
        const n = names.get(f.entity.entityId);
        return n && n !== f.entity.displayName
          ? { ...f, entity: { ...f.entity, displayName: n } }
          : f;
      });
    } catch (err) {
      console.warn("decorateFindings: detected-name overlay failed", err);
    }
  }

  const keys = (tagColumnKeys ?? []).filter(Boolean);
  if (keys.length > 0) {
    try {
      const valueMap = await resolveEntityTagValues(entityType, ids, keys);
      out = out.map((f) => {
        const bag = valueMap.get(f.entity.entityId);
        return bag
          ? { ...f, tagValues: { ...(f.tagValues ?? {}), ...bag } }
          : f;
      });
    } catch (err) {
      console.warn("decorateFindings: tag-value columns failed", err);
    }
  }

  return out;
}

// live compute
async function computeFindingsLive(req: FindingsRequest): Promise<{
  findings: Finding[];
  dataAsOf?: string;
  notApplicable?: boolean;
  scanned?: number;
  inScope?: InScopeCounts;
}> {
  let raw: Finding[] = [];
  let notApplicable = false;
  // Records evaluated before threshold filtering (disk/compute only): the
  // denominator for the Overview's "nominal" bar.
  let scanned: number | undefined;
  // Records past every non-usage filter (disk/compute only).
  let inScope: InScopeCounts | undefined;
  const filter = reqFilterBundle(req);
  const now = new Date().toISOString();
  try {
    switch (req.module) {
      case "disk": {
        const result = await computeDiskFindings(
          req.scope,
          req.timeframe,
          req.thresholds,
          filter,
          req.forecastWindowDays,
          req.resourceWindowDays,
          req.resourceWindowSync,
          req.hostNameSource,
          req.dataResolution,
          req.includeNormal
        );
        raw = result.findings;
        scanned = result.scanned;
        inScope = result.inScope;
        break;
      }
      case "compute": {
        const result = await computeComputeFindings(
          req.scope,
          req.timeframe,
          req.thresholds,
          filter,
          req.resourceWindowDays,
          req.resourceWindowSync,
          req.hostNameSource,
          req.dataResolution,
          req.includeNormal
        );
        raw = result.findings;
        scanned = result.scanned;
        inScope = result.inScope;
        break;
      }
      case "kubernetes": {
        const result = await computeKubernetesFindings(req.scope, req.timeframe, req.thresholds, req.hostFilter);
        raw = result.findings;
        notApplicable = result.notApplicable;
        break;
      }
      case "scaling": {
        const result = await computeScalingFindings(req.scope, req.timeframe, req.thresholds, req.hostFilter);
        raw = result.findings;
        notApplicable = result.notApplicable;
        break;
      }
    }
  } catch (err) {
    console.error(`computeFindingsLive(${req.module}) failed`, err);
    return { findings: [], dataAsOf: now };
  }
  // Stamp OS + deployment (cloud provider) onto host-keyed findings so the
  // details popup can show them. One batched lookup per fetch; cached.
  const hostIds = Array.from(
    new Set(
      raw
        .filter((f) => f.entity.entityType === "HOST")
        .map((f) => f.entity.entityId)
    )
  );
  if (hostIds.length > 0) {
    const attrs = await resolveHostAttributes(hostIds);
    for (const f of raw) {
      if (f.entity.entityType !== "HOST") continue;
      const a = attrs.get(f.entity.entityId);
      f.entity.os = osLabel(a?.osType);
      f.entity.deployment = deploymentLabel(a?.cloudType);
    }
  }
  const withState = await joinUserState(raw);
  return { findings: withState, dataAsOf: now, notApplicable, scanned, inScope };
}

// disk
const toGb = (val: number, unit: SizeUnit) => {
  switch (unit) {
    case "MB": return val / 1000;
    case "GB": return val;
    case "TB": return val * 1000;
    case "PB": return val * 1000 * 1000;
  }
};
const toDays = (val: number, unit: TimeUnit) =>
  unit === "years" ? val * 365 : val;

function passesGate(
  totalGb: number | null,
  cond: { minSizeEnabled: boolean; minSize: number; minSizeUnit: SizeUnit; maxSizeEnabled: boolean; maxSize: number; maxSizeUnit: SizeUnit }
): boolean {
  if (totalGb == null) return true;
  if (cond.minSizeEnabled && totalGb < toGb(cond.minSize, cond.minSizeUnit)) return false;
  if (cond.maxSizeEnabled && totalGb > toGb(cond.maxSize, cond.maxSizeUnit)) return false;
  return true;
}

/** vCPU (core count) gate for compute conditions. Unknown cores → passes. */
function passesCoreGate(
  cores: number | null,
  gate: { minCoresEnabled: boolean; minCores: number; maxCoresEnabled: boolean; maxCores: number }
): boolean {
  if (cores == null) return true;
  if (gate.minCoresEnabled && cores < gate.minCores) return false;
  if (gate.maxCoresEnabled && cores > gate.maxCores) return false;
  return true;
}

/**
 * Span (in minutes) of a relative `now-Xu` timeframe, or null when the
 * expression isn't a simple relative window (absolute timestamps, etc.).
 */
function timeframeSpanMinutes(from: string, to: string): number | null {
  const perMin: Record<string, number> = {
    s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, M: 43200, y: 525600,
  };
  const rel = (e: string): number | null => {
    const s = e.trim().replace(/\(\)/g, "").replace(/\s+/g, "");
    if (s === "now" || s === "now-0") return 0;
    const mt = s.match(/^now-(\d+)([smhdwMy])$/);
    if (!mt) return null;
    return Number(mt[1]) * perMin[mt[2]];
  };
  const f = rel(from);
  const t = rel(to);
  if (f != null && t != null) {
    const span = f - t;
    return span > 0 ? span : null;
  }
  // Calendar-aligned windows (Today / Yesterday / This week) aren't simple
  // `now-Xu` expressions; resolve both ends to real dates and diff them.
  const fd = resolveTimeExprToDate(from);
  const td = resolveTimeExprToDate(to);
  if (fd && td) {
    const span = (td.getTime() - fd.getTime()) / 60000;
    return span > 0 ? span : null;
  }
  return null;
}

/**
 * Target bucket count per data-resolution mode, split by query: compute stats,
 * disk IOPS (`disk`), and the disk fill scan (`diskFill`). Fewer buckets means
 * a coarser interval and less data scanned, but each bucket is an average, so
 * P95 / max smooth out and short spikes can vanish. Disk usage is steadier than
 * compute, so outside High it runs at a lower bucket count.
 */
const RESOLUTION_BUCKETS: Record<
  DataResolution,
  { compute: number; disk: number; diskFill: number }
> = {
  high: { compute: 300, disk: 300, diskFill: 150 },
  balanced: { compute: 120, disk: 80, diskFill: 40 },
  fast: { compute: 40, disk: 24, diskFill: 12 },
};

function bucketsFor(resolution: DataResolution | undefined): {
  compute: number;
  disk: number;
  diskFill: number;
} {
  return RESOLUTION_BUCKETS[resolution ?? "balanced"];
}

/**
 * Pick a timeseries interval that fits inside the selected window. DQL snaps
 * the query timeframe out to whole intervals, so `interval: 1d` on a 2h window
 * widens it to the full day and pulls back hosts that were only online earlier
 * today. Keeping the interval strictly smaller than the span keeps the window
 * (and which disks count as "live") exactly what the user picked. Aims for
 * `buckets` buckets; falls back to 1h when the window can't be parsed.
 */
function pickFillInterval(from: string, to: string, buckets = 60): string {
  const span = timeframeSpanMinutes(from, to);
  if (span == null) return "1h";
  const ladder = [1, 5, 15, 30, 60, 180, 360, 720, 1440];
  const want = span / Math.max(1, buckets);
  let pick = ladder[0];
  for (const step of ladder) {
    if (step <= want) pick = step;
    else break;
  }
  if (pick >= span) pick = Math.max(1, Math.floor(span / 2));
  if (pick % 1440 === 0) return `${pick / 1440}d`;
  if (pick % 60 === 0) return `${pick / 60}h`;
  return `${pick}m`;
}

/**
 * Minutes represented by an interval expression like "15m" / "6h" / "1d".
 * Used to convert a query's bucket spacing into the days-based x-axis the fill
 * regression works in. Returns null for anything unparsed.
 */
function intervalMinutes(expr: string): number | null {
  const m = expr.trim().match(/^(\d+)([mhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "d" ? n * 1440 : m[2] === "h" ? n * 60 : n;
}

/**
 * Resolve the resource-metrics window: the look-back period for descriptive
 * stats (compute CPU/mem percentiles, disk IOPS). With `sync` on it follows the
 * page timeframe, otherwise it's a fixed `days`-day window ending now. Either
 * way the interval scales to `buckets` buckets so query cost stays flat
 * regardless of span. Separate from the disk forecast window
 * (`forecastWindowDays`), which needs a stable baseline and never follows the
 * timeframe.
 */
function resourceWindowRefs(
  timeframe: TimeframeRange,
  days: number | undefined,
  sync: boolean | undefined,
  buckets = 120
): { fromRef: string; toRef: string; interval: string } {
  const d = Math.min(365, Math.max(1, Math.round(days ?? 14)));
  const spanMin = sync
    ? timeframeSpanMinutes(timeframe.from, timeframe.to) ?? d * 1440
    : d * 1440;
  const intervalMin = Math.max(1, Math.round(spanMin / Math.max(1, buckets)));
  const interval =
    intervalMin >= 60
      ? `${Math.max(1, Math.round(intervalMin / 60))}h`
      : `${intervalMin}m`;
  const fromRef = sync ? toDqlTimeRef(timeframe.from) : `now() - ${d}d`;
  const toRef = sync ? toDqlTimeRef(timeframe.to) : `now()`;
  return { fromRef, toRef, interval };
}

/**
 * Epoch (ms) of the page-timeframe start, used to gate which entities are
 * "visible" when the resource window is longer than the timeframe. Anchored
 * on now for relative `now-Xu` windows (the common case); good enough for
 * calendar windows too.
 */
function timeframeStartEpoch(timeframe: TimeframeRange): number {
  const span = timeframeSpanMinutes(timeframe.from, timeframe.to) ?? 120;
  return Date.now() - span * 60_000;
}

// Filesystems that aren't real provisioned storage: pseudo, ephemeral,
// or platform-managed mounts. Hidden by default; the disk filter's
// "include non-provisioned filesystems" toggle brings them back. Match is
// against a lower-cased, slash-normalized, trailing-slash-stripped mount.
const NON_PROVISIONED_MOUNT_RULES: Array<(m: string) => boolean> = [
  (m) => m === "/dbfs", // Databricks FUSE mount
  (m) => m.endsWith("oneagent-bin"), // Dynatrace OneAgent
  (m) => m.startsWith("/var/lib/kubelet/"), // k8s per-pod / plugin mounts
  (m) => m.includes("kubernetes.io~"), // k8s volume-plugin bind mounts (csi, configmap, secret, projected…)
  (m) => m.startsWith("/var/lib/docker/"), // Docker overlay / container layers
  (m) => m.startsWith("/var/lib/containers/"), // Podman / CRI-O layers
  (m) => m.startsWith("/snap/"), // snap package loop mounts
];
function isNonProvisionedMount(mountPath: string): boolean {
  return NON_PROVISIONED_MOUNT_RULES.some((rule) => rule(mountPath));
}

/** Compact ops/sec: "1.2k" for >=1000, else a whole number. */
function formatIops(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

interface NameRuleLike {
  mode: string;
  pattern: string;
  action?: "include" | "exclude";
}
interface NameFilterLike {
  /** List-level direction; a fallback for rules lacking `action`. */
  mode?: "include" | "exclude";
  rules: NameRuleLike[];
}

/**
 * True if `name` passes a name filter (case-insensitive rule match). Each
 * rule is independently an include-only or exclude rule:
 *   - a row is dropped if it matches ANY exclude rule;
 *   - if any include rules exist, the row must match at least ONE of them.
 * No rules → everything passes. Rules without an `action` fall back to the
 * list-level `mode`, which is what pre-migration data carries. Shared by the
 * disk mount-name filter and the app-wide host-name filter.
 */
function passesNameFilter(name: string, filter: NameFilterLike | undefined | null): boolean {
  if (!filter) return true;
  const rules = filter.rules ?? [];
  if (rules.length === 0) return true;
  const lower = String(name).toLowerCase();
  const matches = (rule: NameRuleLike) => {
    const p = (rule.pattern ?? "").toLowerCase();
    if (!p) return false;
    switch (rule.mode) {
      case "equals": return lower === p;
      case "contains": return lower.includes(p);
      case "startsWith": return lower.startsWith(p);
      case "endsWith": return lower.endsWith(p);
      default: return false;
    }
  };
  const legacy = filter.mode === "include" ? "include" : "exclude";
  const actionOf = (r: NameRuleLike): "include" | "exclude" =>
    r.action === "include" || r.action === "exclude" ? r.action : legacy;

  const includeRules = rules.filter((r) => actionOf(r) === "include");
  const excludeRules = rules.filter((r) => actionOf(r) === "exclude");

  if (excludeRules.some(matches)) return false;
  if (includeRules.length > 0 && !includeRules.some(matches)) return false;
  return true;
}

/** Apply the app-wide host-name filter to a finding list (by entity name). */
function applyHostNameFilter(
  findings: Finding[],
  filter: NameFilterLike | undefined | null
): Finding[] {
  if (!filter || (filter.rules ?? []).length === 0) return findings;
  return findings.filter((f) => passesNameFilter(f.entity.displayName, filter));
}

/** In-scope population: records past every Filters-menu control (host + disk
 *  name rules, non-provisioned, exclude-non-growing). One count per module; the
 *  size / vCPU limits are Thresholds-menu controls and don't narrow scope. */
type InScopeCounts = number;

/** Severity ordering used to pick the worst of several outcomes. `normal` is
 *  deliberately 0: it is the absence of a finding, not a tier. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  atCapacity: 3,
  highUsage: 2,
  lowUsage: 1,
  normal: 0,
};

async function computeDiskFindings(
  scope: ScopeRef,
  timeframe: TimeframeRange,
  t: Thresholds,
  filter: FilterBundle,
  forecastWindowDays?: number,
  resourceWindowDays?: number,
  resourceWindowSync?: boolean,
  hostNameSource?: HostNameSource,
  resolution?: DataResolution,
  includeNormal?: boolean
): Promise<{ findings: Finding[]; scanned: number; inScope: InScopeCounts }> {
  const scopeFilter = await scopeToDqlFilter(scope, "dt.entity.host", timeframe, filter.attrs);
  const fromRef = toDqlTimeRef(timeframe.from);
  const toRef = toDqlTimeRef(timeframe.to);
  const buckets = bucketsFor(resolution);
  // IOPS is a descriptive stat, so it uses the resource-metrics window
  // (page timeframe when synced, else the fixed look-back). Discovery and
  // current % still come from the timeframe fill query below.
  const rw = resourceWindowRefs(timeframe, resourceWindowDays, resourceWindowSync, buckets.disk);
  // Interval fitted to the window so it never widens it (see pickFillInterval);
  // that is what makes the timeframe act as the "is this disk live enough to
  // include?" gate.
  const fillInterval = pickFillInterval(timeframe.from, timeframe.to, buckets.diskFill);
  // Spacing between two fill-query samples, in DAYS. The fallback regression
  // below runs over the fill series, whose buckets are `fillInterval` apart
  // (often minutes), not one per day; treating them as daily understates the
  // slope by up to ~1440x and the disk reads "99y+".
  const fillDxDays = (intervalMinutes(fillInterval) ?? 60) / 1440;

  // Size limits are a per-tier whole-table blanket (folded into skipHigh /
  // skipLow below); there are no per-condition size gates.

  // Query 1: selected-timeframe fill % + physical size.
  // Drives current % used and entity discovery. A disk appears here only if it
  // reported at least one sample inside the selected window, so a host offline
  // longer than the window won't come back. used_bytes / avail_bytes ride along
  // (same grouping and window); the size logic takes the last non-null, so the
  // fitted interval doesn't change them.
  const fillQuery = `
    timeseries
      used = avg(dt.host.disk.used.percent),
      used_bytes = avg(dt.host.disk.used),
      avail_bytes = avg(dt.host.disk.avail),
      by: { dt.entity.host, dt.entity.disk, dt.disk.mount }, interval: ${fillInterval}, from: ${fromRef}, to: ${toRef}
    ${scopeFilter}
    | limit 50000
  `;

  // Query 2: fill trend, on a fixed window decoupled from the page timeframe so
  // the "Time to full" projection stays stable as the view window changes. The
  // window is user-configurable (Settings): longer is more accurate for slow
  // trends but scans more data. Interval scales to keep ~120 samples so the
  // query shape holds across window sizes. Same scope filter as the fill query
  // so the two join. The projection uses the precise fitted slope; only the
  // Daily Δ% display is rounded.
  const TREND_WINDOW_DAYS = Math.min(365, Math.max(1, Math.round(forecastWindowDays ?? 14)));
  const TREND_INTERVAL_HOURS = Math.min(
    24,
    Math.max(1, Math.round((TREND_WINDOW_DAYS * 24) / 120))
  );
  const trendQuery = `
    timeseries used = avg(dt.host.disk.used.percent), by: { dt.entity.host, dt.entity.disk }, interval: ${TREND_INTERVAL_HOURS}h, from: now() - ${TREND_WINDOW_DAYS}d, to: now()
    ${scopeFilter}
    | limit 50000
  `;

  // Query 3: disk IOPS (read + write ops) averaged over the resource window.
  // 0 IOPS is a strong underutilization signal. Only disks the timeframe fill
  // query discovered are looked up, so a wider window here never adds disks; it
  // measures the same ones over longer.
  const iopsQuery = `
    timeseries
      read_ops = avg(dt.host.disk.read_ops),
      write_ops = avg(dt.host.disk.write_ops),
      by: { dt.entity.host, dt.entity.disk },
      interval: ${rw.interval}, from: ${rw.fromRef}, to: ${rw.toRef}
    ${scopeFilter}
    | limit 50000
  `;

  const findings: Finding[] = [];
  // Population = provisioned disks we actually evaluate (past the structural
  // filters). Drives the Overview "nominal" bar: nominal = scanned - findings.
  let scanned = 0;
  // In-scope population = past every Filters-menu control (scope + tags/OS/
  // deployment via the query, provisioned, mount + host name rules, and the
  // exclude-non-growing filter). One per-module count: the size limits are a
  // Thresholds-menu control and don't narrow scope.
  let inScope = 0;
  try {
    const [fillResult, trendResult, iopsResult] = await Promise.all([
      runDqlQuery(fillQuery, "disk"),
      runDqlQuery(trendQuery, "disk:trend").catch((err) => {
        console.warn("[disk:trend] query failed; will fall back to short-window fit", err);
        return { records: [] as any[], state: "FAILED" };
      }),
      runDqlQuery(iopsQuery, "disk:iops").catch((err) => {
        console.warn("[disk:iops] query failed", err);
        return { records: [] as any[], state: "FAILED" };
      }),
    ]);
    const records = fillResult.records;
    const sizeByKey = new Map<string, { usedBytes: number; totalBytes: number | null }>();
    const lastNonNull = (arr: number[] | undefined | null): number | null => {
      if (!Array.isArray(arr)) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (Number.isFinite(arr[i])) return arr[i];
      }
      return null;
    };
    for (const rec of records) {
      const h = rec["dt.entity.host"];
      const d = rec["dt.entity.disk"];
      if (typeof h !== "string" || typeof d !== "string") continue;
      const u = lastNonNull(rec.used_bytes);
      const a = lastNonNull(rec.avail_bytes);
      if (u == null && a == null) continue;
      const usedBytes = u ?? 0;
      const totalBytes = a != null ? usedBytes + a : null;
      sizeByKey.set(`${h}:${d}`, { usedBytes, totalBytes });
    }

    // IOPS per host:disk: min/avg/median/P95/max over the window for read,
    // write, and total (read+write), so any of them can back a column or
    // filter. The total is a per-bin sum, so its percentiles are real.
    type IopsStats = {
      read: SeriesStats | null;
      write: SeriesStats | null;
      total: SeriesStats | null;
    };
    const iopsByKey = new Map<string, IopsStats>();
    for (const rec of iopsResult.records) {
      const h = rec["dt.entity.host"];
      const d = rec["dt.entity.disk"];
      if (typeof h !== "string" || typeof d !== "string") continue;
      const readArr = Array.isArray(rec.read_ops) ? (rec.read_ops as number[]) : [];
      const writeArr = Array.isArray(rec.write_ops) ? (rec.write_ops as number[]) : [];
      const totalArr: number[] = [];
      const n = Math.max(readArr.length, writeArr.length);
      for (let i = 0; i < n; i++) {
        const r = Number.isFinite(readArr[i]) ? readArr[i] : null;
        const w = Number.isFinite(writeArr[i]) ? writeArr[i] : null;
        if (r == null && w == null) continue;
        totalArr.push((r ?? 0) + (w ?? 0));
      }
      iopsByKey.set(`${h}:${d}`, {
        read: seriesStats(readArr),
        write: seriesStats(writeArr),
        total: seriesStats(totalArr),
      });
    }

    const nowDay = Math.floor(Date.now() / 86_400_000);

    // Trend fits keyed by host:disk. Samples are `TREND_INTERVAL_HOURS` apart,
    // so x is converted to days-from-now to keep the slope in %/day.
    const dxDays = TREND_INTERVAL_HOURS / 24;
    const trendByKey = new Map<string, ReturnType<typeof linearFit>>();
    for (const rec of trendResult.records) {
      const h = rec["dt.entity.host"];
      const d = rec["dt.entity.disk"];
      if (typeof h !== "string" || typeof d !== "string") continue;
      const series = (rec.used as number[]) ?? [];
      if (series.length < 2) continue;
      const lastIdx = series.length - 1;
      const tp = series
        .map((y, i) => ({ x: nowDay - (lastIdx - i) * dxDays, y }))
        .filter((p) => Number.isFinite(p.y));
      if (tp.length < 2) continue;
      const fit = linearFit(tp);
      if (fit) trendByKey.set(`${h}:${d}`, fit);
    }

    const allIds = new Set<string>();
    const hostIds = new Set<string>();
    for (const rec of records) {
      const h = rec["dt.entity.host"];
      const d = rec["dt.entity.disk"];
      if (typeof h === "string") { allIds.add(h); hostIds.add(h); }
      if (typeof d === "string") allIds.add(d);
    }
    // Wider window than the selected timeframe so disks that aren't actively
    // reporting in the short window still resolve to their mount paths instead
    // of a raw DISK-id. The classic entities API is cached and batched, so
    // widening costs little.
    const names = await resolveEntityNames(Array.from(allIds), "now-7d");
    // The in-scope counter must test the SAME name the finding is filtered by
    // downstream. Under the detected-name source that's the detected name, so
    // resolve those here; otherwise in-scope tests the classic name, rejects
    // hosts the finding keeps, and collapses to zero. Only needed when
    // host-name rules are set (the filter is a no-op otherwise).
    const nameRulesActive = (filter.hostNameFilter.rules?.length ?? 0) > 0;
    const detectedNames =
      hostNameSource === "detected" && nameRulesActive
        ? await resolveHostDetectedNames(Array.from(hostIds)).catch(
            () => new Map<string, string>()
          )
        : null;
    const filterName = (entityId: string, classicName: string): string =>
      (detectedNames?.get(entityId) ?? "") || classicName;

    for (const rec of records) {
      const series = (rec.used as number[]) ?? [];
      if (series.length < 1) continue;
      const points = series
        .map((y, i) => ({ x: nowDay - (series.length - 1 - i) * fillDxDays, y }))
        .filter((p) => Number.isFinite(p.y));
      if (points.length < 1) continue;

      const last = points[points.length - 1].y;
      // Comparison value mirroring what the UI shows: 0 and 100 are reserved
      // for a genuinely empty / full disk, everything else clamps into
      // [0.5, 99]. So "at or below 0%" matches only a real 0.0% disk, while a
      // 0.3% ("<1%") disk matches "at or below 1%".
      const shownPct =
        last >= 100
          ? 100
          : last <= 0
          ? 0
          : Math.min(99, Math.max(0.5, Math.round(last)));
      // Slope comes from the fixed trend query, not the selected-timeframe
      // points, which keeps "Time to full" stable as the user flips between
      // 2h/7d/30d windows. Falls back to a short-window fit when the trend
      // query missed this disk or failed entirely.
      const diskTrendKey = `${rec["dt.entity.host"] ?? ""}:${rec["dt.entity.disk"] ?? ""}`;
      const fit =
        trendByKey.get(diskTrendKey) ??
        (points.length >= 2 ? linearFit(points) : null);

      const entityId = rec["dt.entity.host"] ?? "unknown";
      if (entityId === "unknown") continue;
      const resolvedHost = names.get(entityId);
      // Never drop a real disk because its host name didn't resolve: on large
      // tenants the batched classic-API name lookup flakily misses hosts. Fall
      // back to the raw host id so the finding still appears.
      const name =
        resolvedHost && resolvedHost !== entityId ? resolvedHost : entityId;
      const diskEntityId = rec["dt.entity.disk"] ?? "";
      // Prefer the real mount path from the query (`dt.disk.mount`, e.g.
      // "/var/log"). The entity-name fallback must reject an id-valued name:
      // resolveEntityNames stores the id itself when a disk has no display
      // name, so using it directly shows "DISK-1234" instead of the mount.
      // Order: real mount path → a *resolved* disk name (not the id) → the
      // id → "—".
      const resolvedDisk = names.get(diskEntityId);
      const mountDim =
        typeof rec["dt.disk.mount"] === "string" ? (rec["dt.disk.mount"] as string) : "";
      const mount =
        mountDim ||
        (resolvedDisk && resolvedDisk !== diskEntityId ? resolvedDisk : "") ||
        diskEntityId ||
        "—";

      // OneAgent bind mounts (paths ending "oneagent-bin/mount") mirror the size
      // of a real disk already in the report, so they always drop. No opt-in.
      const mountPath = String(mount).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
      if (mountPath.endsWith("oneagent-bin/mount")) continue;
      if (!filter.includeNonProvisioned && isNonProvisionedMount(mountPath)) continue;

      const diskKey = `${entityId}:${diskEntityId || mount}`;

      const size = sizeByKey.get(`${entityId}:${diskEntityId}`);
      const iopsData = iopsByKey.get(`${entityId}:${diskEntityId}`) ?? null;
      // Full IOPS stat set (total/read/write × min/avg/median/P95/max), used by
      // the IOPS columns AND the per-metric IOPS filter below.
      const iopsMet = (label: string, v: number | null | undefined) => ({
        label,
        // Only a true 0 reads "0" (and dims, below). A tiny non-zero value that
        // would round down to "0" reads "<1" instead, so real-but-slow activity
        // isn't mistaken for idle. null falls through to the greyed "—" cell.
        value:
          v == null ? "—" : v === 0 ? "0" : Math.round(v) === 0 ? "<1" : formatIops(v),
        sortValue: v ?? -1,
        isIssue: v != null && v !== 0,
        dim: v === 0,
      });
      const iopsMetrics = {
        iops: iopsMet("Avg IOPS", iopsData?.total?.avg ?? null),
        iopsMin: iopsMet("Min IOPS", iopsData?.total?.min ?? null),
        iopsP50: iopsMet("Median IOPS", iopsData?.total?.p50 ?? null),
        iopsP95: iopsMet("P95 IOPS", iopsData?.total?.p95 ?? null),
        iopsMax: iopsMet("Max IOPS", iopsData?.total?.max ?? null),
        iopsReadMin: iopsMet("Min read IOPS", iopsData?.read?.min ?? null),
        iopsReadAvg: iopsMet("Avg read IOPS", iopsData?.read?.avg ?? null),
        iopsReadP50: iopsMet("Median read IOPS", iopsData?.read?.p50 ?? null),
        iopsReadP95: iopsMet("P95 read IOPS", iopsData?.read?.p95 ?? null),
        iopsReadMax: iopsMet("Max read IOPS", iopsData?.read?.max ?? null),
        iopsWriteMin: iopsMet("Min write IOPS", iopsData?.write?.min ?? null),
        iopsWriteAvg: iopsMet("Avg write IOPS", iopsData?.write?.avg ?? null),
        iopsWriteP50: iopsMet("Median write IOPS", iopsData?.write?.p50 ?? null),
        iopsWriteP95: iopsMet("P95 write IOPS", iopsData?.write?.p95 ?? null),
        iopsWriteMax: iopsMet("Max write IOPS", iopsData?.write?.max ?? null),
      };
      // Evaluate the per-metric IOPS filter for one tier. Only enabled
      // thresholds whose metric has data count; they combine per any/all. High
      // fires at/above the threshold (busy), low at/below (idle).
      const iopsFilterResult = (
        filter: DiskIopsFilter,
        tier: "high" | "low"
      ): { fired: boolean; detail: string } => {
        const active = Object.entries(filter.byMetric).filter(([, c]) => c.enabled);
        if (active.length === 0) return { fired: false, detail: "" };
        const hits: string[] = [];
        const results: boolean[] = [];
        for (const [key, c] of active) {
          const m = (iopsMetrics as Record<string, { label: string; sortValue: number }>)[key];
          const v = m?.sortValue;
          // No data for this stat → skip it entirely (don't let a missing
          // read/write metric block an "all" match or count as a miss).
          if (v == null || v < 0) continue;
          const pass = tier === "high" ? v >= c.value : v <= c.value;
          if (pass) hits.push(`${m.label} ${tier === "high" ? "≥" : "≤"} ${Math.round(c.value)}`);
          results.push(pass);
        }
        if (results.length === 0) return { fired: false, detail: "" };
        const fired =
          filter.combine === "all" ? results.every(Boolean) : results.some(Boolean);
        return { fired, detail: hits.join(filter.combine === "all" ? " and " : " or ") };
      };
      const usedBytesAbs = size?.usedBytes ?? null;
      let totalBytes: number | null = size?.totalBytes ?? null;
      if (totalBytes == null && usedBytesAbs != null && last >= 0.5) {
        totalBytes = (usedBytesAbs * 100) / last;
      }
      const totalGb = totalBytes != null ? totalBytes / 1000 ** 3 : null;

      if (!passesNameFilter(String(mount), filter.diskNameFilter)) continue;

      // Past every structural filter → this is a real disk we're auditing.
      // Counted whether or not it ends up firing, so nominal = scanned - fired.
      scanned++;

      // Runway = headroom / fill rate, from the ACTUAL current fill (`last`)
      // and the trend slope (%/day). Using the real current value rather than
      // the fit line extrapolated to now keeps a near-full growing disk off the
      // "no trend" default: a fit line that overshoots 100% at now yields a
      // negative runway.
      const days =
        fit && fit.slope > 0
          ? Math.max(0, (100 - last) / fit.slope)
          : Number.POSITIVE_INFINITY;

      // Pre-formatted runway ("0d" when already full, then "<1d", "37d", "3y",
      // "99y+"), computed once so the Time-to-full column and the details popup
      // agree, including the 0d case for a saturated disk.
      const timeToFull = (() => {
        const CAP = 40000;
        // Cap the forecast at 99 years (99 * 365 = 36135 days); anything longer
        // reads "99y+".
        const YEAR_CAP_DAYS = 36135;
        if (last >= 100) return { display: "0d", sortValue: CAP };
        if (fit && fit.slope > 0) {
          const fillDays = (100 - last) / fit.slope;
          if (Number.isFinite(fillDays) && fillDays >= 0 && fillDays <= YEAR_CAP_DAYS) {
            const display =
              fillDays < 1
                ? "<1d"
                : fillDays < 365
                ? `${Math.round(fillDays)}d`
                : `${Math.round(fillDays / 365)}y`;
            return { display, sortValue: CAP - Math.min(fillDays, CAP) };
          }
        }
        // No upward trend, or a runway past the 99-year cap. Both render
        // identically, so they share one sortValue at the bottom of the order.
        return { display: "99y+", sortValue: 0 };
      })();

      // "No longer growing" = flat or declining fill trend, backing the
      // optional "exclude disks that are no longer growing" filter. GROWTH_EPS
      // (%-points/day) is the same near-zero band the Daily Δ% column dims at,
      // so a disk that reads flat there reads stagnant here too.
      const GROWTH_EPS = 0.005;
      // A disk with no usable fit (brand-new, or too few samples) counts as
      // unknown, not stagnant, so the exclude filter doesn't drop every
      // newly-provisioned disk from scope.
      const isStagnant = !!fit && fit.slope < GROWTH_EPS;

      // In scope = past the Filters-menu controls: the host-name rules and the
      // app-wide exclude-non-growing filter (mount rules + non-provisioned
      // already dropped above). The size limits are NOT here: a disk excluded
      // only by a limit still counts as in scope. Exclude-non-growing is a
      // scope filter, so a non-growing disk drops out on both tabs.
      const hostInScope = passesNameFilter(filterName(entityId, name), filter.hostNameFilter);
      const stagnantDropped = filter.excludeStagnantDisks && isStagnant;
      const inScopeThis = hostInScope && !stagnantDropped;
      if (inScopeThis) inScope++;

      // The per-tab size limit gates the FINDINGS (not scope): High and Low each
      // use their own limit, so a disk can qualify on one tab but not the other.
      // A disk dropped from scope (non-growing) is skipped on both.
      const highSizePass = passesGate(totalGb, t.disk.highUsage.blanketSize);
      const lowSizePass = passesGate(totalGb, t.disk.lowUsage.blanketSize);
      const skipHigh = stagnantDropped || !highSizePass;
      const skipLow = stagnantDropped || !lowSizePass;

      // At capacity (>=100% used). Fires with no threshold config.
      //
      // Scope and limits differ here. The app-wide exclude-non-growing filter is
      // a SCOPE control, so a full-but-static disk is genuinely gone. The
      // per-tab size limit is not: a full disk outside it still surfaces in the
      // High tab, flagged `limitExcluded` so the row renders dimmed and stays
      // out of every count except the in-scope population.
      let severity: Severity | null = null;
      let limitExcluded = false;
      const reasons: string[] = [];
      const recs: string[] = [];

      if (last >= 100) {
        if (!stagnantDropped) {
          severity = "atCapacity";
          limitExcluded = !highSizePass;
          reasons.push(
            limitExcluded
              ? `Disk is at capacity (${last.toFixed(1)}% used), outside the High size limit`
              : `Disk is at capacity (${last.toFixed(1)}% used)`
          );
          recs.push(`${mount} on ${name} is fully saturated. Writes are at risk; provision more capacity immediately.`);
        }
      } else {
        // Each condition group reports { active (enabled), fired } plus its
        // reason/rec. The tier's conditionCombine decides whether the group
        // results fire the tier as a whole (any = OR, all = AND over the
        // enabled groups). Reasons are collected only for groups that fired,
        // and only pushed once the tier actually fires.
        type CondGroup = { active: boolean; fired: boolean; reason?: string; rec?: string };
        const hasEnabledIops = (f: DiskIopsFilter) =>
          Object.values(f.byMetric).some((c) => c.enabled);
        const iopsHadEnabled = { high: hasEnabledIops(t.disk.highUsage.iops), low: hasEnabledIops(t.disk.lowUsage.iops) };

        // High-usage condition groups
        const hp = t.disk.highUsage.percent;
        const hd = t.disk.highUsage.days;
        const hi = t.disk.highUsage.iops;
        const hcc = t.disk.highUsage.dailyChange;
        const highSlope = fit?.slope ?? 0;
        const highIops = iopsFilterResult(hi, "high");
        const highGroups: CondGroup[] = [
          {
            active: !skipHigh && hp.enabled,
            fired: !skipHigh && hp.enabled && shownPct >= hp.value,
            reason: `Disk at ${last.toFixed(1)}% used`,
            rec: `${mount} on ${name} is at ${last.toFixed(1)}% used, provision more capacity.`,
          },
          {
            active: !skipHigh && hd.enabled,
            fired:
              !skipHigh && hd.enabled && Number.isFinite(days) && days > 0 &&
              days <= toDays(hd.value, hd.unit),
            reason: `Disk projected to fill in ${Math.round(days)}d`,
            rec: `${mount} on ${name} will hit 100% in ~${Math.round(days)} days at ${highSlope.toFixed(2)}%/day.`,
          },
          {
            active: !skipHigh && iopsHadEnabled.high,
            fired: !skipHigh && iopsHadEnabled.high && highIops.fired,
            reason: `Disk busy on IOPS (${highIops.detail})`,
            rec: `${mount} on ${name} crossed an IOPS threshold: ${highIops.detail}. Check for I/O contention.`,
          },
          {
            active: !skipHigh && hcc.enabled,
            fired: !skipHigh && hcc.enabled && highSlope >= hcc.value,
            reason: `Disk growing +${highSlope.toFixed(2)}%/day`,
            rec: `${mount} on ${name} is growing +${highSlope.toFixed(2)}%/day, trending toward capacity.`,
          },
        ];

        if (combineConditionResults(highGroups, t.disk.highUsage.conditionCombine)) {
          severity = "highUsage";
          for (const g of highGroups) if (g.fired) { if (g.reason) reasons.push(g.reason); if (g.rec) recs.push(g.rec); }
        } else {
          // Low-usage condition groups
          const lp = t.disk.lowUsage.percent;
          const ld = t.disk.lowUsage.days;
          const li = t.disk.lowUsage.iops;
          const lcc = t.disk.lowUsage.dailyChange;
          const lowSlope = fit?.slope ?? 0;
          const lowIops = iopsFilterResult(li, "low");
          // Days-low fires two ways: no upward trend, or a very long fill ETA.
          const daysLowNoTrend = !fit || fit.slope <= 0;
          const daysLowLong = Number.isFinite(days) && days >= toDays(ld.value, ld.unit);
          const yrs = (days / 365).toFixed(1);
          const lowGroups: CondGroup[] = [
            {
              active: !skipLow && lp.enabled,
              fired: !skipLow && lp.enabled && shownPct <= lp.value,
              reason: `Disk underused at ${last.toFixed(1)}%`,
              rec: `${mount} sits at ${last.toFixed(1)}% used, reclaim or right-size.`,
            },
            {
              active: !skipLow && ld.enabled,
              fired: !skipLow && ld.enabled && (daysLowNoTrend || daysLowLong),
              reason: daysLowNoTrend ? "Disk has no upward fill trend" : `Disk projected to take ${yrs}y to fill`,
              rec: daysLowNoTrend
                ? `${mount} on ${name} isn't growing, reclaim or right-size.`
                : `${mount} on ${name} will take ~${yrs} years to reach 100%, reclaim or right-size.`,
            },
            {
              active: !skipLow && iopsHadEnabled.low,
              fired: !skipLow && iopsHadEnabled.low && lowIops.fired,
              reason: `Disk nearly idle on IOPS (${lowIops.detail})`,
              rec: `${mount} on ${name} is under an IOPS threshold: ${lowIops.detail}. Likely unused, reclaim or right-size.`,
            },
            {
              active: !skipLow && lcc.enabled,
              fired: !skipLow && lcc.enabled && lowSlope <= lcc.value,
              reason: `Disk barely changing at ${lowSlope.toFixed(2)}%/day`,
              rec: `${mount} on ${name} is changing ${lowSlope.toFixed(2)}%/day, flat or shrinking, reclaim or right-size.`,
            },
          ];
          if (combineConditionResults(lowGroups, t.disk.lowUsage.conditionCombine)) {
            severity = "lowUsage";
            for (const g of lowGroups) if (g.fired) { if (g.reason) reasons.push(g.reason); if (g.rec) recs.push(g.rec); }
          }
        }
      }

      if (!severity) {
        // In-scope but tripped nothing: a "normal" record for the Normal tab
        // (only when the caller asked; the Overview skips it to stay lean).
        if (!inScopeThis || !includeNormal) continue;
        severity = "normal";
        reasons.length = 0;
        recs.length = 0;
      }

      const finding: Finding = {
        id: buildFindingId("disk", diskKey, "summary"),
        module: "disk",
        ruleId: "disk-summary",
        entity: { entityId, displayName: name, entityType: "HOST", qualifier: mount },
        severity,
        limitExcluded: limitExcluded || undefined,
        title: reasons[0] ?? "Disk usage and capacity review",
        // Prescriptive advice is deliberately omitted; the finding shows the
        // facts and leaves the call to action to the reader.
        recommendation: "",
        evidence: {
          mount,
          disk_entity_id: diskEntityId || null,
          current_used_percent: formatPercent(last, 1),
          // Always two decimals, signed (matches the "Daily Δ%" column). A value
          // that rounds to zero shows "0.00%" with no sign.
          growth_percent_per_day: fit
            ? `${Math.abs(fit.slope).toFixed(2) === "0.00" ? "" : fit.slope > 0 ? "+" : "-"}${Math.abs(fit.slope).toFixed(2)}%`
            : "—",
          time_to_full: timeToFull.display,
          // Combined + split IOPS (read+write) for the details popup.
          ...(iopsData
            ? {
                total_iops: `${formatIops(iopsData.total?.avg ?? 0)} ops/s`,
                read_iops: `${formatIops(iopsData.read?.avg ?? 0)} ops/s`,
                write_iops: `${formatIops(iopsData.write?.avg ?? 0)} ops/s`,
              }
            : {}),
        },
        metrics: {
          diskUsed: {
            label: "% used",
            // Reserve 0/100 for a genuinely empty / full disk; near-extremes
            // read "<1%" / ">99%" (shared rule, see formatPercent).
            value: formatPercent(last, 0),
            sortValue: last,
            isIssue: true,
          },
          daysToFull: {
            label: "Time to full",
            value: timeToFull.display,
            sortValue: timeToFull.sortValue,
            isIssue: true,
          },
          growthRate: (() => {
            // Average %-points/day over the fixed trend window, independent of
            // the page timeframe. With no fit (brand-new disk, sparse data) the
            // cell renders a dimmed zero rather than going blank.
            const slope = fit?.slope ?? 0;
            // Daily change in % points, always two decimals with a sign,
            // no "/d" suffix (the "Daily Δ%" header conveys the cadence).
            // Pick the sign from the ROUNDED magnitude so a value that rounds
            // to zero (e.g. -0.0001) shows "0.00%", never "-0.00%"/"+0.00%".
            const rounded = Math.abs(slope).toFixed(2);
            const sign = rounded === "0.00" ? "" : slope > 0 ? "+" : "-";
            const display = `${sign}${rounded}%`;
            return {
              label: "Daily Δ%",
              value: display,
              sortValue: slope,
              // Dim only truly-flat rows (displays as 0.00%). Anything
              // that shows a non-zero value reads at full strength.
              isIssue: !!fit && Math.abs(slope) >= 0.005,
            };
          })(),
          growthBytes: (() => {
            // Same trend, expressed as an absolute size change per day
            // (slope %/day × capacity). Hidden by default; a companion to the
            // "Daily Δ%" column for people who want GB/day, not %/day.
            const slope = fit?.slope ?? 0;
            const perDay = totalBytes != null ? (slope / 100) * totalBytes : null;
            if (perDay == null) {
              return { label: "Daily Δ", value: "—", sortValue: -1e18, isIssue: false };
            }
            const abs = Math.abs(perDay);
            const sign = abs < 1 ? "" : perDay > 0 ? "+" : "-";
            return {
              label: "Daily Δ",
              value: `${sign}${formatBytes(abs)}`,
              sortValue: perDay,
              isIssue: !!fit && Math.abs(slope) >= 0.005,
            };
          })(),
          usedStorage: {
            label: "Used",
            value: usedBytesAbs != null ? formatBytes(usedBytesAbs) : "—",
            sortValue: usedBytesAbs ?? -1,
            isIssue: true,
          },
          maxStorage: {
            label: "Allocated",
            value: totalBytes != null ? formatBytes(totalBytes) : "—",
            sortValue: totalBytes ?? -1,
            isIssue: true,
          },
          ...iopsMetrics,
        },
        detectedAt: new Date().toISOString(),
        dataAsOf: new Date().toISOString(),
      };
      // A "normal" disk tripped nothing, so nothing on it is an issue: clear the
      // per-cell highlight flags (they'd otherwise read as red/bold).
      if (severity === "normal" && finding.metrics) {
        for (const m of Object.values(finding.metrics)) if (m) m.isIssue = false;
      }
      findings.push(finding);
    }
  } catch (err) {
    console.error("computeDiskFindings failed", err);
  }
  return {
    findings,
    scanned,
    inScope,
  };
}

// compute helpers

/** Percentile of a numeric series (client-side, nearest-rank). */
function percentileOf(arr: number[], p: number): number | null {
  const nums = arr.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

/** Max over aligned bins of a[i] + b[i], used for total RAM (used+avail). */
function pairedMax(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  let best: number | null = null;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      const sum = a[i] + b[i];
      if (best == null || sum > best) best = sum;
    }
  }
  return best;
}

// Compute stat filters (CPU / memory min/avg/P50/P95/max)

interface SeriesStats {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

/** min / mean / median / P95 / max over a per-bin series (nulls dropped). */
function seriesStats(arr: number[]): SeriesStats | null {
  const xs = arr.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of xs) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    min,
    max,
    avg: sum / xs.length,
    p50: percentileOf(xs, 50) ?? min,
    p95: percentileOf(xs, 95) ?? max,
  };
}

type StatKey = "min" | "avg" | "p50" | "p95" | "max";
const STAT_KEYS: StatKey[] = ["min", "avg", "p50", "p95", "max"];
const STAT_LABEL: Record<StatKey, string> = {
  min: "min",
  avg: "avg",
  p50: "median",
  p95: "P95",
  max: "max",
};

interface StatCond {
  enabled: boolean;
  value: number;
}
interface StatFilterLike {
  enabled: boolean;
  combine: "any" | "all";
  min: StatCond;
  avg: StatCond;
  p50: StatCond;
  p95: StatCond;
  max: StatCond;
  /** CPU only; evaluated on the high tier. */
  steal?: StatCond;
}

/** A stat's comparison for the tier: high fires `>=`, low fires `<=`. */
function statCrosses(stat: number, value: number, tier: "high" | "low"): boolean {
  return tier === "high" ? stat >= value : stat <= value;
}

/**
 * Does a CPU/memory filter fire for these stats? Collects each enabled
 * stat's result (plus steal on the high tier for CPU) and combines them
 * with `any` (OR) or `all` (AND). No enabled stats → never fires.
 */
function computeFilterFires(
  filter: StatFilterLike,
  stats: SeriesStats | null,
  tier: "high" | "low",
  stealVal: number | null
): boolean {
  if (!filter.enabled || !stats) return false;
  const results: boolean[] = [];
  for (const k of STAT_KEYS) {
    const c = filter[k];
    if (c.enabled) results.push(statCrosses(stats[k], c.value, tier));
  }
  if (tier === "high" && filter.steal?.enabled && stealVal != null) {
    results.push(stealVal >= filter.steal.value);
  }
  if (results.length === 0) return false;
  return filter.combine === "all" ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Combine a tier's condition GROUPS (disk: percent / days / IOPS / daily
 * change; compute: CPU / memory). Only *active* (enabled) groups count. "any"
 * fires when one trips; "all" fires only when every active group trips. No
 * active groups → no fire.
 */
function combineConditionResults(
  groups: { active: boolean; fired: boolean }[],
  combine: FilterCombine
): boolean {
  const active = groups.filter((g) => g.active);
  if (active.length === 0) return false;
  return combine === "all" ? active.every((g) => g.fired) : active.some((g) => g.fired);
}

type CoreGateShape = {
  minCoresEnabled: boolean;
  minCores: number;
  maxCoresEnabled: boolean;
  maxCores: number;
};
type SizeGateShape = {
  minSizeEnabled: boolean;
  minSize: number;
  minSizeUnit: SizeUnit;
  maxSizeEnabled: boolean;
  maxSize: number;
  maxSizeUnit: SizeUnit;
};

/**
 * Whole-table limit check for compute: a host must be within the enabled
 * pCPU, vCPU, and/or memory limits. Only limits that are actually enabled
 * take part, and they combine with "all" (within every enabled limit) or
 * "any" (within at least one). No enabled limits → everything passes.
 */
function blanketPasses(
  pcpu: number | null,
  vcpu: number | null,
  memGb: number | null,
  pcpuGate: CoreGateShape,
  vcpuGate: CoreGateShape,
  memGate: SizeGateShape,
  combine: "any" | "all"
): boolean {
  const checks: boolean[] = [];
  if (pcpuGate.minCoresEnabled || pcpuGate.maxCoresEnabled) {
    checks.push(passesCoreGate(pcpu, pcpuGate));
  }
  if (vcpuGate.minCoresEnabled || vcpuGate.maxCoresEnabled) {
    checks.push(passesCoreGate(vcpu, vcpuGate));
  }
  if (memGate.minSizeEnabled || memGate.maxSizeEnabled) {
    checks.push(passesGate(memGb, memGate));
  }
  if (checks.length === 0) return true;
  return combine === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

/** Human summary of which stats crossed (for the finding's reason line). */
function crossedStats(
  filter: StatFilterLike,
  stats: SeriesStats,
  tier: "high" | "low",
  stealVal: number | null
): string {
  const parts: string[] = [];
  for (const k of STAT_KEYS) {
    const c = filter[k];
    if (c.enabled && statCrosses(stats[k], c.value, tier)) {
      parts.push(`${STAT_LABEL[k]} ${formatPercent(stats[k], 0)}`);
    }
  }
  if (
    tier === "high" &&
    filter.steal?.enabled &&
    stealVal != null &&
    stealVal >= filter.steal.value
  ) {
    parts.push(`steal ${formatPercent(stealVal, 0)}`);
  }
  return parts.join(", ");
}

interface HostCpuCounts {
  /** Physical CPU cores (`cpuCores`). */
  physical: number | null;
  /** Logical CPUs / vCPUs (`logicalCpuCores` / `logicalCpus`), falling back
   *  to the physical count when the host doesn't report a logical one. */
  logical: number | null;
}

/**
 * Physical (pCPU) and logical (vCPU) CPU counts per host, from the host entity:
 * `cpuCores` is the physical count, `logicalCpuCores` / `logicalCpus` the
 * logical one. A host missing a value won't show that column.
 */
async function resolveHostCpuCores(
  ids: string[],
  fromExpr: string
): Promise<Map<string, HostCpuCounts>> {
  const out = new Map<string, HostCpuCounts>();
  const hostIds = ids.filter((id) => id.startsWith("HOST-"));
  const jobs: string[][] = [];
  for (let i = 0; i < hostIds.length; i += 50) jobs.push(hostIds.slice(i, i + 50));
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  await Promise.all(
    jobs.map(async (chunk) => {
      try {
        const response = await monitoredEntitiesClient.getEntities({
          entitySelector: `type("HOST"),entityId(${chunk.join(",")})`,
          from: toEntityApiTimeRef(fromExpr),
          fields: "+properties.cpuCores,+properties.logicalCpuCores,+properties.logicalCpus",
          pageSize: 500,
        });
        for (const e of response.entities ?? []) {
          const id = (e as any).entityId ?? (e as any).id ?? "";
          const props = (e as any).properties ?? {};
          const physical = num(props.cpuCores);
          const logical =
            num(props.logicalCpuCores) ?? num(props.logicalCpus) ?? physical;
          if (id && (physical != null || logical != null)) {
            out.set(id, { physical, logical });
          }
        }
      } catch (err) {
        console.warn("resolveHostCpuCores chunk failed", err);
      }
    })
  );
  return out;
}

// compute
async function computeComputeFindings(
  scope: ScopeRef,
  timeframe: TimeframeRange,
  t: Thresholds,
  filter: FilterBundle,
  resourceWindowDays?: number,
  resourceWindowSync?: boolean,
  hostNameSource?: HostNameSource,
  resolution?: DataResolution,
  includeNormal?: boolean
): Promise<{ findings: Finding[]; scanned: number; inScope: InScopeCounts }> {
  const scopeFilter = await scopeToDqlFilter(scope, "dt.entity.host", timeframe, filter.attrs);
  // Descriptive stats (CPU/mem percentiles) run over the resource window,
  // which is either the page timeframe (when synced) or a fixed look-back.
  // When they diverge we still gate visibility on the page timeframe below.
  const rw = resourceWindowRefs(
    timeframe,
    resourceWindowDays,
    resourceWindowSync,
    bucketsFor(resolution).compute
  );
  const fromRef = rw.fromRef;
  const toRef = rw.toRef;

  // Size limits are a single whole-table blanket (pCPU + vCPU + memory,
  // combined per blanketCombine). There are no per-filter size gates.

  const findings: Finding[] = [];
  // Population = hosts we actually evaluate (have CPU or memory data). Drives
  // the Overview "nominal" bar: nominal = scanned - findings.
  let scanned = 0;
  // In-scope population = past every Filters-menu control (scope + tags/OS/
  // deployment via the query, has data, host name rules). One per-module count:
  // the pCPU / vCPU / memory limits are a Thresholds-menu control and don't
  // narrow scope.
  let inScope = 0;

  // All five metrics share grouping, window, and interval, so one timeseries
  // command covers them. Each returns a per-bin series; P95 is taken
  // client-side so peaks, not the first bin or a flat average, drive the
  // right-sizing decision. A host with any metric returns a row; absent series
  // parse to [].
  const metricsQuery = `
    timeseries
      cpu = avg(dt.host.cpu.usage),
      mem = avg(dt.host.memory.usage),
      steal = avg(dt.host.cpu.steal),
      memUsed = avg(dt.host.memory.used),
      memAvail = avg(dt.host.memory.avail.bytes),
      by: { dt.entity.host }, interval: ${rw.interval}, from: ${fromRef}, to: ${toRef}
    ${scopeFilter}
    | limit 50000
  `;

  type Label = "cpu" | "mem" | "steal" | "memUsed" | "memAvail";
  type HostRow = {
    entityId: string;
    name: string;
    series: Partial<Record<Label, number[]>>;
  };
  const hosts = new Map<string, HostRow>();
  const numArray = (raw: unknown): number[] =>
    Array.isArray(raw)
      ? (raw.filter((v) => typeof v === "number" && Number.isFinite(v)) as number[])
      : [];

  try {
    const { records } = await runDqlQuery(metricsQuery, "compute:metrics");
    for (const rec of records) {
      const entityId = rec["dt.entity.host"] ?? "unknown";
      if (entityId === "unknown") continue;
      const name = rec["dt.entity.host.name"] ?? entityId;
      hosts.set(entityId, {
        entityId,
        name,
        series: {
          cpu: numArray(rec.cpu),
          mem: numArray(rec.mem),
          steal: numArray(rec.steal),
          memUsed: numArray(rec.memUsed),
          memAvail: numArray(rec.memAvail),
        },
      });
    }
  } catch (err) {
    console.error("[compute:metrics] query failed", err);
  }

  try {
    const hostIds = Array.from(hosts.keys());
    const [names, coresMap] = await Promise.all([
      resolveEntityNames(hostIds, timeframe.from),
      resolveHostCpuCores(hostIds, timeframe.from),
    ]);
    // The in-scope counter must test the SAME name the finding is filtered by
    // downstream. Under the detected-name source that's the detected name, so
    // resolve those here; otherwise in-scope tests the classic name, rejects
    // hosts the finding keeps, and collapses to zero. Only needed when
    // host-name rules are set.
    const nameRulesActive = (filter.hostNameFilter.rules?.length ?? 0) > 0;
    const detectedNames =
      hostNameSource === "detected" && nameRulesActive
        ? await resolveHostDetectedNames(hostIds).catch(
            () => new Map<string, string>()
          )
        : null;
    const filterName = (entityId: string, classicName: string): string =>
      (detectedNames?.get(entityId) ?? "") || classicName;
    // Visibility gate: a fixed look-back wider than the page timeframe lets the
    // stat queries surface hosts that never reported inside the selected
    // window. The timeframe stays the source of truth for what's visible, so
    // last-seen is queried over the full resource window (every candidate gets
    // a real timestamp) and compared against the timeframe start. Skipped when
    // synced; fails open when the lookup returns nothing.
    let lastSeenGate: Map<string, number> | null = null;
    let gateCutoff = 0;
    if (!resourceWindowSync) {
      const d = Math.min(365, Math.max(1, Math.round(resourceWindowDays ?? 14)));
      const seen = await resolveEntityLastSeen(Array.from(hosts.keys()), `now-${d}d`);
      if (seen.size > 0) {
        lastSeenGate = seen;
        gateCutoff = timeframeStartEpoch(timeframe);
      }
    }
    for (const { entityId, series } of hosts.values()) {
      if (lastSeenGate) {
        // Drop only hosts we can confirm went quiet before the timeframe
        // started. A missing last-seen is treated as "keep" (fail open) so an
        // entity-API hiccup can't hide a live host; the offline pipeline
        // still flags anything truly stale later.
        const ls = lastSeenGate.get(entityId);
        if (ls != null && ls < gateCutoff) continue;
      }
      // Never drop a host because its name didn't resolve: the classic
      // entity-name lookup flakes on large tenants, and dropping here (before
      // `scanned++`) would remove it from the table and shrink the denominator.
      // Fall back to the raw id, matching the disk engine.
      const resolved = names.get(entityId);
      const name = resolved && resolved !== entityId ? resolved : entityId;

      const cpuStats = seriesStats(series.cpu ?? []);
      const memStats = seriesStats(series.mem ?? []);
      const steal = percentileOf(series.steal ?? [], 95);
      // Absolute memory-used stats (bytes) over the window, mirroring the
      // percentage stats. memUsedPeak (P95) feeds the evidence blob.
      const memBytes = seriesStats(series.memUsed ?? []);
      const memUsedPeak = memBytes?.p95 ?? null;
      const memTotal = pairedMax(series.memUsed ?? [], series.memAvail ?? []);
      const coresInfo = coresMap.get(entityId);
      const pcpu = coresInfo?.physical ?? null;
      const vcpu = coresInfo?.logical ?? null;

      // A host with any CPU/memory data is a real audit candidate, counted
      // whether or not it fires, so nominal = scanned - fired.
      const hasData = cpuStats != null || memStats != null;
      if (hasData) scanned++;

      const memTotalGb = memTotal != null ? memTotal / 1000 ** 3 : null;
      const hc = t.compute.highUsage;
      const lc = t.compute.lowUsage;

      // Per-tier whole-table pCPU + vCPU + memory limit. High and Low each use
      // their own limit, so a host can qualify on one tab but not the other:
      // the tier's conditions (at-capacity included) only fire if it's within
      // that tier's limit.
      const passHigh = blanketPasses(
        pcpu, vcpu, memTotalGb,
        hc.blanketPcpu, hc.blanketVcpu, hc.blanketMem, hc.blanketCombine
      );
      const passLow = blanketPasses(
        pcpu, vcpu, memTotalGb,
        lc.blanketPcpu, lc.blanketVcpu, lc.blanketMem, lc.blanketCombine
      );

      // In scope for the audit = has data + past the host-name rules. The
      // pCPU / vCPU / memory limits (passHigh / passLow) are NOT part of scope;
      // they only gate the findings below, so a host excluded by a limit still
      // counts as in scope.
      const hostInScope =
        hasData && passesNameFilter(filterName(entityId, name), filter.hostNameFilter);
      if (hostInScope) inScope++;

      // Tier-level any/all across the CPU and memory filters
      // (`conditionCombine`): "any" is OR, "all" needs every enabled filter to
      // trip. At-capacity (P95 >= 100) bypasses this tier combine but still
      // requires that metric's own filter to catch the host, so a disabled
      // filter keeps a maxed host off the list.
      const cpuHighActive = cpuStats != null && passHigh && hc.cpu.enabled;
      const cpuHighFired =
        cpuHighActive && cpuStats!.p95 < 100 && computeFilterFires(hc.cpu, cpuStats, "high", steal);
      const memHighActive = memStats != null && passHigh && hc.mem.enabled;
      const memHighFired =
        memHighActive && memStats!.p95 < 100 && computeFilterFires(hc.mem, memStats, "high", null);
      const highOk = combineConditionResults(
        [{ active: cpuHighActive, fired: cpuHighFired }, { active: memHighActive, fired: memHighFired }],
        hc.conditionCombine
      );
      const cpuLowActive = cpuStats != null && passLow && lc.cpu.enabled;
      const cpuLowFired = cpuLowActive && computeFilterFires(lc.cpu, cpuStats, "low", steal);
      const memLowActive = memStats != null && passLow && lc.mem.enabled;
      const memLowFired = memLowActive && computeFilterFires(lc.mem, memStats, "low", null);
      const lowOk = combineConditionResults(
        [{ active: cpuLowActive, fired: cpuLowFired }, { active: memLowActive, fired: memLowFired }],
        lc.conditionCombine
      );

      // Each metric records the tier it fired on plus its reason / rec, and they
      // are reconciled only AFTER the tier-level any/all veto is applied.
      // Reconciling first lets a vetoed high tier discard a legitimate low
      // finding on the other metric (CPU low + memory high promotes to
      // highUsage, then a failing `highOk` nulls both).
      type MetricOutcome = {
        tier: Exclude<Severity, "normal"> | null;
        reason?: string;
        rec?: string;
      };

      let stealIsIssue = false;
      const cpuOutcome: MetricOutcome = { tier: null };
      if (cpuStats != null) {
        // "At capacity" is a maxed host (P95 >= 100) that an *enabled* high CPU
        // condition also catches, so a 100% host surfaces only when some enabled
        // condition (or steal) trips. It outranks the tier match mode below.
        const cpuHighCaught = passHigh && computeFilterFires(hc.cpu, cpuStats, "high", steal);
        if (cpuHighCaught && cpuStats.p95 >= 100) {
          cpuOutcome.tier = "atCapacity";
          cpuOutcome.reason = `CPU at capacity (${cpuStats.p95.toFixed(1)}% P95)`;
          cpuOutcome.rec = "Host CPU is fully saturated; scale out immediately.";
        } else if (cpuHighCaught) {
          cpuOutcome.tier = "highUsage";
          cpuOutcome.reason = `CPU high (${crossedStats(hc.cpu, cpuStats, "high", steal)})`;
          cpuOutcome.rec = "Scale out or move to a larger instance.";
        } else if (passLow && computeFilterFires(lc.cpu, cpuStats, "low", steal)) {
          cpuOutcome.tier = "lowUsage";
          cpuOutcome.reason = `CPU low (${crossedStats(lc.cpu, cpuStats, "low", steal)})`;
          cpuOutcome.rec = "Downsizing or family change is a candidate.";
        }
        // Flag steal as an issue whenever it crossed on the high tier.
        if (
          passHigh &&
          hc.cpu.steal.enabled &&
          steal != null &&
          steal >= hc.cpu.steal.value &&
          cpuStats.p95 < 100
        ) {
          stealIsIssue = true;
        }
      }

      const memOutcome: MetricOutcome = { tier: null };
      if (memStats != null) {
        const memHighCaught = passHigh && computeFilterFires(hc.mem, memStats, "high", null);
        if (memHighCaught && memStats.p95 >= 100) {
          memOutcome.tier = "atCapacity";
          memOutcome.reason = `Memory at capacity (${memStats.p95.toFixed(1)}% P95)`;
          memOutcome.rec = "Memory is fully saturated; OOM is imminent.";
        } else if (memHighCaught) {
          memOutcome.tier = "highUsage";
          memOutcome.reason = `Memory high (${crossedStats(hc.mem, memStats, "high", null)})`;
          memOutcome.rec = "Risk of OOM; scale up.";
        } else if (passLow && computeFilterFires(lc.mem, memStats, "low", null)) {
          memOutcome.tier = "lowUsage";
          memOutcome.reason = `Memory low (${crossedStats(lc.mem, memStats, "low", null)})`;
          memOutcome.rec = "Downsizing or family change is a candidate.";
        }
      }

      // Tier-level any/all, applied PER metric. At capacity bypasses it (its own
      // metric filter already caught the host); high and low each need their own
      // tier combine satisfied. A vetoed tier removes only that metric's finding,
      // so the other metric's still stands. (For the default "any", a no-op.)
      const survives = (tier: MetricOutcome["tier"]): boolean =>
        tier === "atCapacity" ||
        (tier === "highUsage" && highOk) ||
        (tier === "lowUsage" && lowOk);

      const cpuIsIssue = survives(cpuOutcome.tier);
      const memIsIssue = survives(memOutcome.tier);

      let worst: Severity | null = null;
      const reasons: string[] = [];
      const recs: string[] = [];
      // Worst-first so the finding title reflects the most severe surviving
      // outcome.
      const surviving = [cpuOutcome, memOutcome]
        .filter((o) => survives(o.tier))
        .sort((a, b) => SEVERITY_WEIGHT[b.tier!] - SEVERITY_WEIGHT[a.tier!]);
      for (const o of surviving) {
        worst = worsen(worst, o.tier!);
        if (o.reason) reasons.push(o.reason);
        if (o.rec) recs.push(o.rec);
      }

      if (!worst) {
        // In-scope but tripped nothing: a "normal" record for the Normal tab
        // (only when the caller asked; the Overview skips it to stay lean).
        if (!hostInScope || !includeNormal) continue;
        worst = "normal";
        reasons.length = 0;
        recs.length = 0;
      }

      const pctMetric = (label: string, v: number | null, isIssue: boolean) => ({
        label,
        value: v != null ? formatPercent(v, 0) : "—",
        sortValue: v ?? -1,
        isIssue,
      });
      const bytesMetric = (label: string, v: number | null) => ({
        label,
        value: v != null ? formatBytes(v) : "—",
        sortValue: v ?? -1,
        isIssue: memIsIssue,
      });

      const metrics: NonNullable<Finding["metrics"]> = {};
      metrics.cpuMin = pctMetric("CPU min", cpuStats?.min ?? null, cpuIsIssue);
      metrics.cpuAvg = pctMetric("CPU avg", cpuStats?.avg ?? null, cpuIsIssue);
      metrics.cpuP50 = pctMetric("CPU Median", cpuStats?.p50 ?? null, cpuIsIssue);
      metrics.cpu = pctMetric("CPU P95", cpuStats?.p95 ?? null, cpuIsIssue);
      metrics.cpuMax = pctMetric("CPU max", cpuStats?.max ?? null, cpuIsIssue);
      metrics.steal = pctMetric("CPU steal", steal, stealIsIssue);
      // Memory as a share of total (%).
      metrics.memMin = pctMetric("Mem min %", memStats?.min ?? null, memIsIssue);
      metrics.memAvg = pctMetric("Mem avg %", memStats?.avg ?? null, memIsIssue);
      metrics.memP50 = pctMetric("Mem Median %", memStats?.p50 ?? null, memIsIssue);
      metrics.mem = pctMetric("Mem P95 %", memStats?.p95 ?? null, memIsIssue);
      metrics.memMax = pctMetric("Mem max %", memStats?.max ?? null, memIsIssue);
      // Memory in absolute bytes, same five stats. `memUsed` is the P95 key so
      // saved column layouts keep resolving.
      metrics.memMinBytes = bytesMetric("Mem min", memBytes?.min ?? null);
      metrics.memAvgBytes = bytesMetric("Mem avg", memBytes?.avg ?? null);
      metrics.memP50Bytes = bytesMetric("Mem Median", memBytes?.p50 ?? null);
      metrics.memUsed = bytesMetric("Mem P95", memBytes?.p95 ?? null);
      metrics.memMaxBytes = bytesMetric("Mem max", memBytes?.max ?? null);
      if (memTotal != null) metrics.memTotal = { label: "Mem allocated", value: formatBytes(memTotal, 0), sortValue: memTotal, isIssue: true };
      if (pcpu != null) metrics.pcpu = { label: "pCPUs", value: String(pcpu), sortValue: pcpu, isIssue: true };
      if (vcpu != null) metrics.vcpu = { label: "vCPUs", value: String(vcpu), sortValue: vcpu, isIssue: true };

      // A "normal" record tripped nothing, so nothing on it is an issue: clear
      // the per-cell highlight flags (they'd otherwise read as red/bold).
      if (worst === "normal") {
        for (const m of Object.values(metrics)) if (m) m.isIssue = false;
      }

      findings.push({
        id: buildFindingId("compute", entityId, "host"),
        module: "compute",
        ruleId: "host-summary",
        entity: { entityId, displayName: name, entityType: "HOST" },
        severity: worst,
        title: reasons[0] ?? "Compute capacity review",
        // Prescriptive advice is deliberately omitted; the finding shows the
        // facts and leaves the call to action to the reader.
        recommendation: "",
        // Pre-formatted for the details popup, grouped by prefix (cpu_/mem_) so
        // the popup can render CPU and Memory as separate sections. Percentages
        // carry "%", memory is human bytes (GB/TB), not raw bytes.
        evidence: {
          cpu_p95: cpuStats != null ? formatPercent(cpuStats.p95, 1) : "—",
          cpu_max: cpuStats != null ? formatPercent(cpuStats.max, 1) : "—",
          cpu_avg: cpuStats != null ? formatPercent(cpuStats.avg, 1) : "—",
          cpu_steal: steal != null ? formatPercent(steal, 1) : "—",
          cpu_physical: pcpu != null ? String(pcpu) : "—",
          cpu_logical: vcpu != null ? String(vcpu) : "—",
          mem_p95: memStats != null ? formatPercent(memStats.p95, 1) : "—",
          mem_max: memStats != null ? formatPercent(memStats.max, 1) : "—",
          mem_avg: memStats != null ? formatPercent(memStats.avg, 1) : "—",
          mem_used: memUsedPeak != null ? formatBytes(memUsedPeak) : "—",
          mem_allocated: memTotal != null ? formatBytes(memTotal) : "—",
        },
        metrics,
        detectedAt: new Date().toISOString(),
        dataAsOf: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("computeComputeFindings failed", err);
  }
  return {
    findings,
    scanned,
    inScope,
  };
}

// kubernetes
async function computeKubernetesFindings(
  scope: ScopeRef,
  timeframe: TimeframeRange,
  t: Thresholds,
  // Host filter doesn't apply to K8s workload queries (workloads are
  // keyed by cloud_application, not host); accepted to keep the
  // dispatch signature uniform, but ignored.
  _hostFilter?: HostFilter
): Promise<{ findings: Finding[]; notApplicable: boolean }> {
  const findings: Finding[] = [];
  const fromRef = toDqlTimeRef(timeframe.from);
  const toRef = toDqlTimeRef(timeframe.to);

  const selectorScope = scopeToEntitySelector(scope);
  // Probe always uses a 7-day window so a 2-hour view doesn't mark Kubernetes
  // Not applicable when a cluster hasn't ticked in the short window. Cheap
  // classic API call (pageSize 1), so widening costs nothing.
  const probeFrom = "now-7d";
  void timeframe;
  let hasWorkloads = false;
  try {
    const clusters = await monitoredEntitiesClient.getEntities({
      entitySelector: `type("KUBERNETES_CLUSTER")${selectorScope}`,
      from: probeFrom,
      pageSize: 1,
    });
    hasWorkloads = (clusters.entities?.length ?? 0) > 0;
    if (!hasWorkloads) {
      const workloads = await monitoredEntitiesClient.getEntities({
        entitySelector: `type("CLOUD_APPLICATION")${selectorScope}`,
        from: probeFrom,
        pageSize: 1,
      });
      hasWorkloads = (workloads.entities?.length ?? 0) > 0;
    }
  } catch (err) {
    console.warn("Kubernetes probe failed", err);
  }
  if (!hasWorkloads) return { findings: [], notApplicable: true };

  const cpuUsageQuery = `
    timeseries usage = avg(dt.kubernetes.container.cpu_usage), by: { dt.entity.cloud_application }, from: ${fromRef}, to: ${toRef}
    | limit 50000
  `;
  const cpuReqQuery = `
    timeseries req = avg(dt.kubernetes.container.requests_cpu), by: { dt.entity.cloud_application }, from: ${fromRef}, to: ${toRef}
    | limit 50000
  `;
  const memUsageQuery = `
    timeseries usage = avg(dt.kubernetes.container.memory_working_set), by: { dt.entity.cloud_application }, from: ${fromRef}, to: ${toRef}
    | limit 50000
  `;
  const memReqQuery = `
    timeseries req = avg(dt.kubernetes.container.requests_memory), by: { dt.entity.cloud_application }, from: ${fromRef}, to: ${toRef}
    | limit 50000
  `;

  type WorkloadRow = {
    entityId: string;
    cpuUsage?: number;
    cpuReq?: number;
    memUsage?: number;
    memReq?: number;
  };
  const workloads = new Map<string, WorkloadRow>();

  async function runK8s(label: string, query: string, field: string, target: keyof WorkloadRow) {
    try {
      const { records } = await runDqlQuery(query, `k8s:${label}`);
      for (const rec of records) {
        const entityId = rec["dt.entity.cloud_application"] ?? "";
        if (!entityId) continue;
        const value = firstNumber(rec[field]);
        const existing = workloads.get(entityId) ?? { entityId };
        if (value != null) (existing as any)[target] = value;
        workloads.set(entityId, existing);
      }
    } catch (err) {
      console.warn(`[k8s:${label}] query failed`, err);
    }
  }

  await Promise.all([
    runK8s("cpu-usage", cpuUsageQuery, "usage", "cpuUsage"),
    runK8s("cpu-req", cpuReqQuery, "req", "cpuReq"),
    runK8s("mem-usage", memUsageQuery, "usage", "memUsage"),
    runK8s("mem-req", memReqQuery, "req", "memReq"),
  ]);

  if (workloads.size === 0) return { findings: [], notApplicable: false };

  const names = await resolveEntityNames(Array.from(workloads.keys()), timeframe.from);

  for (const { entityId, cpuUsage, cpuReq, memUsage, memReq } of workloads.values()) {
    const resolved = names.get(entityId);
    if (!resolved || resolved === entityId) continue;
    const name = resolved;

    const overcommit = 1 / t.kubernetes.cpuRequestOvercommitRatio;
    const under = t.kubernetes.cpuRequestUnderRatio;

    const cpuRatio =
      cpuUsage != null && cpuReq != null && cpuReq > 0 ? cpuUsage / cpuReq : null;
    let cpuSeverity: Severity | null = null;
    let cpuReason: string | null = null;
    let cpuRec: string | null = null;
    if (cpuRatio != null) {
      if (cpuRatio > under) {
        cpuSeverity = "highUsage";
        cpuReason = `CPU under-requested: ${(cpuRatio * 100).toFixed(0)}% of requests`;
        cpuRec = "Raise CPU requests to avoid throttling.";
      } else if (cpuRatio < overcommit) {
        cpuSeverity = "lowUsage";
        cpuReason = `CPU overcommit: ${(cpuRatio * 100).toFixed(0)}% of requests`;
        cpuRec = "Lower CPU requests to free scheduling capacity.";
      }
    }

    const memRatio =
      memUsage != null && memReq != null && memReq > 0 ? memUsage / memReq : null;
    let memSeverity: Severity | null = null;
    let memReason: string | null = null;
    let memRec: string | null = null;
    if (memRatio != null) {
      if (memRatio > under) {
        memSeverity = "highUsage";
        memReason = `Memory under-requested: ${(memRatio * 100).toFixed(0)}% of requests`;
        memRec = "Risk of OOM kill; raise memory requests and limits.";
      } else if (memRatio < overcommit) {
        memSeverity = "lowUsage";
        memReason = `Memory overcommit: ${(memRatio * 100).toFixed(0)}% of requests`;
        memRec = "Lower memory requests to reclaim node space.";
      }
    }

    if (!cpuSeverity && !memSeverity) continue;

    let severity: Severity | null = null;
    if (cpuSeverity) severity = worsen(severity, cpuSeverity);
    if (memSeverity) severity = worsen(severity, memSeverity);

    const reasons = [cpuReason, memReason].filter(Boolean) as string[];
    const recs = [cpuRec, memRec].filter(Boolean) as string[];

    const metrics: NonNullable<Finding["metrics"]> = {};
    if (cpuRatio != null) {
      metrics.cpu = {
        label: "CPU vs req",
        value: `${(cpuRatio * 100).toFixed(0)}%`,
        sortValue: cpuRatio * 100,
        isIssue: cpuSeverity != null,
      };
    }
    if (memRatio != null) {
      metrics.mem = {
        label: "Mem vs req",
        value: `${(memRatio * 100).toFixed(0)}%`,
        sortValue: memRatio * 100,
        isIssue: memSeverity != null,
      };
    }

    findings.push({
      id: buildFindingId("kubernetes", entityId, "workload"),
      module: "kubernetes",
      ruleId: "workload-summary",
      entity: { entityId, displayName: name, entityType: "CLOUD_APPLICATION" },
      severity: severity!,
      title: reasons[0] ?? "Workload capacity review",
      recommendation: recs.join(" "),
      evidence: {
        cpu_usage_to_request_ratio: cpuRatio != null ? Number(cpuRatio.toFixed(2)) : null,
        mem_usage_to_request_ratio: memRatio != null ? Number(memRatio.toFixed(2)) : null,
      },
      metrics,
      detectedAt: new Date().toISOString(),
      dataAsOf: new Date().toISOString(),
    });
  }
  return { findings, notApplicable: false };
}

// scaling
async function computeScalingFindings(
  scope: ScopeRef,
  timeframe: TimeframeRange,
  _t: Thresholds,
  // ASGs are keyed by their own entity type, not host, so the host filter
  // doesn't apply here. Accepted for signature uniformity.
  _hostFilter?: HostFilter
): Promise<{ findings: Finding[]; notApplicable: boolean }> {
  const findings: Finding[] = [];
  const fromRef = toDqlTimeRef(timeframe.from);
  const toRef = toDqlTimeRef(timeframe.to);

  const selectorScope = scopeToEntitySelector(scope);
  // Same reasoning as the K8s probe: always a 7d window so a 2h view doesn't
  // mark Scaling Not applicable.
  const probeFrom = "now-7d";
  void timeframe;
  try {
    const probe = await monitoredEntitiesClient.getEntities({
      entitySelector: `type("AUTO_SCALING_GROUP")${selectorScope}`,
      from: probeFrom,
      pageSize: 1,
    });
    if (!probe.entities || probe.entities.length === 0) {
      return { findings: [], notApplicable: true };
    }
  } catch (err) {
    console.error("[scaling:probe] failed", err);
    return { findings: [], notApplicable: true };
  }

  const asgQuery = `
    timeseries
      running_min = min(dt.cloud.aws.asg.running),
      running_max = max(dt.cloud.aws.asg.running),
      running_avg = avg(dt.cloud.aws.asg.running),
      by: { dt.entity.auto_scaling_group },
      from: ${fromRef}, to: ${toRef}
    | limit 50000
  `;

  try {
    const { records } = await runDqlQuery(asgQuery, "scaling");
    const asgIds = new Set<string>();
    for (const rec of records) {
      const id = rec["dt.entity.auto_scaling_group"];
      if (typeof id === "string") asgIds.add(id);
    }
    const names = await resolveEntityNames(Array.from(asgIds), timeframe.from);

    for (const rec of records) {
      const entityId = rec["dt.entity.auto_scaling_group"] ?? "unknown";
      if (entityId === "unknown") continue;
      const resolved = names.get(entityId);
      if (!resolved || resolved === entityId) continue;
      const name = resolved;
      const min = firstNumber(rec.running_min);
      const max = firstNumber(rec.running_max);
      const avg = firstNumber(rec.running_avg);
      if (min == null || max == null || avg == null) continue;

      // Flat run: never scaled during the window.
      if (min === max && avg > 0) {
        findings.push({
          id: buildFindingId("scaling", entityId, "flat-run"),
          module: "scaling",
          ruleId: "flat-run",
          entity: { entityId, displayName: name, entityType: "AUTO_SCALING_GROUP" },
          severity: "lowUsage",
          title: "ASG never scaled in this window",
          recommendation: "",
          evidence: {
            running_min: min,
            running_max: max,
            running_avg: Number(avg.toFixed(1)),
          },
          primaryMetric: { label: "Running", value: avg.toFixed(0), sortKey: avg },
          detectedAt: new Date().toISOString(),
          dataAsOf: new Date().toISOString(),
        });
      }

      // Zero floor: scaled all the way down.
      if (min === 0) {
        findings.push({
          id: buildFindingId("scaling", entityId, "zero-floor"),
          module: "scaling",
          ruleId: "zero-floor",
          entity: { entityId, displayName: name, entityType: "AUTO_SCALING_GROUP" },
          severity: "lowUsage",
          title: "ASG scaled to zero",
          recommendation: "",
          evidence: { running_min: min, running_max: max },
          primaryMetric: { label: "Min", value: "0", sortKey: 100 },
          detectedAt: new Date().toISOString(),
          dataAsOf: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error("[scaling] query failed", err);
  }

  return { findings, notApplicable: false };
}

function worsen(current: Severity | null, next: Severity): Severity {
  if (!current) return next;
  return SEVERITY_WEIGHT[next] > SEVERITY_WEIGHT[current] ? next : current;
}

function firstNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) {
    for (const v of input) {
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  return null;
}

async function joinUserState(findings: Finding[]): Promise<Finding[]> {
  const state = await fetchFindingState();
  return findings.map((f) => {
    const s = state.get(f.id);
    if (!s) return f;
    return {
      ...f,
      snoozedUntil: s.snoozedUntil,
      acknowledgedBy: s.acknowledgedBy,
      acknowledgedAt: s.acknowledgedAt,
    };
  });
}
