import { settingsObjectsClient } from "@dynatrace-sdk/client-classic-environment-v2";
import { getCurrentUserDetails } from "@dynatrace-sdk/app-environment";
import type {
  AppSettings,
  ComputeTier,
  CpuCoreGate,
  CustomColumn,
  CustomColumnTag,
  DiskDaysCondition,
  DiskNameFilter,
  DiskNameRule,
  DiskNameRuleMode,
  DiskPercentCondition,
  DiskSizeGate,
  DiskTier,
  DiskThresholds,
  FilterBundle,
  FilterCombine,
  FindingState,
  HostFilter,
  LimitScope,
  TagFilter,
  ModuleId,
  OverviewCache,
  OverviewCacheEntry,
  PageColumnConfig,
  PageColumnView,
  ScopeRef,
  Severity,
  SizeUnit,
  Thresholds,
  TimeUnit,
} from "../types/types";
import { DEFAULT_APP_SETTINGS } from "../types/types";
import { DEFAULT_THRESHOLDS, SCHEMA_IDS } from "../constants";

// Chunked JSON payload
//
// The registered Settings 2.0 schemas store every config as one `chunks` list
// of text segments rather than a property per field, so the schema stays fixed
// as the config shape evolves. A Settings text value holds at most 5000
// characters, so the serialized JSON is split into <=4000-char pieces and
// rejoined on read. `unpackPayload` also accepts a plain (unchunked) object.

const PAYLOAD_CHUNK_SIZE = 4000;

function packPayload(obj: unknown): Record<string, unknown> {
  const json = JSON.stringify(obj);
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += PAYLOAD_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + PAYLOAD_CHUNK_SIZE));
  }
  return { chunks };
}

function unpackPayload<T>(value: unknown): T | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.chunks)) {
    try {
      return JSON.parse((v.chunks as string[]).join("")) as T;
    } catch {
      return null;
    }
  }
  // Unchunked shape: the value itself is the stored object.
  return value as T;
}

/**
 * Pull the useful bits out of a Settings 2.0 error. The SDK's ResponseError
 * carries the server's validation detail (constraint violations, offending
 * paths) on `body`; the default console print only shows the top message.
 */
function settingsErrorDetail(err: unknown): unknown {
  if (err && typeof err === "object") {
    const anyErr = err as { body?: unknown; response?: unknown };
    if (anyErr.body !== undefined) return anyErr.body;
    if (anyErr.response !== undefined) return anyErr.response;
  }
  return err;
}

const LOCAL_THRESHOLDS_KEY = "capacity-audit:thresholds";

function readLocalThresholds(): Thresholds | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_THRESHOLDS_KEY);
    if (!raw) return null;
    return mergeWithDefaults(JSON.parse(raw) as Partial<Thresholds>);
  } catch {
    return null;
  }
}

function writeLocalThresholds(t: Thresholds): void {
  try {
    window.localStorage.setItem(LOCAL_THRESHOLDS_KEY, JSON.stringify(t));
  } catch {
    /* localStorage disabled (private mode, etc.), silent. */
  }
}

export async function fetchThresholds(): Promise<Thresholds> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.thresholds,
      pageSize: 1,
      fields: "objectId,value",
    });
    const item = response.items?.[0];
    if (item && item.value) {
      const parsed = unpackPayload<Partial<Thresholds>>(item.value);
      if (parsed) return mergeWithDefaults(parsed);
    }
  } catch (err) {
    console.warn(
      "fetchThresholds: settings API unavailable, using localStorage fallback",
      err
    );
  }
  const local = readLocalThresholds();
  if (local) return local;
  return DEFAULT_THRESHOLDS;
}

export async function saveThresholds(t: Thresholds): Promise<void> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.thresholds,
      pageSize: 1,
      fields: "objectId",
    });
    const existing = response.items?.[0];
    if (existing?.objectId) {
      await settingsObjectsClient.putSettingsObjectByObjectId({
        objectId: existing.objectId,
        body: { value: packPayload(t) },
      });
      writeLocalThresholds(t);
      return;
    }
    await settingsObjectsClient.postSettingsObjects({
      body: [
        {
          schemaId: SCHEMA_IDS.thresholds,
          scope: "environment",
          value: packPayload(t),
        },
      ],
    });
    writeLocalThresholds(t);
  } catch (err) {
    console.warn(
      "saveThresholds: settings API unavailable, persisting to localStorage instead",
      err,
      settingsErrorDetail(err)
    );
    writeLocalThresholds(t);
  }
}

// App settings (host-name preference + custom columns + column layout)
//
// Stored like thresholds: environment-scoped Settings 2.0 with a localStorage
// fallback for dev and for tenants where the schema isn't deployed. "Global"
// settings apply across all four module pages.

const LOCAL_APP_SETTINGS_KEY = "capacity-audit:app-settings";

function normalizeCustomColumns(input: unknown): CustomColumn[] {
  if (!Array.isArray(input)) return [];
  const out: CustomColumn[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const label = typeof r.label === "string" ? r.label : "";
    const src = (r.source ?? {}) as Record<string, unknown>;
    const type =
      src.type === "metadata"
        ? "metadata"
        : src.type === "metric"
        ? "metric"
        : "tag";
    if (!id || !label) continue;
    // Tag resolution chain: ordered [primary, ...fallbacks], each { key, regex? }.
    const tags = Array.isArray(src.tags)
      ? (src.tags as unknown[]).reduce<CustomColumnTag[]>((acc, t) => {
          if (t && typeof t === "object") {
            const tr = t as Record<string, unknown>;
            const key = typeof tr.key === "string" ? tr.key : "";
            if (key) {
              const regex =
                typeof tr.regex === "string" && tr.regex.trim() !== ""
                  ? tr.regex
                  : undefined;
              acc.push({ key, regex });
            }
          }
          return acc;
        }, [])
      : undefined;
    const caseTransform =
      src.caseTransform === "upper" || src.caseTransform === "lower"
        ? src.caseTransform
        : undefined;
    out.push({
      id,
      label,
      source: {
        type,
        tagKey: typeof src.tagKey === "string" ? src.tagKey : undefined,
        tags: tags && tags.length > 0 ? tags : undefined,
        caseTransform,
        metadataKey:
          typeof src.metadataKey === "string" ? src.metadataKey : undefined,
        metricKey: typeof src.metricKey === "string" ? src.metricKey : undefined,
      },
    });
  }
  return out;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
}

function normalizePageView(v: unknown): PageColumnView {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    order: strList(r.order),
    hidden: strList(r.hidden),
    pageCustomColumns: normalizeCustomColumns(r.pageCustomColumns),
  };
}

function normalizePageColumns(
  input: unknown
): Partial<Record<ModuleId, PageColumnConfig>> {
  const out: Partial<Record<ModuleId, PageColumnConfig>> = {};
  if (!input || typeof input !== "object") return out;
  for (const [module, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    // Per-view shape carries `high`/`low`/`normal`. Older stored layouts have a
    // single `order`/`hidden` pair, which is copied to both tabs. `normal` is
    // optional and only kept when present.
    const hasPerView = "high" in r || "low" in r || "normal" in r;
    const high = hasPerView ? normalizePageView(r.high) : normalizePageView(r);
    const low = hasPerView ? normalizePageView(r.low) : normalizePageView(r);
    const normal = "normal" in r ? normalizePageView(r.normal) : undefined;
    // Custom columns are per-view. A module-level list from older data seeds
    // any view that carries none; ids match, so order/hidden still resolve.
    const legacyCustoms = normalizeCustomColumns(r.pageCustomColumns);
    if (legacyCustoms.length > 0) {
      if (high.pageCustomColumns.length === 0) high.pageCustomColumns = legacyCustoms;
      if (low.pageCustomColumns.length === 0) {
        low.pageCustomColumns = legacyCustoms.map((c) => ({ ...c }));
      }
    }
    const cfg: PageColumnConfig = { high, low };
    if (normal) cfg.normal = normal;
    out[module as ModuleId] = cfg;
  }
  return out;
}

function mergeAppSettings(partial: Partial<AppSettings> | null | undefined): AppSettings {
  const p = partial ?? {};
  return {
    hostNameSource: p.hostNameSource === "detected" ? "detected" : "displayName",
    filterScope:
      p.filterScope === "app" || p.filterScope === "view"
        ? p.filterScope
        : "module",
    filters: normalizeFilters(p.filters),
    snoozeEnabled: p.snoozeEnabled === true,
    // One look-back window drives both forecast and resource stats; older data
    // split them, so fall back to the resource field, then the forecast one.
    windowDays: (() => {
      const legacy = p as Record<string, unknown>;
      const raw =
        typeof legacy.windowDays === "number"
          ? legacy.windowDays
          : typeof legacy.resourceWindowDays === "number"
          ? legacy.resourceWindowDays
          : typeof legacy.forecastWindowDays === "number"
          ? legacy.forecastWindowDays
          : NaN;
      return Number.isFinite(raw) && raw > 0
        ? Math.min(365, Math.max(1, Math.round(raw)))
        : DEFAULT_APP_SETTINGS.windowDays;
    })(),
    resourceWindowSync: p.resourceWindowSync === true,
    dataResolution:
      p.dataResolution === "high" || p.dataResolution === "fast"
        ? p.dataResolution
        : "balanced",
    hideFilterForHiddenColumns: p.hideFilterForHiddenColumns !== false,
    showManagementZoneFilter: p.showManagementZoneFilter === true,
    hideOfflineHosts: p.hideOfflineHosts === true,
    globalCustomColumns: normalizeCustomColumns(p.globalCustomColumns),
    pageColumns: normalizePageColumns(p.pageColumns),
  };
}

function readLocalAppSettings(): AppSettings | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_APP_SETTINGS_KEY);
    if (!raw) return null;
    return mergeAppSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return null;
  }
}

function writeLocalAppSettings(s: AppSettings): void {
  try {
    window.localStorage.setItem(LOCAL_APP_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* localStorage disabled, silent. */
  }
}

export async function fetchAppSettings(): Promise<AppSettings> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.appSettings,
      pageSize: 1,
      fields: "objectId,value",
    });
    const item = response.items?.[0];
    if (item && item.value) {
      const parsed = unpackPayload<Partial<AppSettings>>(item.value);
      if (parsed) return mergeAppSettings(parsed);
    }
  } catch (err) {
    console.warn(
      "fetchAppSettings: settings API unavailable, using localStorage fallback",
      err
    );
  }
  const local = readLocalAppSettings();
  if (local) return local;
  return DEFAULT_APP_SETTINGS;
}

export async function saveAppSettings(s: AppSettings): Promise<void> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.appSettings,
      pageSize: 1,
      fields: "objectId",
    });
    const existing = response.items?.[0];
    if (existing?.objectId) {
      await settingsObjectsClient.putSettingsObjectByObjectId({
        objectId: existing.objectId,
        body: { value: packPayload(s) },
      });
      writeLocalAppSettings(s);
      return;
    }
    await settingsObjectsClient.postSettingsObjects({
      body: [
        {
          schemaId: SCHEMA_IDS.appSettings,
          scope: "environment",
          value: packPayload(s),
        },
      ],
    });
    writeLocalAppSettings(s);
  } catch (err) {
    console.warn(
      "saveAppSettings: settings API unavailable, persisting to localStorage instead",
      err,
      settingsErrorDetail(err)
    );
    writeLocalAppSettings(s);
  }
}

// Per-user overrides (localStorage, keyed by user email)
//
// `fetchThresholds` / `saveThresholds` and `fetchAppSettings` /
// `saveAppSettings` are the shared team-default layer: one environment-wide
// object each, written only when someone publishes their setup as the team
// default. A per-user override sits on top: the sparse set of fields one
// person changed. What a person sees is deepMerge(teamDefault, override)
// (see utils/merge.ts and ScopeContext).
//
// Overrides live in localStorage keyed by email, so two people sharing a
// browser profile stay separate. Per-browser only, not synced across devices.
// Editing a filter, column, or setting affects only the editor.

export interface UserOverrides {
  /** Sparse subtree of Thresholds the user has personally changed. */
  thresholds?: Partial<Thresholds>;
  /** Sparse subtree of AppSettings the user has personally changed. */
  appSettings?: Partial<AppSettings>;
}

const LOCAL_USER_OVERRIDES_PREFIX = "capacity-audit:user-overrides:";

export function readUserOverrides(email: string): UserOverrides {
  try {
    const raw = window.localStorage.getItem(LOCAL_USER_OVERRIDES_PREFIX + email);
    if (raw) {
      const parsed = JSON.parse(raw) as UserOverrides;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* localStorage disabled / bad JSON, treat as no overrides. */
  }
  return {};
}

export function writeUserOverrides(email: string, overrides: UserOverrides): void {
  try {
    window.localStorage.setItem(
      LOCAL_USER_OVERRIDES_PREFIX + email,
      JSON.stringify(overrides)
    );
  } catch {
    /* localStorage disabled, silent. */
  }
}

/** Normalize a (possibly sparse / legacy) thresholds payload to a full,
 *  migrated Thresholds. Exposed so the context can re-normalize after
 *  merging a user override onto the team default. */
export function normalizeThresholds(partial: Partial<Thresholds>): Thresholds {
  return mergeWithDefaults(partial);
}

/** Same, for AppSettings. */
export function normalizeAppSettings(
  partial: Partial<AppSettings> | null | undefined
): AppSettings {
  return mergeAppSettings(partial);
}

// Disk threshold migration
//
// Stored records come in three shapes:
//   v1 (flat): { criticalFillDays, warningFillDays, criticalOverusedPercent, ... }
//   v2 (tier+mode): { nearCapacity: { mode, percent, days, ... }, highUsage, lowUsage }
//   v3 (current): { highUsage: { percent: {...}, days: {...} }, lowUsage: {...} }
//
// `migrateDiskThresholds` translates v1 and v2 into v3, so the rule engine and
// the modal never branch on shape.

function mergeWithDefaults(partial: Partial<Thresholds>): Thresholds {
  // Disk name rules, non-provisioned, and exclude-non-growing are app-wide
  // Filters-menu controls. Top-level fields win; older records carry them under
  // `disk.nameFilter` / `disk.includeNonProvisioned` /
  // `disk.highUsage.excludeStagnant`.
  const rawDisk = partial.disk as unknown as Record<string, unknown> | undefined;
  const rawHigh = rawDisk?.highUsage as Record<string, unknown> | undefined;
  return {
    disk: migrateDiskThresholds(partial.disk),
    compute: migrateComputeThresholds(partial.compute),
    kubernetes: {
      ...DEFAULT_THRESHOLDS.kubernetes,
      ...(partial.kubernetes ?? {}),
    },
    scaling: { ...DEFAULT_THRESHOLDS.scaling, ...(partial.scaling ?? {}) },
    hostNameFilter: normalizeNameFilter(
      partial.hostNameFilter ?? DEFAULT_THRESHOLDS.hostNameFilter
    ),
    diskNameFilter: normalizeNameFilter(
      partial.diskNameFilter ?? rawDisk?.nameFilter ?? DEFAULT_THRESHOLDS.diskNameFilter
    ),
    includeNonProvisioned:
      typeof partial.includeNonProvisioned === "boolean"
        ? partial.includeNonProvisioned
        : typeof rawDisk?.includeNonProvisioned === "boolean"
        ? (rawDisk.includeNonProvisioned as boolean)
        : DEFAULT_THRESHOLDS.includeNonProvisioned,
    excludeStagnantDisks:
      typeof partial.excludeStagnantDisks === "boolean"
        ? partial.excludeStagnantDisks
        : typeof rawHigh?.excludeStagnant === "boolean"
        ? (rawHigh.excludeStagnant as boolean)
        : DEFAULT_THRESHOLDS.excludeStagnantDisks,
  };
}

// Name filters (host / disk): per-rule include/exclude
//
// Each rule carries its own `action` (include-only / exclude). Older records
// have a single list-level `mode` and no per-rule `action`, so a rule without
// one inherits the list mode.

function normalizeNameFilter(raw: unknown): DiskNameFilter {
  const listMode: "include" | "exclude" =
    raw && typeof raw === "object" && (raw as Record<string, unknown>).mode === "include"
      ? "include"
      : "exclude";
  const rulesIn =
    raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).rules)
      ? ((raw as Record<string, unknown>).rules as unknown[])
      : [];
  const rules: DiskNameRule[] = [];
  for (const item of rulesIn) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const pattern = typeof r.pattern === "string" ? r.pattern : "";
    const mode =
      r.mode === "equals" || r.mode === "contains" || r.mode === "startsWith" || r.mode === "endsWith"
        ? (r.mode as DiskNameRuleMode)
        : ("contains" as DiskNameRuleMode);
    const action: "include" | "exclude" =
      r.action === "include" || r.action === "exclude" ? r.action : listMode;
    rules.push({ action, mode, pattern });
  }
  return { mode: listMode, rules };
}

// Scoped filter bundles (Filters menu)

function normalizeHostFilterAttrs(raw: unknown): HostFilter {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    tags: Array.isArray(a.tags) ? (a.tags as TagFilter[]) : [],
    columnFilters: Array.isArray(a.columnFilters) ? (a.columnFilters as TagFilter[]) : [],
    osTypes: Array.isArray(a.osTypes) ? (a.osTypes as string[]) : [],
    cloudTypes: Array.isArray(a.cloudTypes) ? (a.cloudTypes as string[]) : [],
    osMode: a.osMode === "exclude" ? "exclude" : "include",
    cloudMode: a.cloudMode === "exclude" ? "exclude" : "include",
    kubernetes:
      a.kubernetes === "only"
        ? "only"
        : a.kubernetes === "exclude"
        ? "exclude"
        : "include",
  };
}

function normalizeFilterBundle(raw: unknown): FilterBundle {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    hostNameFilter: normalizeNameFilter(r.hostNameFilter),
    diskNameFilter: normalizeNameFilter(r.diskNameFilter),
    attrs: normalizeHostFilterAttrs(r.attrs),
    includeNonProvisioned: r.includeNonProvisioned === true,
    excludeStagnantDisks: r.excludeStagnantDisks === true,
  };
}

function normalizeFilters(raw: unknown): Record<string, FilterBundle> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, FilterBundle> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = normalizeFilterBundle(val);
  }
  return out;
}

// Size / vCPU limit scope (whole-table blanket vs per-condition)

function coerceLimitScope(raw: unknown): LimitScope | null {
  return raw === "all" || raw === "perFilter" || raw === "both" || raw === "none"
    ? raw
    : null;
}

function mergeSizeGate(def: DiskSizeGate, raw: unknown): DiskSizeGate {
  if (!raw || typeof raw !== "object") return { ...def };
  const r = raw as Record<string, unknown>;
  return {
    minSizeEnabled: typeof r.minSizeEnabled === "boolean" ? r.minSizeEnabled : def.minSizeEnabled,
    minSize: typeof r.minSize === "number" ? r.minSize : def.minSize,
    minSizeUnit: typeof r.minSizeUnit === "string" ? (r.minSizeUnit as SizeUnit) : def.minSizeUnit,
    maxSizeEnabled: typeof r.maxSizeEnabled === "boolean" ? r.maxSizeEnabled : def.maxSizeEnabled,
    maxSize: typeof r.maxSize === "number" ? r.maxSize : def.maxSize,
    maxSizeUnit: typeof r.maxSizeUnit === "string" ? (r.maxSizeUnit as SizeUnit) : def.maxSizeUnit,
  };
}

function mergeCoreGateFull(def: CpuCoreGate, raw: unknown): CpuCoreGate {
  if (!raw || typeof raw !== "object") return { ...def };
  const r = raw as Record<string, unknown>;
  return {
    minCoresEnabled: typeof r.minCoresEnabled === "boolean" ? r.minCoresEnabled : def.minCoresEnabled,
    minCores: typeof r.minCores === "number" ? r.minCores : def.minCores,
    maxCoresEnabled: typeof r.maxCoresEnabled === "boolean" ? r.maxCoresEnabled : def.maxCoresEnabled,
    maxCores: typeof r.maxCores === "number" ? r.maxCores : def.maxCores,
  };
}

// A stored config without `limitScope`: any enabled per-condition gate means
// "perFilter", otherwise "all" (whole-table). A disabled blanket changes
// nothing either way.
function diskLimitExtras(
  src: Record<string, unknown>,
  hu: DiskTier,
  lu: DiskTier
): { limitScope: LimitScope } {
  const gated = (t: DiskTier) =>
    t.percent.minSizeEnabled ||
    t.percent.maxSizeEnabled ||
    t.days.minSizeEnabled ||
    t.days.maxSizeEnabled;
  return {
    limitScope: coerceLimitScope(src.limitScope) ?? (gated(hu) || gated(lu) ? "perFilter" : "all"),
  };
}

function computeLimitExtras(
  src: Record<string, unknown>,
  hu: ComputeTier,
  lu: ComputeTier
): { limitScope: LimitScope } {
  const gated = (t: ComputeTier) =>
    t.cpu.minCoresEnabled ||
    t.cpu.maxCoresEnabled ||
    t.mem.minSizeEnabled ||
    t.mem.maxSizeEnabled;
  return {
    limitScope: coerceLimitScope(src.limitScope) ?? (gated(hu) || gated(lu) ? "perFilter" : "all"),
  };
}

function migrateDiskThresholds(input: unknown): DiskThresholds {
  const def = DEFAULT_THRESHOLDS.disk;
  if (!input || typeof input !== "object") return def;
  const src = input as Record<string, unknown>;

  const hasV3 = (() => {
    const hu = src.highUsage as Record<string, unknown> | undefined;
    const lu = src.lowUsage as Record<string, unknown> | undefined;
    return (
      (hu && typeof hu === "object" && "percent" in hu && typeof hu.percent === "object") ||
      (lu && typeof lu === "object" && "percent" in lu && typeof lu.percent === "object")
    );
  })();
  if (hasV3) {
    const hu = mergeTier(def.highUsage, src.highUsage);
    const lu = mergeTier(def.lowUsage, src.lowUsage);
    return {
      highUsage: hu,
      lowUsage: lu,
      ...diskLimitExtras(src, hu, lu),
    };
  }

  // v2 detection: nearCapacity / highUsage / lowUsage objects that
  // carry a `mode` field (not a nested `percent`/`days` object).
  const hasV2 =
    src.nearCapacity != null || src.highUsage != null || src.lowUsage != null;
  if (hasV2) {
    const hu = tierFromV2(
      def.highUsage,
      (src.nearCapacity as Record<string, unknown>) ?? (src.highUsage as Record<string, unknown>)
    );
    const lu = tierFromV2(def.lowUsage, src.lowUsage as Record<string, unknown>);
    return {
      highUsage: hu,
      lowUsage: lu,
      ...diskLimitExtras(src, hu, lu),
    };
  }

  // v1 flat fields: "near capacity" and "warning" fold into highUsage,
  // "underused" into lowUsage.
  const num = (k: string, fb: number): number =>
    typeof src[k] === "number" && Number.isFinite(src[k]) ? (src[k] as number) : fb;
  const str = <T extends string>(k: string, fb: T): T =>
    typeof src[k] === "string" ? ((src[k] as string) as T) : fb;
  const bool = (k: string, fb: boolean): boolean =>
    typeof src[k] === "boolean" ? (src[k] as boolean) : fb;

  // Widen to `string` so the `=== "days"` check below isn't narrowed
  // away by the literal type of the fallback.
  const overusedMode: string = str("overusedMode", "percent");
  const underusedMode: string = str("underusedMode", "percent");

  const highPercentValue =
    num("criticalOverusedPercent", def.highUsage.percent.value);
  const highDaysValue = num("criticalFillDays", def.highUsage.days.value);
  const highDaysUnit = str("criticalFillUnit", def.highUsage.days.unit);

  const lowPercentValue = num("underutilizedPercent", def.lowUsage.percent.value);
  const lowDaysValue = num("underusedMinFillDays", def.lowUsage.days.value);
  const lowDaysUnit = str("underusedMinFillUnit", def.lowUsage.days.unit);

  return {
    highUsage: {
      percent: {
        enabled: overusedMode === "percent",
        value: highPercentValue,
        minSizeEnabled: bool("overusedMinDiskSizeEnabled", false),
        minSize: num("overusedMinDiskSizeGb", 0),
        minSizeUnit: str<SizeUnit>("overusedMinDiskSizeUnit", "GB"),
        maxSizeEnabled: bool("overusedMaxDiskSizeEnabled", false),
        maxSize: num("overusedMaxDiskSizeGb", 0),
        maxSizeUnit: str<SizeUnit>("overusedMaxDiskSizeUnit", "GB"),
      },
      days: {
        enabled: overusedMode === "days",
        value: highDaysValue,
        unit: highDaysUnit as TimeUnit,
        minSizeEnabled: bool("overusedMinDiskSizeEnabled", false),
        minSize: num("overusedMinDiskSizeGb", 0),
        minSizeUnit: str<SizeUnit>("overusedMinDiskSizeUnit", "GB"),
        maxSizeEnabled: bool("overusedMaxDiskSizeEnabled", false),
        maxSize: num("overusedMaxDiskSizeGb", 0),
        maxSizeUnit: str<SizeUnit>("overusedMaxDiskSizeUnit", "GB"),
      },
      iops: def.highUsage.iops,
      dailyChange: def.highUsage.dailyChange,
      conditionCombine: def.highUsage.conditionCombine,
      blanketSize: { ...def.highUsage.blanketSize },
    },
    lowUsage: {
      percent: {
        enabled: underusedMode === "percent",
        value: lowPercentValue,
        minSizeEnabled: bool("underusedMinDiskSizeEnabled", false),
        minSize: num("underusedMinDiskSizeGb", 0),
        minSizeUnit: str<SizeUnit>("underusedMinDiskSizeUnit", "GB"),
        maxSizeEnabled: bool("underusedMaxDiskSizeEnabled", false),
        maxSize: num("underusedMaxDiskSizeGb", 0),
        maxSizeUnit: str<SizeUnit>("underusedMaxDiskSizeUnit", "GB"),
      },
      days: {
        enabled: underusedMode === "days",
        value: lowDaysValue,
        unit: lowDaysUnit as TimeUnit,
        minSizeEnabled: bool("underusedMinDiskSizeEnabled", false),
        minSize: num("underusedMinDiskSizeGb", 0),
        minSizeUnit: str<SizeUnit>("underusedMinDiskSizeUnit", "GB"),
        maxSizeEnabled: bool("underusedMaxDiskSizeEnabled", false),
        maxSize: num("underusedMaxDiskSizeGb", 0),
        maxSizeUnit: str<SizeUnit>("underusedMaxDiskSizeUnit", "GB"),
      },
      iops: def.lowUsage.iops,
      dailyChange: def.lowUsage.dailyChange,
      conditionCombine: def.lowUsage.conditionCombine,
      blanketSize: { ...def.lowUsage.blanketSize },
    },
    limitScope:
      coerceLimitScope(src.limitScope) ??
      (bool("overusedMinDiskSizeEnabled", false) ||
      bool("overusedMaxDiskSizeEnabled", false) ||
      bool("underusedMinDiskSizeEnabled", false) ||
      bool("underusedMaxDiskSizeEnabled", false)
        ? "perFilter"
        : "all"),
  };
}

function mergeTier(def: DiskTier, raw: unknown): DiskTier {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  return {
    percent: mergePercent(def.percent, r.percent),
    days: mergeDays(def.days, r.days),
    iops: mergeIops(def.iops, r.iops),
    dailyChange: mergeDailyChange(def.dailyChange, r.dailyChange),
    conditionCombine: coerceCombine(r.conditionCombine, def.conditionCombine),
    blanketSize: mergeSizeGate(def.blanketSize, r.blanketSize),
  };
}

function mergeIops(def: DiskTier["iops"], raw: unknown): DiskTier["iops"] {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  // Legacy single-condition { enabled, value } → migrate onto the total-IOPS
  // key ("iops"), keeping the default combine.
  if (!("byMetric" in r) && ("enabled" in r || "value" in r)) {
    const enabled = r.enabled === true;
    const value =
      typeof r.value === "number" && Number.isFinite(r.value)
        ? r.value
        : def.byMetric.iops?.value ?? 0;
    return {
      combine: def.combine,
      byMetric: { ...def.byMetric, iops: { enabled, value } },
    };
  }
  const combine = r.combine === "all" ? "all" : "any";
  const byMetric: DiskTier["iops"]["byMetric"] = {};
  const rawMap =
    r.byMetric && typeof r.byMetric === "object"
      ? (r.byMetric as Record<string, unknown>)
      : {};
  for (const [k, v] of Object.entries(rawMap)) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    byMetric[k] = {
      enabled: c.enabled === true,
      value: typeof c.value === "number" && Number.isFinite(c.value) ? c.value : 0,
    };
  }
  // Keep the total-IOPS field seeded so the Avg IOPS filter can appear.
  if (!byMetric.iops && def.byMetric.iops) byMetric.iops = { ...def.byMetric.iops };
  return { combine, byMetric };
}

function mergeDailyChange(
  def: DiskTier["dailyChange"],
  raw: unknown
): DiskTier["dailyChange"] {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    // Slope can be negative (low tier), so no positivity constraint.
    value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : def.value,
  };
}

function mergePercent(def: DiskPercentCondition, raw: unknown): DiskPercentCondition {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : def.value,
    minSizeEnabled: typeof r.minSizeEnabled === "boolean" ? r.minSizeEnabled : def.minSizeEnabled,
    minSize: typeof r.minSize === "number" ? r.minSize : def.minSize,
    minSizeUnit: typeof r.minSizeUnit === "string" ? (r.minSizeUnit as SizeUnit) : def.minSizeUnit,
    maxSizeEnabled: typeof r.maxSizeEnabled === "boolean" ? r.maxSizeEnabled : def.maxSizeEnabled,
    maxSize: typeof r.maxSize === "number" ? r.maxSize : def.maxSize,
    maxSizeUnit: typeof r.maxSizeUnit === "string" ? (r.maxSizeUnit as SizeUnit) : def.maxSizeUnit,
  };
}

function mergeDays(def: DiskDaysCondition, raw: unknown): DiskDaysCondition {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : def.value,
    unit: typeof r.unit === "string" ? (r.unit as TimeUnit) : def.unit,
    minSizeEnabled: typeof r.minSizeEnabled === "boolean" ? r.minSizeEnabled : def.minSizeEnabled,
    minSize: typeof r.minSize === "number" ? r.minSize : def.minSize,
    minSizeUnit: typeof r.minSizeUnit === "string" ? (r.minSizeUnit as SizeUnit) : def.minSizeUnit,
    maxSizeEnabled: typeof r.maxSizeEnabled === "boolean" ? r.maxSizeEnabled : def.maxSizeEnabled,
    maxSize: typeof r.maxSize === "number" ? r.maxSize : def.maxSize,
    maxSizeUnit: typeof r.maxSizeUnit === "string" ? (r.maxSizeUnit as SizeUnit) : def.maxSizeUnit,
  };
}

function tierFromV2(defaults: DiskTier, raw: unknown): DiskTier {
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Record<string, unknown>;
  const mode = (r.mode as string) ?? "percent";
  const sizeBase = {
    minSizeEnabled: typeof r.minSizeEnabled === "boolean" ? r.minSizeEnabled : false,
    minSize: typeof r.minSize === "number" ? r.minSize : 0,
    minSizeUnit:
      typeof r.minSizeUnit === "string" ? (r.minSizeUnit as SizeUnit) : ("GB" as SizeUnit),
    maxSizeEnabled: typeof r.maxSizeEnabled === "boolean" ? r.maxSizeEnabled : false,
    maxSize: typeof r.maxSize === "number" ? r.maxSize : 0,
    maxSizeUnit:
      typeof r.maxSizeUnit === "string" ? (r.maxSizeUnit as SizeUnit) : ("GB" as SizeUnit),
  };
  return {
    percent: {
      enabled: mode === "percent",
      value:
        typeof r.percent === "number" ? (r.percent as number) : defaults.percent.value,
      ...sizeBase,
    },
    days: {
      enabled: mode === "days",
      value: typeof r.days === "number" ? (r.days as number) : defaults.days.value,
      unit:
        typeof r.daysUnit === "string"
          ? (r.daysUnit as TimeUnit)
          : defaults.days.unit,
      ...sizeBase,
    },
    iops: defaults.iops,
    dailyChange: defaults.dailyChange,
    conditionCombine: defaults.conditionCombine,
    blanketSize: { ...defaults.blanketSize },
  };
}

// Compute threshold migration: CPU / memory stat filters
//
// Current shape: two filters per tier (cpu, mem), each with an `enabled`
// master, a `combine` mode, and a threshold per statistic (min/avg/p50/p95/
// max); cpu also has `steal`. Older records store a single `value` per
// cpu/mem/steal condition; that value migrates to the P95 stat, and a
// standalone `steal` condition folds into `cpu.steal`.

type ComputeTierT = Thresholds["compute"]["highUsage"];
type ComputeCpuFilterT = ComputeTierT["cpu"];
type ComputeMemFilterT = ComputeTierT["mem"];

function coerceCombine(raw: unknown, fb: FilterCombine): FilterCombine {
  return raw === "any" || raw === "all" ? raw : fb;
}

function mergeStat(
  def: { enabled: boolean; value: number },
  raw: unknown
): { enabled: boolean; value: number } {
  if (!raw || typeof raw !== "object") return { ...def };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : def.value,
  };
}

function migrateComputeThresholds(input: unknown): Thresholds["compute"] {
  const def = DEFAULT_THRESHOLDS.compute;
  if (!input || typeof input !== "object") return def;
  const src = input as Record<string, unknown>;

  // Tiered shape: both the single-value and per-stat forms carry `cpu`.
  const huRaw = src.highUsage as Record<string, unknown> | undefined;
  if (huRaw && typeof huRaw === "object" && "cpu" in huRaw) {
    const hu = mergeComputeTier(def.highUsage, src.highUsage);
    const lu = mergeComputeTier(def.lowUsage, src.lowUsage);
    return { highUsage: hu, lowUsage: lu, ...computeLimitExtras(src, hu, lu) };
  }

  // Flat shape: seed each tier's P95 from the flat numbers.
  const num = (k: string, fb: number): number =>
    typeof src[k] === "number" && Number.isFinite(src[k]) ? (src[k] as number) : fb;
  const hu: ComputeTier = {
    cpu: {
      ...def.highUsage.cpu,
      p95: { enabled: true, value: num("cpuHighP95", num("cpuUpsizeCriticalP95", def.highUsage.cpu.p95.value)) },
      steal: { ...def.highUsage.cpu.steal, value: num("cpuStealPercent", def.highUsage.cpu.steal.value) },
    },
    mem: {
      ...def.highUsage.mem,
      p95: { enabled: true, value: num("memHighP95", num("memUpsizeCriticalP95", def.highUsage.mem.p95.value)) },
    },
    conditionCombine: def.highUsage.conditionCombine,
    blanketPcpu: { ...def.highUsage.blanketPcpu },
    blanketVcpu: { ...def.highUsage.blanketVcpu },
    blanketMem: { ...def.highUsage.blanketMem },
    blanketCombine: def.highUsage.blanketCombine,
  };
  const lu: ComputeTier = {
    cpu: {
      ...def.lowUsage.cpu,
      p95: { enabled: true, value: num("cpuLowP95", num("cpuDownsizeP95", def.lowUsage.cpu.p95.value)) },
    },
    mem: {
      ...def.lowUsage.mem,
      p95: { enabled: true, value: num("memLowP95", num("memDownsizeP95", def.lowUsage.mem.p95.value)) },
    },
    conditionCombine: def.lowUsage.conditionCombine,
    blanketPcpu: { ...def.lowUsage.blanketPcpu },
    blanketVcpu: { ...def.lowUsage.blanketVcpu },
    blanketMem: { ...def.lowUsage.blanketMem },
    blanketCombine: def.lowUsage.blanketCombine,
  };
  return { highUsage: hu, lowUsage: lu, ...computeLimitExtras(src, hu, lu) };
}

function mergeComputeTier(def: ComputeTierT, raw: unknown): ComputeTierT {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  let cpu = mergeCpuFilter(def.cpu, r.cpu);
  // Older records keep `steal` as a sibling of cpu/mem; fold it into cpu.steal
  // when the cpu object carries no steal stat of its own. Rebuild rather than
  // mutate (see the copy note in mergeCpuFilter).
  const cpuRaw = (r.cpu ?? {}) as Record<string, unknown>;
  if (!("steal" in cpuRaw) && r.steal && typeof r.steal === "object") {
    cpu = { ...cpu, steal: mergeStat(def.cpu.steal, r.steal) };
  }
  return {
    cpu,
    mem: mergeMemFilter(def.mem, r.mem),
    conditionCombine: coerceCombine(r.conditionCombine, def.conditionCombine),
    // Per-tier whole-table limits (High and Low independent).
    blanketPcpu: mergeCoreGateFull(def.blanketPcpu, r.blanketPcpu),
    // `blanketCores` in older records is the vCPU limit.
    blanketVcpu: mergeCoreGateFull(def.blanketVcpu, r.blanketVcpu ?? r.blanketCores),
    blanketMem: mergeSizeGate(def.blanketMem, r.blanketMem),
    blanketCombine: coerceCombine(r.blanketCombine, def.blanketCombine),
  };
}

function mergeCpuFilter(def: ComputeCpuFilterT, raw: unknown): ComputeCpuFilterT {
  // Return a COPY, never `def` itself: `def` is a live subtree of
  // DEFAULT_THRESHOLDS, and a caller that mutates the result would corrupt the
  // module's defaults for every later fetch.
  if (!raw || typeof raw !== "object") {
    return {
      ...def,
      min: { ...def.min },
      avg: { ...def.avg },
      p50: { ...def.p50 },
      p95: { ...def.p95 },
      max: { ...def.max },
      steal: { ...def.steal },
    };
  }
  const r = raw as Record<string, unknown>;
  // Legacy single-value cpu condition (no per-stat sub-objects) → P95.
  const legacyP95 =
    typeof r.value === "number" && !("p95" in r)
      ? { enabled: r.enabled !== false, value: r.value as number }
      : mergeStat(def.p95, r.p95);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    combine: coerceCombine(r.combine, def.combine),
    min: mergeStat(def.min, r.min),
    avg: mergeStat(def.avg, r.avg),
    p50: mergeStat(def.p50, r.p50),
    p95: legacyP95,
    max: mergeStat(def.max, r.max),
    steal: mergeStat(def.steal, r.steal),
    ...mergeCoreGateFull(def, r),
  };
}

function mergeMemFilter(def: ComputeMemFilterT, raw: unknown): ComputeMemFilterT {
  if (!raw || typeof raw !== "object") return def;
  const r = raw as Record<string, unknown>;
  const legacyP95 =
    typeof r.value === "number" && !("p95" in r)
      ? { enabled: r.enabled !== false, value: r.value as number }
      : mergeStat(def.p95, r.p95);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    combine: coerceCombine(r.combine, def.combine),
    min: mergeStat(def.min, r.min),
    avg: mergeStat(def.avg, r.avg),
    p50: mergeStat(def.p50, r.p50),
    p95: legacyP95,
    max: mergeStat(def.max, r.max),
    ...mergeSizeGate(def, r),
  };
}

// Finding state (snooze / acknowledge)

interface FindingStateRecord extends FindingState {
  __objectId?: string;
}

export async function fetchFindingState(): Promise<Map<string, FindingStateRecord>> {
  const map = new Map<string, FindingStateRecord>();
  async function page(pageKey?: string): Promise<void> {
    try {
      const response = await settingsObjectsClient.getSettingsObjects(
        pageKey
          ? { nextPageKey: pageKey }
          : {
              schemaIds: SCHEMA_IDS.findingState,
              pageSize: 500,
              fields: "objectId,value",
            }
      );
      for (const item of response.items ?? []) {
        const v = item.value as FindingState | undefined;
        if (v?.findingId) {
          map.set(v.findingId, { ...v, __objectId: item.objectId });
        }
      }
      if (response.nextPageKey) await page(response.nextPageKey);
    } catch (err) {
      console.error("fetchFindingState failed", err);
    }
  }
  await page();
  return map;
}

export async function upsertFindingState(state: FindingState): Promise<void> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.findingState,
      pageSize: 500,
      fields: "objectId,value",
    });
    const existing = (response.items ?? []).find(
      (item) => (item.value as FindingState | undefined)?.findingId === state.findingId
    );
    if (existing?.objectId) {
      await settingsObjectsClient.putSettingsObjectByObjectId({
        objectId: existing.objectId,
        body: { value: state as unknown as Record<string, unknown> },
      });
      return;
    }
    await settingsObjectsClient.postSettingsObjects({
      body: [
        {
          schemaId: SCHEMA_IDS.findingState,
          scope: "environment",
          value: state as unknown as Record<string, unknown>,
        },
      ],
    });
  } catch (err) {
    console.error("upsertFindingState failed", err);
    throw err;
  }
}

export async function snoozeFinding(
  findingId: string,
  until: string,
  note?: string
): Promise<void> {
  await upsertFindingState({ findingId, snoozedUntil: until, note });
}

export async function acknowledgeFinding(
  findingId: string,
  note?: string
): Promise<void> {
  const user = await safeGetUserEmail();
  await upsertFindingState({
    findingId,
    acknowledgedBy: user,
    acknowledgedAt: new Date().toISOString(),
    note,
  });
}

export async function clearFindingState(findingId: string): Promise<void> {
  await upsertFindingState({ findingId });
}

// User preferences

export interface UserPreferences {
  userId: string;
  lastScope?: ScopeRef;
  lastTimeframe?: { from: string; to: string };
  /** Last-applied tag/OS/cloud host filter, persisted alongside scope. */
  lastHostFilter?: HostFilter;
  /** Last-applied severity multi-select (At capacity / High usage / Low usage). */
  lastActiveSeverities?: Severity[];
  defaultModule?: string;
}

// The `user-preferences` schema isn't registered (see constants/index.ts), so
// the Settings write below normally 404s and falls back to a per-browser
// localStorage copy keyed by user id (email). The local write happens first so
// view state (scope, timeframe, host filter, severities) survives a reload.
const LOCAL_USER_PREFS_PREFIX = "capacity-audit:user-prefs:";

function readLocalUserPreferences(userId: string): UserPreferences | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_USER_PREFS_PREFIX + userId);
    if (raw) return JSON.parse(raw) as UserPreferences;
  } catch {
    /* ignore */
  }
  return null;
}

function writeLocalUserPreferences(prefs: UserPreferences): void {
  try {
    window.localStorage.setItem(
      LOCAL_USER_PREFS_PREFIX + prefs.userId,
      JSON.stringify(prefs)
    );
  } catch {
    /* ignore */
  }
}

export async function fetchUserPreferences(): Promise<UserPreferences | null> {
  const userId = await safeGetUserEmail();
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.userPreferences,
      pageSize: 500,
      fields: "objectId,value",
    });
    const existing = (response.items ?? []).find(
      (item) => (item.value as UserPreferences | undefined)?.userId === userId
    );
    if (existing) return existing.value as UserPreferences;
  } catch (err) {
    console.warn(
      "fetchUserPreferences: settings API unavailable, using localStorage fallback",
      err
    );
  }
  return readLocalUserPreferences(userId) ?? { userId };
}

export async function saveUserPreferences(prefs: UserPreferences): Promise<void> {
  // Persist locally first so view state survives a reload even when the
  // shared schema isn't registered.
  writeLocalUserPreferences(prefs);
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.userPreferences,
      pageSize: 500,
      fields: "objectId,value",
    });
    const existing = (response.items ?? []).find(
      (item) => (item.value as UserPreferences | undefined)?.userId === prefs.userId
    );
    if (existing?.objectId) {
      await settingsObjectsClient.putSettingsObjectByObjectId({
        objectId: existing.objectId,
        body: { value: prefs as unknown as Record<string, unknown> },
      });
      return;
    }
    await settingsObjectsClient.postSettingsObjects({
      body: [
        {
          schemaId: SCHEMA_IDS.userPreferences,
          scope: "environment",
          value: prefs as unknown as Record<string, unknown>,
        },
      ],
    });
  } catch (err) {
    console.warn(
      "saveUserPreferences: settings API unavailable, persisted to localStorage only",
      err
    );
  }
}

/** Reset a user's stored view-state preferences to bare (just the id), so
 *  nothing personal re-applies on the next load. Used by "Reset all". */
export async function clearUserPreferences(userId: string): Promise<void> {
  await saveUserPreferences({ userId });
}

async function safeGetUserEmail(): Promise<string> {
  try {
    const details = await getCurrentUserDetails();
    return details?.email ?? "anonymous";
  } catch {
    return "anonymous";
  }
}

/** The current user's email (or "anonymous"). Used to key per-user
 *  localStorage (overrides, view-state preferences). */
export async function getUserEmail(): Promise<string> {
  return safeGetUserEmail();
}

/**
 * Whether the current user may write the shared team-default objects, i.e. has
 * `settings:objects:write` on this app's schemas. Server-enforced: a non-admin's
 * write is rejected regardless of what the UI allows. Grant the permission to an
 * admin group with an IAM policy to control who qualifies. Fails closed
 * (returns false) if the permission API is unavailable.
 */
export async function canWriteSharedSettings(): Promise<boolean> {
  try {
    const res = await settingsObjectsClient.resolveEffectivePermissions({
      body: {
        permissions: [
          {
            context: { schemaId: SCHEMA_IDS.thresholds, scope: "environment" },
            permission: "settings:objects:write",
          },
        ],
      },
    });
    // `granted` comes back as either the string "true" or a real boolean,
    // depending on SDK version. Matching only one of them fails closed and
    // silently locks every admin out of publishing, so accept both.
    return (res ?? []).some((p) => {
      if (p.permission !== "settings:objects:write") return false;
      const granted = (p as { granted?: unknown }).granted;
      return granted === true || String(granted).toLowerCase() === "true";
    });
  } catch (err) {
    console.warn(
      "canWriteSharedSettings: permission check failed; treating as non-admin",
      err
    );
    return false;
  }
}

// Org defaults: a team-wide baseline new users inherit
//
// Snapshot of the per-user view state (scope, timeframe, host filter,
// severities) that a user with no saved preferences is seeded from on first
// load. Thresholds and app settings are already environment-shared, so they
// are not duplicated here. Stored environment-wide with a localStorage
// fallback, like thresholds.

const LOCAL_ORG_DEFAULTS_KEY = "capacity-audit:org-defaults";

export interface OrgDefaults {
  updatedBy?: string;
  updatedAt?: string;
  scope?: ScopeRef;
  timeframe?: { from: string; to: string };
  hostFilter?: HostFilter;
  activeSeverities?: Severity[];
}

export async function fetchOrgDefaults(): Promise<OrgDefaults | null> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.orgDefaults,
      pageSize: 1,
      fields: "objectId,value",
    });
    const item = response.items?.[0];
    if (item && item.value) {
      const parsed = unpackPayload<OrgDefaults>(item.value);
      if (parsed) return parsed;
    }
  } catch (err) {
    console.warn(
      "fetchOrgDefaults: settings API unavailable, using localStorage fallback",
      err
    );
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_ORG_DEFAULTS_KEY);
    if (raw) return JSON.parse(raw) as OrgDefaults;
  } catch {
    /* ignore */
  }
  return null;
}

export async function saveOrgDefaults(input: OrgDefaults): Promise<OrgDefaults> {
  const stamped: OrgDefaults = {
    ...input,
    updatedBy: await safeGetUserEmail(),
    updatedAt: new Date().toISOString(),
  };
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.orgDefaults,
      pageSize: 1,
      fields: "objectId",
    });
    const existing = response.items?.[0];
    if (existing?.objectId) {
      await settingsObjectsClient.putSettingsObjectByObjectId({
        objectId: existing.objectId,
        body: { value: packPayload(stamped) },
      });
    } else {
      await settingsObjectsClient.postSettingsObjects({
        body: [
          {
            schemaId: SCHEMA_IDS.orgDefaults,
            scope: "environment",
            value: packPayload(stamped),
          },
        ],
      });
    }
  } catch (err) {
    console.warn(
      "saveOrgDefaults: settings API unavailable, persisting to localStorage instead",
      err,
      settingsErrorDetail(err)
    );
  }
  try {
    window.localStorage.setItem(LOCAL_ORG_DEFAULTS_KEY, JSON.stringify(stamped));
  } catch {
    /* ignore */
  }
  return stamped;
}

// Shared Overview cache
//
// Environment-wide, last-write-wins per module. Module pages call
// writeOverviewCacheEntry after each load; the Overview page reads the whole
// object with fetchOverviewCache instead of re-querying every module.
// Best-effort: a failed persist never blocks the UI, and a localStorage copy
// keeps the Overview useful on tenants where the schema isn't deployed.

const LOCAL_OVERVIEW_CACHE_KEY = "capacity-audit:overview-cache";

/**
 * Back-fill the per-side stamps on entries that carry none. Such an entry
 * recorded all three counts atomically, so both halves are "known" as of its
 * single `updatedAt` / `dataAsOf`.
 */
function normalizeOverviewEntry(e: OverviewCacheEntry): OverviewCacheEntry {
  if (e.highUpdatedAt || e.lowUpdatedAt) return e;
  return {
    ...e,
    highUpdatedAt: e.updatedAt,
    lowUpdatedAt: e.updatedAt,
    highDataAsOf: e.dataAsOf,
    lowDataAsOf: e.dataAsOf,
  };
}

function normalizeOverviewCache(c: OverviewCache): OverviewCache {
  const modules: Partial<Record<ModuleId, OverviewCacheEntry>> = {};
  for (const key of Object.keys(c.modules ?? {}) as ModuleId[]) {
    const v = c.modules[key];
    if (v) modules[key] = normalizeOverviewEntry(v);
  }
  return { modules };
}

function readLocalOverviewCache(): OverviewCache | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_OVERVIEW_CACHE_KEY);
    if (raw) return normalizeOverviewCache(JSON.parse(raw) as OverviewCache);
  } catch {
    /* ignore */
  }
  return null;
}

function writeLocalOverviewCache(c: OverviewCache): void {
  try {
    window.localStorage.setItem(LOCAL_OVERVIEW_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

export async function fetchOverviewCache(): Promise<OverviewCache | null> {
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.overviewCache,
      pageSize: 1,
      fields: "objectId,value",
    });
    const item = response.items?.[0];
    if (item && item.value) {
      const parsed = unpackPayload<OverviewCache>(item.value);
      if (parsed?.modules) return normalizeOverviewCache(parsed);
    }
  } catch (err) {
    console.warn(
      "fetchOverviewCache: settings API unavailable, using localStorage fallback",
      err
    );
  }
  return readLocalOverviewCache();
}

/**
 * Read-modify-write the single shared cache object through a mutator. The
 * mutator receives the current (normalized) cache plus the caller's email and
 * returns the next cache. Two pages writing at once can race; a lost update
 * means one module's count is re-recorded on its next visit.
 */
async function persistOverviewMutate(
  mutate: (base: OverviewCache, user: string) => OverviewCache
): Promise<void> {
  let base: OverviewCache = { modules: {} };
  let objectId: string | undefined;
  try {
    const response = await settingsObjectsClient.getSettingsObjects({
      schemaIds: SCHEMA_IDS.overviewCache,
      pageSize: 1,
      fields: "objectId,value",
    });
    const item = response.items?.[0];
    if (item) {
      objectId = item.objectId;
      const parsed = item.value
        ? unpackPayload<OverviewCache>(item.value)
        : null;
      if (parsed?.modules) base = normalizeOverviewCache(parsed);
    }
  } catch {
    const local = readLocalOverviewCache();
    if (local?.modules) base = local;
  }

  const user = await safeGetUserEmail();
  const next = mutate(base, user);
  writeLocalOverviewCache(next);

  try {
    if (objectId) {
      await settingsObjectsClient.putSettingsObjectByObjectId({
        objectId,
        body: { value: packPayload(next) },
      });
    } else {
      await settingsObjectsClient.postSettingsObjects({
        body: [
          {
            schemaId: SCHEMA_IDS.overviewCache,
            scope: "environment",
            value: packPayload(next),
          },
        ],
      });
    }
  } catch (err) {
    console.warn(
      "persistOverviewMutate: settings API unavailable, cached to localStorage only",
      err,
      settingsErrorDetail(err)
    );
  }
}

/** Merge whole per-module entries over the base (last-write-wins per module). */
async function persistOverviewMerge(
  patch: Partial<Record<ModuleId, OverviewCacheEntry>>
): Promise<void> {
  await persistOverviewMutate((base, user) => {
    const stamped: Partial<Record<ModuleId, OverviewCacheEntry>> = {};
    for (const key of Object.keys(patch) as ModuleId[]) {
      const v = patch[key];
      if (!v) continue;
      stamped[key] = { ...v, updatedBy: v.updatedBy ?? user };
    }
    return { modules: { ...base.modules, ...stamped } };
  });
}

/** Record one module's Overview counts in the shared cache. */
export async function writeOverviewCacheEntry(
  module: ModuleId,
  entry: OverviewCacheEntry
): Promise<void> {
  await persistOverviewMerge({ [module]: entry });
}

/** Record several modules' Overview counts in a single shared write. */
export async function writeOverviewCacheEntries(
  entries: Partial<Record<ModuleId, OverviewCacheEntry>>
): Promise<void> {
  await persistOverviewMerge(entries);
}

/** Counts for one recordable side of a module's overview entry. */
export interface OverviewHighSide {
  atCapacity: number;
  highUsage: number;
  dataAsOf?: string;
}
export interface OverviewLowSide {
  lowUsage: number;
  dataAsOf?: string;
}

/** Pick the earlier (stalest) of two optional ISO timestamps. */
function olderIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
/** Pick the later (freshest) of two optional ISO timestamps. */
function newerIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Record whichever side(s) of a module the caller was allowed to cache. Only
 * the provided halves are overwritten; the untouched half keeps its previous
 * counts and stamps. `total` is recomputed from whichever sides are *known*
 * (have ever been recorded), so an unrecorded side reads as 0 rather than a
 * stale number. Pass `notApplicable` (threshold-independent) to mark the whole
 * module N/A for the scope.
 */
export interface OverviewSideUpdate {
  high?: OverviewHighSide;
  low?: OverviewLowSide;
  /** Record population (denominator for "nominal"). Undefined = keep prior. */
  scanned?: number;
  /** In-scope population (denominator for "X of Y flagged"). Undefined = keep prior. */
  inScope?: number;
  /** Records inside `inScope` but excluded from every severity count. Undefined
   *  = keep prior. */
  limitExcluded?: number;
  notApplicable?: boolean;
  at: string;
}

/** Merge a per-side update onto a module's previous entry. Only provided halves
 *  are overwritten; the untouched half keeps its counts and stamps. */
function mergeSideUpdate(
  prev: OverviewCacheEntry | undefined,
  update: OverviewSideUpdate,
  user: string
): OverviewCacheEntry {
  const atCapacity = update.high ? update.high.atCapacity : prev?.atCapacity ?? 0;
  const highUsage = update.high ? update.high.highUsage : prev?.highUsage ?? 0;
  const lowUsage = update.low ? update.low.lowUsage : prev?.lowUsage ?? 0;
  const scanned = update.scanned !== undefined ? update.scanned : prev?.scanned;
  const inScope = update.inScope !== undefined ? update.inScope : prev?.inScope;
  const limitExcluded =
    update.limitExcluded !== undefined ? update.limitExcluded : prev?.limitExcluded;

  const highUpdatedAt = update.high ? update.at : prev?.highUpdatedAt;
  const lowUpdatedAt = update.low ? update.at : prev?.lowUpdatedAt;
  const highDataAsOf = update.high ? update.high.dataAsOf : prev?.highDataAsOf;
  const lowDataAsOf = update.low ? update.low.dataAsOf : prev?.lowDataAsOf;

  // Total counts only the sides that have ever been recorded.
  const total =
    (highUpdatedAt ? atCapacity + highUsage : 0) + (lowUpdatedAt ? lowUsage : 0);

  return {
    atCapacity,
    highUsage,
    lowUsage,
    total,
    scanned,
    inScope,
    limitExcluded,
    notApplicable:
      update.notApplicable !== undefined ? update.notApplicable : prev?.notApplicable,
    highUpdatedAt,
    lowUpdatedAt,
    highDataAsOf,
    lowDataAsOf,
    dataAsOf: olderIso(
      highUpdatedAt ? highDataAsOf : undefined,
      lowUpdatedAt ? lowDataAsOf : undefined
    ),
    updatedAt: newerIso(highUpdatedAt, lowUpdatedAt) ?? update.at,
    updatedBy: user,
  };
}

export async function writeOverviewCacheSides(
  module: ModuleId,
  update: OverviewSideUpdate
): Promise<void> {
  await persistOverviewMutate((base, user) => ({
    modules: {
      ...base.modules,
      [module]: mergeSideUpdate(base.modules[module], update, user),
    },
  }));
}

// Personal overview cache (per user, localStorage only)
//
// When the personal-overview setting is on, the user's Overview reads and
// writes this per-user cache instead of the shared team object. Same shape and
// normalization as the shared cache, but stored only in localStorage keyed by
// email, like the per-user config overrides.

const LOCAL_PERSONAL_OVERVIEW_PREFIX = "capacity-audit:overview-cache:personal:";

function readLocalPersonalOverviewCache(email: string): OverviewCache | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_PERSONAL_OVERVIEW_PREFIX + email);
    if (raw) return normalizeOverviewCache(JSON.parse(raw) as OverviewCache);
  } catch {
    /* localStorage disabled / bad JSON, treat as no cache. */
  }
  return null;
}

function writeLocalPersonalOverviewCache(email: string, c: OverviewCache): void {
  try {
    window.localStorage.setItem(
      LOCAL_PERSONAL_OVERVIEW_PREFIX + email,
      JSON.stringify(c)
    );
  } catch {
    /* localStorage disabled, silent. */
  }
}

export async function fetchPersonalOverviewCache(): Promise<OverviewCache | null> {
  const email = await safeGetUserEmail();
  return readLocalPersonalOverviewCache(email);
}

/** Mirror of writeOverviewCacheSides for a submodule the user has
 *  personalized: same per-side merge, localStorage only, keyed by email. */
export async function writePersonalOverviewCacheSides(
  module: ModuleId,
  update: OverviewSideUpdate
): Promise<void> {
  const email = await safeGetUserEmail();
  const base = readLocalPersonalOverviewCache(email) ?? { modules: {} };
  const entry = mergeSideUpdate(base.modules[module], update, email);
  writeLocalPersonalOverviewCache(email, {
    modules: { ...base.modules, [module]: entry },
  });
}

/** Merge per-module entries into the current user's personal overview cache. */
export async function writePersonalOverviewCacheEntries(
  entries: Partial<Record<ModuleId, OverviewCacheEntry>>
): Promise<void> {
  const email = await safeGetUserEmail();
  const base = readLocalPersonalOverviewCache(email) ?? { modules: {} };
  const stamped: Partial<Record<ModuleId, OverviewCacheEntry>> = {};
  for (const key of Object.keys(entries) as ModuleId[]) {
    const v = entries[key];
    if (v) stamped[key] = { ...v, updatedBy: v.updatedBy ?? email };
  }
  writeLocalPersonalOverviewCache(email, {
    modules: { ...base.modules, ...stamped },
  });
}
