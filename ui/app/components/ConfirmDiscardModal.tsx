import { Modal } from "@dynatrace/strato-components-preview/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Paragraph } from "@dynatrace/strato-components/typography";

export interface ConfirmDiscardModalProps {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

export const ConfirmDiscardModal = ({
  open,
  onKeepEditing,
  onDiscard,
}: ConfirmDiscardModalProps) => (
  <Modal
    show={open}
    onDismiss={onKeepEditing}
    title="Discard unsaved changes?"
    size="small"
  >
    <div className="modal-body">
      <Paragraph>
        This menu has changes that haven't been saved yet. Closing now discards
        them.
      </Paragraph>
    </div>

    <Flex className="modal-footer" justifyContent="flex-end" gap={8}>
      <Button variant="emphasized" onClick={onKeepEditing}>
        Keep editing
      </Button>
      <Button variant="accent" color="primary" onClick={onDiscard}>
        Discard changes
      </Button>
    </Flex>
  </Modal>
);
