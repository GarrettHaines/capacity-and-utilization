import { useEffect, useState } from "react";
import {
  Label,
  Select,
  Switch,
  TextInput,
  ToggleButtonGroup,
} from "@dynatrace/strato-components-preview/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Paragraph } from "@dynatrace/strato-components/typography";
import { PlusIcon, DeleteIcon } from "@dynatrace/strato-icons";
import type {
  ColumnBroadcast,
  CustomColumn,
  CustomColumnSourceType,
  CustomColumnTag,
  ModuleId,
} from "../types/types";
import { generateId } from "../utils/helpers";

// Cap on the tag chain: primary plus fallbacks.
const MAX_TAGS = 6;
import { fetchAllTagKeys } from "../api/tag-columns";
import {
  METRIC_STAT_ORDER,
  metricKeyToSelection,
  metricPickerGroups,
  type MetricStat,
} from "../utils/columns";

// Full aggregation names for the Statistic dropdown. The auto-filled column
// label stays short ("Min IOPS", "CPU P95"); that comes from STAT_LABEL /
// STAT_CAP in utils/columns, not this map.
const STAT_DISPLAY: Record<MetricStat, string> = {
  min: "Minimum",
  avg: "Average",
  p50: "Median",
  p95: "95th percentile",
  max: "Maximum",
};

/**
 * Shared add/edit form for a custom column. A column maps a header label to a
 * value source: a metric (an already-computed CPU/memory/IOPS stat, no extra
 * query) or a tag value. The host-metadata source exists in the model but its
 * picker option is hidden.
 *
 * Pass `initial` to edit an existing column; its id is preserved.
 */
export const AddCustomColumnForm = ({
  module,
  initial,
  submitLabel = "Add column",
  allowBroadcast = false,
  defaultTagBroadcast = "view",
  existingTagColumnName,
  onAdd,
  onCancel,
}: {
  module: ModuleId;
  initial?: CustomColumn;
  submitLabel?: string;
  /** Show the broadcast selector (add flow only, never editing). */
  allowBroadcast?: boolean;
  /** Pre-selected reach for a new tag column (from the app's filter scope). */
  defaultTagBroadcast?: ColumnBroadcast;
  /**
   * The shared name a tag key already uses elsewhere in the naming scope, if
   * any. Picking that tag key auto-fills the label so same-tag columns stay in
   * sync.
   */
  existingTagColumnName?: (tagKey: string) => string | undefined;
  onAdd: (col: CustomColumn, opts?: { broadcast?: ColumnBroadcast }) => void;
  onCancel: () => void;
}) => {
  const groups = metricPickerGroups(module);
  const initMetric =
    initial?.source.type === "metric" && initial.source.metricKey
      ? metricKeyToSelection(module, initial.source.metricKey)
      : null;

  const [label, setLabel] = useState(initial?.label ?? "");
  const [sourceType, setSourceType] = useState<CustomColumnSourceType>(
    initial?.source.type ?? (groups.length > 0 ? "metric" : "tag")
  );
  const [tags, setTags] = useState<CustomColumnTag[]>(
    initial?.source.type === "tag" && initial.source.tags?.length
      ? initial.source.tags.map((t) => ({ key: t.key, regex: t.regex }))
      : [{ key: initial?.source.tagKey ?? "" }]
  );
  const [caseTransform, setCaseTransform] = useState<"none" | "upper" | "lower">(
    initial?.source.caseTransform ?? "none"
  );
  const [metricGroupId, setMetricGroupId] = useState(
    initMetric?.groupId ?? groups[0]?.id ?? ""
  );
  const [metricStat, setMetricStat] = useState<MetricStat>(
    initMetric?.stat ?? "p95"
  );
  const [metricPercent, setMetricPercent] = useState(initMetric?.percent ?? false);
  // Metric columns only reach within a module, so their broadcast is a
  // two-state "both usage views" switch. Tag columns reach further and get the
  // three-way selector seeded from the app's filter scope.
  const [metricBothViews, setMetricBothViews] = useState(true);
  const [tagBroadcast, setTagBroadcast] = useState<ColumnBroadcast>(defaultTagBroadcast);
  const [keys, setKeys] = useState<string[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  // An existing column already has a meaningful label, so skip auto-fill.
  const [labelTouched, setLabelTouched] = useState(!!initial);

  const group = groups.find((g) => g.id === metricGroupId);

  useEffect(() => {
    let cancelled = false;
    setKeysLoading(true);
    fetchAllTagKeys()
      .then((ks) => {
        if (!cancelled) setKeys(ks);
      })
      .finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the label in sync with the metric selection until the user edits it.
  useEffect(() => {
    if (labelTouched || sourceType !== "metric" || !group) return;
    setLabel(group.toLabel(group.stats.length ? metricStat : null, metricPercent));
  }, [labelTouched, sourceType, group, metricStat, metricPercent]);

  const setTagAt = (i: number, patch: Partial<CustomColumnTag>) =>
    setTags((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addFallback = () =>
    setTags((prev) => (prev.length < MAX_TAGS ? [...prev, { key: "" }] : prev));
  const removeTagAt = (i: number) =>
    setTags((prev) => prev.filter((_, idx) => idx !== i));
  const choosePrimary = (k: string) => {
    setTagAt(0, { key: k });
    // Prefer the name this tag key already uses so same-tag columns share it.
    if (!labelTouched && k) setLabel(existingTagColumnName?.(k) ?? k);
  };

  const canSubmit =
    label.trim() !== "" &&
    ((sourceType === "tag" && (tags[0]?.key.trim() ?? "") !== "") ||
      (sourceType === "metric" && !!group));

  const submit = () => {
    if (!canSubmit) return;
    const id = initial?.id ?? generateId("col");
    const broadcast: ColumnBroadcast | undefined =
      allowBroadcast && !initial
        ? sourceType === "metric"
          ? metricBothViews
            ? "module"
            : "view"
          : tagBroadcast
        : undefined;
    const opts = { broadcast };
    if (sourceType === "metric" && group) {
      const stat = group.stats.length ? metricStat : null;
      const metricKey = group.toKey(stat, group.hasPercent ? metricPercent : false);
      onAdd(
        { id, label: label.trim(), source: { type: "metric", metricKey } },
        opts
      );
      return;
    }
    const chain = tags
      .filter((t) => t.key.trim() !== "")
      .map((t) => ({
        key: t.key,
        regex: t.regex && t.regex.trim() !== "" ? t.regex.trim() : undefined,
      }));
    onAdd(
      {
        id,
        label: label.trim(),
        source: {
          type: "tag",
          tagKey: chain[0]?.key ?? "",
          tags: chain,
          caseTransform: caseTransform === "none" ? undefined : caseTransform,
        },
      },
      opts
    );
  };

  return (
    <Flex flexDirection="column" gap={8} className="custom-column-form">
      <div>
        <ToggleButtonGroup
          value={sourceType}
          onChange={(v) =>
            setSourceType(
              v === "metric" ? "metric" : v === "metadata" ? "metadata" : "tag"
            )
          }
        >
          {groups.length > 0 && (
            <ToggleButtonGroup.Item value="metric">Metric</ToggleButtonGroup.Item>
          )}
          <ToggleButtonGroup.Item value="tag">Tag</ToggleButtonGroup.Item>
          {/* Host metadata source: hidden UI, restore later.
          <ToggleButtonGroup.Item value="metadata">
            Host metadata
          </ToggleButtonGroup.Item> */}
        </ToggleButtonGroup>
      </div>

      {sourceType === "metric" ? (
        <>
          <div>
            <Label>Metric</Label>
            <Select
              value={metricGroupId}
              onChange={(v) => setMetricGroupId(String(v ?? ""))}
            >
              <Select.Trigger width="full" />
              <Select.Content>
                {groups.map((g) => (
                  <Select.Option key={g.id} value={g.id}>
                    {g.label}
                  </Select.Option>
                ))}
              </Select.Content>
            </Select>
          </div>
          {group && group.stats.length > 0 && (
            <div>
              <Label>Statistic</Label>
              <Select
                value={metricStat}
                onChange={(v) => setMetricStat((String(v ?? "p95") as MetricStat))}
              >
                <Select.Trigger width="full" />
                <Select.Content>
                  {METRIC_STAT_ORDER.map((s) => (
                    <Select.Option key={s} value={s}>
                      {STAT_DISPLAY[s]}
                    </Select.Option>
                  ))}
                </Select.Content>
              </Select>
            </div>
          )}
          {group && group.hasPercent && (
            <Flex gap={8} alignItems="center">
              <Switch
                value={metricPercent}
                onChange={(v) => setMetricPercent(Boolean(v))}
              />
              <Paragraph>Show as a percentage of total (%)</Paragraph>
            </Flex>
          )}
        </>
      ) : sourceType === "metadata" ? (
        <Paragraph className="text-subdued">
          Host metadata columns are coming soon. Choose "Metric" or "Tag" for now.
        </Paragraph>
      ) : keysLoading ? (
        <Paragraph className="text-subdued">Loading tag keys…</Paragraph>
      ) : keys.length === 0 ? (
        <Paragraph className="text-subdued">
          No tags found on this tenant.
        </Paragraph>
      ) : (
        <>
          {tags.map((t, i) => (
            <div key={i} className="custom-tag-row">
              <Label>{i === 0 ? "Tag key" : `Fallback ${i}`}</Label>
              <Flex gap={6} alignItems="center">
                <div style={{ flex: 1 }}>
                  <Select
                    value={t.key}
                    onChange={(v) =>
                      i === 0
                        ? choosePrimary(String(v ?? ""))
                        : setTagAt(i, { key: String(v ?? "") })
                    }
                  >
                    <Select.Trigger width="full" />
                    <Select.Content>
                      {keys.map((k) => (
                        <Select.Option key={k} value={k}>
                          {k}
                        </Select.Option>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
                {i > 0 && (
                  <Button
                    className="tag-remove-btn"
                    size="condensed"
                    aria-label="Remove fallback tag"
                    onClick={() => removeTagAt(i)}
                  >
                    <DeleteIcon />
                  </Button>
                )}
              </Flex>
              <div style={{ marginTop: 8 }}>
                <TextInput
                  placeholder="Optional regex to parse the value, e.g. ^([^.]+)"
                  value={t.regex ?? ""}
                  onChange={(v) => setTagAt(i, { regex: String(v ?? "") })}
                />
              </div>
            </div>
          ))}
          {tags.length < MAX_TAGS && (
            <div>
              <Button variant="emphasized" onClick={addFallback}>
                <PlusIcon className="button-add-margin-right-4" /> Add fallback tag
              </Button>
            </div>
          )}
          <Flex flexDirection="column" gap={6}>
            <Label>Value case</Label>
            <ToggleButtonGroup
              value={caseTransform}
              onChange={(v) =>
                setCaseTransform(v === "upper" ? "upper" : v === "lower" ? "lower" : "none")
              }
            >
              <ToggleButtonGroup.Item value="none">As-is</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="upper">Uppercase</ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="lower">Lowercase</ToggleButtonGroup.Item>
            </ToggleButtonGroup>
          </Flex>
        </>
      )}

      <div>
        <Label>Column label</Label>
        <TextInput
          placeholder="e.g. App"
          value={label}
          onChange={(v) => {
            setLabel(String(v ?? ""));
            setLabelTouched(true);
          }}
        />
      </div>

      {allowBroadcast && !initial && sourceType === "metric" && (
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <Flex gap={8} alignItems="center">
            <Switch
              value={metricBothViews}
              onChange={(v) => setMetricBothViews(Boolean(v))}
            />
            <Paragraph>Add to every tab on this page</Paragraph>
          </Flex>
        </div>
      )}

      {allowBroadcast && !initial && sourceType === "tag" && (
        <Flex flexDirection="column" gap={6}>
          <Label>Add this column to</Label>
          <ToggleButtonGroup
            value={tagBroadcast}
            onChange={(v) =>
              setTagBroadcast(v === "app" ? "app" : v === "module" ? "module" : "view")
            }
          >
            <ToggleButtonGroup.Item value="view">This tab</ToggleButtonGroup.Item>
            <ToggleButtonGroup.Item value="module">
              All tabs on this page
            </ToggleButtonGroup.Item>
            <ToggleButtonGroup.Item value="app">All pages</ToggleButtonGroup.Item>
          </ToggleButtonGroup>
        </Flex>
      )}

      <Flex gap={6}>
        <Button variant="emphasized" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="accent"
          color="primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </Flex>
    </Flex>
  );
};

/** Short human description of a column's source, e.g. `Tag · APP-ID (+2)`. */
export function describeColumnSource(col: CustomColumn): string {
  if (col.source.type === "tag") {
    const chain =
      col.source.tags && col.source.tags.length > 0
        ? col.source.tags
        : col.source.tagKey
        ? [{ key: col.source.tagKey }]
        : [];
    const primary = chain[0]?.key ?? "—";
    const extra = chain.length > 1 ? ` (+${chain.length - 1})` : "";
    return `Tag · ${primary}${extra}`;
  }
  if (col.source.type === "metric") return "Metric";
  if (col.source.type === "metadata")
    return `Metadata · ${col.source.metadataKey ?? "—"}`;
  return "—";
}
