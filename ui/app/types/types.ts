export type ModuleId = "disk" | "compute" | "kubernetes" | "scaling";

/**
 * Severity tiers, worst to best:
 *   - "atCapacity" → 100% full / saturated (red)
 *   - "highUsage"  → over the configured upper band (orange)
 *   - "lowUsage"   → under the configured lower band (yellow)
 *   - "normal"     → in scope but tripped no threshold (the Normal tab)
 * "normal" is emitted only for the module table when a request asks for it,
 * never cached, and `countBySeverity` skips it, so it never inflates the
 * flagged totals. Legacy persisted values are mapped on read by
 * `normalizeSeverity()` in utils/helpers.
 */
export type Severity = "atCapacity" | "highUsage" | "lowUsage" | "normal";

/** Every module emits this shape; cross-cutting features operate on it. */
export interface Finding {
  /** Stable id: module + entityId + ruleId. */
  id: string;
  module: ModuleId;
  /** Rule that fired, e.g. "disk-fill", "cpu-underutilized", "asg-floor". */
  ruleId: string;

  entity: EntityRef;

  severity: Severity;
  title: string;
  recommendation: string;

  /** Pre-formatted values; the details modal renders them as-is. */
  evidence: Record<string, string | number | boolean | null>;

  /** Legacy single-metric field; prefer `metrics`. */
  primaryMetric?: { label: string; value: string; sortKey: number };

  metrics?: Record<
    string,
    {
      label: string;
      value: string;
      sortValue: number;
      isIssue: boolean;
      /** Render this cell dimmed regardless of tab (e.g. a 0-IOPS disk: a real
       *  value, but "no activity", so it reads de-emphasized). */
      dim?: boolean;
    }
  >;

  /**
   * Resolved custom-column values keyed by tag key (e.g. { "APP-ID": "1234" }).
   * Populated by the tag-column resolver for the custom columns configured on
   * the current module. Absent when no custom columns apply.
   */
  tagValues?: Record<string, string>;

  /** Deep link into native Dynatrace (entity screen, notebook). */
  evidenceLink?: string;

  /** ISO timestamp when the rule fired or was last refreshed. */
  detectedAt: string;
  /** ISO timestamp of the underlying data window end. */
  dataAsOf?: string;

  /** Snooze / acknowledge state; stored in App Settings, joined on read. */
  snoozedUntil?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;

  /**
   * Host liveness (host-keyed modules only). `offline` is set when the
   * owning host hasn't reported within the offline grace window; `offlineForMs`
   * is how long it's been dark. Drives row dimming and the hide-offline filter.
   */
  offline?: boolean;
  offlineForMs?: number;

  /**
   * Shown for context but excluded from every count. Set when a record is worth
   * surfacing (today: a disk at 100% used) yet the active tab's size limit
   * excludes it from being flagged. The row renders dimmed in its severity's
   * tab and is skipped by `countBySeverity` and the table's tab count, so it
   * contributes only to the in-scope population; high + low + normal can
   * therefore total less than the in-scope count.
   */
  limitExcluded?: boolean;
}

export interface EntityRef {
  entityId: string;
  displayName: string;
  /** "HOST" | "DISK" | "CLOUD_APPLICATION" | "AUTO_SCALING_GROUP" | ... */
  entityType: string;
  /** Optional sub-identity (mount path, container name, etc.) */
  qualifier?: string;
  /** Host OS, pre-formatted for display (e.g. "Linux"). Host-keyed modules. */
  os?: string;
  /** Host deployment / cloud provider, pre-formatted (e.g. "AWS (EC2)",
   *  "On-prem / Other"). Host-keyed modules. */
  deployment?: string;
}

// ----------------------------------------------------------------
// Scope
// ----------------------------------------------------------------

export type ScopeMode = "management-zone" | "segment" | "all";

export interface TimeframeRange {
  from: string;
  to: string;
}

export interface ScopeRef {
  mode: ScopeMode;
  /** Empty string when mode === "all". */
  id: string;
  name: string;
}

/**
 * Tag predicate. `values` is an OR-combined multiselect of the tag's values;
 * the sentinel `"*"` (or an empty array) means "all values", surfacing the tag
 * with no value constraint. Different tag keys AND together; values within one
 * key OR together.
 */
export interface TagFilter {
  key: string;
  values: string[];
}

/** Sentinel value in TagFilter.values meaning "all values" (no constraint). */
export const ALL_TAG_VALUES = "*";

/**
 * App-wide host filter applied as an intersection on TOP of the scope
 * (MZ / segment). Translated into a host-entity-id list via Grail
 * `fetch dt.entity.host`, then composed into the metric query as
 * another `| filter in(dt.entity.host, ...)`.
 *
 *   - `tags`       : tag predicates, OR-combined within a tag key.
 *   - `osTypes`    : OS strings (LINUX, WINDOWS, AIX, …). Empty = no OS gate.
 *   - `cloudTypes` : cloud-provider strings (AZURE, EC2,
 *                    GOOGLE_CLOUD_PLATFORM, …) plus the "ON_PREM" sentinel for
 *                    the null/uncategorized bucket. Empty = no cloud gate.
 * The three AND together.
 */
export interface HostFilter {
  /** Manual tag filters (the Tags section). Always applied in scope. */
  tags: TagFilter[];
  /**
   * Value filters set via the Columns section, keyed by the backing tag key.
   * Separate from `tags` so they can be honored per submodule: a column filter
   * applies only where its column is shown, and is ignored where the column is
   * hidden or removed. A tag key lives in EITHER `columnFilters` or `tags`,
   * never both; claiming a column's tag in the Tags section moves it to `tags`
   * and greys the column's picker.
   */
  columnFilters: TagFilter[];
  osTypes: string[];
  cloudTypes: string[];
  /**
   * Whether the selected osTypes are the only ones included (default) or
   * excluded. Nothing selected = no gate either way (everything shown).
   */
  osMode?: "include" | "exclude";
  /** Same include/exclude semantics for cloudTypes. Default include. */
  cloudMode?: "include" | "exclude";
  /**
   * Kubernetes membership gate, orthogonal to the cloud provider: a host runs
   * K8s or not regardless of EC2/Azure/etc. Detected via
   * `softwareTechnologies`. "include" (default) = no gate; "only" = K8s hosts
   * only; "exclude" = drop K8s hosts.
   */
  kubernetes?: "include" | "only" | "exclude";
}

export const EMPTY_HOST_FILTER: HostFilter = {
  tags: [],
  columnFilters: [],
  osTypes: [],
  cloudTypes: [],
  osMode: "include",
  cloudMode: "include",
  kubernetes: "include",
};

/**
 * Everything the Filters menu controls, bundled so it can be scoped as a unit
 * (app / module / view, per `AppSettings.filterScope`). Stored in
 * `AppSettings.filters`, keyed by scope key. `attrs` is the tag / OS /
 * deployment host filter.
 */
export interface FilterBundle {
  hostNameFilter: DiskNameFilter;
  diskNameFilter: DiskNameFilter;
  attrs: HostFilter;
  includeNonProvisioned: boolean;
  excludeStagnantDisks: boolean;
}

export const EMPTY_FILTER_BUNDLE: FilterBundle = {
  hostNameFilter: { mode: "exclude", rules: [] },
  diskNameFilter: { mode: "exclude", rules: [] },
  attrs: EMPTY_HOST_FILTER,
  includeNonProvisioned: false,
  excludeStagnantDisks: false,
};

// ----------------------------------------------------------------
// User-configurable thresholds (per module)
// ----------------------------------------------------------------

export type DiskNameRuleMode = "equals" | "contains" | "startsWith" | "endsWith";

/** Per-rule direction: keep only matches ("include") or drop matches
 *  ("exclude"). Each rule carries its own, so one list can mix both. */
export type DiskNameRuleAction = "include" | "exclude";

export interface DiskNameRule {
  /** Defaults to "exclude". */
  action: DiskNameRuleAction;
  mode: DiskNameRuleMode;
  pattern: string;
}

/**
 * Name-based include/exclude list for disk mount paths / host names. Matching
 * is case-insensitive (e.g. "/var/log"). Each rule is independently an
 * include-only or exclude rule (`DiskNameRule.action`), so a single list can
 * mix both: exclude rules drop matches, and if any include rules exist a row
 * must match one of them.
 */
export interface DiskNameFilter {
  /** @deprecated list-level direction; per-rule `action` supersedes it. Still
   *  the fallback action for a rule that carries none. */
  mode: "exclude" | "include";
  rules: DiskNameRule[];
}

/** Unit applied to a "time-till-full" numeric input. */
export type TimeUnit = "days" | "years";

/** Unit applied to a "disk capacity" numeric input. */
export type SizeUnit = "MB" | "GB" | "TB" | "PB";

/**
 * Shared min/max disk-capacity gate: a condition fires only for disks within
 * the configured size window. Each side carries its own `enabled` flag so a
 * value can be staged in the input without silently filtering rows.
 */
export interface DiskSizeGate {
  minSizeEnabled: boolean;
  minSize: number;
  minSizeUnit: SizeUnit;
  maxSizeEnabled: boolean;
  maxSize: number;
  maxSizeUnit: SizeUnit;
}

/**
 * "By % used" condition. For the high-usage tier the trigger is
 * `current% >= value`; for low-usage it's `current% <= value`.
 */
export interface DiskPercentCondition extends DiskSizeGate {
  enabled: boolean;
  value: number;
}

/**
 * "By time till full" condition. For high-usage the trigger is
 * `projectedDays <= value*unit`; for low-usage it's
 * `projectedDays >= value*unit` (and stable/emptying disks always
 * qualify under low-usage).
 */
export interface DiskDaysCondition extends DiskSizeGate {
  enabled: boolean;
  value: number;
  unit: TimeUnit;
}

/**
 * "By IOPS" filter: a threshold per visible IOPS column (total / read /
 * write × min/avg/median/P95/max), keyed by the metric key ("iops",
 * "iopsReadAvg", …). High-usage fires when a disk is at/above the threshold
 * (busy); low-usage at/below (idle / reclaim candidate). The enabled
 * thresholds combine per `combine`. The UI only surfaces a field for an IOPS
 * metric whose column is currently visible, so the whole block disappears
 * when no IOPS column is shown.
 */
export interface DiskIopsThreshold {
  enabled: boolean;
  value: number;
}
export interface DiskIopsFilter {
  combine: FilterCombine;
  byMetric: Record<string, DiskIopsThreshold>;
}

/**
 * "By daily change" condition: the fill trend's slope in %-points/day
 * (the "Daily Δ%" column). High-usage trigger is `slope >= value`
 * (growing fast); low-usage is `slope <= value` (flat or shrinking, so a
 * negative value is meaningful there). No size gate.
 */
export interface DiskDailyChangeCondition {
  enabled: boolean;
  value: number;
}

export interface DiskTier {
  percent: DiskPercentCondition;
  days: DiskDaysCondition;
  /** Per-IOPS-column thresholds + any/all combine (empty by default). */
  iops: DiskIopsFilter;
  /** Daily fill-change (%-points/day) threshold (off by default). */
  dailyChange: DiskDailyChangeCondition;
  /**
   * How the enabled condition groups (percent / days / IOPS / daily change)
   * combine: match ANY (fire if one trips) or ALL (fire only if every enabled
   * condition trips). Default "any". "At capacity" (100%) is an absolute and
   * ignores this.
   */
  conditionCombine: FilterCombine;
  /** Whole-table disk-size limit, per tab (High and Low independent). A disk
   *  outside the enabled min/max is dropped from THIS tab's findings. */
  blanketSize: DiskSizeGate;
  /** @deprecated superseded by app-wide `Thresholds.excludeStagnantDisks`.
   *  Read only when migrating stored data. */
  excludeStagnant?: boolean;
}

/**
 * How the min/max size / vCPU limits are scoped:
 *   - "all":       one whole-table blanket limit applies to every row;
 *                  the per-condition limits are ignored.
 *   - "perFilter": each condition carries its own limit; no blanket.
 *   - "both":      a row must satisfy the blanket AND the specific
 *                  condition's own limit.
 *   - "none":      no min/max limits at all.
 * Default is "all". Labelled in the UI as Whole table / Per condition /
 * Both / Off.
 */
export type LimitScope = "all" | "perFilter" | "both" | "none";

export interface DiskThresholds {
  highUsage: DiskTier;
  lowUsage: DiskTier;
  /** @deprecated superseded by app-wide `Thresholds.diskNameFilter`. Read only
   *  when migrating stored data. */
  nameFilter?: DiskNameFilter;
  /** @deprecated superseded by app-wide `Thresholds.includeNonProvisioned`. */
  includeNonProvisioned?: boolean;
  /** Legacy; the size limit lives per tier (`DiskTier.blanketSize`). */
  limitScope: LimitScope;
}

/** Min/max vCPU (core count) gate; scopes a compute condition to hosts
 *  of a certain size, mirroring the disk size gate. */
export interface CpuCoreGate {
  minCoresEnabled: boolean;
  minCores: number;
  maxCoresEnabled: boolean;
  maxCores: number;
}

/**
 * One statistic threshold inside a CPU / memory filter. High tier fires
 * `stat >= value`; low tier fires `stat <= value` (steal is always `>=`,
 * high tier only). `enabled` toggles just this stat.
 */
export interface ComputeStatCondition {
  enabled: boolean;
  value: number;
}

/** How a filter's enabled stat conditions combine: match ANY (OR) or ALL
 *  (AND). */
export type FilterCombine = "any" | "all";

/**
 * CPU filter: one master switch plus a threshold per statistic (min, avg,
 * P50, P95, max) and CPU steal. The enabled stats combine per `combine`.
 * Scoped by vCPU count (`CpuCoreGate`, used as the per-filter size limit).
 */
export interface ComputeCpuFilter extends CpuCoreGate {
  enabled: boolean;
  combine: FilterCombine;
  min: ComputeStatCondition;
  avg: ComputeStatCondition;
  p50: ComputeStatCondition;
  p95: ComputeStatCondition;
  max: ComputeStatCondition;
  /** CPU steal (P95 of the steal series). Evaluated on the high tier only. */
  steal: ComputeStatCondition;
}

/**
 * Memory filter: same shape as the CPU filter (min/avg/P50/P95/max) minus
 * steal. Scoped by total memory size (`DiskSizeGate`).
 */
export interface ComputeMemFilter extends DiskSizeGate {
  enabled: boolean;
  combine: FilterCombine;
  min: ComputeStatCondition;
  avg: ComputeStatCondition;
  p50: ComputeStatCondition;
  p95: ComputeStatCondition;
  max: ComputeStatCondition;
}

export interface ComputeTier {
  cpu: ComputeCpuFilter;
  mem: ComputeMemFilter;
  /**
   * How the enabled filters (CPU / memory) combine: match ANY (fire if one
   * trips) or ALL (fire only if every enabled filter trips). Default "any".
   * "At capacity" (P95 >= 100%) is an absolute and ignores this.
   */
  conditionCombine: FilterCombine;
  /** Whole-table pCPU / vCPU / memory limits, per tab (High and Low are
   *  independent). Hosts outside the enabled limits are dropped from THIS
   *  tab's findings; `blanketCombine` sets any/all across the enabled ones. */
  blanketPcpu: CpuCoreGate;
  blanketVcpu: CpuCoreGate;
  blanketMem: DiskSizeGate;
  blanketCombine: FilterCombine;
}

export interface ComputeThresholds {
  highUsage: ComputeTier;
  lowUsage: ComputeTier;
  /** Legacy; the limits live per tier (`ComputeTier.blanket*`). */
  limitScope: LimitScope;
}

export interface KubernetesThresholds {
  /** usage/requests < (1 / this) → low usage (overcommit) */
  cpuRequestOvercommitRatio: number;
  /** usage/requests > this → high usage (under-requested) */
  cpuRequestUnderRatio: number;
  /** Node CPU bin-pack ceiling (%) before high-usage flag */
  nodeCpuPackedPercent: number;
  /** Pending-pod minutes/day before high-usage flag */
  pendingPodMinutesPerDay: number;
}

export interface ScalingThresholds {
  /** ASG floor: min == observed max over X days → over-provisioned */
  flatRunDays: number;
  /** Ceiling hits: hit max more than X times in 30 days → undersized ceiling */
  ceilingHitsPerMonth: number;
  /** Day/night swing ratio above which scheduled scaling is a candidate */
  diurnalSwingRatio: number;
}

export interface Thresholds {
  disk: DiskThresholds;
  compute: ComputeThresholds;
  kubernetes: KubernetesThresholds;
  scaling: ScalingThresholds;
  /**
   * App-wide host-name include/exclude rules. Matches each finding's host
   * (entity) name, and applies on every module page. Part of the Filters menu,
   * so it defines what is in scope.
   */
  hostNameFilter: DiskNameFilter;
  /**
   * App-wide disk mount-path include/exclude rules. A Filters-menu control
   * shown on the disk and Overview pages; non-disk modules ignore it. Defines
   * what disks are in scope.
   */
  diskNameFilter: DiskNameFilter;
  /**
   * App-wide (disk): when false (default) the report hides "non-provisioned"
   * filesystems (pseudo / ephemeral / platform-managed mounts). A Filters-menu
   * control on the disk and Overview pages.
   */
  includeNonProvisioned: boolean;
  /**
   * App-wide (disk): when true, drop disks whose fill trend is flat or
   * declining from scope entirely, on both the high and low views. A
   * Filters-menu control on the disk and Overview pages. Default false.
   */
  excludeStagnantDisks: boolean;
}

// ----------------------------------------------------------------
// User state (snooze / acknowledge)
// ----------------------------------------------------------------

export interface FindingState {
  findingId: string;
  snoozedUntil?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  note?: string;
}

// ----------------------------------------------------------------
// Module summary tile data
// ----------------------------------------------------------------

export interface ModuleSummary {
  module: ModuleId;
  atCapacity: number;
  highUsage: number;
  lowUsage: number;
  total: number;
  dataAsOf?: string;
  notApplicable?: boolean;
}

// ----------------------------------------------------------------
// Shared Overview cache
// ----------------------------------------------------------------
//
// Environment-wide, last-write-wins snapshot of each module's counts.
// Only the *canonical* view is ever recorded (all zones, the default
// timeframe, and no host filter; see isCanonicalOverviewContext) so the
// shared numbers are comparable no matter who last ran a page. The
// Overview then renders instantly from the cache instead of re-querying.
//
// The entry is split into two independently-recordable halves:
//   - the HIGH half  → `atCapacity` + `highUsage` (governed by the high-usage
//     filter), stamped by `highUpdatedAt` / `highDataAsOf`
//   - the LOW half   → `lowUsage` (governed by the low-usage filter), stamped
//     by `lowUpdatedAt` / `lowDataAsOf`
// A side is only written when the user is viewing it with the team-default
// filter for that side, so a person who's customized (say) their low filter
// still refreshes the shared high counts without corrupting the low ones. A
// side whose `*UpdatedAt` is absent has never been recorded.

export interface OverviewCacheEntry {
  atCapacity: number;
  highUsage: number;
  lowUsage: number;
  /** Sum of the recorded sides only (an unrecorded side contributes 0). */
  total: number;
  /**
   * Total records evaluated in the environment for this module (provisioned
   * disks / hosts with data), before threshold filtering. The denominator for
   * the Overview progress bars; `nominal = scanned - total`. Filter-independent
   * (structural), so it's recorded whenever either side is cached.
   */
  scanned?: number;
  /**
   * Records past every non-usage filter (scope + host filter + name rules +
   * size limits), deduped across the two usage tabs. This is the "in scope"
   * denominator shown on the tile footer (`X of {inScope} flagged`). Unlike
   * `scanned` it reflects the active filters, so it's recorded per computed
   * view. Falls back to `scanned` for legacy entries that predate it.
   */
  inScope?: number;
  /**
   * Records surfaced for context but excluded from every count: today, disks
   * at 100% that the High tier's size limit excludes (`Finding.limitExcluded`).
   * They sit inside `inScope` but outside `total`, so the tile must subtract
   * them explicitly; otherwise they silently inflate the "Normal" remainder.
   */
  limitExcluded?: number;
  notApplicable?: boolean;
  /** When the high half (atCapacity + highUsage) was last recorded. */
  highUpdatedAt?: string;
  /** When the low half (lowUsage) was last recorded. */
  lowUpdatedAt?: string;
  /** Data-window freshness of each half (from the findings query). */
  highDataAsOf?: string;
  lowDataAsOf?: string;
  /** When the underlying data was current: the STALEST recorded half, so
   *  the combined tile never overstates freshness. */
  dataAsOf?: string;
  /** When this cache entry was last written (the most recent half). */
  updatedAt: string;
  /** Who triggered the run that produced these counts. */
  updatedBy?: string;
}

export interface OverviewCache {
  modules: Partial<Record<ModuleId, OverviewCacheEntry>>;
}

// ----------------------------------------------------------------
// Generic helpers
// ----------------------------------------------------------------

export interface ManagementZone {
  id: string;
  name: string;
}

export interface Segment {
  id: string;
  name: string;
  description?: string;
}

// ----------------------------------------------------------------
// App-wide settings: host-name preference + custom columns
// ----------------------------------------------------------------

/**
 * Which host name to display. `displayName` (the default) is the tenant's
 * resolved entity name; `detected` is the OneAgent-detected host name (Grail
 * `entity.detected_name`). Only affects host-keyed modules (disk, compute);
 * other entity types always fall back to their display name.
 */
export type HostNameSource = "displayName" | "detected";

/**
 * Discriminated source for a custom column's value. `metadata` (host property /
 * metadata key) is reserved: the model and persisted schema accept it, but no
 * column of that type is produced yet.
 */
export type CustomColumnSourceType = "tag" | "metadata" | "metric";

/**
 * One tag in a tag column's resolution chain: a tag key plus an optional regex
 * to parse its value. The regex uses capture group 1 if present, else the whole
 * match; a non-match is treated as "no value" so resolution falls through to the
 * next entry.
 */
export interface CustomColumnTag {
  key: string;
  regex?: string;
}

export interface CustomColumnSource {
  type: CustomColumnSourceType;
  /** For `type: "tag"`: the primary tag key (kept == `tags[0].key`). */
  tagKey?: string;
  /**
   * For `type: "tag"`: the ordered resolution chain [primary, ...fallbacks].
   * The first entry whose (regex-parsed) value is non-empty wins; if the tag is
   * missing / empty / a placeholder ("null"/"undefined"), the next is tried.
   * Absent (old columns) → treated as `[{ key: tagKey }]`.
   */
  tags?: CustomColumnTag[];
  /** Force the resolved value's case. Undefined = leave as-is. */
  caseTransform?: "upper" | "lower";
  /** Reserved for `type: "metadata"`: the metadata/property key. */
  metadataKey?: string;
  /**
   * For `type: "metric"`: the resolved metric key (a `finding.metrics`
   * key, e.g. "cpuAvg", "memP95", "steal", "iops"). The column renders that
   * already-computed value; no extra query is needed.
   */
  metricKey?: string;
}

/**
 * A user-defined column that surfaces a per-entity value (currently a
 * tag value). Example: label "App" sourced from tag key "APP-ID" shows
 * each host's APP-ID value in an "App" column.
 */
export interface CustomColumn {
  /** Stable id (uuid-ish). Used as the column id in layout ordering. */
  id: string;
  label: string;
  source: CustomColumnSource;
}

/** Usage tab a column layout applies to. Normal (unflagged records) keeps its
 *  own layout, independent of High/Low. */
export type ColumnView = "high" | "low" | "normal";

/**
 * How far a newly added custom column is copied at add time:
 *   - "view":   this view only (this module + tab).
 *   - "module": both usage tabs of this module.
 *   - "app":    every page in the app (both tabs of every module).
 * Each copy is independent afterward.
 */
export type ColumnBroadcast = "view" | "module" | "app";

/** Column order, hidden set, and custom columns for a single usage tab. */
export interface PageColumnView {
  /** Ordered column ids. Ids not present fall to their default slot. */
  order: string[];
  /** Column ids hidden on this tab. */
  hidden: string[];
  /**
   * Columns defined for this view (module + tab). Adding or removing one here
   * does not touch the other tab unless a broadcast option copies it across.
   * Built-ins can't be removed.
   */
  pageCustomColumns: CustomColumn[];
}

/**
 * Per-page (per-module) column layout. Order, show/hide, and the custom-column
 * set are all per usage tab (`high` / `low`), so each tab is fully independent.
 * A column added on one tab reaches the other only through a broadcast option
 * at add time.
 */
export interface PageColumnConfig {
  high: PageColumnView;
  low: PageColumnView;
  /** Optional: older saved layouts have no Normal tab. */
  normal?: PageColumnView;
}

/**
 * Environment-wide app settings, persisted the same way as thresholds
 * (Settings 2.0 with a localStorage fallback). "Global" here means the
 * setting applies across all four module pages, not per-page.
 */
/**
 * How widely the Filters menu applies:
 *   - "app":    one filter used everywhere (the Overview keeps a Filters button).
 *   - "module": filters are shared within a module (its High and Low views) but
 *               independent between modules. Overview Filters button hidden.
 *   - "view":   every usage view (module + tab) keeps its own filter. Overview
 *               Filters button hidden.
 * The Filters menu defines what is in scope at this granularity; thresholds are
 * always per view and never affect scope.
 */
export type FilterScope = "app" | "module" | "view";

/**
 * Timeseries resolution vs. cost tradeoff for live metric queries. Every metric
 * query fits its `interval` to a target bucket count; this picks that target.
 * Fewer buckets means a coarser interval, so queries scan less and run faster
 * at the cost of peak fidelity: P95 / max are smoothed and short spikes can be
 * missed, which matters most for the high / overutilization view. Only live
 * recomputes are affected; cached snapshots are unchanged.
 */
export type DataResolution = "high" | "balanced" | "fast";

export interface AppSettings {
  hostNameSource: HostNameSource;
  /** How widely the Filters menu applies (default "module"). */
  filterScope: FilterScope;
  /**
   * Scoped filter bundles, keyed by scope key ("app", a module id, or
   * `${module}:${view}`). Which key is read/written depends on `filterScope`.
   * A missing key inherits from the broader scope, then from the legacy
   * (pre-scoping) filter, so switching scope never loses the current filter.
   */
  filters: Record<string, FilterBundle>;
  /**
   * Whether snooze / acknowledge (and the associated "notices": the
   * homepage recent-activity card, the Show-snoozed filter, and the
   * details-modal actions) are available at all. Off by default so the
   * app has no snooze surface unless a team opts in.
   */
  snoozeEnabled: boolean;
  /**
   * Look-back window (in days) shared by two things: the disk fill forecast
   * ("Full in" / "Daily Δ%") and the descriptive resource stats (compute
   * min/avg/P50/P95/max/steal and disk IOPS). The page timeframe still decides
   * which entities are visible; this decides how far back the numbers go. The
   * forecast always uses this fixed window (a projection needs a stable
   * baseline); the resource stats use it unless `resourceWindowSync` is on.
   * Default 14.
   */
  windowDays: number;
  /**
   * When on, the resource stats follow the page timeframe instead of the fixed
   * `windowDays`, so they cover exactly the window on screen. Off by default.
   * The forecast is unaffected and always uses `windowDays`.
   */
  resourceWindowSync: boolean;
  /** Timeseries resolution vs. query-cost tradeoff (default "balanced"). */
  dataResolution: DataResolution;
  /**
   * When on (default), a column hidden on the current usage tab also drops
   * its matching field from that tab's filter modal, so the filter only
   * offers what you're actually looking at. Turn off to always show every
   * filter field regardless of which columns are visible.
   */
  hideFilterForHiddenColumns: boolean;
  /**
   * Show the management-zone / scope dropdown ("All hosts" picker) in the table
   * toolbar. **Off by default** (everyone works across all hosts); turn it on to
   * expose the picker for narrowing to a management zone or segment.
   */
  showManagementZoneFilter: boolean;
  /**
   * Drop hosts that aren't currently reporting (offline) from findings. **Off
   * by default**, so offline hosts still show, dimmed with an "offline" badge;
   * turn on to hide them entirely.
   */
  hideOfflineHosts: boolean;
  /** Custom columns shown on every page (removable only in Settings). */
  globalCustomColumns: CustomColumn[];
  /** Per-module column layout (order / hidden / page-only columns). */
  pageColumns: Partial<Record<ModuleId, PageColumnConfig>>;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  hostNameSource: "displayName",
  filterScope: "module",
  filters: {},
  snoozeEnabled: false,
  windowDays: 14,
  resourceWindowSync: false,
  dataResolution: "balanced",
  hideFilterForHiddenColumns: true,
  showManagementZoneFilter: false,
  hideOfflineHosts: false,
  globalCustomColumns: [],
  pageColumns: {},
};
