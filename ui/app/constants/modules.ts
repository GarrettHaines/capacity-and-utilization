import type { ModuleId } from "../types/types";

export interface ModuleConfig {
  id: ModuleId;
  name: string;
  shortName: string;
  path: string;
  description: string;
  /** Singular noun for one evaluated record (e.g. "disk", "host"), used in
   *  Overview copy like "12 findings of 340 disks". Pluralize by appending s. */
  recordNoun: string;
  /** Schema id under settings:objects for module-specific thresholds */
  thresholdsKey: string;
  /**
   * Whether the module is live. Disabled modules (Kubernetes, Scaling) are
   * greyed out and non-navigable: their nav tab and Overview tile are inert,
   * and the route shows an "unavailable" notice. Defaults to enabled.
   */
  enabled?: boolean;
}

export const MODULES: ModuleConfig[] = [
  {
    id: "compute",
    name: "Compute right-sizing",
    shortName: "Compute",
    path: "/compute",
    description:
      "Hosts to downsize, upsize, or move to a different instance family based on CPU and memory usage.",
    recordNoun: "host",
    thresholdsKey: "compute",
    enabled: true,
  },
  {
    id: "disk",
    name: "Disk usage and capacity",
    shortName: "Disk",
    path: "/disk",
    description:
      "Disks projected to fill, chronically underused, or saturating their tier limits.",
    recordNoun: "disk",
    thresholdsKey: "disk",
    enabled: true,
  },
  {
    id: "kubernetes",
    name: "Kubernetes density",
    shortName: "Kubernetes",
    path: "/kubernetes",
    description:
      "Workload request/limit alignment, node bin-packing, and unschedulable-pod pressure.",
    recordNoun: "workload",
    thresholdsKey: "kubernetes",
    enabled: false,
  },
  {
    id: "scaling",
    name: "Scaling & boundaries",
    shortName: "Scaling",
    path: "/scaling",
    description:
      "Auto-scaling groups that never scale, hit their ceiling, or could benefit from scheduled scaling.",
    recordNoun: "group",
    thresholdsKey: "scaling",
    enabled: false,
  },
];

export const ENABLED_MODULES: ModuleConfig[] = MODULES.filter(
  (m) => m.enabled !== false
);

export const isModuleEnabled = (id: ModuleId): boolean =>
  MODULE_BY_ID[id]?.enabled !== false;

export const MODULE_BY_ID: Record<ModuleId, ModuleConfig> = MODULES.reduce(
  (acc, m) => ({ ...acc, [m.id]: m }),
  {} as Record<ModuleId, ModuleConfig>
);
