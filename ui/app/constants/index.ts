export * from "./modules";
export * from "./thresholds";

/**
 * Settings 2.0 schema ids. An app may only read/write schemas in its own
 * `app:<appId>:*` namespace, so these are namespaced under the app id
 * (`my.capacity.utilization`); anything else is rejected environment-wide and
 * falls back to per-browser localStorage.
 *
 * Each schema also needs a definition at `settings/schemas/<name>.schema.json`,
 * which `dt-app deploy` registers automatically. Registered/shared: thresholds,
 * app-settings, org-defaults, overview-cache. `user-preferences` is unregistered
 * and falls back to localStorage. `finding-state` is unregistered and has NO
 * fallback; it talks to Settings 2.0 only, so snooze / acknowledge needs that
 * schema to exist.
 */
export const SCHEMA_IDS = {
  thresholds: "app:my.capacity.utilization:thresholds",
  findingState: "app:my.capacity.utilization:finding-state",
  userPreferences: "app:my.capacity.utilization:user-preferences",
  appSettings: "app:my.capacity.utilization:app-settings",
  orgDefaults: "app:my.capacity.utilization:org-defaults",
  overviewCache: "app:my.capacity.utilization:overview-cache",
} as const;

export const PAGE_SIZE = 25;
export const REFRESH_POLL_MS = 60_000;
