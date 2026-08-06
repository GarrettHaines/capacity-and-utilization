import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { sendIntent } from "@dynatrace-sdk/navigation";
import type { Severity } from "../types/types";

// ----------------------------------------------------------------
// Date / time formatting
// ----------------------------------------------------------------

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** Convert an ISO string to "YYYY-MM-DDTHH:mm:ss" (no fractional seconds, no Z). */
export function toApiDateTime(iso: string): string {
  return iso.replace(/\.\d+/, "").replace(/Z$/, "");
}

/** Epoch ms → locale string, or "—" fallback. */
export function formatTimestamp(ts?: number | null): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Compact age relative to now: "just now", "5m ago", "3h ago", "2d ago". */
export function relativeFromNow(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const deltaMs = Date.now() - t;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ----------------------------------------------------------------
// Severity helpers
// ----------------------------------------------------------------

export const SEVERITY_ORDER: Severity[] = [
  "atCapacity",
  "highUsage",
  "lowUsage",
];

export const SEVERITY_RANK: Record<Severity, number> = {
  atCapacity: 3,
  highUsage: 2,
  lowUsage: 1,
  normal: 0,
};

export function severitySortDesc(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

/** Human-facing label for each tier. */
export function severityLabel(s: Severity): string {
  switch (s) {
    case "atCapacity":
      return "At capacity";
    case "highUsage":
      return "High usage";
    case "lowUsage":
      return "Low usage";
    case "normal":
      return "Normal";
  }
}

/**
 * Map legacy severity strings onto the current set so old persisted records
 * still render: critical/warning become highUsage, info/notice become
 * lowUsage, current values pass through.
 */
export function normalizeSeverity(raw: unknown): Severity {
  const v = String(raw ?? "").trim();
  if (v === "atCapacity" || v === "highUsage" || v === "lowUsage" || v === "normal")
    return v;
  if (v === "critical" || v === "warning") return "highUsage";
  if (v === "info" || v === "notice") return "lowUsage";
  // Unknown or missing: bias to the gentlest tier so a stray record never
  // inflates the at-capacity counter.
  return "lowUsage";
}

// ----------------------------------------------------------------
// IDs & strings
// ----------------------------------------------------------------

export function generateId(prefix = "id"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildFindingId(
  module: string,
  entityId: string,
  ruleId: string
): string {
  return `${module}:${entityId}:${ruleId}`;
}

// ----------------------------------------------------------------
// Numbers / units
// ----------------------------------------------------------------

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return "—";
  // 0% and 100% are reserved for a genuinely empty / full reading. A value that
  // would round to either without actually reaching it reads "<x%" or ">y%"
  // instead (e.g. 0.3% -> "<1%", 99.6% -> ">99%"), so a near-extreme is never
  // mistaken for the real thing. The thresholds scale with `digits`.
  if (value >= 100) return "100%";
  if (value <= 0) return "0%";
  const factor = 10 ** digits;
  const eps = 1 / factor;
  const rounded = Math.round(value * factor) / factor;
  if (rounded >= 100) return `>${trimTrailingZeros((100 - eps).toFixed(digits))}%`;
  if (rounded <= 0) return `<${trimTrailingZeros(eps.toFixed(digits))}%`;
  return `${trimTrailingZeros(rounded.toFixed(digits))}%`;
}

export function formatPercentDelta(
  value: number | null | undefined,
  digits = 1
): string {
  if (value == null || !Number.isFinite(value)) return "0%";
  const s = trimTrailingZeros(value.toFixed(digits));
  if (s === "0" || s === "-0") return "0%";
  const sign = s.startsWith("-") ? "" : "+";
  return `${sign}${s}%`;
}

function trimTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

export function formatBytes(
  bytes: number | null | undefined,
  digits?: number
): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  // Decimal (1000-based) units to match Dynatrace InfraOps.
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  // Whole numbers at double digits, one decimal below. Pass `digits` to force
  // a fixed precision.
  const d = digits != null ? digits : v >= 10 ? 0 : 1;
  return `${trimTrailingZeros(v.toFixed(d))} ${units[i]}`;
}

/** Compact elapsed duration for the "offline Xd" badge: m / h / d / w. */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function formatDays(days: number | null | undefined): string {
  if (days == null || Number.isNaN(days) || !Number.isFinite(days)) return "—";
  if (days < 1) return "<1d";
  if (days < 60) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

// ----------------------------------------------------------------
// Linear regression (used for disk fill projection)
// ----------------------------------------------------------------

export interface LinearFit {
  slope: number;
  intercept: number;
  rSquared: number;
}

export function linearFit(points: Array<{ x: number; y: number }>): LinearFit | null {
  const n = points.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
    sumYY += p.y * p.y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const numerator = n * sumXY - sumX * sumY;
  const yDenom = n * sumYY - sumY * sumY;
  const rSquared = yDenom === 0 ? 1 : (numerator * numerator) / (denom * yDenom);
  return { slope, intercept, rSquared };
}

export function daysUntil(fit: LinearFit, target: number, nowDay: number): number {
  if (fit.slope <= 0) return Number.POSITIVE_INFINITY;
  return (target - (fit.slope * nowDay + fit.intercept)) / fit.slope;
}

// ----------------------------------------------------------------
// Misc
// ----------------------------------------------------------------

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}

export function groupBy<T, K extends string>(
  items: T[],
  key: (item: T) => K
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const it of items) {
    const k = key(it);
    if (!out[k]) out[k] = [];
    out[k].push(it);
  }
  return out;
}

/**
 * Resolve a Dynatrace/Grail relative time expression to an absolute Date.
 * Handles "now", "now-<n><unit>", and calendar alignment "/<unit>" (e.g.
 * "now/d" = start of today, "now-1d/d" = start of yesterday, "now/w" = start
 * of this week), the forms Strato's Today / Yesterday / This week presets emit.
 * Alignment uses the browser's local timezone. Returns null if unparsed.
 */
export function resolveTimeExprToDate(
  expr: string,
  base: Date = new Date()
): Date | null {
  const s = expr.trim().replace(/\(\)/g, "").replace(/\s+/g, "");
  const m = s.match(/^now(?:-(\d+)([smhdwMy]))?(?:\/([smhdwMy]))?$/);
  if (!m) return null;
  const [, amt, subUnit, alignUnit] = m;
  const d = new Date(base.getTime());
  if (amt && subUnit) {
    const n = Number(amt);
    switch (subUnit) {
      case "s": d.setSeconds(d.getSeconds() - n); break;
      case "m": d.setMinutes(d.getMinutes() - n); break;
      case "h": d.setHours(d.getHours() - n); break;
      case "d": d.setDate(d.getDate() - n); break;
      case "w": d.setDate(d.getDate() - n * 7); break;
      case "M": d.setMonth(d.getMonth() - n); break;
      case "y": d.setFullYear(d.getFullYear() - n); break;
    }
  }
  if (alignUnit) {
    switch (alignUnit) {
      case "s": d.setMilliseconds(0); break;
      case "m": d.setSeconds(0, 0); break;
      case "h": d.setMinutes(0, 0, 0); break;
      case "d": d.setHours(0, 0, 0, 0); break;
      case "w": {
        // Snap to the start of the week (Monday), matching Dynatrace.
        d.setHours(0, 0, 0, 0);
        const mondayOffset = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
        d.setDate(d.getDate() - mondayOffset);
        break;
      }
      case "M": d.setDate(1); d.setHours(0, 0, 0, 0); break;
      case "y": d.setMonth(0, 1); d.setHours(0, 0, 0, 0); break;
    }
  }
  return d;
}

export function toEntityApiTimeRef(expr: string): string {
  const trimmed = expr.trim();
  const normalized = trimmed.replace(/^now\(\)/, "now");
  if (normalized === "now") return "now";
  if (/^now\s*-\s*\d+\s*[smhdwMy]$/.test(normalized)) {
    return normalized.replace(/\s+/g, "");
  }
  // Calendar-aligned (Today/Yesterday/etc.) resolve to epoch ms for the API.
  const resolved = resolveTimeExprToDate(normalized);
  if (resolved) return String(resolved.getTime());
  return normalized;
}

export function toDqlTimeRef(expr: string): string {
  const trimmed = expr.trim();
  const normalized = trimmed.replace(/^now\(\)/, "now");
  if (normalized === "now") return "now()";
  const rel = normalized.match(/^now\s*-\s*(\d+\s*[smhdwMy])$/);
  if (rel) return `now() - ${rel[1].replace(/\s+/g, "")}`;
  // Calendar-aligned expressions (e.g. "now/d") aren't valid inside a DQL
  // from:/to:, so resolve them to an absolute timestamp.
  const resolved = resolveTimeExprToDate(normalized);
  if (resolved) return `timestamp("${resolved.toISOString()}")`;
  return `timestamp("${trimmed}")`;
}

// ----------------------------------------------------------------
// Cross-app navigation
// ----------------------------------------------------------------

function tenantOrigin(): string {
  try {
    return (getEnvironmentUrl() ?? "").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function hostDetailUrl(hostId: string): string {
  return `${tenantOrigin()}/ui/apps/dynatrace.infraops/explorer/Compute/Hosts?DT_APP_ID=dynatrace.infraops&fullPageId=${encodeURIComponent(
    hostId
  )}&fullPageTab=Overview`;
}

export function diskDetailUrl(hostId: string, diskId: string): string {
  return `${tenantOrigin()}/ui/apps/dynatrace.infraops/explorer/Compute/Hosts?DT_APP_ID=dynatrace.infraops&fullPageId=${encodeURIComponent(
    hostId
  )}&fullPageTab=Overview&diskId=${encodeURIComponent(diskId)}&fullPageDrawer=disk`;
}

export function openHostInInfraOps(hostId: string): void {
  try {
    sendIntent({ "dt.entity.host": hostId });
    return;
  } catch (err) {
    console.warn("openHostInInfraOps: sendIntent failed, opening in new tab", err);
  }
  try {
    window.open(hostDetailUrl(hostId), "_blank", "noopener");
  } catch (err) {
    console.error("openHostInInfraOps: window.open failed", err);
  }
}

export function openDiskInInfraOps(hostId: string, diskId: string): void {
  try {
    window.open(diskDetailUrl(hostId, diskId), "_blank", "noopener");
  } catch (err) {
    console.error("openDiskInInfraOps: window.open failed", err);
  }
}

// ----------------------------------------------------------------
// Severity counting
// ----------------------------------------------------------------

export function countBySeverity(
  items: { severity: Severity; limitExcluded?: boolean }[]
): {
  atCapacity: number;
  highUsage: number;
  lowUsage: number;
  total: number;
  /** Records shown for context but excluded from `total`. Tracked separately so
   *  the Overview tile can subtract them from its "Normal" remainder instead of
   *  quietly absorbing them. */
  limitExcluded: number;
} {
  let a = 0;
  let h = 0;
  let l = 0;
  let x = 0;
  for (const it of items) {
    // `limitExcluded` records are surfaced for context only (a disk at 100%
    // that the tab's size limit excludes). They're counted in no severity, so
    // the limit still holds on every tally and on the Overview tiles.
    if (it.limitExcluded) {
      x++;
      continue;
    }
    if (it.severity === "atCapacity") a++;
    else if (it.severity === "highUsage") h++;
    else if (it.severity === "lowUsage") l++;
  }
  return { atCapacity: a, highUsage: h, lowUsage: l, total: a + h + l, limitExcluded: x };
}
