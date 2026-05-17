import { Modal } from './Modal';

interface Props {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDestructiveAction({
  open,
  title,
  description,
  confirmLabel = 'Remove',
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="text-sm text-ctp-subtext1 mb-5">{description}</p>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-lg text-ctp-subtext0 hover:text-ctp-text
            hover:bg-surface-0 cursor-pointer transition-colors"
          data-testid="confirm-destructive-cancel"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-4 py-1.5 text-xs rounded-lg bg-ctp-error text-ctp-base hover:opacity-90
            cursor-pointer transition-colors font-medium"
          data-testid="confirm-destructive-confirm"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
