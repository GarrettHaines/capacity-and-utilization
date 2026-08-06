import { Modal } from "@dynatrace/strato-components-preview/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import {
  Heading,
  Paragraph,
  ExternalLink,
  Text,
} from "@dynatrace/strato-components/typography";
import { useState } from "react";
import type { Finding } from "../types/types";
import { SnoozeMenu } from "./SnoozeMenu";
import { acknowledgeFinding, clearFindingState } from "../api/settings";
import {
  diskDetailUrl,
  formatDateTime,
  hostDetailUrl,
  openDiskInInfraOps,
  openHostInInfraOps,
} from "../utils/helpers";
import { useScope } from "../contexts/ScopeContext";

export interface FindingDetailsModalProps {
  finding: Finding | null;
  onClose: () => void;
  onStateChanged: () => void;
}

// The section title carries the "CPU"/"Memory" word, so row labels drop it.
const CPU_DETAIL_ROWS: Array<[string, string]> = [
  ["cpu_avg", "Avg"],
  ["cpu_p95", "P95"],
  ["cpu_max", "Max"],
  ["cpu_steal", "Steal"],
  ["cpu_physical", "Physical CPUs"],
  ["cpu_logical", "Logical CPUs"],
];
const MEM_DETAIL_ROWS: Array<[string, string]> = [
  ["mem_avg", "Avg"],
  ["mem_p95", "P95"],
  ["mem_max", "Max"],
  ["mem_used", "Used"],
  ["mem_allocated", "Allocated"],
];

/** Render a set of label→value rows from a finding's evidence, skipping any
 *  that have no value. */
function StatRows({
  rows,
  evidence,
}: {
  rows: Array<[string, string]>;
  evidence: Finding["evidence"];
}) {
  const shown = rows.filter(([k]) => {
    const v = evidence[k];
    return v != null && v !== "—" && v !== "";
  });
  if (shown.length === 0)
    return <Paragraph className="text-subdued">No data captured.</Paragraph>;
  return (
    <>
      {shown.map(([k, label]) => (
        <div className="detail-evidence-row" key={k}>
          <Text className="text-secondary">{label}</Text>
          <Text>{String(evidence[k] ?? "—")}</Text>
        </div>
      ))}
    </>
  );
}

/**
 * Read-only details + actions (snooze / acknowledge / unsnooze).
 * Evidence is rendered as a key/value table from `finding.evidence`.
 */
export const FindingDetailsModal = ({
  finding,
  onClose,
  onStateChanged,
}: FindingDetailsModalProps) => {
  const { appSettings } = useScope();
  const [snoozing, setSnoozing] = useState<Finding | null>(null);
  const [busy, setBusy] = useState(false);

  if (!finding) return null;

  const acknowledge = async () => {
    setBusy(true);
    try {
      await acknowledgeFinding(finding.id);
      onStateChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await clearFindingState(finding.id);
      onStateChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal show onDismiss={onClose} title={finding.title} size="medium">
        <div className="modal-body">
          <Section title="Summary">
            {finding.primaryMetric && (
              <Text>
                {finding.primaryMetric.label}: {finding.primaryMetric.value}
              </Text>
            )}
            <div className="detail-field-grid">
              <Field
                label="Host"
                value={finding.entity.displayName}
                href={hostDetailUrl(finding.entity.entityId)}
                onActivate={() => openHostInInfraOps(finding.entity.entityId)}
              />
              {finding.entity.qualifier &&
                (() => {
                  const diskId = String(
                    finding.evidence?.disk_entity_id ?? ""
                  );
                  return (
                    <Field
                      label="Mount"
                      value={finding.entity.qualifier}
                      // A long mount path would grow a horizontal scrollbar,
                      // so ellipsis it; the full path stays in the link's
                      // hover title.
                      truncate
                      href={
                        diskId
                          ? diskDetailUrl(finding.entity.entityId, diskId)
                          : undefined
                      }
                      onActivate={
                        diskId
                          ? () =>
                              openDiskInInfraOps(
                                finding.entity.entityId,
                                diskId
                              )
                          : undefined
                      }
                    />
                  );
                })()}
              {finding.entity.os && (
                <Field label="OS" value={finding.entity.os} />
              )}
              {finding.entity.deployment && (
                <Field label="Deployment" value={finding.entity.deployment} />
              )}
              {appSettings.snoozeEnabled && finding.snoozedUntil && (
                <Field
                  label="Snoozed until"
                  value={formatDateTime(finding.snoozedUntil)}
                />
              )}
              {appSettings.snoozeEnabled && finding.acknowledgedBy && (
                <Field
                  label="Acknowledged by"
                  value={`${finding.acknowledgedBy} on ${formatDateTime(
                    finding.acknowledgedAt
                  )}`}
                />
              )}
            </div>
          </Section>

          {finding.module === "compute" ? (
            <>
              <Section title="CPU">
                <StatRows rows={CPU_DETAIL_ROWS} evidence={finding.evidence} />
              </Section>
              <Section title="Memory">
                <StatRows rows={MEM_DETAIL_ROWS} evidence={finding.evidence} />
              </Section>
              {finding.evidenceLink && (
                <div className="detail-section">
                  <ExternalLink href={finding.evidenceLink}>
                    Open evidence in Dynatrace
                  </ExternalLink>
                </div>
              )}
            </>
          ) : (
            <Section title="Details">
              {finding.evidenceLink && (
                <ExternalLink href={finding.evidenceLink}>
                  Open evidence in Dynatrace
                </ExternalLink>
              )}
              {(() => {
                // Mount already shows in Summary and the disk id only drives
                // that deep link, so neither repeats in this list.
                const HIDE = new Set(["mount", "disk_entity_id"]);
                const entries = Object.entries(finding.evidence).filter(
                  ([k]) => !HIDE.has(k)
                );
                return entries.length === 0 ? (
                  <Paragraph className="text-subdued">
                    No additional details captured.
                  </Paragraph>
                ) : (
                  entries.map(([k, v]) => (
                    <div className="detail-evidence-row" key={k}>
                      <Text className="text-secondary">{prettyKey(k)}</Text>
                      <Text>{String(v ?? "—")}</Text>
                    </div>
                  ))
                );
              })()}
            </Section>
          )}
        </div>

        {appSettings.snoozeEnabled && (
          <Flex className="modal-footer" gap={8}>
            {(finding.snoozedUntil || finding.acknowledgedBy) && (
              <Button variant="emphasized" onClick={clear} disabled={busy}>
                Clear state
              </Button>
            )}
            <Button
              variant="emphasized"
              onClick={() => setSnoozing(finding)}
              disabled={busy}
            >
              Snooze
            </Button>
            <Button
              variant="accent"
              color="primary"
              onClick={acknowledge}
              disabled={busy}
            >
              Acknowledge
            </Button>
          </Flex>
        )}
      </Modal>

      {appSettings.snoozeEnabled && (
        <SnoozeMenu
          finding={snoozing}
          onClose={() => setSnoozing(null)}
          onSnoozed={onStateChanged}
        />
      )}
    </>
  );
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-section">
      <div className="detail-section-header">
        <Heading level={6}>{title}</Heading>
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  href,
  truncate,
  onActivate,
}: {
  label: string;
  value: string;
  href?: string;
  /** When true, single-line ellipsis the value so a long string can't grow the modal horizontally. Full value sits in the hover title. */
  truncate?: boolean;
  /**
   * Called on left-click of the link, to route through the AppEngine
   * navigation SDK: a bare `<a href target="_top">` gets swallowed by the
   * iframe sandbox.
   */
  onActivate?: () => void;
}) {
  const valueClass = truncate
    ? "detail-field-value detail-field-value-truncate"
    : "detail-field-value";
  return (
    <>
      <span className="detail-field-label">{label}</span>
      <span className={valueClass} title={truncate ? value : undefined}>
        {href ? (
          <a
            href={href}
            rel="noreferrer"
            className="host-link"
            title={value}
            onClick={(e) => {
              if (onActivate) {
                e.preventDefault();
                onActivate();
              }
            }}
          >
            {value}
          </a>
        ) : (
          value
        )}
      </span>
    </>
  );
}

function prettyKey(key: string): string {
  return key
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bIops\b/g, "IOPS")
    .replace(/\bCpu\b/g, "CPU")
    .replace(/\bId\b/g, "ID");
}
