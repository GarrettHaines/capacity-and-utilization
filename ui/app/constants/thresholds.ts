import type { CpuCoreGate, DiskSizeGate, DiskTier, Thresholds } from "../types/types";

/** A size gate with both sides off: the "no limit" baseline. */
const OFF_SIZE_GATE: DiskSizeGate = {
  minSizeEnabled: false,
  minSize: 0,
  minSizeUnit: "GB",
  maxSizeEnabled: false,
  maxSize: 0,
  maxSizeUnit: "GB",
};

/** A vCPU (core) gate with both sides off. */
const OFF_CORE_GATE: CpuCoreGate = {
  minCoresEnabled: false,
  minCores: 0,
  maxCoresEnabled: false,
  maxCores: 0,
};

/**
 * Defaults are intentionally strict: out of the box the app surfaces a handful
 * of interesting findings, not thousands of borderline cases. Users tune the
 * dials in the Filter modal.
 *
 * Each disk tier (high / low) owns two conditions, "by % used" and "by time till
 * full", both on by default. High fires when either trips; low fires only when
 * both do, above a 250 GB size floor.
 */
const blankHighUsageTier: DiskTier = {
  percent: {
    enabled: true,
    value: 90,
    minSizeEnabled: false,
    minSize: 0,
    minSizeUnit: "GB",
    maxSizeEnabled: false,
    maxSize: 0,
    maxSizeUnit: "GB",
  },
  days: {
    enabled: true,
    value: 120,
    unit: "days",
    minSizeEnabled: false,
    minSize: 0,
    minSizeUnit: "GB",
    maxSizeEnabled: false,
    maxSize: 0,
    maxSizeUnit: "GB",
  },
  // Busy-disk trigger (iops >= value). Staged but off by default.
  iops: { combine: "any", byMetric: { iops: { enabled: false, value: 1000 } } },
  // Fast-growing trigger (slope >= value %/day). Staged but off.
  dailyChange: { enabled: false, value: 1 },
  // Enabled conditions combine with OR by default (fire if any trips).
  conditionCombine: "any",
  blanketSize: { ...OFF_SIZE_GATE },
};

const blankLowUsageTier: DiskTier = {
  percent: {
    enabled: true,
    value: 50,
    minSizeEnabled: false,
    minSize: 0,
    minSizeUnit: "GB",
    maxSizeEnabled: false,
    maxSize: 0,
    maxSizeUnit: "GB",
  },
  days: {
    enabled: true,
    value: 10,
    unit: "years",
    minSizeEnabled: false,
    minSize: 0,
    minSizeUnit: "GB",
    maxSizeEnabled: false,
    maxSize: 0,
    maxSizeUnit: "GB",
  },
  // Idle-disk trigger (iops <= value). Staged but off by default.
  iops: { combine: "any", byMetric: { iops: { enabled: false, value: 1 } } },
  // Flat/shrinking trigger (slope <= value %/day). Staged but off.
  dailyChange: { enabled: false, value: 0 },
  // A disk counts as low only if it trips EVERY enabled condition (very
  // underused AND with a long fill runway), not just one.
  conditionCombine: "all",
  // Low usage defaults to a 250 GB floor: a nearly-empty small disk is noise,
  // a nearly-empty large one is real reclaimable capacity.
  blanketSize: {
    minSizeEnabled: true,
    minSize: 250,
    minSizeUnit: "GB",
    maxSizeEnabled: false,
    maxSize: 0,
    maxSizeUnit: "GB",
  },
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  disk: {
    highUsage: blankHighUsageTier,
    lowUsage: blankLowUsageTier,
    limitScope: "all",
  },
  // App-wide host-name rules (empty -> every host passes through).
  hostNameFilter: { mode: "exclude", rules: [] },
  // App-wide disk mount-path rules (empty -> every disk passes through).
  diskNameFilter: { mode: "exclude", rules: [] },
  // Hide pseudo / ephemeral / managed filesystems by default.
  includeNonProvisioned: false,
  // Keep non-growing disks in scope by default.
  excludeStagnantDisks: false,
  compute: {
    // CPU and memory filters, each with a threshold per statistic (min / avg /
    // P50 / P95 / max) plus CPU steal. Average and P95 are on by default;
    // min / median / max stay staged off. combine "any" = fire if any enabled
    // stat crosses.
    highUsage: {
      cpu: {
        enabled: true,
        combine: "any",
        min: { enabled: false, value: 0 },
        avg: { enabled: true, value: 70 },
        p50: { enabled: false, value: 0 },
        p95: { enabled: true, value: 85 },
        max: { enabled: false, value: 98 },
        steal: { enabled: false, value: 10 },
        ...OFF_CORE_GATE,
      },
      mem: {
        enabled: true,
        combine: "any",
        min: { enabled: false, value: 0 },
        avg: { enabled: true, value: 75 },
        p50: { enabled: false, value: 0 },
        p95: { enabled: true, value: 85 },
        max: { enabled: false, value: 98 },
        ...OFF_SIZE_GATE,
      },
      // CPU and memory combine with OR by default (fire if either trips).
      conditionCombine: "any",
      blanketPcpu: { ...OFF_CORE_GATE },
      blanketVcpu: { ...OFF_CORE_GATE },
      blanketMem: { ...OFF_SIZE_GATE },
      blanketCombine: "all",
    },
    lowUsage: {
      cpu: {
        enabled: true,
        combine: "any",
        min: { enabled: false, value: 0 },
        avg: { enabled: true, value: 30 },
        p50: { enabled: false, value: 0 },
        p95: { enabled: true, value: 40 },
        max: { enabled: false, value: 0 },
        steal: { enabled: false, value: 10 },
        ...OFF_CORE_GATE,
      },
      mem: {
        enabled: true,
        combine: "any",
        min: { enabled: false, value: 0 },
        avg: { enabled: true, value: 40 },
        p50: { enabled: false, value: 0 },
        p95: { enabled: true, value: 50 },
        max: { enabled: false, value: 0 },
        ...OFF_SIZE_GATE,
      },
      // CPU and memory combine with OR by default (fire if either trips).
      conditionCombine: "any",
      blanketPcpu: { ...OFF_CORE_GATE },
      blanketVcpu: { ...OFF_CORE_GATE },
      // Low usage defaults to a 64 GB RAM floor: an idle small host is noise, an
      // idle large one is real reclaimable capacity.
      blanketMem: {
        minSizeEnabled: true,
        minSize: 64,
        minSizeUnit: "GB",
        maxSizeEnabled: false,
        maxSize: 0,
        maxSizeUnit: "GB",
      },
      blanketCombine: "all",
    },
    limitScope: "all",
  },
  kubernetes: {
    // 5x overcommit is wasteful; 1.5x under-request risks throttling. The wide
    // band keeps the noisy middle out of findings.
    cpuRequestOvercommitRatio: 5,
    cpuRequestUnderRatio: 1.5,
    nodeCpuPackedPercent: 95,
    pendingPodMinutesPerDay: 120,
  },
  scaling: {
    flatRunDays: 30,
    ceilingHitsPerMonth: 5,
    diurnalSwingRatio: 2.5,
  },
};
