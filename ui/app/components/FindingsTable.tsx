import { useEffect, useMemo, useState } from "react";
import {
  DataTable,
  type DataTableColumnDef,
} from "@dynatrace/strato-components-preview/tables";
import {
  SearchInput,
  ToggleButtonGroup,
} from "@dynatrace/strato-components-preview/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Paragraph } from "@dynatrace/strato-components/typography";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import {
  InformationIcon,
  FilterIcon,
  ThresholdIcon,
  DownloadIcon,
  SettingIcon,
  RefreshIcon,
} from "@dynatrace/strato-icons";
import type {
  CustomColumnSource,
  Finding,
  ModuleId,
  Thresholds,
} from "../types/types";
import {
  hostDetailUrl,
  diskDetailUrl,
  openHostInInfraOps,
  openDiskInInfraOps,
  formatDurationShort,
} from "../utils/helpers";
import {
  hiddenColumnIds,
  metricColumnsFor,
  metricGroupOfColumn,
  metricValueWidth,
  resolveColumnsForModule,
  resolveTagColumnValue,
} from "../utils/columns";
import { MODULE_BY_ID } from "../constants/modules";
import { FindingDetailsModal } from "./FindingDetailsModal";
import { ThresholdSettingsModal } from "./ThresholdSettingsModal";
import { ColumnsMenu } from "./ColumnsMenu";
import { AppSettingsModal } from "./AppSettingsModal";
import { ScopeSelector } from "./ScopeSelector";
import { TimeframePicker } from "./TimeframePicker";
import { useScope } from "../contexts/ScopeContext";
import { downloadCsv, tableToCsv } from "../utils/csv";
import {
  FILTER_SHOW_LABEL,
  EXPORT_SHOW_LABEL,
  SETTINGS_SHOW_LABEL,
} from "../constants/ui-toggles";

type UsageView = "high" | "low";

export interface FindingsTableProps {
  findings: Finding[];
  isLoading?: boolean;
  /** Called after the user changes finding state (snooze/ack). */
  onStateChanged: () => void;
  /** Called after the user saves thresholds in the Filter modal. */
  onThresholdsSaved?: (t: Thresholds) => void;
  /** Force a live recompute (bypasses cache). Wired to the Refresh button. */
  onRefresh?: () => void;
  /** Which module; controls whether the Disk/mount column is rendered. */
  module: ModuleId;
  /** In-scope population for this module; the footer count's denominator. */
  inScope?: number;
  /** Controlled usage view. When provided, the parent owns High/Low (so the
   *  page can recompute per tab for "view"-scope filters); otherwise the table
   *  keeps it internally. */
  usageView?: UsageView;
  onUsageViewChange?: (next: UsageView) => void;
  defaultSortBy?: Array<{ id: string; desc: boolean }>;
}

// Shared canvas for measuring text width, so a name column can size to its
// typical content. Created lazily, with a per-character estimate as fallback.
let _measureCtx: CanvasRenderingContext2D | null = null;
const CELL_FONT = "13px -apple-system, 'Segoe UI', Roboto, sans-serif";

function measureTextWidth(text: string): number {
  try {
    if (!_measureCtx) {
      _measureCtx = document.createElement("canvas").getContext("2d");
      if (_measureCtx) _measureCtx.font = CELL_FONT;
    }
    if (_measureCtx) return _measureCtx.measureText(text).width;
  } catch {
    /* no canvas (restricted context); use the estimate below */
  }
  return text.length * 7;
}

/**
 * Content-aware minimum width for a name column: sizes to a high percentile of
 * its values so long outliers truncate instead of stretching the column, then
 * pads and clamps between floor and ceil. Callers still pass an fr weight, so
 * the column also takes a share of any slack.
 */
function contentFloor(
  values: string[],
  opts: { floor: number; ceil: number; pad: number; header: string; percentile?: number }
): number {
  const clamp = (v: number) => Math.round(Math.max(opts.floor, Math.min(opts.ceil, v)));
  const headerNeed = measureTextWidth(opts.header) + opts.pad;
  const uniq = Array.from(
    new Set(values.map((v) => (v ?? "").trim()).filter((v) => v && v !== "—"))
  );
  if (uniq.length === 0) return clamp(headerNeed);
  const widths = uniq.map(measureTextWidth).sort((a, b) => a - b);
  const p = opts.percentile ?? 0.9;
  const pick = widths[Math.min(widths.length - 1, Math.floor(p * (widths.length - 1)))];
  return clamp(Math.max(pick + opts.pad, headerNeed));
}

/**
 * The findings list: search box, selectors, data table, usage toggle, and the
 * footer actions (Export, Columns, Settings). The toggle picks which tier the
 * table shows: high-usage (at-capacity plus high), low-usage, or normal.
 */
export const FindingsTable = ({
  findings,
  isLoading,
  onStateChanged,
  onThresholdsSaved,
  onRefresh,
  module,
  inScope,
  usageView: controlledView,
  onUsageViewChange,
  defaultSortBy,
}: FindingsTableProps) => {
  const { appSettings } = useScope();
  const [search, setSearch] = useState("");
  // "high" covers at-capacity + high usage, "low" covers low usage. The parent
  // owns this when it has to recompute per tab (view-scope filters).
  const [internalView, setInternalView] = useState<UsageView>("high");
  const usageView = controlledView ?? internalView;
  const setUsageView = onUsageViewChange ?? setInternalView;
  // The visible tab. High and Low mirror `usageView` (which drives columns,
  // thresholds, and the query); Normal is a third view of the same query's
  // unflagged records and reuses whichever layout is active, so switching to it
  // never re-queries.
  const [tab, setTab] = useState<"high" | "low" | "normal">(usageView);
  useEffect(() => {
    setTab((t) => (t === "normal" ? t : usageView));
  }, [usageView]);
  const changeTab = (next: "high" | "low" | "normal") => {
    setTab(next);
    if (next !== "normal") setUsageView(next);
  };
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [selected, setSelected] = useState<Finding | null>(null);
  const [openModal, setOpenModal] = useState<"thresholds" | "filters" | null>(
    null
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const now = Date.now();
    return findings.filter((f) => {
      const isLow = f.severity === "lowUsage";
      const isNormal = f.severity === "normal";
      // High = at-capacity + high usage; Low = low usage; Normal = unflagged.
      if (tab === "high" && (isLow || isNormal)) return false;
      if (tab === "low" && !isLow) return false;
      if (tab === "normal" && !isNormal) return false;
      // With the setting off, offline hosts stay, dimmed with an "offline" badge.
      if (appSettings.hideOfflineHosts && f.offline) return false;
      if (
        appSettings.snoozeEnabled &&
        !showSnoozed &&
        f.snoozedUntil &&
        new Date(f.snoozedUntil).getTime() > now
      ) {
        return false;
      }
      if (term) {
        const hay = [
          f.entity.displayName,
          f.entity.entityId,
          f.entity.qualifier ?? "",
          f.entity.entityType,
          f.title,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [
    findings,
    search,
    tab,
    showSnoozed,
    appSettings.snoozeEnabled,
    appSettings.hideOfflineHosts,
  ]);

  // Records in this tab (severity match, ignoring the search box): the
  // numerator of the "X of Y in scope" footer.
  const tabCount = useMemo(
    () =>
      findings.filter((f) => {
        if (appSettings.hideOfflineHosts && f.offline) return false;
        // A record the tab's size limit keeps from being flagged shows for
        // context but counts nowhere, so the three tab counts can total less
        // than the in-scope population.
        if (f.limitExcluded) return false;
        const isLow = f.severity === "lowUsage";
        const isNormal = f.severity === "normal";
        if (tab === "high") return !isLow && !isNormal;
        if (tab === "low") return isLow;
        return isNormal;
      }).length,
    [findings, tab, appSettings.hideOfflineHosts]
  );
  // A tab's rows are a subset of the in-scope population, so inScope is floored
  // at tabCount; a stale or undercounted value would otherwise render as the
  // nonsensical "125 of 0".
  const inScopeForTab =
    inScope != null ? Math.max(inScope, tabCount) : undefined;
  const recordNoun = MODULE_BY_ID[module].recordNoun;

  // Both the table and the Columns modal derive their column set from
  // `resolveColumnsForModule` (utils/columns), so they can't drift.
  const columns = useMemo<DataTableColumnDef<Finding>[]>(() => {
    // Offline and limit-excluded findings render greyed. The class goes on
    // every cell so the whole row reads as muted.
    const offCls = (f: Finding) =>
      f.offline || f.limitExcluded ? " cell-offline" : "";

    const hostFloor = contentFloor(
      findings.map((f) => f.entity.displayName ?? ""),
      { floor: 150, ceil: 320, pad: 32, header: "Host" }
    );
    const diskFloor =
      module === "disk"
        ? contentFloor(
            findings.map((f) => f.entity.qualifier ?? ""),
            { floor: 120, ceil: 280, pad: 28, header: "Disk" }
          )
        : 120;

    const hostCol: DataTableColumnDef<Finding> = {
      id: "host",
      header: "Host",
      accessor: (row) => row.entity.displayName,
      // Floor tracks the typical host name; the fr weight is the largest in
      // the table, so host also takes the most slack.
      minWidth: hostFloor,
      width: "5fr",
      cell: ({ rowData }) => {
        const f = rowData as Finding;
        return (
          <div className={"cell-pad host-cell" + offCls(f)}>
            {/* href stays so middle-click + right-click "copy link"
                return the right URL. onClick routes left-clicks through
                the SDK so navigation works inside the sandbox. */}
            <a
              href={hostDetailUrl(f.entity.entityId)}
              rel="noreferrer"
              className="host-link"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openHostInInfraOps(f.entity.entityId);
              }}
              title={f.entity.entityId}
            >
              {f.entity.displayName}
            </a>
            {f.offline && (
              <span className="offline-tag" title="Host isn't currently reporting">
                offline
                {f.offlineForMs != null ? ` ${formatDurationShort(f.offlineForMs)}` : ""}
              </span>
            )}
            {f.limitExcluded && (
              <span
                className="limit-tag"
                title="Outside this tab's size limit; shown for context, not included in any count"
              >
                size limit
              </span>
            )}
          </div>
        );
      },
    };

    const mountCol: DataTableColumnDef<Finding> = {
      id: "mount",
      header: "Disk",
      accessor: (row) => row.entity.qualifier ?? "—",
      sortType: "text",
      // fr weight below host, so this column stays a notch narrower.
      minWidth: diskFloor,
      width: "3fr",
      cell: ({ rowData }) => {
        const f = rowData as Finding;
        const mount = f.entity.qualifier ?? "—";
        const diskId = String(f.evidence?.disk_entity_id ?? "");
        if (diskId) {
          return (
            <div className={"cell-pad" + offCls(f)}>
              <a
                href={diskDetailUrl(f.entity.entityId, diskId)}
                rel="noreferrer"
                className="host-link mount-cell"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openDiskInInfraOps(f.entity.entityId, diskId);
                }}
                title={mount}
              >
                {mount}
              </a>
            </div>
          );
        }
        return (
          <div className={"cell-pad" + offCls(f)}>
            <span className="mount-cell" title={mount}>
              {mount}
            </span>
          </div>
        );
      },
    };

    const metricCol = (
      key: string,
      header: string,
      width: number,
      fr: `${number}fr` = "2fr"
    ): DataTableColumnDef<Finding> => ({
      id: `metric-${key}`,
      header,
      accessor: (row) => row.metrics?.[key]?.sortValue ?? -Infinity,
      sortType: "number",
      // Fitted width is the floor; the fr weight lets each metric column take
      // some of the leftover space instead of dumping it all into host/disk.
      // Tiny-value columns (e.g. "Full in") pass a lighter fr.
      minWidth: width,
      width: fr,
      alignment: "right",
      cell: ({ rowData }) => {
        const f = rowData as Finding;
        const m = f.metrics?.[key];
        // Missing data (no metric, or a blank value) renders greyed, so an
        // absent IOPS or size reads as "no data" rather than a real value.
        const missing =
          !m || m.value == null || m.value === "—" || m.value === "";
        if (missing)
          return (
            <div className={"cell-pad metric-cell-empty" + offCls(f)}>—</div>
          );
        return (
          <div
            className={
              (m.isIssue
                ? "cell-pad metric-cell-issue"
                : m.dim || f.severity !== "normal"
                ? "cell-pad metric-cell-fine"
                : "cell-pad metric-cell-normal") + offCls(f)
            }
            title={m.isIssue ? "Flagged" : "Within thresholds"}
          >
            <span className="metric-value">{m.value}</span>
          </div>
        );
      },
    });

    // Fit each custom column to the widest of its header or its resolved values
    // (fallbacks, regex, and case applied). Strato collapses a min/max range to
    // the minimum, so this is one fixed width: ~8px per char plus padding,
    // clamped.
    const customWidth = (header: string, source: CustomColumnSource): number => {
      let maxLen = header.length;
      for (const f of findings) {
        const v = resolveTagColumnValue(source, f.tagValues);
        if (v.length > maxLen) maxLen = v.length;
      }
      return Math.max(72, Math.min(260, maxLen * 8 + 30));
    };

    const customCol = (
      id: string,
      header: string,
      source: CustomColumnSource,
      width: number
    ): DataTableColumnDef<Finding> => ({
      id,
      header,
      accessor: (row) => resolveTagColumnValue(source, row.tagValues),
      sortType: "text",
      // Fitted width is the floor; the fr weight gives it a share of the slack,
      // same as the metric columns.
      minWidth: width,
      width: "2fr",
      cell: ({ rowData }) => {
        const f = rowData as Finding;
        const val = resolveTagColumnValue(source, f.tagValues);
        return (
          <div className={"cell-pad" + offCls(f)}>
            <span className="tag-column-cell" title={val}>
              {val.length > 0 ? val : "—"}
            </span>
          </div>
        );
      },
    });

    // A "Metric" custom column renders an already-computed finding.metrics
    // value, styled like a built-in metric column.
    const metricCustomCol = (
      id: string,
      header: string,
      metricKey: string,
      width: number,
      fr: `${number}fr` = "2fr"
    ): DataTableColumnDef<Finding> => ({
      id,
      header,
      accessor: (row) => row.metrics?.[metricKey]?.sortValue ?? -Infinity,
      sortType: "number",
      minWidth: width,
      width: fr,
      alignment: "right",
      cell: ({ rowData }) => {
        const f = rowData as Finding;
        const m = f.metrics?.[metricKey];
        const missing =
          !m || m.value == null || m.value === "—" || m.value === "";
        if (missing)
          return (
            <div className={"cell-pad metric-cell-empty" + offCls(f)}>—</div>
          );
        return (
          <div
            className={
              (m.isIssue
                ? "cell-pad metric-cell-issue"
                : m.dim || f.severity !== "normal"
                ? "cell-pad metric-cell-fine"
                : "cell-pad metric-cell-normal") + offCls(f)
            }
            title={m.isIssue ? "Flagged" : "Within thresholds"}
          >
            <span className="metric-value">{m.value}</span>
          </div>
        );
      },
    });

    const metricMeta = new Map(
      metricColumnsFor(module).map((m) => [`metric-${m.key}`, m])
    );

    const hidden = hiddenColumnIds(module, appSettings, tab);
    const ordered = resolveColumnsForModule(module, appSettings, tab).filter(
      (c) => !hidden.has(c.id)
    );

    // Compute groups its metric columns under "CPU" and "Memory" parent headers
    // (nested `columns`). Membership comes from utils/columns so the table and
    // the Columns menu's draggable groups agree; Host and custom tag columns
    // stay top-level.
    const computeGroupOf = (desc: (typeof ordered)[number]) =>
      metricGroupOfColumn(module, desc);

    // Under a "CPU"/"Memory" group header the child headers shouldn't repeat
    // the word: strip a leading "CPU "/"Mem "/"Memory " and re-capitalize (so
    // "CPU max" → "Max", "Mem allocated" → "Allocated"). Counts like "vCPUs"
    // have no such prefix and are left alone. The Columns menu keeps the full,
    // disambiguated labels (it has no group context).
    //
    // Runs before the column is built: a column's width has to be measured
    // against the header it actually renders.
    const stripGroupPrefix = (
      header: string,
      group: "cpu" | "mem" | null
    ): string => {
      if (!group) return header;
      const prefixes = group === "cpu" ? ["cpu "] : ["memory ", "mem "];
      const lower = header.toLowerCase();
      for (const p of prefixes) {
        if (lower.startsWith(p)) {
          const rest = header.slice(p.length).trim();
          if (rest.length > 0) return rest.charAt(0).toUpperCase() + rest.slice(1);
          break;
        }
      }
      return header;
    };

    // Slack weight per metric column. Short-value columns take a lighter share
    // so they don't over-stretch: "Full in" (e.g. "3d", "99y+") the lightest,
    // IOPS a touch below the rest, and all of compute's stat columns light,
    // which leaves the slack for Host and custom tag columns. Built-in and
    // picker-made metric columns share this, so the two can't drift apart.
    const metricFr = (key: string): `${number}fr` =>
      module === "compute"
        ? "1.4fr"
        : key === "daysToFull"
        ? "1.6fr"
        : key.startsWith("iops")
        ? "1.8fr"
        : "2fr";

    // Builds the DataTable column def for one descriptor, or null if it maps to
    // nothing renderable. `group` is the compute CPU/Memory group it nests
    // under, null when it stays top-level.
    const colForDesc = (
      desc: (typeof ordered)[number],
      group: "cpu" | "mem" | null
    ): DataTableColumnDef<Finding> | null => {
      if (desc.id === "host") return hostCol;
      if (desc.id === "mount") return mountCol;
      if (desc.id.startsWith("metric-")) {
        const key = desc.id.slice("metric-".length);
        const meta = metricMeta.get(desc.id);
        const header = stripGroupPrefix(meta?.header ?? desc.label, group);
        return metricCol(key, header, meta?.width ?? 72, metricFr(key));
      }
      if (desc.custom?.source.type === "metric") {
        const mk = desc.custom.source.metricKey ?? "";
        const header = stripGroupPrefix(desc.label, group);
        // Match the built-in floor for this metric so a picker-made "CPU min"
        // sizes like the built-in "CPU avg" beside it; widen only when the
        // stripped header needs the room (a user-renamed column).
        const width = Math.max(
          metricValueWidth(module, mk),
          Math.round(measureTextWidth(header) + 24)
        );
        return metricCustomCol(desc.id, header, mk, width, metricFr(mk));
      }
      if (desc.custom?.source.type === "tag") {
        const source = desc.custom.source;
        return customCol(desc.id, desc.label, source, customWidth(desc.label, source));
      }
      return null;
    };

    const cols: DataTableColumnDef<Finding>[] = [];
    if (module === "compute") {
      // Each group holds a live reference to its children array, so the group
      // can be pushed early (fixing its position) and filled in afterward.
      const cpuChildren: DataTableColumnDef<Finding>[] = [];
      const memChildren: DataTableColumnDef<Finding>[] = [];
      let cpuPlaced = false;
      let memPlaced = false;
      for (const desc of ordered) {
        const g = computeGroupOf(desc);
        const col = colForDesc(desc, g);
        if (!col) continue;
        if (g === "cpu") {
          if (!cpuPlaced) {
            cols.push({
              id: "grp-cpu",
              header: "CPU",
              columns: cpuChildren,
            } as unknown as DataTableColumnDef<Finding>);
            cpuPlaced = true;
          }
          cpuChildren.push(col);
        } else if (g === "mem") {
          if (!memPlaced) {
            cols.push({
              id: "grp-mem",
              header: "Memory",
              columns: memChildren,
            } as unknown as DataTableColumnDef<Finding>);
            memPlaced = true;
          }
          memChildren.push(col);
        } else {
          cols.push(col);
        }
      }
    } else {
      for (const desc of ordered) {
        const col = colForDesc(desc, null);
        if (col) cols.push(col);
      }
    }

    // Details action column is always pinned last and isn't user-managed.
    cols.push({
      id: "info",
      header: "",
      accessor: (row) => row,
      minWidth: 84,
      maxWidth: 84,
      cell: ({ value }) => {
        const f = value as Finding;
        return (
          <div className={"cell-pad findings-row-action" + offCls(f)}>
            <Button
              variant="default"
              size="condensed"
              onClick={(e) => {
                e.stopPropagation();
                setSelected(f);
              }}
              aria-label="View details"
            >
              <InformationIcon />
            </Button>
          </div>
        );
      },
    });

    return cols;
  }, [module, appSettings, findings, tab]);

  // Export columns mirror the on-screen table (same visible columns, order, and
  // displayed values), minus the action column.
  const exportColumns = useMemo(() => {
    const hidden = hiddenColumnIds(module, appSettings, tab);
    const ordered = resolveColumnsForModule(module, appSettings, tab).filter(
      (c) => !hidden.has(c.id)
    );
    // Exports use the more explicit organizer label, so the memory % and
    // absolute-bytes columns don't both land as "Mem avg" in the file.
    const metricHeaders = new Map(
      metricColumnsFor(module).map((m) => [`metric-${m.key}`, m.managerLabel ?? m.header])
    );
    const cols: Array<{ header: string; get: (f: Finding) => string }> = [];
    for (const desc of ordered) {
      if (desc.id === "host") {
        cols.push({ header: "Host", get: (f) => f.entity.displayName });
      } else if (desc.id === "mount") {
        cols.push({ header: "Disk", get: (f) => f.entity.qualifier ?? "" });
      } else if (desc.id.startsWith("metric-")) {
        const key = desc.id.slice("metric-".length);
        cols.push({
          header: metricHeaders.get(desc.id) ?? desc.label,
          // Drop a leading "+" (Daily growth) so the common positive
          // case isn't read as a spreadsheet formula.
          get: (f) => (f.metrics?.[key]?.value ?? "").replace(/^\+/, ""),
        });
      } else if (desc.custom?.source.type === "metric") {
        const mk = desc.custom.source.metricKey ?? "";
        cols.push({
          header: desc.label,
          get: (f) => (f.metrics?.[mk]?.value ?? "").replace(/^\+/, ""),
        });
      } else if (desc.custom?.source.type === "tag") {
        const source = desc.custom.source;
        cols.push({
          header: desc.label,
          get: (f) => resolveTagColumnValue(source, f.tagValues),
        });
      }
    }
    return cols;
  }, [module, appSettings, tab]);

  const columnSignature = useMemo(
    () => columns.map((c) => c.id).join(","),
    [columns]
  );

  const handleExport = () => {
    // Local calendar date (not UTC), so the filename matches the day it's
    // downloaded in the user's timezone.
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    downloadCsv(
      `${module}-${tab}-${stamp}.csv`,
      tableToCsv(exportColumns, filtered)
    );
  };

  return (
    <Flex flexDirection="column" gap={12} className="page-section">
      <div className="findings-toolbar">
        <Flex className="findings-toolbar-actions" alignItems="center" gap={8}>
          <ToggleButtonGroup
            value={tab}
            onChange={(v) =>
              changeTab(v === "low" ? "low" : v === "normal" ? "normal" : "high")
            }
          >
            <ToggleButtonGroup.Item value="high">High</ToggleButtonGroup.Item>
            <ToggleButtonGroup.Item value="low">Low</ToggleButtonGroup.Item>
            <ToggleButtonGroup.Item value="normal">Normal</ToggleButtonGroup.Item>
          </ToggleButtonGroup>
        </Flex>
        <Flex className="findings-filters" alignItems="center" gap={8}>
          <div className="findings-search">
            <SearchInput
              placeholder="Search findings..."
              value={search}
              onChange={(v) => setSearch(String(v ?? ""))}
            />
          </div>
        </Flex>
        <Flex className="findings-toolbar-actions" alignItems="center" gap={8}>
          <Button
            variant="emphasized"
            onClick={() => setOpenModal("thresholds")}
            aria-label="Edit thresholds"
          >
            <Button.Prefix>
              <ThresholdIcon className="button-shave-margin-right-2" />
            </Button.Prefix>
            {FILTER_SHOW_LABEL ? "Thresholds" : null}
          </Button>
          <Button
            variant="emphasized"
            onClick={() => setOpenModal("filters")}
            aria-label="Edit filters"
          >
            <Button.Prefix>
              <FilterIcon className="button-shave-margin-right-2" />
            </Button.Prefix>
            {FILTER_SHOW_LABEL ? "Filters" : null}
          </Button>
          {appSettings.showManagementZoneFilter && <ScopeSelector />}
          <TimeframePicker />
          <Button
            variant="emphasized"
            onClick={() => onRefresh?.()}
            disabled={isLoading || !onRefresh}
            aria-label="Refresh data"
          >
            <Button.Prefix>
              <RefreshIcon />
            </Button.Prefix>
          </Button>
        </Flex>
      </div>

      <div className="findings-table-card">
        {isLoading ? (
          <Flex justifyContent="center" alignItems="center" className="table-loading">
            <ProgressCircle />
          </Flex>
        ) : findings.length === 0 ? (
          <div className="findings-empty">
            <Paragraph className="findings-empty-title">No findings detected</Paragraph>
            <Paragraph className="findings-empty-body">
              This page didn't surface any findings for the current scope. Either
              everything is within range, or the underlying metric data isn't available
              for this scope. Widen the scope or adjust the timeframe.
            </Paragraph>
          </div>
        ) : filtered.length === 0 ? (
          <div className="findings-empty">
            <Paragraph className="findings-empty-title">
              No {tab === "high" ? "overutilized" : tab === "low" ? "underutilized" : "normal"}{" "}
              {MODULE_BY_ID[module].recordNoun}s found
            </Paragraph>
            <Paragraph className="findings-empty-body">
              Nothing matches the current filter. Try widening the scope,
              adjusting the timeframe, or clearing the search.
            </Paragraph>
          </div>
        ) : (
          <DataTable
            key={`${defaultSortBy?.[0]?.id ?? "default"}|${columnSignature}`}
            data={filtered}
            columns={columns}
            className={`compact-table${module === "compute" ? " grouped-header" : ""}`}
            fullWidth
            fullHeight
            sortable
            defaultSortBy={defaultSortBy}
            variant={{
              verticalDividers: false,
              verticalAlignment: {
                // Compute has a two-row grouped header (CPU / Memory). Top
                // alignment keeps ungrouped columns that span both rows (Host,
                // the actions column) level with the group labels.
                header: module === "compute" ? "top" : "center",
                body: "center",
              },
              rowDensity: "condensed",
            }}
          />
        )}
      </div>

      <Flex
        className="findings-footer"
        justifyContent="space-between"
        alignItems="center"
        gap={8}
      >
        <Paragraph className="text-count">
          {inScopeForTab != null
            ? `${tabCount.toLocaleString()} of ${inScopeForTab.toLocaleString()} in-scope ${recordNoun}s`
            : `${tabCount.toLocaleString()} ${recordNoun}${tabCount === 1 ? "" : "s"}`}
        </Paragraph>
        <Flex className="findings-footer-actions" gap={8} alignItems="center">
          <Button
            variant="emphasized"
            onClick={handleExport}
            disabled={filtered.length === 0}
            aria-label="Export"
          >
            <Button.Prefix>
              <DownloadIcon />
            </Button.Prefix>
            {EXPORT_SHOW_LABEL ? "Export" : null}
          </Button>
          <ColumnsMenu
            module={module}
            usageView={tab}
            onUsageViewChange={changeTab}
          />
          <Button
            variant="emphasized"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <Button.Prefix>
              <SettingIcon />
            </Button.Prefix>
            {SETTINGS_SHOW_LABEL ? "Settings" : null}
          </Button>
        </Flex>
      </Flex>

      <FindingDetailsModal
        finding={selected}
        onClose={() => setSelected(null)}
        onStateChanged={onStateChanged}
      />

      <ThresholdSettingsModal
        module={module}
        open={openModal !== null}
        variant={openModal ?? "thresholds"}
        onClose={() => setOpenModal(null)}
        onSaved={(t) => {
          onThresholdsSaved?.(t);
        }}
        usageView={usageView}
        onUsageViewChange={setUsageView}
        showSnoozed={showSnoozed}
        onShowSnoozedChange={setShowSnoozed}
        inScopeEither={inScope}
      />

      <AppSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </Flex>
  );
};
