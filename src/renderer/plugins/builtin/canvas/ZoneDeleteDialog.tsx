/**
 * ZoneDeleteDialog — prompts user whether to keep or remove contained widgets
 * when deleting a zone.
 */

import React from 'react';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';

interface ZoneDeleteDialogProps {
  zoneName: string;
  containedCount: number;
  onConfirm: (removeContents: boolean) => void;
  onCancel: () => void;
}

export function ZoneDeleteDialog({ zoneName, containedCount, onConfirm, onCancel }: ZoneDeleteDialogProps) {
  return (
    // Stop mousedown here: React bubbles portal events through this tree, and
    // the canvas workspace would read a click in the dialog as a board click.
    <div onMouseDown={(e) => e.stopPropagation()}>
      <Modal
        open
        onClose={onCancel}
        title={`Delete ${zoneName}?`}
        width="w-[380px]"
        backdropTestId="zone-delete-dialog"
        footer={
          <>
            <Button kind="quiet" onClick={onCancel}>Cancel</Button>
            <Button kind="ghost" onClick={() => onConfirm(false)}>Keep widgets</Button>
            <Button kind="danger-solid" onClick={() => onConfirm(true)}>Delete widgets too</Button>
          </>
        }
      >
        <p className="text-xs text-ctp-subtext1">
          This zone holds {containedCount} widget{containedCount !== 1 ? 's' : ''}. Its wires are removed either way.
        </p>
      </Modal>
    </div>
  );
}
