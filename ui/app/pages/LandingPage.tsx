import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Paragraph } from "@dynatrace/strato-components/typography";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import { SettingIcon, FilterIcon } from "@dynatrace/strato-icons";
import { SummaryTile } from "../components/SummaryTile";
import { ScopeSelector } from "../components/ScopeSelector";
// Timeframe picker hidden on the Overview.
// import { TimeframePicker } from "../components/TimeframePicker";
import { ThresholdSettingsModal } from "../components/ThresholdSettingsModal";
import { AppSettingsModal } from "../components/AppSettingsModal";
import { SETTINGS_SHOW_LABEL } from "../constants/ui-toggles";
import { useScope, isCanonicalOverviewContext } from "../contexts/ScopeContext";
import {
  fetchFindings,
  fetchOverviewCache,
  fetchPersonalOverviewCache,
  writeOverviewCacheSides,
  writePersonalOverviewCacheSides,
} from "../api/api";
import type {
  ModuleId,
  OverviewCache,
  OverviewCacheEntry,
} from "../types/types";
import { EMPTY_HOST_FILTER } from "../types/types";
import { MODULES, ENABLED_MODULES } from "../constants/modules";
import { countBySeverity } from "../utils/helpers";
import { resolveSubmoduleFilter } from "../utils/columns";

type FindingsResult = Awaited<ReturnType<typeof fetchFindings>>;
type Entries = Partial<Record<ModuleId, OverviewCacheEntry>>;

/** Cache entry with both halves stamped at the same time. */
function entryFromResult(r: FindingsResult, now: string): OverviewCacheEntry {
  // countBySeverity also supplies limitExcluded, so the tile can subtract the
  // excluded records rather than rolling them into its "Normal" remainder.
  return {
    ...countBySeverity(r.findings),
    scanned: r.scanned,
    inScope: r.inScope,
    notApplicable: Boolean(r.notApplicable),
    highUpdatedAt: now,
    lowUpdatedAt: now,
    highDataAsOf: r.dataAsOf,
    lowDataAsOf: r.dataAsOf,
    dataAsOf: r.dataAsOf,
    updatedAt: now,
  };
}

/** Whether a result carries population data. A failed live-compute returns
 *  `{ findings: [], dataAsOf }` with no scanned / inScope; recording that would
 *  blank a good tile to "not computed", so the refresh skips it. */
function isUsableResult(r: FindingsResult): boolean {
  return (
    Boolean(r.notApplicable) ||
    typeof r.scanned === "number" ||
    r.inScope != null ||
    r.findings.length > 0
  );
}

/** Epoch millis for an entry's recency; 0 when unstamped or unparseable, which
 *  reads as oldest. */
function entryTime(e?: OverviewCacheEntry): number {
  const t = e?.updatedAt ?? e?.dataAsOf;
  const n = t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** On open, the auto-refresh is skipped when the snapshot already on screen is
 *  this fresh. A picker or threshold change always refreshes. */
const FRESH_ON_OPEN_MS = 5 * 60 * 1000;

/** A missing tile counts as stale, so a cold install still refreshes. */
function snapshotFresh(entries: Entries, now: number): boolean {
  return ENABLED_MODULES.every((m) => {
    const t = entryTime(entries[m.id]);
    return t > 0 && now - t < FRESH_ON_OPEN_MS;
  });
}

function olderIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** True when a submodule reads the shared team cache, false for the user's own. */
type SideSource = (module: ModuleId, side: "high" | "low") => boolean;

/**
 * Blend the shared and personal caches per submodule for the pre-refresh
 * snapshot. Each module's high and low halves come from whichever cache
 * `teamSide` routes them to, falling back to the other cache when the chosen one
 * has no entry yet. A tile's "as of" is the OLDER of its two halves.
 */
function blendCaches(
  shared: OverviewCache | null,
  local: OverviewCache | null,
  teamSide: SideSource
): OverviewCache {
  const sm = shared?.modules ?? {};
  const lm = local?.modules ?? {};
  const modules: Entries = {};
  const ids = new Set<ModuleId>([
    ...(Object.keys(sm) as ModuleId[]),
    ...(Object.keys(lm) as ModuleId[]),
  ]);
  for (const id of ids) {
    const s = sm[id];
    const l = lm[id];
    const highSrc = (teamSide(id, "high") ? s : l) ?? l ?? s;
    const lowSrc = (teamSide(id, "low") ? s : l) ?? l ?? s;
    if (!highSrc && !lowSrc) continue;
    const atCapacity = highSrc?.atCapacity ?? 0;
    const highUsage = highSrc?.highUsage ?? 0;
    const lowUsage = lowSrc?.lowUsage ?? 0;
    modules[id] = {
      atCapacity,
      highUsage,
      lowUsage,
      total: atCapacity + highUsage + lowUsage,
      scanned: highSrc?.scanned ?? lowSrc?.scanned,
      inScope: highSrc?.inScope ?? lowSrc?.inScope,
      // Only the high tier produces limit-excluded records, so prefer the high
      // source and fall back to low the same way scanned / inScope do.
      limitExcluded: highSrc?.limitExcluded ?? lowSrc?.limitExcluded,
      notApplicable: highSrc?.notApplicable ?? lowSrc?.notApplicable,
      highUpdatedAt: highSrc?.highUpdatedAt,
      lowUpdatedAt: lowSrc?.lowUpdatedAt,
      highDataAsOf: highSrc?.highDataAsOf,
      lowDataAsOf: lowSrc?.lowDataAsOf,
      dataAsOf: olderIso(highSrc?.highDataAsOf, lowSrc?.lowDataAsOf),
      // `updatedAt` is required; fall back to epoch so a missing stamp reads as
      // stale, not fresh.
      updatedAt:
        olderIso(highSrc?.updatedAt, lowSrc?.updatedAt) ?? new Date(0).toISOString(),
    };
  }
  return { modules };
}

/**
 * Overview page.
 *
 * Tiles render from cache on open, then the page recomputes the current view
 * (the pickers plus the user's own thresholds) and swaps in the live numbers.
 * Caching is per side: a side at the team default (canonical pickers) goes to
 * the shared team cache, a personalized side to the user's browser-local cache.
 * `blendCaches` recombines them per submodule for the pre-refresh snapshot.
 */
export const LandingPage = () => {
  const {
    scope,
    timeframe,
    filterFor,
    thresholds,
    appSettings,
    isSubmoduleAtTeamDefault,
    isLoading: ctxLoading,
  } = useScope();
  // App-wide Filters dialog (host / disk name rules, tags, OS, deployment); it
  // edits the same scope the tiles query.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);

  // Blended (shared + personal) cache read on open. `liveEntries` holds a
  // freshly computed view and overrides the cache once set.
  const [cache, setCache] = useState<OverviewCache | null>(null);
  const [liveEntries, setLiveEntries] = useState<Partial<
    Record<ModuleId, OverviewCacheEntry>
  > | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Modules currently recomputing (per-tile spinner).
  const [autoLoading, setAutoLoading] = useState<Set<ModuleId>>(new Set());
  const loadSeq = useRef(0);

  // The context loads scope / timeframe / thresholds asynchronously, so the
  // on-open refresh waits for both it and the cache read before querying.
  const settled = !isLoading && !ctxLoading;

  // Canonical pickers: all hosts, default timeframe, no host filter. With the
  // per-module thresholds this decides which cache a refreshed module is written
  // to; it does not gate the refresh itself.
  const canonicalPickers = useMemo(
    () => isCanonicalOverviewContext(scope, timeframe, EMPTY_HOST_FILTER),
    [scope, timeframe]
  );

  // Shared team cache when the user is at the team default, otherwise their own.
  // The low side additionally requires high to be at default: a row is only low
  // if it didn't fire high, so low counts shift with the high filter.
  const teamSide = useCallback<SideSource>(
    (id, side) =>
      side === "high"
        ? isSubmoduleAtTeamDefault(id, "high")
        : isSubmoduleAtTeamDefault(id, "high") && isSubmoduleAtTeamDefault(id, "low"),
    [isSubmoduleAtTeamDefault]
  );

  const runViewQuery = useCallback(
    (module: ModuleId): Promise<FindingsResult> =>
      fetchFindings({
        module,
        scope,
        timeframe,
        thresholds,
        filter: resolveSubmoduleFilter(
          filterFor(module, "high"),
          module,
          appSettings,
          "high"
        ),
        hostNameSource: appSettings.hostNameSource,
        forecastWindowDays: appSettings.windowDays,
        resourceWindowDays: appSettings.windowDays,
        resourceWindowSync: appSettings.resourceWindowSync,
        dataResolution: appSettings.dataResolution,
      }),
    [scope, timeframe, thresholds, filterFor, appSettings]
  );

  // Route each refreshed module's halves per side: a side at the team default
  // (with canonical pickers) feeds the shared cache, a personalized side feeds
  // the user's own.
  const persistEntries = useCallback(
    (entries: Entries) => {
      for (const id of Object.keys(entries) as ModuleId[]) {
        const e = entries[id];
        if (!e) continue;
        const at = e.updatedAt ?? new Date().toISOString();
        if (e.notApplicable) {
          // Structural (scope-based), independent of filter/threshold → shared.
          void writeOverviewCacheSides(id, {
            high: { atCapacity: 0, highUsage: 0, dataAsOf: e.highDataAsOf },
            low: { lowUsage: 0, dataAsOf: e.lowDataAsOf },
            scanned: e.scanned,
            inScope: e.inScope,
            notApplicable: true,
            at,
          });
          continue;
        }
        const atHigh = canonicalPickers && teamSide(id, "high");
        const atLow = canonicalPickers && teamSide(id, "low");
        const highSide = {
          atCapacity: e.atCapacity,
          highUsage: e.highUsage,
          dataAsOf: e.highDataAsOf,
        };
        const lowSide = { lowUsage: e.lowUsage, dataAsOf: e.lowDataAsOf };
        const common = {
          scanned: e.scanned,
          inScope: e.inScope,
          limitExcluded: e.limitExcluded,
          notApplicable: false,
          at,
        };
        if (atHigh || atLow) {
          void writeOverviewCacheSides(id, {
            high: atHigh ? highSide : undefined,
            low: atLow ? lowSide : undefined,
            ...common,
          });
        }
        if (!atHigh || !atLow) {
          void writePersonalOverviewCacheSides(id, {
            high: !atHigh ? highSide : undefined,
            low: !atLow ? lowSide : undefined,
            ...common,
          });
        }
      }
    },
    [canonicalPickers, teamSide]
  );

  const recompute = useCallback(async () => {
    const seq = ++loadSeq.current;
    setIsRefreshing(true);
    setAutoLoading(new Set(ENABLED_MODULES.map((m) => m.id)));
    try {
      const now = new Date().toISOString();
      const results = await Promise.all(
        ENABLED_MODULES.map(async (m) => ({ id: m.id, r: await runViewQuery(m.id) }))
      );
      if (seq !== loadSeq.current) return; // superseded by a newer view
      // Skip failed queries so a previously good tile survives the refresh
      // instead of blanking to "not computed".
      const fresh: Entries = {};
      for (const { id, r } of results) {
        if (isUsableResult(r)) fresh[id] = entryFromResult(r, now);
      }
      setLiveEntries((prev) => ({
        ...(prev ?? cache?.modules ?? {}),
        ...fresh,
      }));
      persistEntries(fresh);
    } catch (err) {
      console.error("Overview recompute failed", err);
    } finally {
      if (seq === loadSeq.current) {
        setIsRefreshing(false);
        setAutoLoading(new Set());
      }
    }
  }, [runViewQuery, persistEntries, cache]);

  // Read both caches on open. Resets the refresh guard so the on-open refresh
  // fires once for the freshly settled view.
  const lastSigRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    setIsLoading(true);
    setLiveEntries(null);
    lastSigRef.current = null;
    Promise.all([fetchOverviewCache(), fetchPersonalOverviewCache()])
      .then(([shared, local]) => {
        if (alive) setCache(blendCaches(shared, local, teamSide));
      })
      .finally(() => {
        if (alive) setIsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [teamSide]);

  const entriesByModule: Entries = liveEntries ?? cache?.modules ?? {};

  // Hidden while the summary line below is commented out.
  // const totalFindings = useMemo(
  //   () =>
  //     ENABLED_MODULES.reduce(
  //       (acc, m) => acc + (entriesByModule[m.id]?.total ?? 0),
  //       0
  //     ),
  //   [entriesByModule]
  // );

  const hasAnyCached = ENABLED_MODULES.some((m) => !!entriesByModule[m.id]);

  // Refresh when the page settles and on any picker / threshold change.
  // `lastSigRef` dedupes so each distinct view refreshes only once. The on-open
  // refresh is skipped when the shown snapshot is still fresh (< 5 min); a view
  // change always refreshes, since its cache is for a different view.
  const viewSig = useMemo(
    () => JSON.stringify([scope, timeframe, appSettings.filters, thresholds]),
    [scope, timeframe, appSettings.filters, thresholds]
  );
  useEffect(() => {
    if (!settled) return;
    if (lastSigRef.current === viewSig) return;
    const onOpen = lastSigRef.current === null;
    lastSigRef.current = viewSig;
    if (onOpen && snapshotFresh(cache?.modules ?? {}, Date.now())) return;
    void recompute();
  }, [settled, viewSig, recompute, cache]);

  return (
    <Flex flexDirection="column" gap={16} className="landing-container">
      <Flex
        justifyContent="space-between"
        alignItems="center"
        className="page-header-row"
      >
        {/* Findings summary hidden for now.
        <Text>
          {totalFindings} findings across {ENABLED_MODULES.length} pages
        </Text> */}
        <span />
        <Flex gap={8} alignItems="center" className="page-actions">
          {/* Filters are app-wide only in "app" scope; in per-module / per-view
              scope there is no single filter to edit from the Overview. */}
          {appSettings.filterScope === "app" && (
            <Button
              variant="emphasized"
              onClick={() => setFiltersOpen(true)}
              aria-label="Edit filters"
            >
              <Button.Prefix>
                <FilterIcon />
              </Button.Prefix>
              Filters
            </Button>
          )}
          {appSettings.showManagementZoneFilter && <ScopeSelector />}
          {/* Timeframe picker + manual Refresh hidden for now. The on-open
              auto-refresh still runs, so the Overview refreshes on load after
              showing the cache.
          <TimeframePicker />
          <Button
            variant="emphasized"
            onClick={() => void recompute()}
            disabled={isRefreshing}
            aria-label="Refresh data"
          >
            <Button.Prefix>
              <RefreshIcon />
            </Button.Prefix>
          </Button>
          */}
        </Flex>
      </Flex>

      {isLoading ? (
        <Flex justifyContent="center" alignItems="center" className="table-loading">
          <ProgressCircle />
        </Flex>
      ) : (
        <>
          <div className="summary-grid">
            {MODULES.map((m) => (
              <SummaryTile
                key={m.id}
                module={m.id}
                entry={entriesByModule[m.id]}
                disabled={m.enabled === false}
                loading={autoLoading.has(m.id)}
              />
            ))}
          </div>
          {!hasAnyCached && (
            <Paragraph className="text-subdued">
              Loading module data. Or use Refresh all to recompute it.
            </Paragraph>
          )}
          <Flex className="landing-footer" justifyContent="flex-end">
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
        </>
      )}

      <ThresholdSettingsModal
        module="disk"
        variant="filters"
        isOverview
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        usageView="high"
        showSnoozed={showSnoozed}
        onShowSnoozedChange={setShowSnoozed}
      />

      <AppSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </Flex>
  );
};
