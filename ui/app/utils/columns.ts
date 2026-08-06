import type {
  AppSettings,
  ColumnView,
  CustomColumn,
  CustomColumnSource,
  FilterBundle,
  ModuleId,
} from "../types/types";

// Column model shared by FindingsTable (builds the real DataTable columns) and
// the per-page Columns modal (reorders / hides them), so the two can't drift.
// Order, hidden state, and the custom-column set are all per usage tab
// (high / low) and per page; each view is independent.

export type ColumnKind = "default" | "page";

export interface ColumnDescriptor {
  /** Stable column id; also the DataTable column id. */
  id: string;
  label: string;
  kind: ColumnKind;
  /** Present for page custom columns. */
  custom?: CustomColumn;
}

export interface MetricColumn {
  key: string;
  /** Header shown in the table (kept short/clean). */
  header: string;
  /**
   * Label shown in the Columns organizer when it needs to be clearer than the
   * table header: the memory %-columns read "Mem avg" in the table but "Mem avg
   * (%)" in the organizer to tell them apart from the byte columns. Falls back
   * to `header`.
   */
  managerLabel?: string;
  /** Minimum pixel width for the (numeric) metric column. */
  width: number;
}

/** Built-in metric columns per module (id suffix + header + width). */
const METRIC_COLUMNS: Record<ModuleId, MetricColumn[]> = {
  disk: [
    { key: "diskUsed", header: "Used %", width: 70 },
    { key: "usedStorage", header: "Used", width: 74 },
    { key: "maxStorage", header: "Allocated", width: 92 },
    { key: "iops", header: "Avg IOPS", width: 88 },
    { key: "growthRate", header: "Daily Δ%", width: 79 },
    { key: "growthBytes", header: "Daily Δ", width: 84 },
    { key: "daysToFull", header: "Full in", width: 64 },
  ],
  // Built-ins are the default-visible set plus pCPUs (hidden). Every other stat
  // (CPU/mem min/P50/max, memory-in-bytes, CPU steal) is added on demand via the
  // Metric custom-column picker; the engine computes them all, so those columns
  // render an existing `metrics` key. cpu/mem keep their P95 keys so older
  // layouts and cached findings still resolve.
  // Widths are the tight-table floors. Under the CPU/Memory group headers the
  // table strips the "CPU "/"Mem " prefix, so these headers render short ("Avg",
  // "P95", "Allocated"); the floors are sized for the stripped header plus a
  // short value ("100%", "1.2 TB"), not the longer managerLabel shown in the
  // Columns menu.
  compute: [
    { key: "cpuAvg", header: "CPU avg", width: 66 },
    { key: "cpu", header: "CPU P95", width: 66 },
    { key: "vcpu", header: "vCPUs", width: 64 },
    { key: "pcpu", header: "pCPUs", width: 64 },
    { key: "memAvg", header: "Mem avg", managerLabel: "Mem avg (%)", width: 66 },
    { key: "mem", header: "Mem P95", managerLabel: "Mem P95 (%)", width: 66 },
    { key: "memTotal", header: "Mem allocated", width: 92 },
  ],
  kubernetes: [
    { key: "cpu", header: "CPU vs req", width: 96 },
    { key: "mem", header: "Mem vs req", width: 96 },
  ],
  scaling: [],
};

export function metricColumnsFor(module: ModuleId): MetricColumn[] {
  return METRIC_COLUMNS[module];
}

/**
 * Minimum pixel width a metric column needs for its *values*, keyed by metric
 * key. Built-ins declare it in METRIC_COLUMNS above; picker-made custom columns
 * look up the same number here, so a custom "CPU min" sizes exactly like the
 * built-in "CPU avg" beside it under the CPU group header, instead of being
 * sized from its own longer, pre-strip label.
 *
 * The families mirror how each value renders: CPU / memory percentages are
 * short ("100%"), core counts shorter still, memory byte stats a little wider
 * ("1.2 TB"), and `memTotal` stays widest of the memory set because its header
 * ("Allocated") is the longest one in that group.
 */
export function metricValueWidth(module: ModuleId, metricKey: string): number {
  const builtIn = METRIC_COLUMNS[module].find((m) => m.key === metricKey);
  if (builtIn) return builtIn.width;
  if (module === "compute") {
    if (metricKey === "pcpu" || metricKey === "vcpu") return 64;
    if (metricKey === "steal" || metricKey.startsWith("cpu")) return 66;
    // Absolute-bytes memory stats (memMinBytes … memUsed) read like "1.2 TB".
    if (metricKey === "memUsed" || metricKey.endsWith("Bytes")) return 84;
    if (metricKey.startsWith("mem")) return 66;
  }
  if (module === "disk" && metricKey.startsWith("iops")) return 88;
  return 72;
}

/**
 * Columns hidden by default, per module and usage tab. Compute leans on
 * peaks for the High tab (P95 + max) and typical load for the Low tab
 * (avg + P50); the rest start hidden and are one toggle away. Other
 * modules show everything on both tabs.
 */
const mCols = (keys: string[]) => keys.map((k) => `metric-${k}`);
const DEFAULT_HIDDEN: Record<ModuleId, Record<ColumnView, string[]>> = {
  // Absolute daily-change (bytes/day) is a companion to "Daily Δ%"; hidden.
  // Normal starts from the same defaults as High/Low.
  disk: {
    high: mCols(["growthBytes"]),
    low: mCols(["growthBytes"]),
    normal: mCols(["growthBytes"]),
  },
  // Only pCPUs starts hidden; every other non-default stat lives in the Metric
  // picker rather than as a hidden built-in.
  compute: { high: mCols(["pcpu"]), low: mCols(["pcpu"]), normal: mCols(["pcpu"]) },
  kubernetes: { high: [], low: [], normal: [] },
  scaling: { high: [], low: [], normal: [] },
};

/** Built-in (non-removable) columns for a module, in default order. */
export function defaultColumnsFor(module: ModuleId): ColumnDescriptor[] {
  const cols: ColumnDescriptor[] = [
    { id: "host", label: "Host", kind: "default" },
  ];
  if (module === "disk") {
    cols.push({ id: "mount", label: "Disk", kind: "default" });
  }
  for (const m of METRIC_COLUMNS[module]) {
    cols.push({
      id: `metric-${m.key}`,
      label: m.managerLabel ?? m.header,
      kind: "default",
    });
  }
  return cols;
}

/** Default column-id order for a module (host → metrics → …). */
export function defaultOrderFor(module: ModuleId): string[] {
  return defaultColumnsFor(module).map((c) => c.id);
}

/** Default hidden column ids for a module + usage tab. */
export function defaultHiddenFor(module: ModuleId, view: ColumnView): string[] {
  return DEFAULT_HIDDEN[module][view];
}

/**
 * The full ordered column set for a module + tab: built-ins + this page's
 * custom columns, arranged by the saved per-tab order. Columns not present
 * in the saved order fall in after the ones that are, in their natural
 * (defaults → page) sequence, so a newly added column shows up at the end
 * until reordered.
 *
 * This does NOT drop hidden columns; the manager needs to list them.
 * Use `hiddenColumnIds` to get the hidden set for the table.
 */
export function resolveColumnsForModule(
  module: ModuleId,
  appSettings: AppSettings,
  view: ColumnView
): ColumnDescriptor[] {
  const defaults = defaultColumnsFor(module);
  const viewCfg = appSettings.pageColumns?.[module]?.[view];
  const pageCustoms: ColumnDescriptor[] = (viewCfg?.pageCustomColumns ?? []).map(
    (c) => ({ id: c.id, label: c.label, kind: "page", custom: c })
  );
  const all = [...defaults, ...pageCustoms];

  const order = viewCfg?.order ?? [];
  const byId = new Map(all.map((c) => [c.id, c]));
  const ordered: ColumnDescriptor[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      ordered.push(c);
      byId.delete(id);
    }
  }
  for (const c of all) if (byId.has(c.id)) ordered.push(c);
  return ordered;
}

export function hiddenColumnIds(
  module: ModuleId,
  appSettings: AppSettings,
  view: ColumnView
): Set<string> {
  const viewCfg = appSettings.pageColumns?.[module]?.[view];
  // A saved tab layout wins (even an empty hidden set = "show everything");
  // otherwise fall back to the sensible per-tab default.
  if (viewCfg) return new Set(viewCfg.hidden);
  return new Set(DEFAULT_HIDDEN[module][view]);
}

/** Tag keys of the custom tag columns currently visible in (module, view). */
export function visibleTagColumnKeys(
  module: ModuleId,
  appSettings: AppSettings,
  view: ColumnView
): Set<string> {
  const hidden = hiddenColumnIds(module, appSettings, view);
  const out = new Set<string>();
  for (const c of resolveColumnsForModule(module, appSettings, view)) {
    const key = c.custom?.source.type === "tag" ? c.custom.source.tagKey : "";
    if (key && !hidden.has(c.id)) out.add(key);
  }
  return out;
}

/**
 * Fold a filter bundle's per-column value filters into `attrs.tags` for one
 * submodule (module + view). A column value filter applies only where its
 * column is visible, and is dropped where the column is hidden or removed;
 * manual tag filters always apply. The engine reads `attrs.tags`, so this is
 * applied when building the fetch filter for a submodule (keeping the engine
 * itself unaware of the column/manual split).
 */
export function resolveSubmoduleFilter(
  bundle: FilterBundle,
  module: ModuleId,
  appSettings: AppSettings,
  view: ColumnView
): FilterBundle {
  const attrs = bundle.attrs;
  const colFilters = attrs.columnFilters ?? [];
  if (colFilters.length === 0) {
    // Nothing to fold; still normalize away the (empty) columnFilters field.
    return { ...bundle, attrs: { ...attrs, columnFilters: [] } };
  }
  const visible = visibleTagColumnKeys(module, appSettings, view);
  const applied = colFilters.filter((t) => visible.has(t.key));
  return {
    ...bundle,
    attrs: {
      ...attrs,
      tags: [...(attrs.tags ?? []), ...applied],
      columnFilters: [],
    },
  };
}

/** Reason a column can't be removed on the page (null = removable). */
export function removalBlockReason(kind: ColumnKind): string | null {
  if (kind === "default") return "Built-in column";
  return null;
}

// ---- Metric grouping (compute's CPU / Memory sections) -------------------

/** Parent section a metric column belongs to on the compute page. */
export type MetricGroup = "cpu" | "mem";

export const METRIC_GROUP_LABEL: Record<MetricGroup, string> = {
  cpu: "CPU",
  mem: "Memory",
};

/**
 * Which section a column belongs to, derived from its metric key. Shared by the
 * findings table (which nests these under "CPU" / "Memory" parent headers) and
 * the Columns menu (which renders them as draggable groups), so the two can't
 * disagree about what belongs where.
 *
 * Membership is derived rather than stored, so a newly added CPU or memory
 * column lands in the right group automatically and a group's members stay
 * contiguous in the saved order without any migration. Non-compute modules
 * have no groups.
 */
export function metricGroupOfColumn(
  module: ModuleId,
  col: Pick<ColumnDescriptor, "id" | "custom">
): MetricGroup | null {
  if (module !== "compute") return null;
  let key: string | null = null;
  if (col.id.startsWith("metric-")) key = col.id.slice("metric-".length);
  else if (col.custom?.source.type === "metric")
    key = col.custom.source.metricKey ?? null;
  if (!key) return null;
  if (key.startsWith("mem")) return "mem";
  if (key.startsWith("cpu") || key === "steal" || key === "pcpu" || key === "vcpu")
    return "cpu";
  return null;
}

// ---- Tag column value resolution (fallbacks + regex + case) --------------

/** The resolution chain [primary, ...fallbacks] for a tag column. */
function tagChain(source: CustomColumnSource): { key: string; regex?: string }[] {
  if (source.tags && source.tags.length > 0) return source.tags;
  return source.tagKey ? [{ key: source.tagKey }] : [];
}

/** Every tag key a tag column needs resolved (primary + fallbacks). */
export function tagColumnKeys(source: CustomColumnSource): string[] {
  return tagChain(source)
    .map((t) => t.key)
    .filter(Boolean);
}

/**
 * Resolve a tag column's display value from a host's raw tag values: walk the
 * fallback chain (first non-empty wins), parse each with its optional regex,
 * and apply the column's case transform. A tag that's missing / empty / a
 * placeholder ("null"/"undefined"), or whose regex doesn't match, is skipped.
 */
export function resolveTagColumnValue(
  source: CustomColumnSource,
  tagValues: Record<string, string> | undefined
): string {
  let out = "";
  for (const spec of tagChain(source)) {
    let raw = (tagValues?.[spec.key] ?? "").trim();
    const low = raw.toLowerCase();
    if (low === "" || low === "null" || low === "undefined") continue;
    if (spec.regex) {
      try {
        const m = new RegExp(spec.regex).exec(raw);
        if (!m) continue; // no match → try the next fallback
        raw = (m[1] ?? m[0]).trim();
      } catch {
        // Invalid regex → ignore it and keep the raw value.
      }
      if (raw === "") continue;
    }
    out = raw;
    break;
  }
  if (out && source.caseTransform === "upper") return out.toUpperCase();
  if (out && source.caseTransform === "lower") return out.toLowerCase();
  return out;
}

// ---- Metric custom-column picker ----------------------------------------
// A "Metric" custom column renders an already-computed `finding.metrics` value.
// The picker composes (metric group + stat + %) into that key; nothing extra is
// queried. Counts (pCPUs/vCPUs) and capacity are excluded since they aren't stats.

export type MetricStat = "min" | "avg" | "p50" | "p95" | "max";

const STAT_LABEL: Record<MetricStat, string> = {
  min: "min", avg: "avg", p50: "median", p95: "P95", max: "max",
};
export const METRIC_STAT_ORDER: MetricStat[] = ["min", "avg", "p50", "p95", "max"];

export interface MetricPickerGroup {
  id: string;
  label: string;
  /** Stats offered; empty = single value (no stat dropdown). */
  stats: MetricStat[];
  /** Whether a "%" toggle applies (memory: bytes vs %). */
  hasPercent: boolean;
  toKey: (stat: MetricStat | null, percent: boolean) => string;
  toLabel: (stat: MetricStat | null, percent: boolean) => string;
}

const CPU_KEY: Record<MetricStat, string> = {
  min: "cpuMin", avg: "cpuAvg", p50: "cpuP50", p95: "cpu", max: "cpuMax",
};
const MEM_PCT_KEY: Record<MetricStat, string> = {
  min: "memMin", avg: "memAvg", p50: "memP50", p95: "mem", max: "memMax",
};
const MEM_BYTES_KEY: Record<MetricStat, string> = {
  min: "memMinBytes", avg: "memAvgBytes", p50: "memP50Bytes", p95: "memUsed", max: "memMaxBytes",
};
// IOPS: total avg reuses the built-in `iops` key so the default column and a
// picker-made "Avg IOPS" resolve to the same value.
const IOPS_TOTAL_KEY: Record<MetricStat, string> = {
  min: "iopsMin", avg: "iops", p50: "iopsP50", p95: "iopsP95", max: "iopsMax",
};
const IOPS_READ_KEY: Record<MetricStat, string> = {
  min: "iopsReadMin", avg: "iopsReadAvg", p50: "iopsReadP50", p95: "iopsReadP95", max: "iopsReadMax",
};
const IOPS_WRITE_KEY: Record<MetricStat, string> = {
  min: "iopsWriteMin", avg: "iopsWriteAvg", p50: "iopsWriteP50", p95: "iopsWriteP95", max: "iopsWriteMax",
};
// Stat-first, capitalized (e.g. "Avg IOPS", "Median read IOPS").
const STAT_CAP: Record<MetricStat, string> = {
  min: "Min", avg: "Avg", p50: "Median", p95: "P95", max: "Max",
};

const METRIC_PICKER: Partial<Record<ModuleId, MetricPickerGroup[]>> = {
  compute: [
    {
      id: "cpu", label: "CPU", stats: METRIC_STAT_ORDER, hasPercent: false,
      toKey: (s) => CPU_KEY[s ?? "p95"],
      toLabel: (s) => `CPU ${STAT_LABEL[s ?? "p95"]}`,
    },
    {
      id: "mem", label: "Memory", stats: METRIC_STAT_ORDER, hasPercent: true,
      toKey: (s, pct) => (pct ? MEM_PCT_KEY : MEM_BYTES_KEY)[s ?? "p95"],
      toLabel: (s, pct) => `Mem ${STAT_LABEL[s ?? "p95"]}${pct ? " %" : ""}`,
    },
    {
      id: "steal", label: "CPU steal", stats: [], hasPercent: false,
      toKey: () => "steal",
      toLabel: () => "CPU steal",
    },
  ],
  disk: [
    {
      id: "iops", label: "IOPS", stats: METRIC_STAT_ORDER, hasPercent: false,
      toKey: (s) => IOPS_TOTAL_KEY[s ?? "avg"],
      toLabel: (s) => `${STAT_CAP[s ?? "avg"]} IOPS`,
    },
    {
      id: "iopsRead", label: "Read IOPS", stats: METRIC_STAT_ORDER, hasPercent: false,
      toKey: (s) => IOPS_READ_KEY[s ?? "avg"],
      toLabel: (s) => `${STAT_CAP[s ?? "avg"]} read IOPS`,
    },
    {
      id: "iopsWrite", label: "Write IOPS", stats: METRIC_STAT_ORDER, hasPercent: false,
      toKey: (s) => IOPS_WRITE_KEY[s ?? "avg"],
      toLabel: (s) => `${STAT_CAP[s ?? "avg"]} write IOPS`,
    },
  ],
};

export function metricPickerGroups(module: ModuleId): MetricPickerGroup[] {
  return METRIC_PICKER[module] ?? [];
}

/** Reverse a metric key back to a picker selection, for the edit form. */
export function metricKeyToSelection(
  module: ModuleId,
  metricKey: string
): { groupId: string; stat: MetricStat | null; percent: boolean } | null {
  for (const g of metricPickerGroups(module)) {
    if (g.stats.length === 0) {
      if (g.toKey(null, false) === metricKey) {
        return { groupId: g.id, stat: null, percent: false };
      }
      continue;
    }
    const pcts = g.hasPercent ? [false, true] : [false];
    for (const s of g.stats) {
      for (const pct of pcts) {
        if (g.toKey(s, pct) === metricKey) {
          return { groupId: g.id, stat: s, percent: pct };
        }
      }
    }
  }
  return null;
}
