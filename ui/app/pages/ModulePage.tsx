import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import { FindingsTable } from "../components/FindingsTable";
import { EmptyState } from "../components/EmptyState";
import { useScope, isCanonicalOverviewContext } from "../contexts/ScopeContext";
import {
  fetchFindings,
  writeOverviewCacheSides,
  writePersonalOverviewCacheSides,
} from "../api/api";
import type { Finding, ModuleId } from "../types/types";
import { EMPTY_HOST_FILTER } from "../types/types";
import { MODULE_BY_ID } from "../constants/modules";
import {
  hiddenColumnIds,
  resolveColumnsForModule,
  resolveSubmoduleFilter,
  tagColumnKeys as sourceTagKeys,
} from "../utils/columns";
import { countBySeverity } from "../utils/helpers";

export interface ModulePageProps {
  module: ModuleId;
}

/**
 * Generic module page: a header plus the FindingsTable. The table owns its own
 * toolbar (search, scope, timeframe) and the Filter modal.
 */
export const ModulePage = ({ module }: ModulePageProps) => {
  const config = MODULE_BY_ID[module];
  // Thresholds are the user's effective set (team default + personal overrides),
  // owned by the context, so a filter save or reset flows straight through.
  // `ctxLoading` gates the first fetch until the context settles, so the initial
  // load uses the real thresholds and host-name rules, not the hardcoded default.
  const {
    scope,
    timeframe,
    filterFor,
    appSettings,
    thresholds,
    isSubmoduleAtTeamDefault,
    isLoading: ctxLoading,
  } = useScope();
  // The table's High/Low view, owned here so a "view"-scope filter can be
  // resolved for the current tab and the page recomputes when the tab changes.
  const [usageView, setUsageView] = useState<"high" | "low">("high");

  // Host-name preference + the tag keys backing this page's visible custom
  // columns. Only these drive extra queries; reordering or hiding built-ins
  // doesn't refetch, and a hidden custom column drops out of the key set.
  const hostNameSource = appSettings.hostNameSource;
  // Tag columns visible in ANY tab are fetched, so switching High / Low / Normal
  // never triggers a refetch.
  const tagColumnKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const view of ["high", "low", "normal"] as const) {
      const hidden = hiddenColumnIds(module, appSettings, view);
      for (const c of resolveColumnsForModule(module, appSettings, view)) {
        if (!hidden.has(c.id) && c.custom?.source.type === "tag") {
          // Primary + all fallback tag keys need fetching.
          for (const k of sourceTagKeys(c.custom.source)) keys.add(k);
        }
      }
    }
    return Array.from(keys);
  }, [module, appSettings]);
  const tagKeysSig = tagColumnKeys.join(",");
  const windowSig = `${appSettings.windowDays}|${appSettings.resourceWindowSync}|${appSettings.dataResolution}`;

  const [findings, setFindings] = useState<Finding[]>([]);
  const [, setDataAsOf] = useState<string | undefined>(undefined);
  const [inScope, setInScope] = useState<number | undefined>(undefined);
  const [notApplicable, setNotApplicable] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // Monotonic id for the most recently started load. An older in-flight request
  // can resolve after a newer one; its stale rows must not overwrite the newer
  // filter's, so any response whose id is no longer the latest is dropped.
  const loadSeq = useRef(0);

  const load = useCallback(
    async () => {
      const mySeq = ++loadSeq.current;
      setIsLoading(true);
      try {
        const result = await fetchFindings({
          module,
          scope,
          timeframe,
          thresholds,
          filter: resolveSubmoduleFilter(
            filterFor(module, usageView),
            module,
            appSettings,
            usageView
          ),
          hostNameSource,
          tagColumnKeys,
          forecastWindowDays: appSettings.windowDays,
          resourceWindowDays: appSettings.windowDays,
          resourceWindowSync: appSettings.resourceWindowSync,
          dataResolution: appSettings.dataResolution,
          includeNormal: true,
        });
        // A newer load superseded this one while it was in flight; discard.
        if (mySeq !== loadSeq.current) return;
        setFindings(result.findings);
        setDataAsOf(result.dataAsOf);
        setInScope(result.inScope);
        setNotApplicable(Boolean(result.notApplicable));

        // Record this module's counts in the Overview cache, but only for the
        // canonical scope + timeframe (all zones, default timeframe), so cached
        // numbers stay comparable. A side at the team default feeds the shared
        // cache, a personalized side the user's own, and the Overview blends
        // them per submodule. The low half counts as team-default only when high
        // is too: a row is only low if it didn't already fire high.
        // Fire-and-forget.
        if (isCanonicalOverviewContext(scope, timeframe, EMPTY_HOST_FILTER)) {
          const at = new Date().toISOString();
          if (result.notApplicable) {
            // N/A is structural (scope-based), independent of filter/threshold.
            void writeOverviewCacheSides(module, {
              high: { atCapacity: 0, highUsage: 0, dataAsOf: result.dataAsOf },
              low: { lowUsage: 0, dataAsOf: result.dataAsOf },
              scanned: result.scanned,
              inScope: result.inScope,
              notApplicable: true,
              at,
            });
          } else {
            const counts = countBySeverity(result.findings);
            const atHigh = isSubmoduleAtTeamDefault(module, "high");
            const atLow = atHigh && isSubmoduleAtTeamDefault(module, "low");
            const highSide = {
              atCapacity: counts.atCapacity,
              highUsage: counts.highUsage,
              dataAsOf: result.dataAsOf,
            };
            const lowSide = { lowUsage: counts.lowUsage, dataAsOf: result.dataAsOf };
            if (atHigh || atLow) {
              void writeOverviewCacheSides(module, {
                high: atHigh ? highSide : undefined,
                low: atLow ? lowSide : undefined,
                scanned: result.scanned,
                inScope: result.inScope,
                limitExcluded: counts.limitExcluded,
                notApplicable: false,
                at,
              });
            }
            if (!atHigh || !atLow) {
              void writePersonalOverviewCacheSides(module, {
                high: !atHigh ? highSide : undefined,
                low: !atLow ? lowSide : undefined,
                scanned: result.scanned,
                inScope: result.inScope,
                limitExcluded: counts.limitExcluded,
                notApplicable: false,
                at,
              });
            }
          }
        }
      } catch (err) {
        if (mySeq !== loadSeq.current) return;
        console.error(err);
        setFindings([]);
        setNotApplicable(false);
      } finally {
        // Only the latest load owns the loading flag.
        if (mySeq === loadSeq.current) setIsLoading(false);
      }
    },
    [
      module,
      scope,
      timeframe,
      filterFor,
      usageView,
      thresholds,
      hostNameSource,
      tagColumnKeys,
      isSubmoduleAtTeamDefault,
      appSettings,
    ]
  );

  // Signature of the resolved Filters bundle for the current (module, view), so
  // a filter change (or a tab change under "view" scope) triggers a reload.
  const currentFilterSig = useMemo(
    () =>
      JSON.stringify(
        resolveSubmoduleFilter(
          filterFor(module, usageView),
          module,
          appSettings,
          usageView
        )
      ),
    [filterFor, module, usageView, appSettings]
  );

  // Reload on scope / filter / config changes. Gated on ctxLoading so the first
  // fetch waits for the context to settle the effective config.
  //
  // Flipping the High/Low tab does NOT reload on its own: one fetch computes
  // every severity (atCapacity / high / low / normal) and the table filters
  // client-side, so all tabs are ready from the initial query. A tab change
  // reloads only when it changes the resolved filter ("view"-scope filters that
  // differ per tab), which surfaces via currentFilterSig.
  useEffect(() => {
    if (ctxLoading) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxLoading, scope, module, timeframe, currentFilterSig, hostNameSource, tagKeysSig, windowSig]);

  // A thresholds change (Filter save or Reset) needs a recompute, since severity
  // is decided engine-side. The first value after the context loads is only a
  // baseline; the initial settle is handled by the effect above.
  const thresholdsSig = useMemo(() => JSON.stringify(thresholds), [thresholds]);
  const baselineThresholdsSig = useRef<string | null>(null);
  useEffect(() => {
    if (ctxLoading) return;
    if (baselineThresholdsSig.current === null) {
      baselineThresholdsSig.current = thresholdsSig;
      return;
    }
    if (baselineThresholdsSig.current === thresholdsSig) return;
    baselineThresholdsSig.current = thresholdsSig;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxLoading, thresholdsSig]);

  const scopeLabel = useMemo(() => scope.name, [scope]);

  // Pre-sort disk rows so the table opens ordered WITHOUT a sort arrow being
  // active. Clicking a header still sorts; this only seeds the initial order.
  const displayFindings = useMemo(() => {
    if (module !== "disk") return findings;
    const disk = thresholds.disk;
    const anyPercent =
      disk.highUsage.percent.enabled || disk.lowUsage.percent.enabled;
    const anyDays = disk.highUsage.days.enabled || disk.lowUsage.days.enabled;
    const key = anyDays && !anyPercent ? "daysToFull" : "diskUsed";
    return [...findings].sort(
      (a, b) =>
        (b.metrics?.[key]?.sortValue ?? -Infinity) -
        (a.metrics?.[key]?.sortValue ?? -Infinity)
    );
  }, [findings, module, thresholds]);

  return (
    <Flex flexDirection="column" gap={16} className="page-container">
      <div className="page-header-row">
        <div className="page-title-block">
          <Heading level={3}>{config.name}</Heading>
          <Paragraph className="page-subtitle">{config.description}</Paragraph>
        </div>
      </div>

      {notApplicable ? (
        <EmptyState
          title={`No ${config.shortName.toLowerCase()} entities in this scope`}
          body={`The current scope (${scopeLabel}) has no entities this page evaluates. Pick a different scope to see findings.`}
        />
      ) : (
        <FindingsTable
          findings={displayFindings}
          isLoading={isLoading}
          onStateChanged={() => void load()}
          onRefresh={() => void load()}
          module={module}
          inScope={inScope}
          usageView={usageView}
          onUsageViewChange={setUsageView}
          // No defaultSortBy: `displayFindings` is already sorted, so no sort
          // arrow is highlighted.
        />
      )}
    </Flex>
  );
};
