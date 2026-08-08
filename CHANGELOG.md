# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-08-07

### Fixed

- `npm run build` failed with `error: unknown option '--prod'`. `dt-app build` has no `--prod` flag; the production build flag is `--optimize`. The `deploy` script was unaffected, which is why the broken build script went unnoticed.
- `npm ci` failed on a clean clone with `EUSAGE`. The committed `package-lock.json` was missing three entries (`@emnapi/runtime`, plus nested `@types/node` copies under `dt-app` and `inquirer`), so a fresh checkout could not install dependencies. Existing checkouts were unaffected, which is why the failure only appeared for new contributors and CI.
- Size and memory limits were entered and displayed in decimal units (GB, TB) but compared in binary ones, so the default 250 GB disk floor really excluded disks displayed up to roughly 269 GB, and the 64 GB memory floor behaved the same way. Both now compare in the units shown, so slightly more resources qualify against an unchanged limit.
- The Overview ignored four settings that change its numbers. Changing the measurement window, timeframe matching, data resolution, or the host name source left the tiles on stale counts with no indication. All four now recompute the tiles.
- Publishing or resetting a team default reported nothing when the environment refused the write. The publisher kept the configuration alone while teammates stayed on the previous baseline, silently. Both paths now surface the failure in the dialog.
- Help text for excluding disks that are no longer growing said the trend was measured over the last 30 days. It has always used the measurement window, 14 days by default, and now reports the window in effect.
- Two Overview messages pointed users at a "Refresh all" control that is not rendered on that screen.
- Stale settings in the module page reload. The `load` callback listed only `windowDays`, `resourceWindowSync`, and `dataResolution` as dependencies, but its body passes the whole `appSettings` object to `resolveSubmoduleFilter`, which reads tag-column visibility from it. Changing a column-visibility or custom-column setting recomputed the filter signature and triggered a reload, but the callback was not recreated, so the refetch applied the previous column filters. The dependency is now the whole `appSettings` object; this does not cause extra fetches, because the reload effect keys off signature strings rather than callback identity.
- `SummaryTile` imported `@dynatrace/strato-design-tokens` from the package root instead of the `colors` subpath, violating the project's own `no-restricted-imports` rule.
- Removed a redundant `Boolean()` cast, two unused type imports, an unused parameter, and an unused page counter. `npm run lint` now exits clean.

### Changed

- `dt-app` updated from 1.14.1 to 1.15.0 and `@dynatrace/strato-components` from `^3.10.1` to `^3.10.4`.
- `engines.node` corrected from `>=20.0.0` to `>=22.12.0`. The previous floor was never achievable: `rollup-plugin-visualizer` requires `>=22`, and `vite` and `rolldown` require `^20.19.0 || >=22.12.0`.
- README prerequisites and Node badge updated to match, and the install step changed from `npm install` to `npm ci` so contributors install the locked dependency versions.
- ESLint configuration quieted for false positives: `react/no-unescaped-entities` disabled (it flagged ordinary apostrophes and quotation marks in UI copy), `no-secrets` tolerance raised to 4.5 (it flagged camelCase setting keys and a Dynatrace deep-link URL), and a Node environment override added for `app.config.js` so its CommonJS globals resolve. This removes 65 of 73 reports without changing any application code.

### Added

- `.nvmrc` pinned to Node 24 (Active LTS).

## [1.0.0] - 2026-08-05

Initial release.

### Added

- Compute right-sizing. One row per host, with CPU and memory presented as distributions (minimum, average, median, P95, maximum) rather than single readings. Includes CPU steal, core counts, and total memory alongside usage figures.
- Disk usage and capacity. One row per disk per host, with fill level, space used, allocated size, average IOPS, daily fill trend, and projected time to full. Pseudo and platform-managed mounts are hidden by default.
- Overview. One tile per page summarizing each population into at capacity, high usage, low usage, and normal, with freshness timestamps.
- Filters and thresholds. Filtering by management zone, tags, operating system, deployment, Kubernetes, and name rules. Thresholds apply independently per tab.
- Column layout and custom columns. Each tab keeps its own column order and hidden set. Custom columns draw from computed statistics or Dynatrace tags.
- Personal settings. Filters, thresholds, and layouts are per-user, with a shared team default applied to new users.
- CSV export for tables.

### Known limitations

- Kubernetes and Scaling sections are inactive placeholders.
- Personal settings are browser-specific and do not synchronize across devices.
- Saturated hosts may not appear without matching conditions.
- Size and memory limits are entered in decimal units but compared in binary units.
- Publishing a team default gives no error feedback on failure.
- The Overview does not refresh on certain setting changes.
- No snooze or acknowledge functionality.

[1.0.1]: https://github.com/GarrettHaines/capacity-and-utilization/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/GarrettHaines/capacity-and-utilization/releases/tag/v1.0.0
