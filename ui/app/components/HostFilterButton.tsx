import { useEffect, useState } from "react";
import { Modal } from "@dynatrace/strato-components-preview/overlays";
import {
  Label,
  Select,
  ToggleButtonGroup,
} from "@dynatrace/strato-components-preview/forms";
import { Checkbox } from "@dynatrace/strato-components/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Container, Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import { FilterIcon } from "@dynatrace/strato-icons";
import type { HostFilter, Severity, TagFilter } from "../types/types";
import { EMPTY_HOST_FILTER } from "../types/types";
import { SEVERITY_ORDER, severityLabel } from "../utils/helpers";
import {
  CLOUD_OPTIONS,
  OS_OPTIONS,
  fetchHostTagKeys,
  fetchHostTagValues,
} from "../api/host-filter";

export interface HostFilterButtonProps {
  value: HostFilter;
  onChange: (next: HostFilter) => void;
  activeSeverities?: Set<Severity>;
  onSeveritiesChange?: (next: Set<Severity>) => void;
}

/**
 * Trigger + modal for editing the tag / OS / cloud-provider host filter
 * (homepage). Reuses HostFilterFields so it matches the per-page filter.
 */
export const HostFilterButton = ({
  value,
  onChange,
  activeSeverities,
  onSeveritiesChange,
}: HostFilterButtonProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="emphasized" onClick={() => setOpen(true)} aria-label="Filter">
        <Button.Prefix>
          <FilterIcon />
        </Button.Prefix>
        Filter
      </Button>
      <HostFilterModal
        open={open}
        initialFilter={value}
        initialSeverities={activeSeverities}
        showSeverity={!!activeSeverities && !!onSeveritiesChange}
        onClose={() => setOpen(false)}
        onApply={(nextFilter, nextSeverities) => {
          onChange(nextFilter);
          if (onSeveritiesChange && nextSeverities) onSeveritiesChange(nextSeverities);
          setOpen(false);
        }}
      />
    </>
  );
};

// Homepage modal: HostFilterFields plus a Severity section.

interface HostFilterModalProps {
  open: boolean;
  initialFilter: HostFilter;
  initialSeverities?: Set<Severity>;
  showSeverity: boolean;
  onClose: () => void;
  onApply: (next: HostFilter, nextSeverities?: Set<Severity>) => void;
}

const HostFilterModal = ({
  open,
  initialFilter,
  initialSeverities,
  showSeverity,
  onClose,
  onApply,
}: HostFilterModalProps) => {
  const [draft, setDraft] = useState<HostFilter>(initialFilter);
  const [sevDraft, setSevDraft] = useState<Set<Severity>>(
    () => new Set(initialSeverities ?? SEVERITY_ORDER)
  );

  useEffect(() => {
    if (open) {
      setDraft(initialFilter);
      setSevDraft(new Set(initialSeverities ?? SEVERITY_ORDER));
    }
  }, [open, initialFilter, initialSeverities]);

  const toggleSeverity = (sev: Severity) => {
    const next = new Set(sevDraft);
    if (next.has(sev)) next.delete(sev);
    else next.add(sev);
    setSevDraft(next);
  };

  return (
    <Modal show={open} onDismiss={onClose} title="Host filter" size="medium">
      <div className="modal-body">
        <Flex flexDirection="column" gap={12}>
          <Paragraph className="text-secondary">
            Narrow findings to a subset of hosts by tag, OS, or cloud provider,
            on top of the current scope.
          </Paragraph>

          {showSeverity && (
            <div className="filter-section">
              <Heading level={5}>Severity</Heading>
              <Paragraph className="text-secondary">
                Show / hide findings by tier. Persisted across pages.
              </Paragraph>
              <div className="filter-checkbox-row">
                {SEVERITY_ORDER.map((sev) => (
                  <Checkbox
                    key={sev}
                    value={sevDraft.has(sev)}
                    onChange={() => toggleSeverity(sev)}
                  >
                    {severityLabel(sev)}
                  </Checkbox>
                ))}
              </div>
            </div>
          )}

          <HostFilterFields value={draft} onChange={setDraft} />
        </Flex>
      </div>

      <Flex className="modal-footer" gap={8}>
        <Button
          variant="emphasized"
          onClick={() => {
            setDraft(EMPTY_HOST_FILTER);
            setSevDraft(new Set(SEVERITY_ORDER));
          }}
        >
          Clear all
        </Button>
        <Button variant="emphasized" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="accent"
          color="primary"
          onClick={() => onApply(draft, showSeverity ? sevDraft : undefined)}
        >
          Apply
        </Button>
      </Flex>
    </Modal>
  );
};

// Reusable host-filter sections (no modal chrome).

/**
 * A page's custom column that's backed by a tag. Rendered in its own
 * **Columns** section (labelled by `columnLabel`, not the raw tag), where you
 * can narrow its value but not add or remove it.
 */
export interface SuggestedTagColumn {
  tagKey: string;
  columnLabel: string;
}

/**
 * OS / Cloud / Columns / Tags sections. `suggestedColumns` (a page's shown
 * tag-backed columns) get a **Columns** section of value pickers; the **Tags**
 * section holds any other host tag and greys out column-backed keys in its add
 * dropdown. A tag filtered under Tags automatically moves to Columns if a column
 * for that tag later appears (same stored value), and back if it's removed.
 */
export const HostFilterFields = ({
  value,
  onChange,
  suggestedColumns,
  render,
}: {
  value: HostFilter;
  onChange: (next: HostFilter) => void;
  suggestedColumns?: SuggestedTagColumn[];
  /** Which sections to render: "columns" (only the per-column value pickers,
   *  for the Thresholds menu), "attributes" (Tags / OS / Deployment, for the
   *  Filters menu), or all when omitted. */
  render?: "columns" | "attributes";
}) => {
  const toggleListMember = (
    list: string[] | undefined,
    member: string,
    setter: (next: string[]) => void
  ) => {
    const set = new Set(list ?? []);
    if (set.has(member)) set.delete(member);
    else set.add(member);
    setter(Array.from(set));
  };
  const setOsTypes = (next: string[]) => onChange({ ...value, osTypes: next });
  const setCloudTypes = (next: string[]) =>
    onChange({ ...value, cloudTypes: next });
  const setOsMode = (mode: "include" | "exclude") =>
    onChange({ ...value, osMode: mode });
  const setCloudMode = (mode: "include" | "exclude") =>
    onChange({ ...value, cloudMode: mode });
  const setKubernetes = (mode: "include" | "only" | "exclude") =>
    onChange({ ...value, kubernetes: mode });
  // A tag key lives in EITHER `tags` (manual) or `columnFilters`, never both.
  // Claiming a column's tag in the Tags section drops it from columnFilters
  // (greying its column picker); setting a column value can't resurrect a key
  // that's claimed in Tags.
  const setTags = (next: TagFilter[]) =>
    onChange({
      ...value,
      tags: next,
      columnFilters: (value.columnFilters ?? []).filter(
        (cf) => !next.some((t) => t.key === cf.key)
      ),
    });
  const setColumnFilters = (next: TagFilter[]) =>
    onChange({
      ...value,
      columnFilters: next,
      tags: (value.tags ?? []).filter((t) => !next.some((cf) => cf.key === t.key)),
    });
  const showColumns = render !== "attributes";
  const showAttributes = render !== "columns";
  // Keys backed by a shown column. The Tags section flags these as "also a
  // column" and, when one is added there, claims it out of the Columns section.
  const tagColumnKeys = new Set((suggestedColumns ?? []).map((c) => c.tagKey));
  return (
    <>
      {showColumns && (suggestedColumns?.length ?? 0) > 0 && (
        <div className="filter-section">
          <Heading level={5}>Columns</Heading>
          <Paragraph className="text-secondary">
            Narrow by the value of a column shown on this page. A host matches if
            it has any value you pick. A column value filter only applies where
            the column is shown; it's ignored on pages that hide or drop it.
          </Paragraph>
          <ColumnFilterList
            columns={suggestedColumns!}
            columnFilters={value.columnFilters ?? []}
            claimedKeys={new Set((value.tags ?? []).map((t) => t.key))}
            onChange={setColumnFilters}
          />
        </div>
      )}
      {showAttributes && (
        <>
          <div className="filter-section">
            <Heading level={5}>Tags</Heading>
            <Paragraph className="text-secondary">
              Filter on any host tag. Pick values, or leave "All values" to not
              filter on a tag. A host matches if it has any value you pick for a
              tag, and matches every tag you add.
            </Paragraph>
            <TagList
              tags={value.tags ?? []}
              columnKeys={tagColumnKeys}
              onChange={setTags}
            />
          </div>
          <div className="filter-section">
            <Heading level={5}>Operating system</Heading>
            <ToggleButtonGroup
              value={value.osMode ?? "include"}
              onChange={(v) => setOsMode(v === "exclude" ? "exclude" : "include")}
            >
              <ToggleButtonGroup.Item value="include">
                Include only selected
              </ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="exclude">
                Exclude selected
              </ToggleButtonGroup.Item>
            </ToggleButtonGroup>
            <div className="filter-checkbox-grid">
              {OS_OPTIONS.map((opt) => {
                const active = (value.osTypes ?? []).includes(opt.value);
                return (
                  <Checkbox
                    key={opt.value}
                    value={active}
                    onChange={() =>
                      toggleListMember(value.osTypes, opt.value, setOsTypes)
                    }
                  >
                    {opt.label}
                  </Checkbox>
                );
              })}
            </div>
          </div>
          <div className="filter-section">
            <Heading level={5}>Deployment</Heading>
            <ToggleButtonGroup
              value={value.cloudMode ?? "include"}
              onChange={(v) => setCloudMode(v === "exclude" ? "exclude" : "include")}
            >
              <ToggleButtonGroup.Item value="include">
                Include only selected
              </ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="exclude">
                Exclude selected
              </ToggleButtonGroup.Item>
            </ToggleButtonGroup>
            <div className="filter-checkbox-grid">
              {CLOUD_OPTIONS.map((opt) => {
                const active = (value.cloudTypes ?? []).includes(opt.value);
                return (
                  <Checkbox
                    key={opt.value}
                    value={active}
                    onChange={() =>
                      toggleListMember(value.cloudTypes, opt.value, setCloudTypes)
                    }
                  >
                    {opt.label}
                  </Checkbox>
                );
              })}
            </div>
          </div>
          <div className="filter-section">
            <Heading level={5}>Kubernetes</Heading>
            <Paragraph className="text-secondary">
              Filter by whether a host runs Kubernetes, independent of its cloud
              provider.
            </Paragraph>
            <ToggleButtonGroup
              value={value.kubernetes ?? "include"}
              onChange={(v) =>
                setKubernetes(
                  v === "only" ? "only" : v === "exclude" ? "exclude" : "include"
                )
              }
            >
              <ToggleButtonGroup.Item value="include">
                Include
              </ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="only">
                Include only
              </ToggleButtonGroup.Item>
              <ToggleButtonGroup.Item value="exclude">
                Exclude
              </ToggleButtonGroup.Item>
            </ToggleButtonGroup>
          </div>
        </>
      )}
    </>
  );
};

// Column filters: value pickers for the tag-backed columns shown on the page.
// Narrowing only (no add / remove); each row is labelled by its column name,
// not the underlying tag.

const ColumnFilterList = ({
  columns,
  columnFilters,
  claimedKeys,
  onChange,
}: {
  columns: SuggestedTagColumn[];
  columnFilters: TagFilter[];
  /** Tag keys claimed by the Tags section; their pickers grey out here. */
  claimedKeys: Set<string>;
  onChange: (next: TagFilter[]) => void;
}) => {
  // Dedupe by tag key (two columns could share a tag); first label wins.
  const seen = new Set<string>();
  const uniq = columns.filter(
    (c) => c.tagKey && !seen.has(c.tagKey) && (seen.add(c.tagKey), true)
  );
  const valuesFor = (key: string) =>
    columnFilters.find((t) => t.key === key)?.values ?? ["*"];
  const setValues = (key: string, vals: string[]) => {
    const concrete = vals.filter((v) => v && v !== "*");
    const others = columnFilters.filter((t) => t.key !== key);
    // Clearing to "all values" drops the stored filter so it doesn't linger.
    onChange(concrete.length > 0 ? [...others, { key, values: concrete }] : others);
  };
  return (
    <Flex flexDirection="column" gap={8}>
      {uniq.map((col) => {
        const claimed = claimedKeys.has(col.tagKey);
        return (
          <Flex
            key={col.tagKey}
            flexDirection="column"
            gap={6}
            style={claimed ? { opacity: 0.5 } : undefined}
          >
            <Label>{col.columnLabel}</Label>
            {claimed ? (
              <Paragraph className="text-subdued">
                Filtered in the Tags section as "{col.tagKey}". Remove it there to
                filter by this column again.
              </Paragraph>
            ) : (
              <TagValueSelect
                tagKey={col.tagKey}
                selected={valuesFor(col.tagKey)}
                onChange={(vals) => setValues(col.tagKey, vals)}
              />
            )}
          </Flex>
        );
      })}
    </Flex>
  );
};

// Tag list: one compact row per tag (key + multiselect + Remove).

const TagList = ({
  tags,
  columnKeys,
  onChange,
}: {
  tags: TagFilter[];
  /** Tag keys already backed by a shown column; they belong in the Columns
   *  section, and the add dropdown marks them "(also a column)". */
  columnKeys: Set<string>;
  onChange: (next: TagFilter[]) => void;
}) => {
  const [adding, setAdding] = useState(false);

  // Column value filters live in their own array, so every entry in `tags` is
  // a manual filter and shows here.
  const manual = tags;

  const setValuesFor = (key: string, values: string[]) => {
    const existing = tags.find((t) => t.key === key);
    onChange(
      existing
        ? tags.map((t) => (t.key === key ? { key, values } : t))
        : [...tags, { key, values }]
    );
  };
  const remove = (key: string) => onChange(tags.filter((t) => t.key !== key));
  const addTag = (tag: TagFilter) => {
    onChange([...tags, tag]);
    setAdding(false);
  };

  return (
    <Flex flexDirection="column" gap={8}>
      {manual.length === 0 ? (
        <Paragraph className="text-subdued">No tag filters applied.</Paragraph>
      ) : (
        manual.map((tag) => (
          <Container key={tag.key} p={12}>
            <Flex flexDirection="column" gap={6}>
              <Flex justifyContent="space-between" alignItems="center" gap={8}>
                <Label>{tag.key}</Label>
                <Button
                  variant="default"
                  size="condensed"
                  onClick={() => remove(tag.key)}
                >
                  Remove
                </Button>
              </Flex>
              <TagValueSelect
                tagKey={tag.key}
                selected={tag.values ?? ["*"]}
                onChange={(vals) => setValuesFor(tag.key, vals)}
              />
              {columnKeys.has(tag.key) && (
                <Paragraph className="text-subdued">
                  Also a column here. Filtered as a tag until removed, then it
                  returns to the Columns section.
                </Paragraph>
              )}
            </Flex>
          </Container>
        ))
      )}
      {adding ? (
        <AddTagFlow
          existingKeys={new Set(manual.map((t) => t.key))}
          columnKeys={columnKeys}
          onAdd={addTag}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div>
          <Button variant="emphasized" onClick={() => setAdding(true)}>
            + Add tag
          </Button>
        </div>
      )}
    </Flex>
  );
};

/**
 * Multiselect value picker (Strato `<Select multiple>`). Empty selection means
 * "all values" (a no-op), stored as `["*"]`.
 */
const TagValueSelect = ({
  tagKey,
  selected,
  onChange,
}: {
  tagKey: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) => {
  const [values, setValues] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchHostTagValues(tagKey)
      .then((vs) => {
        if (!cancelled) setValues(vs);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tagKey]);

  const concrete = (selected ?? []).filter((v) => v && v !== "*");
  const handle = (next: string[]) => onChange(next.length > 0 ? next : ["*"]);

  if (loading) {
    return <Paragraph className="text-subdued">Loading values…</Paragraph>;
  }
  if (values.length === 0) {
    return <Paragraph className="text-subdued">Any value</Paragraph>;
  }
  return (
    <Select
      multiple
      value={concrete}
      onChange={(v) => handle(Array.isArray(v) ? (v as string[]) : [])}
    >
      <Select.Trigger placeholder="All values" width="full" />
      <Select.Content>
        {values.map((v) => (
          <Select.Option key={v} value={v}>
            {v}
          </Select.Option>
        ))}
      </Select.Content>
    </Select>
  );
};

const AddTagFlow = ({
  existingKeys,
  columnKeys,
  onAdd,
  onCancel,
}: {
  existingKeys: Set<string>;
  /** Keys backing a shown column; marked here, normally filtered in Columns. */
  columnKeys: Set<string>;
  onAdd: (tag: TagFilter) => void;
  onCancel: () => void;
}) => {
  const [keys, setKeys] = useState<string[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setKeysLoading(true);
    fetchHostTagKeys()
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

  const available = keys.filter((k) => !existingKeys.has(k));

  return (
    <Container p={12}>
      <Flex flexDirection="column" gap={6}>
        <Label>Tag key</Label>
        {keysLoading ? (
          <Paragraph className="text-subdued">Loading tag keys…</Paragraph>
        ) : available.length === 0 ? (
          <Paragraph className="text-subdued">No more tag keys to add.</Paragraph>
        ) : (
          <Select
            value={selectedKey}
            onChange={(v) => setSelectedKey(String(v ?? ""))}
          >
            <Select.Trigger width="full" />
            <Select.Content>
              {available.map((k) => (
                <Select.Option key={k} value={k}>
                  {columnKeys.has(k) ? `${k} (also a column)` : k}
                </Select.Option>
              ))}
            </Select.Content>
          </Select>
        )}
        {selectedKey && columnKeys.has(selectedKey) && (
          <Paragraph className="text-subdued">
            This tag also backs a column. Adding it here filters by tag and greys
            out that column's picker until you remove it.
          </Paragraph>
        )}
        <Flex gap={6}>
          <Button variant="emphasized" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accent"
            color="primary"
            disabled={!selectedKey}
            onClick={() => onAdd({ key: selectedKey, values: ["*"] })}
          >
            Add
          </Button>
        </Flex>
      </Flex>
    </Container>
  );
};
