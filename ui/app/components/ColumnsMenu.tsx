import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Modal } from "@dynatrace/strato-components-preview/overlays";
import { Tab, Tabs } from "@dynatrace/strato-components/navigation";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import {
  ColumnsIcon,
  DragAllDirectionIcon,
  EditIcon,
  DeleteIcon,
  ViewIcon,
  HideIcon,
  PlusIcon,
} from "@dynatrace/strato-icons";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type {
  AppSettings,
  ColumnBroadcast,
  ColumnView,
  CustomColumn,
  FilterScope,
  ModuleId,
  PageColumnView,
} from "../types/types";
import { useScope } from "../contexts/ScopeContext";
import {
  METRIC_GROUP_LABEL,
  defaultColumnsFor,
  defaultHiddenFor,
  defaultOrderFor,
  hiddenColumnIds,
  metricGroupOfColumn,
  removalBlockReason,
  resolveColumnsForModule,
  type ColumnDescriptor,
  type MetricGroup,
} from "../utils/columns";
import { AddCustomColumnForm, describeColumnSource } from "./CustomColumnForm";
import { ConfirmDiscardModal } from "./ConfirmDiscardModal";
import { COLUMNS_SHOW_LABEL } from "../constants/ui-toggles";
import { ENABLED_MODULES } from "../constants/modules";
import { generateId } from "../utils/helpers";

type ViewKey = { module: ModuleId; view: ColumnView };

/** The three per-tab column layouts a module page keeps. */
const COLUMN_VIEWS: ColumnView[] = ["high", "low", "normal"];

/**
 * Submodules across which tag columns share a name, following the app's filter
 * scope: "view" = just this tab; "module" = every tab of this page; "app" =
 * every page.
 */
function nameScopeKeys(module: ModuleId, view: ColumnView, scope: FilterScope): ViewKey[] {
  if (scope === "view") return [{ module, view }];
  if (scope === "module") {
    return COLUMN_VIEWS.map((v) => ({ module, view: v }));
  }
  const out: ViewKey[] = [];
  for (const m of ENABLED_MODULES) {
    for (const v of COLUMN_VIEWS) out.push({ module: m.id, view: v });
  }
  return out;
}

/** Set every tag column on `tagKey` to `label` across the given submodules. */
function applySharedTagName(
  pageColumns: AppSettings["pageColumns"],
  keys: ViewKey[],
  tagKey: string,
  label: string
): AppSettings["pageColumns"] {
  const next = { ...pageColumns };
  for (const { module, view } of keys) {
    const cfg = next[module];
    const v = cfg?.[view];
    if (!v) continue;
    let changed = false;
    const cols = v.pageCustomColumns.map((c) => {
      if (c.source.type === "tag" && c.source.tagKey === tagKey && c.label !== label) {
        changed = true;
        return { ...c, label };
      }
      return c;
    });
    if (changed) next[module] = { ...cfg, [view]: { ...v, pageCustomColumns: cols } };
  }
  return next;
}

/** Label, source, and trailing controls shared by a live row and its drag
 *  overlay copy. `handleProps` carries dnd-kit's drag listeners onto the grip;
 *  the overlay passes none, so its grip is inert. */
const ColumnRowInner = ({
  col,
  hidden,
  canRemove,
  handleProps,
  onEdit,
  onRemove,
  onToggleHidden,
}: {
  col: ColumnDescriptor;
  hidden: boolean;
  canRemove: boolean;
  handleProps?: HTMLAttributes<HTMLElement>;
  onEdit?: () => void;
  onRemove?: () => void;
  onToggleHidden?: () => void;
}) => (
  <>
    <span className="column-drag-handle" title="Drag to reorder" {...(handleProps ?? {})}>
      <DragAllDirectionIcon />
    </span>

    <span className="column-manager-label">{col.label}</span>
    {col.custom && (
      <span className="text-subdued column-source-label">
        {describeColumnSource(col.custom)}
      </span>
    )}

    <div className="column-row-spacer" />

    {col.custom && onEdit && (
      <Button size="condensed" aria-label="Edit column" onClick={onEdit}>
        <EditIcon />
      </Button>
    )}

    {canRemove && onRemove && (
      <Button size="condensed" aria-label="Remove column" onClick={onRemove}>
        <DeleteIcon />
      </Button>
    )}

    {onToggleHidden && (
      <Button
        size="condensed"
        aria-label={hidden ? "Show column" : "Hide column"}
        onClick={onToggleHidden}
      >
        {hidden ? <HideIcon /> : <ViewIcon />}
      </Button>
    )}
  </>
);

/** One reorderable row. The row being dragged goes invisible in place so the
 *  DragOverlay copy is the only thing the cursor carries. */
const SortableColumnRow = (props: {
  col: ColumnDescriptor;
  hidden: boolean;
  canRemove: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onToggleHidden: () => void;
}) => {
  const { col, hidden } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: col.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // A dragged row keeps full opacity here; `column-row-source` hides its
    // contents while leaving the row box and its hairline, so the list keeps
    // its separators instead of showing a borderless gap.
    opacity: !isDragging && hidden ? 0.45 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`column-manager-row${isDragging ? " column-row-source" : ""}`}
    >
      <ColumnRowInner
        {...props}
        handleProps={
          { ...attributes, ...listeners } as unknown as HTMLAttributes<HTMLElement>
        }
      />
    </div>
  );
};

// Grouped column tree
//
// On compute, metric columns live under CPU / Memory sections mirroring the
// table's grouped headers. The persisted `order` stays a flat id list; grouping
// is derived from each column's metric key (metricGroupOfColumn), and
// flattening always writes a group's members out contiguously.

type ColumnNode =
  | { kind: "column"; id: string; col: ColumnDescriptor }
  | { kind: "group"; id: string; group: MetricGroup; children: ColumnDescriptor[] };

/** Sortable ids for the group containers. Distinct from any column id
 *  ("host" / "mount" / "metric-*" / "col-*"), so the two never collide. */
const GROUP_NODE_ID: Record<MetricGroup, string> = {
  cpu: "grp-cpu",
  mem: "grp-mem",
};

/** Fold the flat descriptor list into top-level nodes. A group is placed where
 *  its first member sat, matching how the table positions its group header. */
function buildColumnNodes(
  module: ModuleId,
  cols: ColumnDescriptor[]
): ColumnNode[] {
  const nodes: ColumnNode[] = [];
  const groups = new Map<MetricGroup, Extract<ColumnNode, { kind: "group" }>>();
  for (const col of cols) {
    const g = metricGroupOfColumn(module, col);
    if (!g) {
      nodes.push({ kind: "column", id: col.id, col });
      continue;
    }
    let node = groups.get(g);
    if (!node) {
      node = { kind: "group", id: GROUP_NODE_ID[g], group: g, children: [] };
      groups.set(g, node);
      nodes.push(node);
    }
    node.children.push(col);
  }
  return nodes;
}

/** Flatten back to the persisted flat id order, group members contiguous. */
function flattenColumnNodes(nodes: ColumnNode[]): string[] {
  return nodes.flatMap((n) =>
    n.kind === "group" ? n.children.map((c) => c.id) : [n.id]
  );
}

function columnSignature(
  order: string[],
  hidden: Set<string>,
  customs: CustomColumn[]
): string {
  return JSON.stringify([order, Array.from(hidden).sort(), customs]);
}

/**
 * A draggable CPU / Memory section: the header handle moves the whole block;
 * its children are their own sortable list and reorder within it.
 */
const SortableColumnGroup = ({
  node,
  hiddenIds,
  renderRow,
}: {
  node: Extract<ColumnNode, { kind: "group" }>;
  hiddenIds: Set<string>;
  renderRow: (col: ColumnDescriptor) => ReactNode;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id });
  const shown = node.children.filter((c) => !hiddenIds.has(c.id)).length;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`column-group${isDragging ? " column-group-dragging" : ""}`}
    >
      <div className="column-group-header">
        <span
          className="column-drag-handle"
          title="Drag to move the whole group"
          {...({ ...attributes, ...listeners } as unknown as HTMLAttributes<HTMLElement>)}
        >
          <DragAllDirectionIcon />
        </span>
        <span className="column-manager-label">{METRIC_GROUP_LABEL[node.group]}</span>
        <span className="text-subdued column-source-label">
          {shown} of {node.children.length} shown
        </span>
      </div>
      <SortableContext
        items={node.children.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="column-group-children">
          {node.children.map((c) => renderRow(c))}
        </div>
      </SortableContext>
    </div>
  );
};

/**
 * Per-page column manager. Drag a row by its handle to reorder; toggle
 * show/hide; add / edit / remove page custom columns. Built-ins can't be
 * removed. Columns are persisted per view.
 */
export const ColumnsMenu = ({
  module,
  usageView,
  onUsageViewChange,
}: {
  module: ModuleId;
  usageView: ColumnView;
  onUsageViewChange?: (next: ColumnView) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="emphasized"
        onClick={() => setOpen(true)}
        aria-label="Columns"
      >
        <Button.Prefix>
          <ColumnsIcon />
        </Button.Prefix>
        {COLUMNS_SHOW_LABEL ? "Columns" : null}
      </Button>
      <ColumnsModal
        module={module}
        usageView={usageView}
        onUsageViewChange={onUsageViewChange}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
};

const ColumnsModal = ({
  module,
  usageView,
  onUsageViewChange,
  open,
  onClose,
}: {
  module: ModuleId;
  usageView: ColumnView;
  onUsageViewChange?: (next: ColumnView) => void;
  open: boolean;
  onClose: () => void;
}) => {
  const { appSettings, setAppSettings, resetModuleColumns } = useScope();
  const [order, setOrder] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pageCustoms, setPageCustoms] = useState<CustomColumn[]>([]);
  // Reach chosen for each custom added this session ("view" adds nowhere else;
  // "module" also copies to the other tab; "app" copies across every page).
  // Already-saved columns aren't in this map, so they stay put.
  const [broadcastById, setBroadcastById] = useState<Map<string, ColumnBroadcast>>(
    new Map()
  );
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The row being dragged; the DragOverlay renders its floating copy.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const seedSig = useRef("");
  // A few px of movement before a drag starts, so clicking the handle (or the
  // edit/hide/remove buttons beside it) never triggers an accidental reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  useEffect(() => {
    if (!open) return;
    const resolved = resolveColumnsForModule(module, appSettings, usageView);
    const seedHidden = hiddenColumnIds(module, appSettings, usageView);
    const seedCustoms =
      appSettings.pageColumns?.[module]?.[usageView]?.pageCustomColumns ?? [];
    setOrder(resolved.map((c) => c.id));
    setHidden(seedHidden);
    setPageCustoms(seedCustoms);
    seedSig.current = columnSignature(
      flattenColumnNodes(buildColumnNodes(module, resolved)),
      seedHidden,
      seedCustoms
    );
    setConfirmDiscard(false);
    setBroadcastById(new Map());
    setAdding(false);
    setEditingId(null);
    setActiveId(null);
  }, [open, module, appSettings, usageView]);

  const descriptors = useMemo<ColumnDescriptor[]>(() => {
    const defaults = defaultColumnsFor(module);
    const pages: ColumnDescriptor[] = pageCustoms.map((c) => ({
      id: c.id,
      label: c.label,
      kind: "page",
      custom: c,
    }));
    const all = [...defaults, ...pages];
    const byId = new Map(all.map((c) => [c.id, c]));
    const ordered: ColumnDescriptor[] = [];
    for (const id of order) {
      const c = byId.get(id);
      if (c) {
        ordered.push(c);
        byId.delete(id);
      }
    }
    for (const c of all) if (byId.has(c.id)) ordered.push(c);
    return ordered;
  }, [module, pageCustoms, order]);

  // Top-level nodes (plain columns plus compute's CPU / Memory groups), and the
  // flat id order they serialize back to.
  const nodes = useMemo(
    () => buildColumnNodes(module, descriptors),
    [module, descriptors]
  );
  const topIds = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const orderedIds = useMemo(() => flattenColumnNodes(nodes), [nodes]);

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const activeKey = String(args.active.id);
      const parent = nodes.find(
        (n) => n.kind === "group" && n.children.some((c) => c.id === activeKey)
      ) as Extract<ColumnNode, { kind: "group" }> | undefined;
      const allowed = parent
        ? new Set(parent.children.map((c) => c.id))
        : new Set(topIds);
      const scoped = {
        ...args,
        droppableContainers: args.droppableContainers.filter((c) =>
          allowed.has(String(c.id))
        ),
      };
      const within = pointerWithin(scoped);
      return within.length > 0 ? within : closestCenter(scoped);
    },
    [nodes, topIds]
  );

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  // Two levels of reordering share one DndContext. Which one applies is decided
  // by where the dragged id lives: inside a group's children, or at top level.
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);

    // A member moving within its own group. Dropping it outside is a deliberate
    // no-op: a column's group comes from its metric, so it can't leave one.
    const parent = nodes.find(
      (n) => n.kind === "group" && n.children.some((c) => c.id === activeKey)
    ) as Extract<ColumnNode, { kind: "group" }> | undefined;
    if (parent) {
      const childIds = parent.children.map((c) => c.id);
      const from = childIds.indexOf(activeKey);
      const to = childIds.indexOf(overKey);
      if (from < 0 || to < 0) return;
      const byId = new Map(parent.children.map((c) => [c.id, c]));
      const moved = arrayMove(childIds, from, to).map((id) => byId.get(id)!);
      const next: ColumnNode[] = nodes.map((n) =>
        n === parent ? { ...parent, children: moved } : n
      );
      setOrder(flattenColumnNodes(next));
      return;
    }

    // Top-level move (a plain column, or a whole group). Releasing over one of
    // a group's children counts as releasing over that group, so a drop
    // anywhere on the section lands correctly.
    const from = topIds.indexOf(activeKey);
    const direct = topIds.indexOf(overKey);
    const to =
      direct >= 0
        ? direct
        : nodes.findIndex(
            (n) => n.kind === "group" && n.children.some((c) => c.id === overKey)
          );
    if (from < 0 || to < 0) return;
    setOrder(flattenColumnNodes(arrayMove(nodes, from, to)));
  };

  const activeNode = activeId
    ? nodes.find((n) => n.id === activeId) ?? null
    : null;
  const activeCol = activeId
    ? descriptors.find((c) => c.id === activeId) ?? null
    : null;

  const toggleHidden = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removePageCustom = (id: string) => {
    setPageCustoms((cols) => cols.filter((c) => c.id !== id));
    setOrder((o) => o.filter((x) => x !== id));
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setBroadcastById((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const addPageCustom = (
    col: CustomColumn,
    opts?: { broadcast?: ColumnBroadcast }
  ) => {
    setPageCustoms((cols) => [...cols, col]);
    setOrder((o) => [...o, col.id]);
    if (opts?.broadcast && opts.broadcast !== "view") {
      setBroadcastById((prev) => new Map(prev).set(col.id, opts.broadcast!));
    }
    setAdding(false);
  };

  const savePageEdit = (updated: CustomColumn) => {
    setPageCustoms((cols) =>
      cols.map((c) => (c.id === updated.id ? updated : c))
    );
    setEditingId(null);
  };

  // The name a tag key already uses elsewhere in the naming scope, so a new
  // tag column on that key auto-fills to match (and stays in sync on rename).
  const tagColumnNameFor = useCallback(
    (tagKey: string): string | undefined => {
      for (const { module: m, view: v } of nameScopeKeys(
        module,
        usageView,
        appSettings.filterScope
      )) {
        const cols = appSettings.pageColumns?.[m]?.[v]?.pageCustomColumns ?? [];
        const hit = cols.find(
          (c) => c.source.type === "tag" && c.source.tagKey === tagKey
        );
        if (hit) return hit.label;
      }
      return undefined;
    },
    [module, usageView, appSettings]
  );

  // Persist this view's edits. Order, hidden, and the custom set are per view,
  // so writing this tab touches another only for columns whose broadcast reach
  // says so: "module" copies to the other tabs of this page, "app" to every
  // page. Copies get fresh ids and are independent afterward.
  const commit = () => {
    const validIds = new Set([
      ...defaultOrderFor(module),
      ...pageCustoms.map((c) => c.id),
    ]);
    const thisView: PageColumnView = {
      // Flattened node order: exactly what the list showed, with each group's
      // members contiguous.
      order: orderedIds,
      hidden: Array.from(hidden).filter((id) => validIds.has(id)),
      pageCustomColumns: pageCustoms,
    };

    const sameSource = (a: CustomColumn, b: CustomColumn) =>
      a.source.type === b.source.type &&
      (a.source.tagKey ?? "") === (b.source.tagKey ?? "") &&
      (a.source.metadataKey ?? "") === (b.source.metadataKey ?? "") &&
      (a.source.metricKey ?? "") === (b.source.metricKey ?? "");

    // Append independent copies (fresh ids) of `cols` to a view, skipping any
    // whose source already lives there, and stamp them onto its order. A view
    // with no saved layout is seeded with the module's default hidden set (an
    // empty one reads as "show everything") and default order: since
    // `resolveColumnsForModule` lays listed ids down first and appends the
    // rest, an empty order would pin the copy to the top of that tab.
    const addCopies = (
      base: PageColumnView | undefined,
      cols: CustomColumn[],
      m: ModuleId,
      v: ColumnView
    ): PageColumnView => {
      const view: PageColumnView = base ?? {
        order: defaultOrderFor(m),
        hidden: defaultHiddenFor(m, v),
        pageCustomColumns: [],
      };
      const toAdd = cols
        .filter((pc) => !view.pageCustomColumns.some((c) => sameSource(c, pc)))
        .map((pc) => ({ ...pc, id: generateId("col") }));
      if (toAdd.length === 0) return view;
      return {
        order: [...view.order, ...toAdd.map((c) => c.id)],
        hidden: view.hidden,
        pageCustomColumns: [...view.pageCustomColumns, ...toAdd],
      };
    };

    const next: typeof appSettings.pageColumns = { ...appSettings.pageColumns };
    const curCfg = next[module];

    // The other tabs keep their own layout; only "module"/"app" columns copy in.
    const toOtherTab = pageCustoms.filter((c) => {
      const b = broadcastById.get(c.id);
      return b === "module" || b === "app";
    });
    const builtCfg = {} as Record<ColumnView, PageColumnView>;
    for (const v of COLUMN_VIEWS) {
      builtCfg[v] =
        v === usageView ? thisView : addCopies(curCfg?.[v], toOtherTab, module, v);
    }
    next[module] = builtCfg;

    // "app" reach: also copy to every other enabled page, every tab.
    const toApp = pageCustoms.filter((c) => broadcastById.get(c.id) === "app");
    if (toApp.length > 0) {
      for (const m of ENABLED_MODULES) {
        if (m.id === module) continue;
        const cfg = next[m.id];
        const built = {} as Record<ColumnView, PageColumnView>;
        for (const v of COLUMN_VIEWS) built[v] = addCopies(cfg?.[v], toApp, m.id, v);
        next[m.id] = built;
      }
    }

    // Keep same-tag columns in sync by name across the naming scope (app /
    // module / view), so a rename here propagates and new copies match.
    const nameKeys = nameScopeKeys(module, usageView, appSettings.filterScope);
    let propagated = next;
    const doneKeys = new Set<string>();
    for (const c of pageCustoms) {
      if (c.source.type === "tag" && c.source.tagKey && !doneKeys.has(c.source.tagKey)) {
        doneKeys.add(c.source.tagKey);
        propagated = applySharedTagName(propagated, nameKeys, c.source.tagKey, c.label);
      }
    }

    setAppSettings({ ...appSettings, pageColumns: propagated });
  };

  const save = () => {
    commit();
    onClose();
  };

  const dirty =
    adding ||
    editingId !== null ||
    columnSignature(orderedIds, hidden, pageCustoms) !== seedSig.current;

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // Committing before the flip keeps the current tab's edits; flipping the view
  // also flips the table behind the popup, and the open-effect re-seeds the
  // editor for the newly selected tab.
  const switchView = (next: ColumnView) => {
    if (next === usageView) return;
    commit();
    onUsageViewChange?.(next);
  };

  // Clears this module's personal column layout back to the team default. The
  // open-effect re-seeds from the reset appSettings, so the list repopulates in
  // place.
  const handleReset = () => {
    resetModuleColumns(module);
  };

  // Shared by the top level and the inside of a group, so an inline edit form
  // works the same in both places.
  const renderRow = (col: ColumnDescriptor): ReactNode =>
    editingId === col.id && col.custom ? (
      <AddCustomColumnForm
        key={col.id}
        module={module}
        initial={col.custom}
        submitLabel="Save column"
        onAdd={savePageEdit}
        onCancel={() => setEditingId(null)}
      />
    ) : (
      <SortableColumnRow
        key={col.id}
        col={col}
        hidden={hidden.has(col.id)}
        canRemove={!removalBlockReason(col.kind)}
        onEdit={() => setEditingId(col.id)}
        onRemove={() => removePageCustom(col.id)}
        onToggleHidden={() => toggleHidden(col.id)}
      />
    );

  return (
    <>
    <Modal show={open} onDismiss={requestClose} title="Columns" size="medium">
      <div className="modal-body">
        <Flex flexDirection="column" gap={12}>
          {onUsageViewChange && (
            <div className="tabs-headeronly">
              <Tabs
                selectedIndex={
                  usageView === "high" ? 0 : usageView === "low" ? 1 : 2
                }
                onChange={(i) =>
                  switchView(i === 0 ? "high" : i === 1 ? "low" : "normal")
                }
              >
                <Tab title="High usage">{null}</Tab>
                <Tab title="Low usage">{null}</Tab>
                <Tab title="Normal">{null}</Tab>
              </Tabs>
            </div>
          )}
          <Paragraph className="text-secondary">
            Drag a row by its handle to reorder.{" "}
            {module === "compute"
              ? "CPU and Memory columns sit in sections that match the table: drag a section header to move the whole block, or a row inside it to reorder within. A new CPU or memory column joins its section automatically. "
              : ""}
            Order, visibility, and the columns themselves save per{" "}
            <strong>
              {usageView === "high"
                ? "High usage"
                : usageView === "low"
                ? "Low usage"
                : "Normal"}
            </strong>{" "}
            tab. A column added here can also be copied to the other tabs or
            every page when you add it.
          </Paragraph>

          <div className="filter-section">
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              modifiers={[restrictToVerticalAxis]}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              <SortableContext items={topIds} strategy={verticalListSortingStrategy}>
                <div className="column-list" style={{ paddingBottom: 16 }}>
                  {nodes.map((n) =>
                    n.kind === "group" ? (
                      <SortableColumnGroup
                        key={n.id}
                        node={n}
                        hiddenIds={hidden}
                        renderRow={renderRow}
                      />
                    ) : (
                      renderRow(n.col)
                    )
                  )}
                </div>
              </SortableContext>

              {/* The lifted copy that tracks the cursor. Its buttons are inert
                  mid-drag; the handlers exist only so the row renders exactly
                  as it does at rest. */}
              <DragOverlay>
                {activeNode?.kind === "group" ? (
                  <div className="column-group column-group-overlay">
                    <div className="column-group-header">
                      <span className="column-drag-handle">
                        <DragAllDirectionIcon />
                      </span>
                      <span className="column-manager-label">
                        {METRIC_GROUP_LABEL[activeNode.group]}
                      </span>
                      <span className="text-subdued column-source-label">
                        {activeNode.children.filter((c) => !hidden.has(c.id)).length} of{" "}
                        {activeNode.children.length} shown
                      </span>
                    </div>
                    {/* The section travels whole: its rows come along at full
                        strength, so the cursor carries exactly what will be
                        dropped. */}
                    <div className="column-group-children">
                      {activeNode.children.map((c) => (
                        <div
                          key={c.id}
                          className="column-manager-row"
                          style={hidden.has(c.id) ? { opacity: 0.45 } : undefined}
                        >
                          <ColumnRowInner
                            col={c}
                            hidden={hidden.has(c.id)}
                            canRemove={!removalBlockReason(c.kind)}
                            onEdit={() => {}}
                            onRemove={() => {}}
                            onToggleHidden={() => {}}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : activeCol ? (
                  <div
                    className="column-manager-row column-row-overlay"
                    style={hidden.has(activeCol.id) ? { opacity: 0.45 } : undefined}
                  >
                    <ColumnRowInner
                      col={activeCol}
                      hidden={hidden.has(activeCol.id)}
                      canRemove={!removalBlockReason(activeCol.kind)}
                      onEdit={() => {}}
                      onRemove={() => {}}
                      onToggleHidden={() => {}}
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>

          <div className="filter-section">
            <Heading level={6}>Add a column</Heading>
            <Paragraph className="text-secondary">
              A column shows a metric or a tag's value. It's added to this tab;
              choose a wider reach below to copy it to the other tabs or every
              page.
            </Paragraph>
            {adding ? (
              <AddCustomColumnForm
                module={module}
                allowBroadcast
                defaultTagBroadcast={appSettings.filterScope}
                existingTagColumnName={tagColumnNameFor}
                onAdd={addPageCustom}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <div>
                <Button variant="emphasized" onClick={() => setAdding(true)}>
                  <PlusIcon className="button-add-margin-right-4"/> Add column
                </Button>
              </div>
            )}
          </div>
        </Flex>
      </div>

      <Flex className="modal-footer" justifyContent="space-between" gap={8}>
        <Button variant="emphasized" onClick={handleReset}>
          Reset to defaults
        </Button>
        <Flex gap={8}>
          <Button variant="emphasized" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="accent" color="primary" onClick={save}>
            Save
          </Button>
        </Flex>
      </Flex>
    </Modal>
    <ConfirmDiscardModal
      open={confirmDiscard}
      onKeepEditing={() => setConfirmDiscard(false)}
      onDiscard={() => {
        setConfirmDiscard(false);
        onClose();
      }}
    />
    </>
  );
};
