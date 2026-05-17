import { useState, useEffect } from 'react';
import { Modal } from '../../components/Modal';

interface ResetProjectDialogProps {
  projectName: string;
  projectPath: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ResetProjectDialog({ projectName, projectPath, onConfirm, onCancel }: ResetProjectDialogProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.clubhouse.project.listClubhouseFiles(projectPath).then((result: string[]) => {
      setFiles(result);
      setLoading(false);
    });
  }, [projectPath]);

  const canConfirm = confirmText === projectName;

  return (
    <Modal open={true} onClose={onCancel} width="w-full max-w-md mx-4">
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-ctp-error">Reset Project</h3>
          <p className="text-sm text-ctp-subtext1">
            This will permanently delete all Clubhouse configuration for{' '}
            <span className="font-semibold text-ctp-text">{projectName}</span>, then close the project.
          </p>

          {/* File list */}
          <div className="space-y-1.5">
            <label className="text-xs text-ctp-subtext0 uppercase tracking-wider">
              Files to delete (.clubhouse/)
            </label>
            <div className="max-h-40 overflow-y-auto rounded-lg bg-ctp-mantle border border-surface-0 p-2">
              {loading ? (
                <span className="text-xs text-ctp-subtext0">Loading...</span>
              ) : files.length === 0 ? (
                <span className="text-xs text-ctp-subtext0">No .clubhouse/ directory found</span>
              ) : (
                <ul className="space-y-0.5">
                  {files.map((f) => (
                    <li key={f} className="text-xs font-mono text-ctp-subtext1">{f}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Confirmation input */}
          <div className="space-y-1.5">
            <label className="text-xs text-ctp-subtext0">
              Type <span className="font-mono font-semibold text-ctp-text">{projectName}</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={projectName}
              className="w-full px-3 py-2 text-sm rounded-lg bg-ctp-mantle border border-surface-2
                text-ctp-text placeholder:text-ctp-subtext0/40
                focus-ring-error"
              autoFocus
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg bg-surface-0 border border-surface-2
              text-ctp-subtext1 hover:bg-surface-1 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm rounded-lg border cursor-pointer transition-colors ${
              canConfirm
                ? 'bg-ctp-error/20 border-ctp-error/40 text-ctp-error hover:bg-ctp-error/30'
                : 'bg-surface-0 border-surface-2 text-ctp-subtext0 opacity-50 cursor-not-allowed'
            }`}
          >
            Delete .clubhouse/ &amp; Close
          </button>
        </div>
    </Modal>
  );
}
