import { useState, useEffect } from 'react';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/Spinner';
import { settingsButton, settingsInput, settingsLabel } from './SettingsLayout';

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
    <Modal open={true} onClose={onCancel} title="Reset project" width="w-[440px] max-w-[calc(100vw-2rem)]">
      <div className="space-y-4">
        <p className="text-[13px] text-ctp-subtext1">
          This permanently deletes the Clubhouse configuration for{' '}
          <span className="font-medium text-ctp-text">{projectName}</span>, then closes the project.
        </p>

        {/* File list */}
        <div>
          <div className={settingsLabel}>Files to delete in .clubhouse/</div>
          <div className="max-h-40 overflow-y-auto rounded-md bg-ctp-crust border border-surface-0 px-2.5 py-2">
            {loading ? (
              <span className="flex items-center gap-2 text-xs text-ctp-overlay1"><Spinner size="xs" />Loading…</span>
            ) : files.length === 0 ? (
              <span className="text-xs text-ctp-overlay1">No .clubhouse/ directory found</span>
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
        <div>
          <label htmlFor="reset-project-confirm" className={settingsLabel}>
            Type <span className="font-mono text-ctp-text">{projectName}</span> to confirm
          </label>
          <input
            id="reset-project-confirm"
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={projectName}
            className={`${settingsInput} w-full`}
            autoFocus
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className={settingsButton.ghost}>
          Cancel
        </button>
        <button onClick={onConfirm} disabled={!canConfirm} className={settingsButton.danger}>
          Delete .clubhouse/ and close
        </button>
      </div>
    </Modal>
  );
}
