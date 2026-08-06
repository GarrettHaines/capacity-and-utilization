import { useState } from "react";
import { Modal } from "@dynatrace/strato-components-preview/overlays";
import {
  FormField,
  Label,
  Select,
  TextArea,
} from "@dynatrace/strato-components-preview/forms";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import type { Finding } from "../types/types";
import { snoozeFinding } from "../api/settings";

const DURATIONS: Array<{ value: string; label: string; days: number }> = [
  { value: "1d", label: "1 day", days: 1 },
  { value: "3d", label: "3 days", days: 3 },
  { value: "7d", label: "1 week", days: 7 },
  { value: "14d", label: "2 weeks", days: 14 },
  { value: "30d", label: "30 days", days: 30 },
];

export interface SnoozeMenuProps {
  finding: Finding | null;
  onClose: () => void;
  onSnoozed: () => void;
}

/**
 * Modal to pick a duration and optional note, persisted to App Settings.
 * Snoozes are coarse by design, so there is no custom datetime picker.
 */
export const SnoozeMenu = ({ finding, onClose, onSnoozed }: SnoozeMenuProps) => {
  const [duration, setDuration] = useState("7d");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!finding) return null;

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const d = DURATIONS.find((x) => x.value === duration) ?? DURATIONS[2];
      const until = new Date(Date.now() + d.days * 86_400_000).toISOString();
      await snoozeFinding(finding.id, until, note || undefined);
      onSnoozed();
      onClose();
    } catch (err) {
      setError("Couldn't save snooze. Try again.");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show onDismiss={onClose} title="Snooze finding" size="small">
      <div className="modal-body">
        <FormField>
          <Label>Duration</Label>
          <Select value={duration} onChange={(v) => setDuration(String(v))}>
            <Select.Trigger />
            <Select.Content>
              {DURATIONS.map((d) => (
                <Select.Option key={d.value} value={d.value}>
                  {d.label}
                </Select.Option>
              ))}
            </Select.Content>
          </Select>
        </FormField>

        <FormField>
          <Label>Note (optional)</Label>
          <TextArea
            value={note}
            onChange={(v) => setNote(String(v ?? ""))}
            placeholder="Why are you snoozing this finding?"
          />
        </FormField>

        {error && <span className="text-error">{error}</span>}
      </div>

      <Flex className="modal-footer" gap={8}>
        <Button variant="emphasized" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="accent" color="primary" onClick={handleSubmit} disabled={saving}>
          {saving ? "Saving…" : "Snooze"}
        </Button>
      </Flex>
    </Modal>
  );
};
