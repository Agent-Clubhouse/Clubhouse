import { useEffect } from 'react';

interface Props {
  entryName: string;
  isDirectory: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteNoteDialog({ entryName, isDirectory, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[380px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ctp-text mb-2">
          Delete {isDirectory ? 'folder' : 'note'}?
        </h2>
        <p className="text-sm text-ctp-subtext0 mb-1 font-medium">{entryName}</p>
        <p className="text-sm text-ctp-subtext0 mb-4">
          {isDirectory
            ? 'This folder and all its contents will be permanently deleted.'
            : 'This note will be permanently deleted.'}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
              hover:bg-surface-2 cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 text-xs rounded bg-red-500/80 text-white
              hover:bg-red-500 cursor-pointer font-medium"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
