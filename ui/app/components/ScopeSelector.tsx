import { Select } from "@dynatrace/strato-components-preview/forms";
import { ContainerIcon } from "@dynatrace/strato-icons";
import { useScope } from "../contexts/ScopeContext";
import type { ScopeRef } from "../types/types";
import { SCOPE_SHOW_LABEL } from "../constants/ui-toggles";

type OptionKey = string;
function keyOf(scope: ScopeRef): OptionKey {
  return `${scope.mode}:${scope.id}`;
}

/**
 * Scope dropdown styled like the Strato segment picker: container icon prefix,
 * current selection as the label. SCOPE_SHOW_LABEL in constants/ui-toggles.ts
 * picks between the label text and the icon alone.
 */
export const ScopeSelector = () => {
  const { scope, setScope, managementZones, segments, isLoading } = useScope();

  const onChange = (rawValue: unknown) => {
    const value = String(rawValue ?? "");
    if (value === "all:") {
      setScope({ mode: "all", id: "", name: "All hosts" });
      return;
    }
    const mz = managementZones.find(
      (m) => keyOf({ mode: "management-zone", id: m.id, name: m.name }) === value
    );
    if (mz) {
      setScope({ mode: "management-zone", id: mz.id, name: mz.name });
      return;
    }
    const seg = segments.find(
      (s) => keyOf({ mode: "segment", id: s.id, name: s.name }) === value
    );
    if (seg) {
      setScope({ mode: "segment", id: seg.id, name: seg.name });
    }
    // Header rows fall through and do nothing.
  };

  const showSectionHeaders = managementZones.length > 0 && segments.length > 0;

  return (
    <Select
      value={keyOf(scope)}
      onChange={onChange}
      disabled={isLoading}
    >
      <Select.Trigger className="scope-trigger">
        <Select.DisplayValue>
          <Select.Prefix>
            <ContainerIcon />
          </Select.Prefix>
          {SCOPE_SHOW_LABEL ? scope.name : null}
        </Select.DisplayValue>
      </Select.Trigger>
      <Select.Content className="scope-content">
        <Select.Option value="all:">All hosts</Select.Option>

        {showSectionHeaders && (
          <Select.Option value="__mz-header__" disabled>
            Management zones
          </Select.Option>
        )}
        {managementZones.map((mz) => (
          <Select.Option
            key={`mz:${mz.id}`}
            value={keyOf({ mode: "management-zone", id: mz.id, name: mz.name })}
          >
            {mz.name}
          </Select.Option>
        ))}

        {showSectionHeaders && (
          <Select.Option value="__seg-header__" disabled>
            Segments
          </Select.Option>
        )}
        {segments.map((seg) => (
          <Select.Option
            key={`seg:${seg.id}`}
            value={keyOf({ mode: "segment", id: seg.id, name: seg.name })}
          >
            {seg.name}
          </Select.Option>
        ))}
      </Select.Content>
    </Select>
  );
};
