import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDiscardModal } from "./ConfirmDiscardModal";
import { Modal } from "@dynatrace/strato-components-preview/overlays";
import {
  FormField,
  Label,
  Select,
  Switch,
  TextInput,
  ToggleButtonGroup,
} from "@dynatrace/strato-components-preview/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Tab, Tabs } from "@dynatrace/strato-components/navigation";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import type {
  ComputeCpuFilter,
  ComputeMemFilter,
  ComputeStatCondition,
  ComputeThresholds,
  ComputeTier,
  CpuCoreGate,
  DiskDailyChangeCondition,
  DiskDaysCondition,
  DiskIopsFilter,
  DiskIopsThreshold,
  DiskNameFilter,
  DiskNameRule,
  DiskNameRuleAction,
  DiskNameRuleMode,
  DiskPercentCondition,
  DiskSizeGate,
  DiskTier,
  DiskThresholds,
  FilterBundle,
  FilterCombine,
  HostFilter,
  ModuleId,
  Severity,
  SizeUnit,
  Thresholds,
  TimeUnit,
} from "../types/types";
import { EMPTY_FILTER_BUNDLE } from "../types/types";
import { PlusIcon, DeleteIcon } from "@dynatrace/strato-icons";
import { DEFAULT_THRESHOLDS } from "../constants/thresholds";
import { MODULE_BY_ID } from "../constants/modules";
import { fetchOverviewCache } from "../api/api";
import { SeverityBadge } from "./SeverityBadge";
import { HostFilterFields } from "./HostFilterButton";
import { hiddenColumnIds, resolveColumnsForModule } from "../utils/columns";
import { useScope } from "../contexts/ScopeContext";

/**
 * Tier-based filter editor. "At capacity" is hardcoded at 100% with no knobs.
 * High usage and Low usage each carry independent conditions with their own
 * enable toggle and threshold. Non-disk modules use a simpler list inside the
 * same tier structure.
 */

type DiskTierKey = "highUsage" | "lowUsage";

interface DiskTierDef {
  key: DiskTierKey;
  severity: Severity;
  label: string;
  description: string;
  percentVerb: string;
  daysVerb: string;
  iopsVerb: string;
  dailyChangeVerb: string;
}

const DISK_TIERS: DiskTierDef[] = [
  {
    key: "highUsage",
    severity: "highUsage",
    label: "High usage",
    description: "Volumes low on space now or filling up soon.",
    percentVerb: "Trigger when % used is at or above",
    daysVerb: "Trigger when projected time-to-full is at or under",
    iopsVerb: "Trigger when IOPS (read+write) is at or above",
    dailyChangeVerb: "Trigger when daily change is at or above",
  },
  {
    key: "lowUsage",
    severity: "lowUsage",
    label: "Low usage",
    description: "Volumes you can reclaim: nearly empty or barely growing.",
    percentVerb: "Trigger when % used is at or below",
    daysVerb: "Trigger when projected time-to-full is at or above",
    iopsVerb: "Trigger when IOPS (read+write) is at or below",
    dailyChangeVerb: "Trigger when daily change is at or below",
  },
];

type ComputeTierKey = "highUsage" | "lowUsage";

interface ComputeTierDef {
  key: ComputeTierKey;
  severity: Severity;
  label: string;
  description: string;
  cpuVerb: string;
  memVerb: string;
}

const COMPUTE_TIERS: ComputeTierDef[] = [
  {
    key: "highUsage",
    severity: "highUsage",
    label: "High usage",
    description: "Hosts running hot and at risk of saturation.",
    cpuVerb: "Trigger when CPU P95 is at or above",
    memVerb: "Trigger when memory P95 is at or above",
  },
  {
    key: "lowUsage",
    severity: "lowUsage",
    label: "Low usage",
    description: "Hosts sitting mostly idle that could be downsized.",
    cpuVerb: "Trigger when CPU P95 is at or below",
    memVerb: "Trigger when memory P95 is at or below",
  },
];

interface KubernetesTierDef {
  severity: Severity;
  label: string;
  description: string;
  fields: Array<{
    key: keyof Thresholds["kubernetes"];
    label: string;
    suffix?: string;
  }>;
}

const KUBERNETES_TIERS: KubernetesTierDef[] = [
  {
    severity: "highUsage",
    label: "High usage",
    description:
      "Workloads using far more than they requested, risking throttling or OOM.",
    fields: [
      { key: "cpuRequestUnderRatio", label: "Under-request ratio (usage / requests above)" },
      { key: "nodeCpuPackedPercent", label: "Node CPU bin-pack ceiling", suffix: "%" },
      { key: "pendingPodMinutesPerDay", label: "Pending-pod minutes per day", suffix: "min" },
    ],
  },
  {
    severity: "lowUsage",
    label: "Low usage",
    description:
      "Workloads reserving far more than they use, so requests can be trimmed.",
    fields: [
      { key: "cpuRequestOvercommitRatio", label: "Overcommit ratio (requests / usage above)" },
    ],
  },
];

const SCALING_FIELDS: Array<{
  key: keyof Thresholds["scaling"];
  label: string;
  suffix?: string;
}> = [
  { key: "flatRunDays", label: "Flat-run window", suffix: "d" },
  { key: "ceilingHitsPerMonth", label: "Ceiling hits per month" },
  { key: "diurnalSwingRatio", label: "Day / night swing ratio" },
];

const SIZE_UNITS: Array<{ value: SizeUnit; label: string }> = [
  { value: "MB", label: "MB" },
  { value: "GB", label: "GB" },
  { value: "TB", label: "TB" },
  { value: "PB", label: "PB" },
];

const TIME_UNITS: Array<{ value: TimeUnit; label: string }> = [
  { value: "days", label: "days" },
  { value: "years", label: "years" },
];

const RULE_MODES: Array<{ value: DiskNameRuleMode; label: string }> = [
  { value: "equals", label: "Equals" },
  { value: "contains", label: "Contains" },
  { value: "startsWith", label: "Starts with" },
  { value: "endsWith", label: "Ends with" },
];

// Per-rule direction. Exclude is the default for a new rule.
const NAME_RULE_ACTIONS: Array<{ value: DiskNameRuleAction; label: string }> = [
  { value: "exclude", label: "Exclude" },
  { value: "include", label: "Include only" },
];

// CPU / memory statistic fields shared by both filters (steal is CPU-only,
// rendered separately on the high tier).
type MemStatKey = "min" | "avg" | "p50" | "p95" | "max";
type CpuStatKey = MemStatKey | "steal";
const COMPUTE_STATS: Array<{ key: MemStatKey; label: string }> = [
  { key: "min", label: "Min" },
  { key: "avg", label: "Avg" },
  { key: "p50", label: "Median" },
  { key: "p95", label: "P95" },
  { key: "max", label: "Max" },
];

// The table column each filter field corresponds to; a hidden column drops its
// filter field (the "Filter fields" app setting).
const CPU_STAT_COLUMN: Record<CpuStatKey, string> = {
  min: "metric-cpuMin",
  avg: "metric-cpuAvg",
  p50: "metric-cpuP50",
  p95: "metric-cpu",
  max: "metric-cpuMax",
  steal: "metric-steal",
};
const MEM_STAT_COLUMN: Record<MemStatKey, string> = {
  min: "metric-memMin",
  avg: "metric-memAvg",
  p50: "metric-memP50",
  p95: "metric-mem",
  max: "metric-memMax",
};
const DISK_CONDITION_COLUMN = {
  percent: "metric-diskUsed",
  days: "metric-daysToFull",
  iops: "metric-iops",
  dailyChange: "metric-growthRate",
} as const;
// Whole-table size/core limits map to columns too, so a hidden column drops its
// limit editor (same coupling as the conditions).
const LIMIT_COLUMN = {
  pcpu: "metric-pcpu",
  vcpu: "metric-vcpu",
  mem: "metric-memTotal",
  diskSize: "metric-maxStorage",
} as const;

export interface ThresholdSettingsModalProps {
  module: ModuleId;
  open: boolean;
  onClose: () => void;
  onSaved?: (t: Thresholds) => void;
  /** Which usage view the page is in; the filter shows only that tier. */
  usageView: "high" | "low";
  /** Switch the page's High/Low usage view (also flips the table behind). */
  onUsageViewChange?: (next: "high" | "low") => void;
  showSnoozed: boolean;
  onShowSnoozedChange: (next: boolean) => void;
  /** Current in-scope count for the scope summary. */
  inScopeEither?: number;
  /**
   * Which dialog this is. "thresholds" (default) = usage conditions, size /
   * vCPU limits, and column value filters for the current module and tab.
   * "filters" = the app-wide scope controls (host + disk name rules, tags, OS,
   * deployment, other filters) that define what is in scope.
   */
  variant?: "thresholds" | "filters";
  /**
   * Rendered from the Overview (no single module). Only meaningful for the
   * filters variant: it shows the disk-specific filter sections even though
   * there is no active disk page.
   */
  isOverview?: boolean;
}

export const ThresholdSettingsModal = ({
  module,
  open,
  onClose,
  onSaved,
  usageView,
  onUsageViewChange,
  showSnoozed,
  onShowSnoozedChange,
  inScopeEither,
  variant = "thresholds",
  isOverview = false,
}: ThresholdSettingsModalProps) => {
  const isFilters = variant === "filters";
  // Disk-only filter sections (disk name rules, non-provisioned, exclude
  // non-growing) show on the disk page and on the Overview (which covers disk),
  // never on compute.
  const showDiskFilters = module === "disk" || isOverview;
  const {
    appSettings,
    thresholds: effectiveThresholds,
    setThresholds,
    resetModuleThresholds,
    filterFor,
    setFilterFor,
  } = useScope();
  const targetSeverity: Severity =
    usageView === "low" ? "lowUsage" : "highUsage";
  const [values, setValues] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  // The whole Filters bundle (name rules, tag / OS / deployment attrs, disk
  // toggles) is staged here and committed to the resolved scope key on Save, so
  // nothing in this dialog applies live except the High/Low view toggle.
  const [filterDraft, setFilterDraft] =
    useState<FilterBundle>(EMPTY_FILTER_BUNDLE);
  const patchFilter = (patch: Partial<FilterBundle>) =>
    setFilterDraft((prev) => ({ ...prev, ...patch }));

  // In per-view scope each side owns an independent bundle, so the outgoing
  // draft is committed before switching (the reseed effect loads the other
  // side). In app/module scope the bundle is shared and the draft stays put.
  const switchFilterView = (next: "high" | "low") => {
    if (next === usageView) return;
    if (appSettings.filterScope === "view") {
      setFilterFor(module, usageView, filterDraft);
    }
    onUsageViewChange?.(next);
  };
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const seedValues = useRef("");
  const seedFilter = useRef("");
  const [error, setError] = useState<string | null>(null);
  // Whole-environment population for this module, read from the Overview
  // cache's unfiltered snapshot. Powers the "of N total" hint.
  const [envTotal, setEnvTotal] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchOverviewCache().then((c) => {
      if (alive) setEnvTotal(c?.modules?.[module]?.scanned);
    });
    return () => {
      alive = false;
    };
  }, [open, module]);
  const recordNoun = MODULE_BY_ID[module].recordNoun;

  // Seed the editor from the effective thresholds (team default plus this
  // user's overrides), which the context already holds.
  useEffect(() => {
    if (!open) return;
    setError(null);
    const seedFilterBundle = filterFor(module, usageView);
    setValues(effectiveThresholds);
    setFilterDraft(seedFilterBundle);
    seedValues.current = JSON.stringify(effectiveThresholds);
    seedFilter.current = JSON.stringify(seedFilterBundle);
    setConfirmDiscard(false);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Per-view scope only: reload the draft when the high/low tab flips (the
  // open-seed handles the first load). switchFilterView commits the outgoing
  // view first, so in-progress edits survive.
  useEffect(() => {
    if (!open || !isFilters) return;
    if (appSettings.filterScope !== "view") return;
    const next = filterFor(module, usageView);
    setFilterDraft(next);
    seedFilter.current = JSON.stringify(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageView]);

  const updateModuleField = (key: string, value: unknown) => {
    setValues((prev) => ({
      ...prev,
      [module]: { ...(prev[module] as unknown as Record<string, unknown>), [key]: value },
    }));
  };
  const updateNumericModuleField = (key: string, value: string) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    updateModuleField(key, num);
  };
  // CPU / memory filter updates: whole-filter patches (enable, combine, gate),
  // then per-stat conditions.
  const updateComputeCpuFilter = (tier: ComputeTierKey, patch: Partial<ComputeCpuFilter>) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [tier]: { ...prev.compute[tier], cpu: { ...prev.compute[tier].cpu, ...patch } },
      },
    }));
  const updateComputeMemFilter = (tier: ComputeTierKey, patch: Partial<ComputeMemFilter>) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [tier]: { ...prev.compute[tier], mem: { ...prev.compute[tier].mem, ...patch } },
      },
    }));
  const updateComputeCpuStat = (
    tier: ComputeTierKey,
    stat: CpuStatKey,
    patch: Partial<ComputeStatCondition>
  ) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [tier]: {
          ...prev.compute[tier],
          cpu: {
            ...prev.compute[tier].cpu,
            [stat]: { ...prev.compute[tier].cpu[stat], ...patch },
          },
        },
      },
    }));
  const updateComputeMemStat = (
    tier: ComputeTierKey,
    stat: MemStatKey,
    patch: Partial<ComputeStatCondition>
  ) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [tier]: {
          ...prev.compute[tier],
          mem: {
            ...prev.compute[tier].mem,
            [stat]: { ...prev.compute[tier].mem[stat], ...patch },
          },
        },
      },
    }));

  const updateComputeTier = (tier: ComputeTierKey, patch: Partial<ComputeTier>) =>
    setValues((prev) => ({
      ...prev,
      compute: { ...prev.compute, [tier]: { ...prev.compute[tier], ...patch } },
    }));
  const updateComputeConditionCombine = (tier: ComputeTierKey, combine: FilterCombine) =>
    updateComputeTier(tier, { conditionCombine: combine });

  const updateDiskPercent = (
    tier: DiskTierKey,
    patch: Partial<DiskPercentCondition>
  ) => {
    setValues((prev) => ({
      ...prev,
      disk: {
        ...prev.disk,
        [tier]: {
          ...prev.disk[tier],
          percent: { ...prev.disk[tier].percent, ...patch },
        },
      },
    }));
  };
  const updateDiskTier = (tier: DiskTierKey, patch: Partial<DiskTier>) => {
    setValues((prev) => ({
      ...prev,
      disk: {
        ...prev.disk,
        [tier]: { ...prev.disk[tier], ...patch },
      },
    }));
  };
  const updateDiskConditionCombine = (tier: DiskTierKey, combine: FilterCombine) =>
    updateDiskTier(tier, { conditionCombine: combine });
  const setIncludeNonProvisioned = (next: boolean) =>
    patchFilter({ includeNonProvisioned: next });
  const setExcludeStagnantDisks = (next: boolean) =>
    patchFilter({ excludeStagnantDisks: next });
  const updateDiskIopsCombine = (tier: DiskTierKey, combine: FilterCombine) => {
    setValues((prev) => ({
      ...prev,
      disk: {
        ...prev.disk,
        [tier]: { ...prev.disk[tier], iops: { ...prev.disk[tier].iops, combine } },
      },
    }));
  };
  const updateDiskIopsMetric = (
    tier: DiskTierKey,
    metricKey: string,
    patch: Partial<DiskIopsThreshold>
  ) => {
    setValues((prev) => {
      const cur = prev.disk[tier].iops;
      const existing = cur.byMetric[metricKey] ?? { enabled: false, value: 0 };
      return {
        ...prev,
        disk: {
          ...prev.disk,
          [tier]: {
            ...prev.disk[tier],
            iops: {
              ...cur,
              byMetric: { ...cur.byMetric, [metricKey]: { ...existing, ...patch } },
            },
          },
        },
      };
    });
  };
  const updateDiskDailyChange = (
    tier: DiskTierKey,
    patch: Partial<DiskDailyChangeCondition>
  ) => {
    setValues((prev) => ({
      ...prev,
      disk: {
        ...prev.disk,
        [tier]: {
          ...prev.disk[tier],
          dailyChange: { ...prev.disk[tier].dailyChange, ...patch },
        },
      },
    }));
  };
  const updateDiskDays = (
    tier: DiskTierKey,
    patch: Partial<DiskDaysCondition>
  ) => {
    setValues((prev) => ({
      ...prev,
      disk: {
        ...prev.disk,
        [tier]: {
          ...prev.disk[tier],
          days: { ...prev.disk[tier].days, ...patch },
        },
      },
    }));
  };

  const diskNameFilter: DiskNameFilter = filterDraft.diskNameFilter;
  const updateNameFilter = (next: DiskNameFilter) =>
    patchFilter({ diskNameFilter: next });
  const hostNameFilter: DiskNameFilter = filterDraft.hostNameFilter;
  const updateHostNameFilter = (next: DiskNameFilter) =>
    patchFilter({ hostNameFilter: next });

  // Blanket size / vCPU limits are per tab (High / Low), so every blanket edit
  // targets the tier for the current usage view.
  const blanketTier: DiskTierKey = usageView === "low" ? "lowUsage" : "highUsage";
  const updateDiskBlanket = (patch: Partial<DiskSizeGate>) =>
    setValues((prev) => ({
      ...prev,
      disk: {
        ...prev.disk,
        [blanketTier]: {
          ...prev.disk[blanketTier],
          blanketSize: { ...prev.disk[blanketTier].blanketSize, ...patch },
        },
      },
    }));
  const updateComputeBlanketPcpu = (patch: Partial<CpuCoreGate>) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [blanketTier]: {
          ...prev.compute[blanketTier],
          blanketPcpu: { ...prev.compute[blanketTier].blanketPcpu, ...patch },
        },
      },
    }));
  const updateComputeBlanketVcpu = (patch: Partial<CpuCoreGate>) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [blanketTier]: {
          ...prev.compute[blanketTier],
          blanketVcpu: { ...prev.compute[blanketTier].blanketVcpu, ...patch },
        },
      },
    }));
  const updateComputeBlanketMem = (patch: Partial<DiskSizeGate>) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [blanketTier]: {
          ...prev.compute[blanketTier],
          blanketMem: { ...prev.compute[blanketTier].blanketMem, ...patch },
        },
      },
    }));
  const updateComputeBlanketCombine = (combine: FilterCombine) =>
    setValues((prev) => ({
      ...prev,
      compute: {
        ...prev.compute,
        [blanketTier]: { ...prev.compute[blanketTier], blanketCombine: combine },
      },
    }));

  // Columns hidden on the current tab whose matching filter field should be
  // dropped (gated by the "Filter fields" app setting; empty = show all).
  const filterHiddenCols = useMemo(
    () =>
      appSettings.hideFilterForHiddenColumns
        ? hiddenColumnIds(module, appSettings, usageView)
        : new Set<string>(),
    [appSettings, module, usageView]
  );

  // Visible IOPS columns on this tab (built-in "Avg IOPS" plus any picker-made
  // IOPS metric columns) drive the dynamic IOPS filter block. Empty hides it.
  const iopsFilterColumns = useMemo(() => {
    if (module !== "disk") return [] as Array<{ metricKey: string; label: string }>;
    const resolved = resolveColumnsForModule(module, appSettings, usageView).filter(
      (c) => !filterHiddenCols.has(c.id)
    );
    const out: Array<{ metricKey: string; label: string }> = [];
    const seen = new Set<string>();
    for (const c of resolved) {
      let metricKey: string | null = null;
      if (c.id === "metric-iops") metricKey = "iops";
      else if (c.custom?.source.type === "metric") {
        const mk = c.custom.source.metricKey ?? "";
        if (mk.startsWith("iops")) metricKey = mk;
      }
      if (metricKey && !seen.has(metricKey)) {
        seen.add(metricKey);
        out.push({ metricKey, label: c.label });
      }
    }
    return out;
  }, [module, appSettings, usageView, filterHiddenCols]);

  // Visible metric columns as `metric-<key>` ids (built-ins keep their id; a
  // picker-made metric column contributes `metric-<its metricKey>`). The
  // CPU/Memory filter shows a stat's field only when its column is here.
  const visibleStatColumns = useMemo(() => {
    const resolved = resolveColumnsForModule(module, appSettings, usageView).filter(
      (c) => !filterHiddenCols.has(c.id)
    );
    const set = new Set<string>();
    for (const c of resolved) {
      if (c.id.startsWith("metric-")) set.add(c.id);
      else if (c.custom?.source.type === "metric" && c.custom.source.metricKey) {
        set.add(`metric-${c.custom.source.metricKey}`);
      }
    }
    return set;
  }, [module, appSettings, usageView, filterHiddenCols]);

  const dirty = isFilters
    ? JSON.stringify(filterDraft) !== seedFilter.current
    : JSON.stringify(values) !== seedValues.current;

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Persists as this user's personal override, never the shared team
      // default. The Filters dialog commits the filter bundle at the current
      // scope key; the Thresholds dialog commits the usage / limit config.
      if (isFilters) {
        setFilterFor(module, usageView, filterDraft);
      } else {
        setThresholds(values);
        onSaved?.(values);
      }
      onClose();
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };
  // Clears this module's personal overrides for both usage tiers and snaps back
  // to the current team default, not the hardcoded default.
  const handleReset = () => {
    const eff = resetModuleThresholds(module);
    setValues(eff);
    seedValues.current = JSON.stringify(eff);
  };

  return (
    <>
    <Modal
      show={open}
      onDismiss={requestClose}
      title={isFilters ? "Filters" : `${MODULE_BY_ID[module].name} thresholds`}
      size="medium"
    >
      <div className="modal-body">
        {loading ? (
          <Paragraph className="text-subdued">Loading...</Paragraph>
        ) : (
          <Flex flexDirection="column" gap={12}>
            <Paragraph className="text-secondary">
              {isFilters
                ? appSettings.filterScope === "app"
                  ? showDiskFilters
                    ? "Choose what is in scope across the app. The disk options here apply to disk reports only."
                    : "Choose what is in scope across the app."
                  : appSettings.filterScope === "view"
                  ? "Choose what is in scope for this tab."
                  : "Choose what is in scope for this page."
                : "Set what counts as high or low usage for this page. High and low are configured independently."}
            </Paragraph>
            {onUsageViewChange && (
              <div className="tabs-headeronly">
                <Tabs
                  selectedIndex={usageView === "high" ? 0 : 1}
                  onChange={(i) =>
                    (isFilters ? switchFilterView : onUsageViewChange)(
                      i === 0 ? "high" : "low"
                    )
                  }
                >
                  <Tab title="High usage">{null}</Tab>
                  <Tab title="Low usage">{null}</Tab>
                </Tabs>
              </div>
            )}
            {isFilters && inScopeEither != null && (
              <Paragraph className="text-secondary">
                {envTotal != null
                  ? `Your filters currently include ${inScopeEither.toLocaleString()} of ${envTotal.toLocaleString()} ${recordNoun}s in the environment.`
                  : `Your filters currently include ${inScopeEither.toLocaleString()} ${recordNoun}${inScopeEither === 1 ? "" : "s"}.`}
              </Paragraph>
            )}

            {/* Thresholds variant: usage conditions, limits, column filters. */}
            {!isFilters && (
              <>
                {module === "disk" && (
                  <DiskTierSections
                    disk={values.disk}
                    severity={targetSeverity}
                    hiddenCols={filterHiddenCols}
                    iopsColumns={iopsFilterColumns}
                    updateDiskPercent={updateDiskPercent}
                    updateDiskDays={updateDiskDays}
                    updateDiskIopsCombine={updateDiskIopsCombine}
                    updateDiskIopsMetric={updateDiskIopsMetric}
                    updateDiskDailyChange={updateDiskDailyChange}
                    updateDiskConditionCombine={updateDiskConditionCombine}
                  />
                )}
                {module === "compute" && (
                  <ComputeTierSections
                    compute={values.compute}
                    severity={targetSeverity}
                    visibleCols={visibleStatColumns}
                    updateComputeCpuFilter={updateComputeCpuFilter}
                    updateComputeMemFilter={updateComputeMemFilter}
                    updateComputeCpuStat={updateComputeCpuStat}
                    updateComputeMemStat={updateComputeMemStat}
                    updateComputeConditionCombine={updateComputeConditionCombine}
                  />
                )}
                {module === "kubernetes" && (
                  <KubernetesTierSections values={values.kubernetes} severity={targetSeverity} onChangeNumeric={updateNumericModuleField} />
                )}
                {module === "scaling" && (
                  <ScalingFieldsSection values={values.scaling} onChangeNumeric={updateNumericModuleField} />
                )}

                {/* Whole-table size / vCPU limits (per tab). */}
                {(module === "disk" || module === "compute") && (
                  <BlanketLimitsSection
                    module={module}
                    disk={values.disk[blanketTier]}
                    compute={values.compute[blanketTier]}
                    hiddenCols={filterHiddenCols}
                    onDiskBlanket={updateDiskBlanket}
                    onComputePcpu={updateComputeBlanketPcpu}
                    onComputeVcpu={updateComputeBlanketVcpu}
                    onComputeMem={updateComputeBlanketMem}
                    onComputeCombine={updateComputeBlanketCombine}
                  />
                )}

              </>
            )}

            {/* Filters variant: scope controls (columns, name rules,
                tags / OS / deployment, other filters). Reach follows the
                filter-scope setting; disk sections still affect disk only. */}
            {isFilters && (
              <>
                {/* Column value filters for this page's tag-backed columns. */}
                {!isOverview && (
                  <HostFilterSection
                    module={module}
                    render="columns"
                    value={filterDraft.attrs}
                    onChange={(attrs) => patchFilter({ attrs })}
                  />
                )}

                <NameRulesEditor
                  title="Host name rules"
                  subject="host"
                  filter={hostNameFilter}
                  onChange={updateHostNameFilter}
                />
                {showDiskFilters && (
                  <NameRulesEditor
                    title="Disk name rules"
                    subject="disk"
                    filter={diskNameFilter}
                    onChange={updateNameFilter}
                  />
                )}

                {/* Tags / OS / Deployment. */}
                <HostFilterSection
                  module={module}
                  render="attributes"
                  value={filterDraft.attrs}
                  onChange={(attrs) => patchFilter({ attrs })}
                />

                {(showDiskFilters || (appSettings.snoozeEnabled && !isOverview)) && (
                  <div className="filter-section">
                    <Heading level={5}>Other filters</Heading>

                    {appSettings.snoozeEnabled && !isOverview && (
                      <div className="tier-condition-block">
                        <div className="tier-condition-header">
                          <Switch
                            value={showSnoozed}
                            onChange={(next) => onShowSnoozedChange(Boolean(next))}
                          >
                            Show snoozed
                          </Switch>
                        </div>
                      </div>
                    )}

                    {showDiskFilters && (
                      <div className="tier-condition-block">
                        <div className="tier-condition-header">
                          <Switch
                            value={filterDraft.includeNonProvisioned}
                            onChange={(next) => setIncludeNonProvisioned(Boolean(next))}
                          >
                            Include non-provisioned filesystems
                          </Switch>
                        </div>
                        <Paragraph className="text-secondary">
                          When off, pseudo and platform-managed mounts stay hidden
                          (Kubernetes and container bind mounts, snap loops,
                          OneAgent, DBFS) since they aren't real storage. Turn on to
                          include every mount.
                        </Paragraph>
                      </div>
                    )}

                    {showDiskFilters && (
                      <div className="tier-condition-block">
                        <div className="tier-condition-header">
                          <Switch
                            value={filterDraft.excludeStagnantDisks}
                            onChange={(next) => setExcludeStagnantDisks(Boolean(next))}
                          >
                            Exclude disks that are no longer growing
                          </Switch>
                        </div>
                        <Paragraph className="text-secondary">
                          Drops disks whose fill trend is flat or declining over the
                          measurement window ({appSettings.windowDays} days) from scope
                          entirely, on both the high and low views, so only disks
                          actively trending toward full remain.
                        </Paragraph>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {error && <span className="text-error">{error}</span>}
          </Flex>
        )}
      </div>

      <Flex className="modal-footer" gap={8}>
        {!isFilters && (
          <Button variant="emphasized" onClick={handleReset} disabled={saving || loading}>
            Reset to defaults
          </Button>
        )}
        <Button variant="emphasized" onClick={requestClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="accent" color="primary" onClick={handleSave} disabled={saving || loading}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </Flex>
    </Modal>
    <ConfirmDiscardModal
      open={confirmDiscard}
      onKeepEditing={() => setConfirmDiscard(false)}
      onDiscard={() => {
        setConfirmDiscard(false);
        onClose();
      }}
    />
    </>
  );
};

// Hides the High/Low usage badge in each tier header; flip to true to show it.
const SHOW_TIER_USAGE_BADGE = false;

const TierHeader = ({
  severity,
  label,
  description,
}: {
  severity: Severity;
  label: string;
  description: string;
}) => (
  // A fragment, so the heading and description are direct children of the
  // `.filter-section` flex and lay out like every other section header.
  <>
    {SHOW_TIER_USAGE_BADGE ? (
      <div className="tier-header-row">
        <Heading level={5}>{label}</Heading>
        <SeverityBadge severity={severity} />
      </div>
    ) : (
      <Heading level={5}>{label}</Heading>
    )}
    <Paragraph className="text-secondary">{description}</Paragraph>
  </>
);

// Disk tier sections

const DiskTierSections = ({
  disk,
  severity,
  hiddenCols,
  iopsColumns,
  updateDiskPercent,
  updateDiskDays,
  updateDiskIopsCombine,
  updateDiskIopsMetric,
  updateDiskDailyChange,
  updateDiskConditionCombine,
}: {
  disk: DiskThresholds;
  severity: Severity;
  /** Column ids hidden on this tab; their condition blocks are dropped. */
  hiddenCols: Set<string>;
  /** Visible IOPS columns → the IOPS filter's fields. */
  iopsColumns: Array<{ metricKey: string; label: string }>;
  updateDiskPercent: (tier: DiskTierKey, patch: Partial<DiskPercentCondition>) => void;
  updateDiskDays: (tier: DiskTierKey, patch: Partial<DiskDaysCondition>) => void;
  updateDiskIopsCombine: (tier: DiskTierKey, combine: FilterCombine) => void;
  updateDiskIopsMetric: (
    tier: DiskTierKey,
    metricKey: string,
    patch: Partial<DiskIopsThreshold>
  ) => void;
  updateDiskDailyChange: (
    tier: DiskTierKey,
    patch: Partial<DiskDailyChangeCondition>
  ) => void;
  updateDiskConditionCombine: (tier: DiskTierKey, combine: FilterCombine) => void;
}) => (
  <>
    {DISK_TIERS.filter((s) => s.severity === severity).map((section) => {
      const tier = disk[section.key];
      // Condition blocks shown in this section (IOPS always renders). The
      // tier-level any/all only makes sense with 2+ conditions to combine.
      const shownConditions =
        (!hiddenCols.has(DISK_CONDITION_COLUMN.percent) ? 1 : 0) +
        (!hiddenCols.has(DISK_CONDITION_COLUMN.days) ? 1 : 0) +
        1 +
        (!hiddenCols.has(DISK_CONDITION_COLUMN.dailyChange) ? 1 : 0);
      return (
        <div className="filter-section" key={section.key}>
          <TierHeader severity={section.severity} label={section.label} description={section.description} />

          {shownConditions >= 2 && (
            <MatchModeToggle
              value={tier.conditionCombine}
              onChange={(c) => updateDiskConditionCombine(section.key, c)}
            />
          )}

          {!hiddenCols.has(DISK_CONDITION_COLUMN.percent) && (
            <PercentConditionBlock
              verb={section.percentVerb}
              condition={tier.percent}
              onChange={(patch) => updateDiskPercent(section.key, patch)}
            />
          )}

          {!hiddenCols.has(DISK_CONDITION_COLUMN.days) && (
            <DaysConditionBlock
              verb={section.daysVerb}
              condition={tier.days}
              onChange={(patch) => updateDiskDays(section.key, patch)}
            />
          )}

          <IopsFilterBlock
            filter={tier.iops}
            columns={iopsColumns}
            high={section.severity === "highUsage"}
            onCombine={(c) => updateDiskIopsCombine(section.key, c)}
            onMetric={(mk, patch) => updateDiskIopsMetric(section.key, mk, patch)}
          />

          {!hiddenCols.has(DISK_CONDITION_COLUMN.dailyChange) && (
            <DailyChangeConditionBlock
              verb={section.dailyChangeVerb}
              condition={tier.dailyChange}
              onChange={(patch) => updateDiskDailyChange(section.key, patch)}
            />
          )}
        </div>
      );
    })}
  </>
);

const PercentConditionBlock = ({
  verb,
  condition,
  onChange,
}: {
  verb: string;
  condition: DiskPercentCondition;
  onChange: (patch: Partial<DiskPercentCondition>) => void;
}) => (
  <div className="tier-condition-block">
    <div className="tier-condition-header">
      <Switch value={condition.enabled} onChange={(next) => onChange({ enabled: Boolean(next) })}>
        By % used
      </Switch>
    </div>
    <FormField>
      <Label>{verb} (%)</Label>
      <TextInput
        value={String(condition.value ?? "")}
        onChange={(v) => {
          const n = Number(String(v ?? ""));
          if (Number.isFinite(n)) onChange({ value: n });
        }}
        disabled={!condition.enabled}
      />
    </FormField>
  </div>
);

const DaysConditionBlock = ({
  verb,
  condition,
  onChange,
}: {
  verb: string;
  condition: DiskDaysCondition;
  onChange: (patch: Partial<DiskDaysCondition>) => void;
}) => (
  <div className="tier-condition-block">
    <div className="tier-condition-header">
      <Switch value={condition.enabled} onChange={(next) => onChange({ enabled: Boolean(next) })}>
        By time till full
      </Switch>
    </div>
    <FormField>
      <Label>{verb}</Label>
      <Flex gap={6} alignItems="center">
        <div className="rule-pattern-input">
          <TextInput
            value={String(condition.value ?? "")}
            onChange={(v) => {
              const n = Number(String(v ?? ""));
              if (Number.isFinite(n)) onChange({ value: n });
            }}
            disabled={!condition.enabled}
          />
        </div>
        <div className="rule-unit-select">
          <Select
            value={condition.unit}
            onChange={(v) => onChange({ unit: String(v ?? "days") as TimeUnit })}
            disabled={!condition.enabled}
          >
            <Select.Trigger width="full" />
            <Select.Content>
              {TIME_UNITS.map((u) => (
                <Select.Option key={u.value} value={u.value}>
                  {u.label}
                </Select.Option>
              ))}
            </Select.Content>
          </Select>
        </div>
      </Flex>
    </FormField>
  </div>
);

// Dynamic IOPS filter: one threshold per visible IOPS column. Hidden when no
// IOPS column is shown; the any/all toggle needs 2+ fields.
const IopsFilterBlock = ({
  filter,
  columns,
  high,
  onCombine,
  onMetric,
}: {
  filter: DiskIopsFilter;
  columns: Array<{ metricKey: string; label: string }>;
  high: boolean;
  onCombine: (c: FilterCombine) => void;
  onMetric: (metricKey: string, patch: Partial<DiskIopsThreshold>) => void;
}) => {
  if (columns.length === 0) return null;
  const dir = high ? "at or above" : "at or below";
  return (
    <div className="tier-condition-block">
      <div className="tier-condition-header">
        <span>By IOPS</span>
      </div>
      {columns.map((col) => (
        <StatRow
          key={col.metricKey}
          label={`${col.label} ${dir} (ops/sec)`}
          cond={filter.byMetric[col.metricKey] ?? { enabled: false, value: 0 }}
          onChange={(patch) => onMetric(col.metricKey, patch)}
        />
      ))}
      {columns.length > 1 && (
        <MatchModeToggle value={filter.combine} onChange={onCombine} />
      )}
    </div>
  );
};

const DailyChangeConditionBlock = ({
  verb,
  condition,
  onChange,
}: {
  verb: string;
  condition: DiskDailyChangeCondition;
  onChange: (patch: Partial<DiskDailyChangeCondition>) => void;
}) => (
  <div className="tier-condition-block">
    <div className="tier-condition-header">
      <Switch value={condition.enabled} onChange={(next) => onChange({ enabled: Boolean(next) })}>
        By daily change
      </Switch>
    </div>
    <FormField>
      <Label>{verb} (%/day, may be negative)</Label>
      <TextInput
        value={String(condition.value ?? "")}
        onChange={(v) => {
          const n = Number(String(v ?? ""));
          if (Number.isFinite(n)) onChange({ value: n });
        }}
        disabled={!condition.enabled}
      />
    </FormField>
  </div>
);

// Include/exclude name-rule editor, shared by the app-wide host-name rules
// (every page) and the disk mount-name rules (disk page).
const NameRulesEditor = ({
  title,
  subject,
  filter,
  onChange,
}: {
  title: string;
  subject: string;
  filter: DiskNameFilter;
  onChange: (next: DiskNameFilter) => void;
}) => {
  const addRule = () =>
    onChange({
      ...filter,
      rules: [...filter.rules, { action: "exclude", mode: "contains", pattern: "" }],
    });
  const removeRule = (idx: number) =>
    onChange({ ...filter, rules: filter.rules.filter((_, i) => i !== idx) });
  const updateRule = (idx: number, patch: Partial<DiskNameRule>) =>
    onChange({
      ...filter,
      rules: filter.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    });
  return (
    <div className="filter-section">
      <Heading level={5}>{title}</Heading>
      <Paragraph className="text-secondary">
        "Exclude" hides matching {subject}s; "Include only" keeps just the
        matches. You can mix them: excludes always win, and if any "Include
        only" rule is set, a {subject} must match one to show.
      </Paragraph>
      <Flex flexDirection="column" gap={6} className="rule-list">
        {filter.rules.length === 0 ? (
          <Paragraph className="text-subdued">
            No rules configured.
          </Paragraph>
        ) : (
          filter.rules.map((rule, idx) => (
            <Flex key={idx} gap={6} alignItems="center" className="rule-row">
              <div className="rule-mode-select">
                <Select
                  value={rule.action ?? "exclude"}
                  onChange={(v) =>
                    updateRule(idx, {
                      action: (String(v ?? "exclude") as DiskNameRuleAction),
                    })
                  }
                >
                  <Select.Trigger width="full" />
                  <Select.Content>
                    {NAME_RULE_ACTIONS.map((a) => (
                      <Select.Option key={a.value} value={a.value}>
                        {a.label}
                      </Select.Option>
                    ))}
                  </Select.Content>
                </Select>
              </div>
              <div className="rule-mode-select">
                <Select
                  value={rule.mode}
                  onChange={(v) =>
                    updateRule(idx, { mode: String(v ?? "contains") as DiskNameRuleMode })
                  }
                >
                  <Select.Trigger width="full" />
                  <Select.Content>
                    {RULE_MODES.map((m) => (
                      <Select.Option key={m.value} value={m.value}>
                        {m.label}
                      </Select.Option>
                    ))}
                  </Select.Content>
                </Select>
              </div>
              <div className="rule-pattern-input">
                <TextInput
                  placeholder={subject === "host" ? "e.g. prod-web" : "e.g. /var/log"}
                  value={rule.pattern}
                  onChange={(v) => updateRule(idx, { pattern: String(v ?? "") })}
                />
              </div>
              <Button
                variant="emphasized"
                className="rule-remove-btn"
                aria-label="Remove rule"
                onClick={() => removeRule(idx)}
              >
                <DeleteIcon />
              </Button>
            </Flex>
          ))
        )}
        <div>
          <Button variant="emphasized" onClick={addRule}>
            <PlusIcon className="button-add-margin-right-4" /> Add rule
          </Button>
        </div>
      </Flex>
    </div>
  );
};

const SizeGateRow = ({
  label,
  enabled,
  value,
  unit,
  sectionEnabled,
  onToggle,
  onValue,
  onUnit,
}: {
  label: string;
  enabled: boolean;
  value: number;
  unit: SizeUnit;
  /** Outer condition switch; when off, the whole row is greyed out. */
  sectionEnabled: boolean;
  onToggle: (b: boolean) => void;
  onValue: (n: number) => void;
  onUnit: (u: SizeUnit) => void;
}) => {
  const inputDisabled = !sectionEnabled || !enabled;
  return (
    <div className="size-gate-row">
      <Label>{label}</Label>
      <Flex gap={6} alignItems="center">
        <Switch
          value={enabled}
          onChange={(next) => onToggle(Boolean(next))}
          disabled={!sectionEnabled}
        />
        <div className="rule-pattern-input">
          <TextInput
            value={String(value ?? "")}
            onChange={(v) => {
              const n = Number(String(v ?? ""));
              if (Number.isFinite(n)) onValue(n);
            }}
            disabled={inputDisabled}
          />
        </div>
        <div className="rule-unit-select">
          <Select
            value={unit}
            onChange={(v) => onUnit(String(v ?? "GB") as SizeUnit)}
            disabled={inputDisabled}
          >
            <Select.Trigger width="full" />
            <Select.Content>
              {SIZE_UNITS.map((u) => (
                <Select.Option key={u.value} value={u.value}>
                  {u.label}
                </Select.Option>
              ))}
            </Select.Content>
          </Select>
        </div>
      </Flex>
    </div>
  );
};

// Compute / Kubernetes / Scaling tier sections

const ComputeTierSections = ({
  compute,
  severity,
  visibleCols,
  updateComputeCpuFilter,
  updateComputeMemFilter,
  updateComputeCpuStat,
  updateComputeMemStat,
  updateComputeConditionCombine,
}: {
  compute: ComputeThresholds;
  severity: Severity;
  /** `metric-<key>` ids of the visible CPU/mem columns; a stat's filter field
   *  shows only when its column is here. */
  visibleCols: Set<string>;
  updateComputeCpuFilter: (tier: ComputeTierKey, patch: Partial<ComputeCpuFilter>) => void;
  updateComputeMemFilter: (tier: ComputeTierKey, patch: Partial<ComputeMemFilter>) => void;
  updateComputeCpuStat: (tier: ComputeTierKey, stat: CpuStatKey, patch: Partial<ComputeStatCondition>) => void;
  updateComputeMemStat: (tier: ComputeTierKey, stat: MemStatKey, patch: Partial<ComputeStatCondition>) => void;
  updateComputeConditionCombine: (tier: ComputeTierKey, combine: FilterCombine) => void;
}) => (
  <>
    {COMPUTE_TIERS.filter((s) => s.severity === severity).map((section) => {
      const tier = compute[section.key];
      const high = section.key === "highUsage";
      // Which filter blocks actually render (they hide when all their columns
      // are hidden). The tier-level any/all only makes sense with both shown.
      const cpuShown =
        COMPUTE_STATS.some((s) => visibleCols.has(CPU_STAT_COLUMN[s.key])) ||
        (high && visibleCols.has(CPU_STAT_COLUMN.steal));
      const memShown = COMPUTE_STATS.some((s) => visibleCols.has(MEM_STAT_COLUMN[s.key]));
      return (
        <div className="filter-section" key={section.key}>
          <TierHeader severity={section.severity} label={section.label} description={section.description} />
          {cpuShown && memShown && (
            <MatchModeToggle
              value={tier.conditionCombine}
              onChange={(c) => updateComputeConditionCombine(section.key, c)}
            />
          )}
          <CpuFilterBlock
            filter={tier.cpu}
            high={high}
            visibleCols={visibleCols}
            onFilter={(patch) => updateComputeCpuFilter(section.key, patch)}
            onStat={(stat, patch) => updateComputeCpuStat(section.key, stat, patch)}
          />
          <MemFilterBlock
            filter={tier.mem}
            high={high}
            visibleCols={visibleCols}
            onFilter={(patch) => updateComputeMemFilter(section.key, patch)}
            onStat={(stat, patch) => updateComputeMemStat(section.key, stat, patch)}
          />
        </div>
      );
    })}
  </>
);

// Min/max vCPU gate: the compute analogue of SizeGateRow.
const CoreGateRow = ({
  label,
  enabled,
  value,
  sectionEnabled,
  onToggle,
  onValue,
}: {
  label: string;
  enabled: boolean;
  value: number;
  sectionEnabled: boolean;
  onToggle: (b: boolean) => void;
  onValue: (n: number) => void;
}) => (
  <div className="size-gate-row">
    <Label>{label}</Label>
    <Flex gap={6} alignItems="center">
      <Switch
        value={enabled}
        onChange={(next) => onToggle(Boolean(next))}
        disabled={!sectionEnabled}
      />
      <div className="rule-pattern-input">
        <TextInput
          value={String(value ?? "")}
          onChange={(v) => {
            const n = Number(String(v ?? ""));
            if (Number.isFinite(n)) onValue(n);
          }}
          disabled={!sectionEnabled || !enabled}
        />
      </div>
    </Flex>
  </div>
);

const StatRow = ({
  label,
  cond,
  onChange,
}: {
  label: string;
  cond: ComputeStatCondition;
  onChange: (patch: Partial<ComputeStatCondition>) => void;
}) => (
  <div className="size-gate-row">
    <Label>{label}</Label>
    <Flex gap={6} alignItems="center">
      <Switch value={cond.enabled} onChange={(n) => onChange({ enabled: Boolean(n) })} />
      <div className="rule-pattern-input">
        <TextInput
          value={String(cond.value ?? "")}
          onChange={(v) => {
            const n = Number(String(v ?? ""));
            if (Number.isFinite(n)) onChange({ value: n });
          }}
          disabled={!cond.enabled}
        />
      </div>
    </Flex>
  </div>
);

// "Any vs all" selector, used by both the filter conditions and the whole-table
// limits. The optional hint spells out AND/OR in plain language.
const MatchModeToggle = ({
  value,
  onChange,
  anyLabel = "Matches any condition",
  allLabel = "Matches all conditions",
  hint,
}: {
  value: FilterCombine;
  onChange: (v: FilterCombine) => void;
  anyLabel?: string;
  allLabel?: string;
  /** Optional plain-language hint under the toggle (limits section only). */
  hint?: { any: string; all: string };
}) => (
  <div className="match-mode-toggle">
    <ToggleButtonGroup value={value} onChange={(v) => onChange(v === "all" ? "all" : "any")}>
      <ToggleButtonGroup.Item value="any">{anyLabel}</ToggleButtonGroup.Item>
      <ToggleButtonGroup.Item value="all">{allLabel}</ToggleButtonGroup.Item>
    </ToggleButtonGroup>
    {hint && (
      <Paragraph className="text-subdued">
        {value === "all" ? hint.all : hint.any}
      </Paragraph>
    )}
  </div>
);

const CpuFilterBlock = ({
  filter,
  high,
  visibleCols,
  onFilter,
  onStat,
}: {
  filter: ComputeCpuFilter;
  high: boolean;
  visibleCols: Set<string>;
  onFilter: (patch: Partial<ComputeCpuFilter>) => void;
  onStat: (stat: CpuStatKey, patch: Partial<ComputeStatCondition>) => void;
}) => {
  const dir = high ? "at or above" : "at or below";
  const stats = COMPUTE_STATS.filter((s) => visibleCols.has(CPU_STAT_COLUMN[s.key]));
  const showSteal = high && visibleCols.has(CPU_STAT_COLUMN.steal);
  const fieldCount = stats.length + (showSteal ? 1 : 0);
  if (fieldCount === 0) return null;
  return (
    <div className="tier-condition-block">
      <div className="tier-condition-header">
        <Switch value={filter.enabled} onChange={(n) => onFilter({ enabled: Boolean(n) })}>
          CPU
        </Switch>
      </div>
      {filter.enabled && (
        <>
          {stats.map((s) => (
            <StatRow
              key={s.key}
              label={`${s.label} ${dir} (%)`}
              cond={filter[s.key]}
              onChange={(patch) => onStat(s.key, patch)}
            />
          ))}
          {showSteal && (
            <StatRow
              label="CPU steal at or above (%)"
              cond={filter.steal}
              onChange={(patch) => onStat("steal", patch)}
            />
          )}
          {fieldCount > 1 && (
            <MatchModeToggle
              value={filter.combine}
              onChange={(c) => onFilter({ combine: c })}
            />
          )}
        </>
      )}
    </div>
  );
};

const MemFilterBlock = ({
  filter,
  high,
  visibleCols,
  onFilter,
  onStat,
}: {
  filter: ComputeMemFilter;
  high: boolean;
  visibleCols: Set<string>;
  onFilter: (patch: Partial<ComputeMemFilter>) => void;
  onStat: (stat: MemStatKey, patch: Partial<ComputeStatCondition>) => void;
}) => {
  const dir = high ? "at or above" : "at or below";
  const stats = COMPUTE_STATS.filter((s) => visibleCols.has(MEM_STAT_COLUMN[s.key]));
  if (stats.length === 0) return null;
  return (
    <div className="tier-condition-block">
      <div className="tier-condition-header">
        <Switch value={filter.enabled} onChange={(n) => onFilter({ enabled: Boolean(n) })}>
          Memory
        </Switch>
      </div>
      {filter.enabled && (
        <>
          {stats.map((s) => (
            <StatRow
              key={s.key}
              label={`${s.label} ${dir} (%)`}
              cond={filter[s.key]}
              onChange={(patch) => onStat(s.key, patch)}
            />
          ))}
          {stats.length > 1 && (
            <MatchModeToggle
              value={filter.combine}
              onChange={(c) => onFilter({ combine: c })}
            />
          )}
        </>
      )}
    </div>
  );
};

/**
 * Whole-table size / vCPU limits. A disk row is kept only if its size is within
 * the limit, a host row only if it's within the vCPU and/or memory limits.
 * Limits stay off until a min/max is enabled and then apply to every row,
 * including "at capacity". With 2+ compute limits an Any/All toggle picks
 * whether a host must be within all of them or just one.
 */
const BlanketLimitsSection = ({
  module,
  disk,
  compute,
  hiddenCols,
  onDiskBlanket,
  onComputePcpu,
  onComputeVcpu,
  onComputeMem,
  onComputeCombine,
}: {
  module: ModuleId;
  disk: DiskTier;
  compute: ComputeTier;
  hiddenCols: Set<string>;
  onDiskBlanket: (patch: Partial<DiskSizeGate>) => void;
  onComputePcpu: (patch: Partial<CpuCoreGate>) => void;
  onComputeVcpu: (patch: Partial<CpuCoreGate>) => void;
  onComputeMem: (patch: Partial<DiskSizeGate>) => void;
  onComputeCombine: (v: FilterCombine) => void;
}) => {
  const isDisk = module === "disk";
  // A hidden column drops its limit editor (matches the conditions coupling).
  const showDiskSize = !hiddenCols.has(LIMIT_COLUMN.diskSize);
  const showPcpu = !hiddenCols.has(LIMIT_COLUMN.pcpu);
  const showVcpu = !hiddenCols.has(LIMIT_COLUMN.vcpu);
  const showMem = !hiddenCols.has(LIMIT_COLUMN.mem);
  const computeGroups = [showPcpu, showVcpu, showMem].filter(Boolean).length;
  if (isDisk ? !showDiskSize : computeGroups === 0) return null;
  return (
    <div className="filter-section">
      <Heading level={5}>{isDisk ? "Size limits" : "CPU & memory limits"}</Heading>
      <Paragraph className="text-secondary">
        Only include {isDisk ? "disks within this size range" : "hosts within these CPU and memory limits"}.
        Applies to entire query.
      </Paragraph>

      {/* Combine only matters across 2+ visible limit groups. */}
      {!isDisk && computeGroups >= 2 && (
        <MatchModeToggle
          value={compute.blanketCombine}
          onChange={onComputeCombine}
        />
      )}

      {isDisk && (
        <div className="tier-condition-block">
          <SizeGateRow
            label="Only disks at least this large"
            enabled={disk.blanketSize.minSizeEnabled}
            value={disk.blanketSize.minSize}
            unit={disk.blanketSize.minSizeUnit}
            sectionEnabled
            onToggle={(b) => onDiskBlanket({ minSizeEnabled: b })}
            onValue={(n) => onDiskBlanket({ minSize: n })}
            onUnit={(u) => onDiskBlanket({ minSizeUnit: u })}
          />
          <SizeGateRow
            label="Only disks no larger than"
            enabled={disk.blanketSize.maxSizeEnabled}
            value={disk.blanketSize.maxSize}
            unit={disk.blanketSize.maxSizeUnit}
            sectionEnabled
            onToggle={(b) => onDiskBlanket({ maxSizeEnabled: b })}
            onValue={(n) => onDiskBlanket({ maxSize: n })}
            onUnit={(u) => onDiskBlanket({ maxSizeUnit: u })}
          />
        </div>
      )}

      {!isDisk && (
        <div className="tier-condition-block">
          {showPcpu && (
            <>
              <CoreGateRow
                label="Only hosts with at least this many pCPUs"
                enabled={compute.blanketPcpu.minCoresEnabled}
                value={compute.blanketPcpu.minCores}
                sectionEnabled
                onToggle={(b) => onComputePcpu({ minCoresEnabled: b })}
                onValue={(n) => onComputePcpu({ minCores: n })}
              />
              <CoreGateRow
                label="Only hosts with no more than this many pCPUs"
                enabled={compute.blanketPcpu.maxCoresEnabled}
                value={compute.blanketPcpu.maxCores}
                sectionEnabled
                onToggle={(b) => onComputePcpu({ maxCoresEnabled: b })}
                onValue={(n) => onComputePcpu({ maxCores: n })}
              />
            </>
          )}
          {showVcpu && (
            <>
              <CoreGateRow
                label="Only hosts with at least this many vCPUs"
                enabled={compute.blanketVcpu.minCoresEnabled}
                value={compute.blanketVcpu.minCores}
                sectionEnabled
                onToggle={(b) => onComputeVcpu({ minCoresEnabled: b })}
                onValue={(n) => onComputeVcpu({ minCores: n })}
              />
              <CoreGateRow
                label="Only hosts with no more than this many vCPUs"
                enabled={compute.blanketVcpu.maxCoresEnabled}
                value={compute.blanketVcpu.maxCores}
                sectionEnabled
                onToggle={(b) => onComputeVcpu({ maxCoresEnabled: b })}
                onValue={(n) => onComputeVcpu({ maxCores: n })}
              />
            </>
          )}
          {showMem && (
            <>
              <SizeGateRow
                label="Only hosts with at least this much memory"
                enabled={compute.blanketMem.minSizeEnabled}
                value={compute.blanketMem.minSize}
                unit={compute.blanketMem.minSizeUnit}
                sectionEnabled
                onToggle={(b) => onComputeMem({ minSizeEnabled: b })}
                onValue={(n) => onComputeMem({ minSize: n })}
                onUnit={(u) => onComputeMem({ minSizeUnit: u })}
              />
              <SizeGateRow
                label="Only hosts with no more than this much memory"
                enabled={compute.blanketMem.maxSizeEnabled}
                value={compute.blanketMem.maxSize}
                unit={compute.blanketMem.maxSizeUnit}
                sectionEnabled
                onToggle={(b) => onComputeMem({ maxSizeEnabled: b })}
                onValue={(n) => onComputeMem({ maxSize: n })}
                onUnit={(u) => onComputeMem({ maxSizeUnit: u })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};

const KubernetesTierSections = ({
  values,
  severity,
  onChangeNumeric,
}: {
  values: Thresholds["kubernetes"];
  severity: Severity;
  onChangeNumeric: (key: string, value: string) => void;
}) => (
  <>
    {KUBERNETES_TIERS.filter((s) => s.severity === severity).map((section) => (
      <div className="filter-section" key={section.label}>
        <TierHeader severity={section.severity} label={section.label} description={section.description} />
        {section.fields.map((field) => (
          <FormField key={String(field.key)}>
            <Label>
              {field.label}
              {field.suffix ? ` (${field.suffix})` : ""}
            </Label>
            <TextInput
              value={String(values[field.key] ?? "")}
              onChange={(v) => onChangeNumeric(String(field.key), String(v ?? ""))}
            />
          </FormField>
        ))}
      </div>
    ))}
  </>
);

const ScalingFieldsSection = ({
  values,
  onChangeNumeric,
}: {
  values: Thresholds["scaling"];
  onChangeNumeric: (key: string, value: string) => void;
}) => (
  <div className="filter-section">
    <Heading level={5}>Scaling thresholds</Heading>
    <Paragraph className="text-secondary">
      Flags scaling groups that flat-run, hit their ceiling, or swing hard between day and night.
    </Paragraph>
    {SCALING_FIELDS.map((field) => (
      <FormField key={String(field.key)}>
        <Label>
          {field.label}
          {field.suffix ? ` (${field.suffix})` : ""}
        </Label>
        <TextInput
          value={String(values[field.key] ?? "")}
          onChange={(v) => onChangeNumeric(String(field.key), String(v ?? ""))}
        />
      </FormField>
    ))}
  </div>
);

/**
 * Host filter (tags / OS / deployment) embedded in the dialog. Edits the
 * modal's staged `value`, never ScopeContext, so nothing applies until Save.
 */
const HostFilterSection = ({
  module,
  render,
  value,
  onChange,
}: {
  module: ModuleId;
  render?: "columns" | "attributes";
  value: HostFilter;
  onChange: (next: HostFilter) => void;
}) => {
  const { appSettings } = useScope();
  // This page's custom-column tag keys, offered as suggested tag filters (with
  // "all values" as a no-op). The column name rides along so the row can show
  // which column it feeds.
  const suggestedColumns = useMemo(() => {
    // Custom columns are per view, so this covers every tag-backed column
    // visible on either tab, deduped by tag key (two columns can share one).
    // The first visible column's label wins.
    const out: { tagKey: string; columnLabel: string }[] = [];
    const seen = new Set<string>();
    for (const view of ["high", "low"] as const) {
      const hidden = hiddenColumnIds(module, appSettings, view);
      for (const c of resolveColumnsForModule(module, appSettings, view)) {
        const key = c.custom?.source.type === "tag" ? c.custom.source.tagKey : "";
        if (!key || hidden.has(c.id) || seen.has(key)) continue;
        seen.add(key);
        out.push({ tagKey: key, columnLabel: c.label });
      }
    }
    return out;
  }, [module, appSettings]);
  return (
    <HostFilterFields
      value={value}
      onChange={onChange}
      suggestedColumns={suggestedColumns}
      render={render}
    />
  );
};
