import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  FilterBundle,
  HostFilter,
  ManagementZone,
  ModuleId,
  ScopeRef,
  Segment,
  Severity,
  Thresholds,
  TimeframeRange,
} from "../types/types";
import { EMPTY_HOST_FILTER, DEFAULT_APP_SETTINGS } from "../types/types";
import { DEFAULT_THRESHOLDS } from "../constants";
import { fetchManagementZones, fetchSegments } from "../api/scope";
import {
  fetchAppSettings,
  saveAppSettings,
  fetchUserPreferences,
  saveUserPreferences,
  clearUserPreferences,
  fetchThresholds,
  saveThresholds,
  fetchOrgDefaults,
  saveOrgDefaults,
  readUserOverrides,
  writeUserOverrides,
  normalizeThresholds,
  normalizeAppSettings,
  getUserEmail,
  canWriteSharedSettings,
  type OrgDefaults,
  type UserOverrides,
  type UserPreferences,
} from "../api/settings";
import { deepDiff, deepMerge, pruneEmpty } from "../utils/merge";

interface ScopeContextValue {
  scope: ScopeRef;
  setScope: (next: ScopeRef) => void;

  timeframe: TimeframeRange;
  setTimeframe: (next: TimeframeRange) => void;

  hostFilter: HostFilter;
  setHostFilter: (next: HostFilter) => void;

  /**
   * Resolve the scoped Filters-menu bundle in effect for (module, view), per
   * `appSettings.filterScope`. `setFilterFor` writes it at the scope key the
   * current mode edits (app / module / view).
   */
  filterFor: (module: ModuleId, view: "high" | "low") => FilterBundle;
  setFilterFor: (
    module: ModuleId,
    view: "high" | "low",
    bundle: FilterBundle
  ) => void;

  activeSeverities: Set<Severity>;
  setActiveSeverities: (next: Set<Severity>) => void;

  /**
   * The user's *effective* thresholds: the shared team default with this
   * person's personal overrides layered on top. `setThresholds` records the
   * diff vs the team default as a per-user override (localStorage); it never
   * touches what anyone else sees.
   */
  thresholds: Thresholds;
  setThresholds: (next: Thresholds) => void;

  /**
   * The user's *effective* app settings (team default + personal overrides).
   * `setAppSettings` records only the changed fields as a per-user override.
   */
  appSettings: AppSettings;
  setAppSettings: (next: AppSettings) => void;

  /**
   * Whether this user's filter for a module's `high` or `low` tier is still
   * exactly the team default (i.e. they have no personal override touching
   * that side, nor any shared field that would move its counts). Drives which
   * halves of the shared Overview cache a page is allowed to record.
   */
  isModuleFilterAtTeamDefault: (module: ModuleId, tier: "high" | "low") => boolean;

  /**
   * Whether a submodule (module + side) is fully at the team default: its tier
   * thresholds AND the filter reaching it are unchanged, and the filter scope
   * itself is unchanged. The Overview shows the shared team cache for a
   * submodule at default, and the user's own cache for one they've customized.
   */
  isSubmoduleAtTeamDefault: (module: ModuleId, view: "high" | "low") => boolean;

  /** Clear this module's personal threshold overrides (both usage tiers)
   *  and snap it back to the team default. Returns the new effective set so
   *  callers can reload immediately. */
  resetModuleThresholds: (module: ModuleId) => Thresholds;
  /** Clear this module's personal column layout override → team default. */
  resetModuleColumns: (module: ModuleId) => void;
  /** Clear only the Settings-menu overrides (host names, snooze, offline,
   *  forecasting) → team default. Leaves columns and thresholds alone. */
  resetSettingsOnly: () => void;
  /** Clear every personal override (thresholds, settings, columns) and reset
   *  view state to the team default. */
  resetAllToDefaults: () => Promise<void>;

  /**
   * Team-wide default setup a brand-new user (no saved preferences of
   * their own) is seeded from. `saveCurrentSetupAsDefault` publishes the
   * current setup for everyone and clears the publisher's own overrides.
   */
  orgDefaults: OrgDefaults | null;
  saveCurrentSetupAsDefault: (appSettingsOverride?: AppSettings) => Promise<void>;

  /**
   * Whether the current user may manage the shared team default (has
   * `settings:objects:write` on the app schemas). Gates the "Save current
   * setup as team default" and "Reset saved team default" admin actions.
   */
  canManageTeamDefault: boolean;
  /** Reset the shared team default back to the app's built-in defaults
   *  (thresholds, app settings, and view-state org defaults). Admin only,
   *  and server-enforced by the settings write permission. */
  resetTeamDefaultToAppDefaults: () => Promise<void>;

  managementZones: ManagementZone[];
  segments: Segment[];
  isLoading: boolean;
  error?: unknown;
}

export const DEFAULT_SCOPE: ScopeRef = { mode: "all", id: "", name: "All hosts" };
export const DEFAULT_TIMEFRAME: TimeframeRange = { from: "now-2h", to: "now" };

/**
 * The shared Overview cache only records the *canonical* view (all zones,
 * the default timeframe, and no host filter) so the numbers different
 * users see are comparable no matter who last ran a page. Anything else is
 * a personalized view and is not written to the shared cache.
 */
export function isCanonicalOverviewContext(
  scope: ScopeRef,
  timeframe: TimeframeRange,
  hostFilter: HostFilter
): boolean {
  return (
    scope.mode === "all" &&
    timeframe.from === DEFAULT_TIMEFRAME.from &&
    timeframe.to === DEFAULT_TIMEFRAME.to &&
    hostFilter.tags.length === 0 &&
    (hostFilter.columnFilters?.length ?? 0) === 0 &&
    hostFilter.osTypes.length === 0 &&
    hostFilter.cloudTypes.length === 0
  );
}
const DEFAULT_ACTIVE_SEVERITIES: Set<Severity> = new Set<Severity>([
  "atCapacity",
  "highUsage",
  "lowUsage",
]);

function normalizeHostFilter(raw: Partial<HostFilter> | undefined): HostFilter {
  return {
    // Migrate legacy single-value tags ({key, value}) to multi-value.
    tags: Array.isArray(raw?.tags)
      ? (raw!.tags as any[]).map((t) => ({
          key: String(t?.key ?? ""),
          values: Array.isArray(t?.values)
            ? t.values.filter((v: unknown) => typeof v === "string")
            : t?.value
            ? [String(t.value)]
            : ["*"],
        }))
      : [],
    columnFilters: Array.isArray(raw?.columnFilters)
      ? (raw!.columnFilters as any[]).map((t) => ({
          key: String(t?.key ?? ""),
          values: Array.isArray(t?.values)
            ? t.values.filter((v: unknown) => typeof v === "string")
            : ["*"],
        }))
      : [],
    osTypes: Array.isArray(raw?.osTypes) ? raw!.osTypes : [],
    cloudTypes: Array.isArray(raw?.cloudTypes)
      ? raw!.cloudTypes.filter((c: unknown) => c !== "KUBERNETES")
      : [],
    osMode: raw?.osMode === "exclude" ? "exclude" : "include",
    cloudMode: raw?.cloudMode === "exclude" ? "exclude" : "include",
    // Legacy "KUBERNETES" in cloudTypes maps onto the standalone gate as
    // "only", matching what selecting it there meant.
    kubernetes:
      raw?.kubernetes === "only" || raw?.kubernetes === "exclude"
        ? raw.kubernetes
        : Array.isArray(raw?.cloudTypes) && raw!.cloudTypes.includes("KUBERNETES")
        ? "only"
        : "include",
  };
}

const ScopeContext = createContext<ScopeContextValue | undefined>(undefined);

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<ScopeRef>(DEFAULT_SCOPE);
  const [timeframe, setTimeframeState] = useState<TimeframeRange>(DEFAULT_TIMEFRAME);
  const [hostFilter, setHostFilterState] = useState<HostFilter>(EMPTY_HOST_FILTER);
  const [activeSeverities, setActiveSeveritiesState] = useState<Set<Severity>>(
    () => new Set(DEFAULT_ACTIVE_SEVERITIES)
  );
  const [thresholds, setThresholdsState] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [appSettings, setAppSettingsState] = useState<AppSettings>(
    DEFAULT_APP_SETTINGS
  );
  const [orgDefaults, setOrgDefaults] = useState<OrgDefaults | null>(null);
  const [canManageTeamDefault, setCanManageTeamDefault] = useState(false);
  const [managementZones, setManagementZones] = useState<ManagementZone[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);

  // --- Two-layer config plumbing (see api/settings.ts) --------------------
  // The team default layer (shared object) and this user's sparse override
  // layer are kept in refs so the setters always read current values without
  // re-render churn or stale closures. The visible thresholds / appSettings
  // above are always `deepMerge(teamLayer, override)`.
  const emailRef = useRef<string>("anonymous");
  const overridesRef = useRef<UserOverrides>({});
  const teamThresholdsRef = useRef<Thresholds>(DEFAULT_THRESHOLDS);
  const teamAppSettingsRef = useRef<AppSettings>(DEFAULT_APP_SETTINGS);

  const persistOverrides = useCallback(() => {
    writeUserOverrides(emailRef.current, overridesRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const email = await getUserEmail();
        const [mzs, segs, userPrefs, teamApp, teamThr, orgDef, admin] = await Promise.all([
          fetchManagementZones(),
          fetchSegments(),
          fetchUserPreferences(),
          fetchAppSettings(),
          fetchThresholds(),
          fetchOrgDefaults(),
          canWriteSharedSettings(),
        ]);
        if (cancelled) return;

        emailRef.current = email;
        setCanManageTeamDefault(admin);
        const overrides = readUserOverrides(email);
        overridesRef.current = overrides;
        teamAppSettingsRef.current = teamApp;
        teamThresholdsRef.current = teamThr;

        setManagementZones(mzs);
        setSegments(segs);
        setPrefs(userPrefs);
        setAppSettingsState(
          normalizeAppSettings(deepMerge(teamApp, overrides.appSettings ?? {}))
        );
        setThresholdsState(
          normalizeThresholds(deepMerge(teamThr, overrides.thresholds ?? {}))
        );
        setOrgDefaults(orgDef);

        // Per-user view state: the user's own saved value, then the team
        // default (brand-new users), then the hardcoded default.
        const up = userPrefs as (UserPreferences & {
          lastTimeframe?: TimeframeRange;
          lastHostFilter?: Partial<HostFilter>;
          lastActiveSeverities?: Severity[];
        }) | null;

        if (up?.lastScope) setScopeState(up.lastScope);
        else if (orgDef?.scope) setScopeState(orgDef.scope);

        if (up?.lastTimeframe) setTimeframeState(up.lastTimeframe);
        else if (orgDef?.timeframe) setTimeframeState(orgDef.timeframe);

        if (up?.lastHostFilter) setHostFilterState(normalizeHostFilter(up.lastHostFilter));
        else if (orgDef?.hostFilter)
          setHostFilterState(normalizeHostFilter(orgDef.hostFilter));

        const userSevs = up?.lastActiveSeverities;
        if (Array.isArray(userSevs) && userSevs.length > 0) {
          setActiveSeveritiesState(new Set(userSevs));
        } else if (
          Array.isArray(orgDef?.activeSeverities) &&
          orgDef!.activeSeverities!.length > 0
        ) {
          setActiveSeveritiesState(new Set(orgDef!.activeSeverities));
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setScope = useCallback(
    (next: ScopeRef) => {
      setScopeState(next);
      if (prefs?.userId) {
        saveUserPreferences({ ...prefs, lastScope: next }).catch((err) =>
          console.error("Failed to persist scope preference", err)
        );
      }
    },
    [prefs]
  );

  const setTimeframe = useCallback(
    (next: TimeframeRange) => {
      setTimeframeState(next);
      if (prefs?.userId) {
        saveUserPreferences({
          ...prefs,
          lastTimeframe: next,
        } as UserPreferences).catch((err) =>
          console.error("Failed to persist timeframe preference", err)
        );
      }
    },
    [prefs]
  );

  const setHostFilter = useCallback(
    (next: HostFilter) => {
      setHostFilterState(next);
      if (prefs?.userId) {
        saveUserPreferences({
          ...prefs,
          lastHostFilter: next,
        } as UserPreferences).catch((err) =>
          console.error("Failed to persist host filter preference", err)
        );
      }
    },
    [prefs]
  );

  const setActiveSeverities = useCallback(
    (next: Set<Severity>) => {
      setActiveSeveritiesState(next);
      if (prefs?.userId) {
        saveUserPreferences({
          ...prefs,
          lastActiveSeverities: Array.from(next),
        } as UserPreferences).catch((err) =>
          console.error("Failed to persist severity preference", err)
        );
      }
    },
    [prefs]
  );

  // Record the diff vs the team default as this user's personal override.
  // No shared write, so other people are unaffected until someone publishes a
  // new team default.
  const setThresholds = useCallback(
    (next: Thresholds) => {
      const eff = normalizeThresholds(next);
      setThresholdsState(eff);
      const diff = deepDiff(eff, teamThresholdsRef.current) as Partial<Thresholds>;
      overridesRef.current = {
        ...overridesRef.current,
        thresholds: pruneEmpty(diff),
      };
      persistOverrides();
    },
    [persistOverrides]
  );

  const setAppSettings = useCallback(
    (next: AppSettings) => {
      const eff = normalizeAppSettings(next);
      setAppSettingsState(eff);
      const diff = deepDiff(eff, teamAppSettingsRef.current) as Partial<AppSettings>;
      overridesRef.current = {
        ...overridesRef.current,
        appSettings: pruneEmpty(diff),
      };
      persistOverrides();
    },
    [persistOverrides]
  );

  // --- Scoped filters (the Filters menu) --------------------------------
  // Fallback bundle for any scope key not yet set, so switching scope carries
  // the current filter forward. Built from the legacy thresholds fields plus
  // the standalone host filter.
  const legacyBundle = useCallback(
    (): FilterBundle => ({
      hostNameFilter: thresholds.hostNameFilter ?? { mode: "exclude", rules: [] },
      diskNameFilter: thresholds.diskNameFilter ?? { mode: "exclude", rules: [] },
      attrs: hostFilter,
      includeNonProvisioned: thresholds.includeNonProvisioned ?? false,
      excludeStagnantDisks: thresholds.excludeStagnantDisks ?? false,
    }),
    [thresholds, hostFilter]
  );

  // Resolve the FilterBundle in effect for (module, view). The scope setting
  // decides which key is authoritative; a missing key inherits from the broader
  // scope, then from the legacy filter.
  const filterFor = useCallback(
    (module: ModuleId, view: "high" | "low"): FilterBundle => {
      const chain =
        appSettings.filterScope === "app"
          ? ["app"]
          : appSettings.filterScope === "module"
          ? [module, "app"]
          : [`${module}:${view}`, module, "app"];
      for (const k of chain) {
        const b = appSettings.filters?.[k];
        if (b) return b;
      }
      return legacyBundle();
    },
    [appSettings, legacyBundle]
  );

  // Write the bundle at the scope key the current mode edits.
  const setFilterFor = useCallback(
    (module: ModuleId, view: "high" | "low", bundle: FilterBundle) => {
      const key =
        appSettings.filterScope === "app"
          ? "app"
          : appSettings.filterScope === "module"
          ? module
          : `${module}:${view}`;
      setAppSettings({
        ...appSettings,
        filters: { ...appSettings.filters, [key]: bundle },
      });
    },
    [appSettings, setAppSettings]
  );

  // A side's counts are the team default iff the user has no personal override
  // touching it. Overrides are stored as a sparse diff of effective-vs-team
  // (see setThresholds), so the mere *presence* of a key means "customized":
  //   - `hostNameFilter`                    → global, moves every module + tier
  //   - `diskNameFilter` / `includeNonProvisioned` /
  //     `excludeStagnantDisks` (app-wide)    → move both tiers of the disk module
  //   - `limitScope` (legacy, per module)    → move both tiers of the module
  //   - `highUsage` / `lowUsage`             → that specific tier
  const isModuleFilterAtTeamDefault = useCallback(
    (module: ModuleId, tier: "high" | "low"): boolean => {
      const ov = overridesRef.current.thresholds as
        | (Partial<Thresholds> & Record<string, unknown>)
        | undefined;
      if (!ov) return true;
      if (ov.hostNameFilter !== undefined) return false;
      if (module === "disk") {
        if (
          ov.diskNameFilter !== undefined ||
          ov.includeNonProvisioned !== undefined ||
          ov.excludeStagnantDisks !== undefined
        )
          return false;
      }
      const m = ov[module] as Record<string, unknown> | undefined;
      if (!m) return true;
      if (module === "disk") {
        // Legacy override keys, tolerated for old stored data.
        if (
          m.nameFilter !== undefined ||
          m.includeNonProvisioned !== undefined ||
          m.limitScope !== undefined
        )
          return false;
      } else if (module === "compute") {
        if (m.limitScope !== undefined) return false;
      }
      const tierKey = tier === "high" ? "highUsage" : "lowUsage";
      return m[tierKey] === undefined;
    },
    []
  );

  // Whether a submodule (module + side) is fully at the team default: its tier
  // thresholds are unchanged AND no personal filter override reaches it. If the
  // user changed the filter *scope* at all, nothing counts as at-default (the
  // Overview then shows only their own cache). Drives the per-submodule cache
  // routing and the Overview team/personal blend.
  const isSubmoduleAtTeamDefault = useCallback(
    (module: ModuleId, view: "high" | "low"): boolean => {
      if (!isModuleFilterAtTeamDefault(module, view)) return false;
      const appOv = overridesRef.current.appSettings;
      if (!appOv) return true;
      if (appOv.filterScope !== undefined) return false;
      const scope = appSettings.filterScope;
      const key =
        scope === "app" ? "app" : scope === "module" ? module : `${module}:${view}`;
      return appOv.filters?.[key] === undefined;
    },
    [appSettings.filterScope, isModuleFilterAtTeamDefault]
  );

  const resetModuleThresholds = useCallback(
    (module: ModuleId): Thresholds => {
      const cur = { ...(overridesRef.current.thresholds ?? {}) } as Record<
        string,
        unknown
      >;
      delete cur[module];
      const nextThrOv = pruneEmpty(cur) as Partial<Thresholds> | undefined;
      overridesRef.current = { ...overridesRef.current, thresholds: nextThrOv };
      persistOverrides();
      const eff = normalizeThresholds(
        deepMerge(teamThresholdsRef.current, nextThrOv ?? {})
      );
      setThresholdsState(eff);
      return eff;
    },
    [persistOverrides]
  );

  const resetModuleColumns = useCallback(
    (module: ModuleId) => {
      const appOv: Partial<AppSettings> = {
        ...(overridesRef.current.appSettings ?? {}),
      };
      if (appOv.pageColumns) {
        const pc = { ...appOv.pageColumns };
        delete pc[module];
        if (Object.keys(pc).length) appOv.pageColumns = pc;
        else delete appOv.pageColumns;
      }
      const nextAppOv = pruneEmpty(appOv) as Partial<AppSettings> | undefined;
      overridesRef.current = { ...overridesRef.current, appSettings: nextAppOv };
      persistOverrides();
      setAppSettingsState(
        normalizeAppSettings(deepMerge(teamAppSettingsRef.current, nextAppOv ?? {}))
      );
    },
    [persistOverrides]
  );

  const resetSettingsOnly = useCallback(() => {
    const appOv: Partial<AppSettings> = {
      ...(overridesRef.current.appSettings ?? {}),
    };
    // Drop only the fields the Settings modal owns.
    delete appOv.hostNameSource;
    delete appOv.snoozeEnabled;
    delete appOv.windowDays;
    delete appOv.resourceWindowSync;
    delete appOv.dataResolution;
    delete appOv.hideFilterForHiddenColumns;
    delete appOv.showManagementZoneFilter;
    delete appOv.hideOfflineHosts;
    const nextAppOv = pruneEmpty(appOv) as Partial<AppSettings> | undefined;
    overridesRef.current = { ...overridesRef.current, appSettings: nextAppOv };
    persistOverrides();
    setAppSettingsState(
      normalizeAppSettings(deepMerge(teamAppSettingsRef.current, nextAppOv ?? {}))
    );
  }, [persistOverrides]);

  const resetAllToDefaults = useCallback(async () => {
    overridesRef.current = {};
    persistOverrides();
    setThresholdsState(normalizeThresholds(teamThresholdsRef.current));
    setAppSettingsState(normalizeAppSettings(teamAppSettingsRef.current));

    // View state → team (org) default if there is one, else hardcoded.
    const od = orgDefaults;
    setScopeState(od?.scope ?? DEFAULT_SCOPE);
    setTimeframeState(od?.timeframe ?? DEFAULT_TIMEFRAME);
    setHostFilterState(
      od?.hostFilter ? normalizeHostFilter(od.hostFilter) : EMPTY_HOST_FILTER
    );
    setActiveSeveritiesState(
      Array.isArray(od?.activeSeverities) && od!.activeSeverities!.length > 0
        ? new Set(od!.activeSeverities)
        : new Set(DEFAULT_ACTIVE_SEVERITIES)
    );

    const userId = prefs?.userId;
    if (userId) {
      setPrefs({ userId });
      await clearUserPreferences(userId);
    }
  }, [orgDefaults, prefs, persistOverrides]);

  const saveCurrentSetupAsDefault = useCallback(
    async (appSettingsOverride?: AppSettings) => {
      const appToPublish = appSettingsOverride
        ? normalizeAppSettings(appSettingsOverride)
        : appSettings;
      const thrToPublish = thresholds;
      // Publish the current *effective* setup to the shared (team) objects.
      try {
        await saveThresholds(thrToPublish);
        await saveAppSettings(appToPublish);
      } catch (err) {
        console.error("saveCurrentSetupAsDefault: shared config publish failed", err);
      }
      // The published config is the new team baseline, and the publisher is
      // now aligned to it, so clear their personal overrides. Everyone else
      // keeps theirs but picks up these values for anything they left default.
      teamThresholdsRef.current = thrToPublish;
      teamAppSettingsRef.current = appToPublish;
      overridesRef.current = {};
      persistOverrides();
      setThresholdsState(thrToPublish);
      setAppSettingsState(appToPublish);

      // Snapshot the per-user view state new users get seeded from.
      const saved = await saveOrgDefaults({
        scope,
        timeframe,
        hostFilter,
        activeSeverities: Array.from(activeSeverities),
      });
      setOrgDefaults(saved);
    },
    [
      appSettings,
      thresholds,
      scope,
      timeframe,
      hostFilter,
      activeSeverities,
      persistOverrides,
    ]
  );

  // Admin action: reset the shared team default back to the app's built-in
  // defaults. Writes the hardcoded defaults to the shared objects and resets
  // the view-state org default. A non-admin's write is rejected server-side.
  const resetTeamDefaultToAppDefaults = useCallback(async () => {
    try {
      await saveThresholds(DEFAULT_THRESHOLDS);
      await saveAppSettings(DEFAULT_APP_SETTINGS);
    } catch (err) {
      console.error("resetTeamDefaultToAppDefaults: shared reset failed", err);
    }
    teamThresholdsRef.current = DEFAULT_THRESHOLDS;
    teamAppSettingsRef.current = DEFAULT_APP_SETTINGS;
    // The team baseline is now app-default; keep the user's own overrides on
    // top so this only changes the *team* default, not the admin's own view.
    setThresholdsState(
      normalizeThresholds(
        deepMerge(DEFAULT_THRESHOLDS, overridesRef.current.thresholds ?? {})
      )
    );
    setAppSettingsState(
      normalizeAppSettings(
        deepMerge(DEFAULT_APP_SETTINGS, overridesRef.current.appSettings ?? {})
      )
    );
    const saved = await saveOrgDefaults({
      scope: DEFAULT_SCOPE,
      timeframe: DEFAULT_TIMEFRAME,
      hostFilter: EMPTY_HOST_FILTER,
      activeSeverities: Array.from(DEFAULT_ACTIVE_SEVERITIES),
    });
    setOrgDefaults(saved);
  }, []);

  const value = useMemo<ScopeContextValue>(
    () => ({
      scope,
      setScope,
      timeframe,
      setTimeframe,
      hostFilter,
      setHostFilter,
      filterFor,
      setFilterFor,
      activeSeverities,
      setActiveSeverities,
      thresholds,
      setThresholds,
      appSettings,
      setAppSettings,
      isModuleFilterAtTeamDefault,
      isSubmoduleAtTeamDefault,
      resetModuleThresholds,
      resetModuleColumns,
      resetSettingsOnly,
      resetAllToDefaults,
      orgDefaults,
      saveCurrentSetupAsDefault,
      canManageTeamDefault,
      resetTeamDefaultToAppDefaults,
      managementZones,
      segments,
      isLoading,
      error,
    }),
    [
      scope,
      setScope,
      timeframe,
      setTimeframe,
      hostFilter,
      setHostFilter,
      filterFor,
      setFilterFor,
      activeSeverities,
      setActiveSeverities,
      thresholds,
      setThresholds,
      appSettings,
      setAppSettings,
      isModuleFilterAtTeamDefault,
      isSubmoduleAtTeamDefault,
      resetModuleThresholds,
      resetModuleColumns,
      resetSettingsOnly,
      resetAllToDefaults,
      orgDefaults,
      saveCurrentSetupAsDefault,
      canManageTeamDefault,
      resetTeamDefaultToAppDefaults,
      managementZones,
      segments,
      isLoading,
      error,
    ]
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error("useScope must be used inside ScopeProvider");
  return ctx;
}
