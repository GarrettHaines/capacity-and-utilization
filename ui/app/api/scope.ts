import {
  monitoredEntitiesClient,
  settingsObjectsClient,
} from "@dynatrace-sdk/client-classic-environment-v2";
import type {
  HostFilter,
  ManagementZone,
  ScopeRef,
  Segment,
  TimeframeRange,
} from "../types/types";
import { toEntityApiTimeRef } from "../utils/helpers";
import { isEmptyHostFilter, resolveHostFilterIds } from "./host-filter";

/** Returns all management zones visible to the calling user. */
export async function fetchManagementZones(): Promise<ManagementZone[]> {
  const out: ManagementZone[] = [];
  // The Settings API rejects pageSize / fields / schemaIds once nextPageKey is
  // set, so send the full param set only on the first page.
  async function page(pageKey?: string): Promise<void> {
    try {
      const response = await settingsObjectsClient.getSettingsObjects(
        pageKey
          ? { nextPageKey: pageKey }
          : {
              schemaIds: "builtin:management-zones",
              pageSize: 500,
              fields: "objectId,value",
            }
      );
      for (const item of response.items ?? []) {
        const v = (item.value ?? {}) as { name?: string };
        if (v?.name) {
          out.push({ id: item.objectId!, name: v.name });
        }
      }
      if (response.nextPageKey) await page(response.nextPageKey);
    } catch (err) {
      console.error("fetchManagementZones failed", err);
    }
  }
  await page();
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns user-created segments (Grail filter sets). */
export async function fetchSegments(): Promise<Segment[]> {
  const candidates = ["app:dynatrace.segments:segment"];
  const out: Segment[] = [];
  for (const schemaId of candidates) {
    try {
      const response = await settingsObjectsClient.getSettingsObjects({
        schemaIds: schemaId,
        pageSize: 500,
        fields: "objectId,value",
      });
      for (const item of response.items ?? []) {
        const v = (item.value ?? {}) as { name?: string; description?: string };
        if (v?.name) {
          out.push({
            id: item.objectId!,
            name: v.name,
            description: v.description,
          });
        }
      }
      if (out.length) break;
    } catch (err) {
      // Not all tenants expose this schema; a miss is not an error.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a DQL filter fragment for the active scope.
 *
 * Grail metric records carry no management-zone field, so an MZ scope resolves
 * to an entity-id list through the classic entities API and filters on ids;
 * segments use the Grail-native `segment()` macro. The (MZ, type) id list is
 * cached per session.
 *
 * @param entityField  DQL field holding the entity id; also selects which
 *                     classic entity type an MZ resolves to.
 */
export async function scopeToDqlFilter(
  scope: ScopeRef,
  entityField: string = "dt.entity.host",
  timeframe?: TimeframeRange,
  /**
   * Tag / OS / cloud filter applied on top of the scope: resolved to a host-id
   * list and intersected with the MZ id list, or used alone when scope is "all".
   */
  hostFilter?: HostFilter
): Promise<string> {
  const wantHostFilter =
    !!hostFilter &&
    !isEmptyHostFilter(hostFilter) &&
    // Only meaningful when the metric is keyed by a host entity. Disk still
    // filters by its owning host, matching the user's intent.
    (entityField === "dt.entity.host" || entityField === "dt.entity.disk");

  if (!wantHostFilter) {
    if (!scope || scope.mode === "all" || !scope.id) return "";
    if (scope.mode === "management-zone") {
      const type = entityFieldToType(entityField);
      if (!type) return "";
      const ids = await fetchEntityIdsInMz(scope.name, type, timeframe?.from);
      if (ids.length === 0) {
        console.warn(
          `[scope:mz] zero ${type} entities in MZ "${scope.name}"; metric query returns empty`
        );
        return `| filter false`;
      }
      return `| filter in(${entityField}, ${ids.map((id) => `"${id}"`).join(", ")})`;
    }
    if (scope.mode === "segment") {
      return `| filter segment("${escapeDql(scope.id)}")`;
    }
    return "";
  }

  const filterIds = await resolveHostFilterIds(hostFilter!);
  if (filterIds == null) return "";
  if (filterIds.length === 0) {
    return `| filter false`;
  }
  // dt.entity.disk metrics filter on the owning host (the user picks hosts);
  // the disk's host id sits on the metric row under dt.entity.host.
  const filterField =
    entityField === "dt.entity.disk" ? "dt.entity.host" : entityField;

  if (scope.mode === "management-zone" && scope.id) {
    const ids = await fetchEntityIdsInMz(scope.name, "HOST", timeframe?.from);
    if (ids.length === 0) {
      console.warn(
        `[scope:mz] zero HOST entities in MZ "${scope.name}"; metric query returns empty`
      );
      return `| filter false`;
    }
    const mzSet = new Set(ids);
    const intersected = filterIds.filter((id) => mzSet.has(id));
    if (intersected.length === 0) {
      console.warn(
        `[scope+filter] MZ "${scope.name}" intersection with host filter is empty`
      );
      return `| filter false`;
    }
    return `| filter in(${filterField}, ${intersected
      .map((id) => `"${id}"`)
      .join(", ")})`;
  }
  if (scope.mode === "segment") {
    return `| filter segment("${escapeDql(scope.id)}") | filter in(${filterField}, ${filterIds
      .map((id) => `"${id}"`)
      .join(", ")})`;
  }
  return `| filter in(${filterField}, ${filterIds.map((id) => `"${id}"`).join(", ")})`;
}

/** Cache of "<type>:<mzName>:<fromExpr>" → entity-id list. */
const _mzEntityIdCache = new Map<string, string[]>();

async function fetchEntityIdsInMz(
  mzName: string,
  type: string,
  // Fallback for call sites that don't thread the timeframe through; kept short
  // so it never scans a wide window of entities.
  fromExpr: string = "now-2h"
): Promise<string[]> {
  const key = `${type}:${mzName}:${fromExpr}`;
  if (_mzEntityIdCache.has(key)) return _mzEntityIdCache.get(key)!;

  const ids: string[] = [];
  let nextPageKey: string | undefined;
  const selector = `type("${type}"),mzName("${escapeSelector(mzName)}")`;
  console.log(`[scope:mz] lookup (from=${fromExpr}) → entitySelector=${selector}`);
  try {
    do {
      const response: any = nextPageKey
        ? await monitoredEntitiesClient.getEntities({ nextPageKey })
        : await monitoredEntitiesClient.getEntities({
            entitySelector: selector,
            from: toEntityApiTimeRef(fromExpr),
            pageSize: 500,
          });
      const pageEntities = response.entities ?? [];
      for (const e of pageEntities) {
        const id = e.entityId ?? e.id;
        if (id) ids.push(id);
      }
      nextPageKey = response.nextPageKey;
    } while (nextPageKey);
  } catch (err) {
    console.warn(`fetchEntityIdsInMz(${type}, ${mzName}) failed`, err);
  }
  console.log(`[scope:mz] ${type} in "${mzName}" → ${ids.length} total`);
  _mzEntityIdCache.set(key, ids);
  return ids;
}

function entityFieldToType(field: string): string {
  switch (field) {
    case "dt.entity.host": return "HOST";
    case "dt.entity.disk": return "DISK";
    case "dt.entity.kubernetes_node": return "KUBERNETES_NODE";
    case "dt.entity.kubernetes_cluster": return "KUBERNETES_CLUSTER";
    case "dt.entity.cloud_application": return "CLOUD_APPLICATION";
    default: return "";
  }
}

export function scopeToEntitySelector(scope: ScopeRef): string {
  if (!scope || scope.mode === "all" || !scope.id) return "";
  if (scope.mode === "management-zone") {
    return `,mzName("${escapeSelector(scope.name)}")`;
  }
  return "";
}

function escapeDql(input: string): string {
  return input.replace(/"/g, '\\"');
}

function escapeSelector(input: string): string {
  return input.replace(/"/g, '\\"');
}
