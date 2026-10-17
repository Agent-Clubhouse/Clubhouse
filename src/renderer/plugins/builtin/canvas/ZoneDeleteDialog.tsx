/**
 * ZoneDeleteDialog — prompts user whether to keep or remove contained widgets
 * when deleting a zone.
 */

import React from 'react';
import { Modal } from '../../../components/Modal';
import { BUTTON } from './canvas-chrome';

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
      <Modal open onClose={onCancel} title={`Delete ${zoneName}?`} width="w-[380px]" backdropTestId="zone-delete-dialog">
        <p className="text-xs text-ctp-subtext1 mb-4">
          This zone holds {containedCount} widget{containedCount !== 1 ? 's' : ''}. Its wires are removed either way.
        </p>
        <div className="flex gap-2 justify-end">
          <button type="button" className={BUTTON.quiet} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={BUTTON.ghost} onClick={() => onConfirm(false)}>
            Keep widgets
          </button>
          <button type="button" className={BUTTON.danger} onClick={() => onConfirm(true)}>
            Delete widgets too
          </button>
        </div>
      </Modal>
    </div>
  );
}
