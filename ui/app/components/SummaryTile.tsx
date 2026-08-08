import { useNavigate } from "react-router-dom";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { MeterBarChart } from "@dynatrace/strato-components/charts";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { Button } from "@dynatrace/strato-components/buttons";
import { ListIcon } from "@dynatrace/strato-icons";
import { Flex } from "@dynatrace/strato-components/layouts";
import type { ModuleId, OverviewCacheEntry } from "../types/types";
import { MODULE_BY_ID } from "../constants/modules";
import { relativeFromNow, severityLabel } from "../utils/helpers";

export interface SummaryTileProps {
  module: ModuleId;
  /** Cached counts for this module, if any have been recorded. */
  entry?: OverviewCacheEntry;
  /** Greyed-out, non-navigable modules (Kubernetes, Scaling). */
  disabled?: boolean;
  /** The Overview is auto-populating this tile's data in the background. */
  loading?: boolean;
}

type BarColor = "critical" | "warning" | "primary" | "success";

// Strato chart status colors per severity intent (theme-adaptive `var(...)`
// tokens): at capacity = Critical, high = Warning, low = Good, normal = Ideal.
const METER_COLOR: Record<BarColor, string> = {
  critical: Colors.Charts.Status.Critical.Default,
  warning: Colors.Charts.Status.Warning.Default,
  primary: Colors.Charts.Status.Good.Default,
  success: Colors.Charts.Status.Ideal.Default,
};

/**
 * Turn slice counts into display percentages that:
 *   - never show 100% unless a slice is the whole population (every other
 *     slice is 0): a 99.6% slice reads ">99%";
 *   - never show 0% for a slice with any records; that reads "<1%";
 *   - sum to exactly 100 across the countable slices. Rounding can leave the
 *     total at 99 or 101, so the slices furthest from their rounded value take
 *     a ±1 nudge (largest rounding error first). "<1%" slices stay out of that
 *     reconciliation.
 * Returns a { key: displayString } map.
 */
function computeShares(
  slices: { key: string; count: number }[],
  total: number
): Record<string, string> {
  const out: Record<string, string> = {};
  if (total <= 0) {
    for (const s of slices) out[s.key] = "0%";
    return out;
  }
  type Item = {
    key: string;
    exact: number;
    base: number;
    kind: "zero" | "sub1" | "full" | "normal";
    atCeil: boolean;
    idx: number;
  };
  const items: Item[] = slices.map((s, idx) => {
    const exact = (s.count / total) * 100;
    let kind: Item["kind"];
    if (s.count === 0) kind = "zero";
    else if (s.count === total) kind = "full";
    else if (Math.round(exact) === 0) kind = "sub1";
    else kind = "normal";
    // Normal slices clamp to 1..99: they have records so never 0, and only a
    // whole-population slice earns 100 (one that rounds up reads ">99%").
    const base = kind === "normal" ? Math.min(99, Math.max(1, Math.round(exact))) : 0;
    const atCeil = kind === "normal" && Math.round(exact) >= 100;
    return { key: s.key, exact, base, kind, atCeil, idx };
  });

  // Reconcile the adjustable (normal) slices to sum to 100. Fixed slices: zero
  // = 0, and a full slice = 100 with no normals alongside it.
  const normals = items.filter((i) => i.kind === "normal");
  let diff = 100 - normals.reduce((a, i) => a + i.base, 0);
  while (diff !== 0) {
    if (diff > 0) {
      const cand = normals.filter((i) => i.base < 99);
      if (cand.length === 0) break;
      // Most rounded-down first (largest exact - base); ties keep slice order.
      cand.sort((a, b) => b.exact - b.base - (a.exact - a.base) || a.idx - b.idx);
      cand[0].base += 1;
      diff -= 1;
    } else {
      const cand = normals.filter((i) => i.base > 1);
      if (cand.length === 0) break;
      // Most rounded-up first (smallest exact - base); ties keep slice order.
      cand.sort((a, b) => a.exact - a.base - (b.exact - b.base) || a.idx - b.idx);
      cand[0].base -= 1;
      diff += 1;
    }
  }

  for (const i of items) {
    out[i.key] =
      i.kind === "zero"
        ? "0%"
        : i.kind === "full"
        ? "100%"
        : i.kind === "sub1"
        ? "<1%"
        : i.atCeil
        ? ">99%"
        : `${i.base}%`;
  }
  return out;
}

/** Bar fill (0-100) that matches the displayed label, with a visible sliver
 *  for "<1%". */
function shareFill(share: string): number {
  if (share === "<1%") return 1;
  if (share === ">99%") return 99;
  const n = parseInt(share, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Overview tile per module. Renders the module's record population from the
 * shared cache as MeterBarCharts (At capacity, High usage, Low usage, and
 * Normal, the remainder) ordered by size. Bars appear only once both usage
 * halves and the in-scope population are recorded, so the Normal remainder is
 * trustworthy; otherwise the tile shows a loading or empty state. The footer
 * "View" button links to the module page. Disabled modules are greyed and inert.
 */
export const SummaryTile = ({ module, entry, disabled, loading }: SummaryTileProps) => {
  const config = MODULE_BY_ID[module];
  const navigate = useNavigate();

  // nominal = inScope - (atCapacity + high + low), so the breakdown needs both
  // usage halves and the in-scope population (records past every non-usage
  // filter, deduped across tabs); `scanned` is the fallback for cache entries
  // written without `inScope`. Flagged rows are a subset of in-scope, so the
  // floor below keeps a stale in-scope from dropping under them and blanking a
  // tile that clearly has findings.
  const flagged = entry?.total ?? 0;
  // Records shown for context but counted in no severity: a disk at 100% that
  // the High tier's size limit excludes. They sit inside `inScope` but outside
  // `total`, so they get their own slice below instead of padding the Normal
  // remainder. The module table does the same: row visible, out of the count.
  const excluded = entry?.limitExcluded ?? 0;
  const inScope = Math.max(entry?.inScope ?? entry?.scanned ?? 0, flagged + excluded);
  const fullyComputed =
    !!entry &&
    !!entry.highUpdatedAt &&
    !!entry.lowUpdatedAt &&
    !entry.notApplicable &&
    inScope > 0;

  // "As of" reflects the oldest recorded half: highs refreshed today alongside
  // three-day-old lows read "as of 3d ago".
  const oldestQueriedAt = [entry?.highUpdatedAt, entry?.lowUpdatedAt]
    .filter((t): t is string => !!t)
    .sort((a, b) => (a < b ? -1 : 1))[0];

  const nominalCount = Math.max(0, inScope - flagged - excluded);
  // The excluded slice exists only when a size limit excluded something; every
  // other tile keeps the familiar four bars.
  const slices = [
    { key: "atCapacity", count: entry?.atCapacity ?? 0 },
    { key: "highUsage", count: entry?.highUsage ?? 0 },
    { key: "lowUsage", count: entry?.lowUsage ?? 0 },
    { key: "nominal", count: nominalCount },
    ...(excluded > 0 ? [{ key: "limitExcluded", count: excluded }] : []),
  ];
  const shares = fullyComputed ? computeShares(slices, inScope) : {};

  const bars = fullyComputed
    ? (
        [
          { key: "atCapacity", label: severityLabel("atCapacity"), count: entry!.atCapacity, color: "critical" },
          { key: "highUsage", label: severityLabel("highUsage"), count: entry!.highUsage, color: "warning" },
          { key: "lowUsage", label: severityLabel("lowUsage"), count: entry!.lowUsage, color: "primary" },
          { key: "nominal", label: "Normal", count: nominalCount, color: "success" },
          // Same Critical colour as At capacity (that's what these are) but
          // muted, matching how the table dims the row.
          ...(excluded > 0
            ? [
                {
                  key: "limitExcluded",
                  label: "At capacity (size limit)",
                  count: excluded,
                  color: "critical" as BarColor,
                  muted: true,
                },
              ]
            : []),
        ] as { key: string; label: string; count: number; color: BarColor; muted?: boolean }[]
      ).sort((a, b) => b.count - a.count)
    : [];

  return (
    <div
      className={`summary-tile${disabled ? " summary-tile-disabled" : ""}`}
      aria-disabled={disabled ? "true" : undefined}
    >
      <div className="summary-tile-top">
        <Heading level={4} className="summary-tile-name">
          {config.name}
        </Heading>
        <Paragraph className="summary-tile-desc">{config.description}</Paragraph>
      </div>

      <div className="summary-tile-bottom">
        {disabled ? (
          <Paragraph className="text-subdued">Currently unavailable.</Paragraph>
        ) : entry?.notApplicable ? (
          <Paragraph className="text-subdued">Not applicable in this scope.</Paragraph>
        ) : loading && !fullyComputed ? (
          <Flex alignItems="center" gap={8}>
            <ProgressCircle />
            <Paragraph className="text-subdued">Loading…</Paragraph>
          </Flex>
        ) : !fullyComputed ? (
          <Paragraph className="text-subdued">
            Not computed yet. Open the {config.shortName} page to compute it.
          </Paragraph>
        ) : (
          <div className="summary-tile-bars">
            {bars.map((b) => (
              <div
                key={b.key}
                className={b.muted ? "summary-tile-bar-muted" : undefined}
                title={
                  b.muted
                    ? "At capacity but outside the High size limit. Shown for context, not counted as a finding."
                    : undefined
                }
              >
                <MeterBarChart
                  value={shareFill(shares[b.key])}
                  min={0}
                  max={100}
                  size="size8"
                  color={METER_COLOR[b.color]}
                  aria-label={`${b.label}: ${b.count.toLocaleString()} of ${inScope.toLocaleString()}`}
                >
                  <MeterBarChart.Label>
                    <strong>{b.label}</strong> • {b.count.toLocaleString()}
                  </MeterBarChart.Label>
                  <MeterBarChart.Value>{shares[b.key]}</MeterBarChart.Value>
                </MeterBarChart>
              </div>
            ))}
          </div>
        )}

        {!disabled && (
          <div className="summary-tile-footer">
            <div className="summary-tile-footer-left">
              {fullyComputed && (
                <>
                  <Text>
                    {inScope.toLocaleString()} {config.recordNoun}
                    {inScope === 1 ? "" : "s"}
                  </Text>
                  <Text className="summary-tile-asof">
                    • as of {relativeFromNow(oldestQueriedAt ?? entry!.dataAsOf ?? entry!.updatedAt)}
                  </Text>
                </>
              )}
            </div>
            <div className="summary-tile-footer-right">
              <Button
                className="summary-tile-view-btn"
                variant="emphasized"
                onClick={() => navigate(config.path)}
                aria-label={`View ${config.recordNoun}s`}
              >
                <Button.Prefix>
                  <ListIcon />
                </Button.Prefix>
                View {config.recordNoun}s
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
