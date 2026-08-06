import { CriticalIcon, WarningIcon } from "@dynatrace/strato-icons";
import type { Severity } from "../types/types";
import { severityLabel } from "../utils/helpers";

export interface SeverityBadgeProps {
  severity: Severity;
  /** @deprecated Ignored by the component; the icon stands in for the dot. */
  showDot?: boolean;
}

/**
 * Dynatrace-style label: a vibrant glyph plus label text on a duller tinted
 * background. CriticalIcon flags the "at capacity" tier; the other three tiers
 * share the WarningIcon glyph and differ by color and label. Color comes from
 * the `severity-badge-${severity}` CSS class.
 */
export const SeverityBadge = ({ severity }: SeverityBadgeProps) => {
  const Icon = severity === "atCapacity" ? CriticalIcon : WarningIcon;
  return (
    <span className={`severity-badge severity-badge-${severity}`}>
      {/* 12px is one step under Strato's "small" preset; at the 11px label
          font-size anything larger sits off the baseline. The span lets CSS
          tighten the icon's effective margin without touching its intrinsic
          sizing. */}
      <span className="severity-badge-icon">
        <Icon size={12} />
      </span>
      {severityLabel(severity)}
    </span>
  );
};
