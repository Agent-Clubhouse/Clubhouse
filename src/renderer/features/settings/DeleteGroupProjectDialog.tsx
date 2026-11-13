import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ipcErrorMessage } from '../../utils/ipc-error';

export interface GroupProjectDeleteImpact {
  token: string;
  members: string[];
  canvases: string[];
  actions: string[];
  grants: string[];
  messages: number;
  topics: number;
  machines: string[];
}

export function DeleteGroupProjectDialog({ name, loadImpact, confirmDelete, onClose }: {
  name: string;
  loadImpact: () => Promise<GroupProjectDeleteImpact>;
  confirmDelete: (token: string) => Promise<void>;
  onClose: () => void;
}) {
  const [impact, setImpact] = useState<GroupProjectDeleteImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setImpact(null);
    setError(null);
    void loadImpact().then((value) => { if (active) setImpact(value); }).catch((err) => {
      // telemetry-exempt: the failure is displayed and deletion stays disabled.
      if (active) setError(ipcErrorMessage(err));
    });
    return () => { active = false; };
  }, [loadImpact, attempt]);

  const remove = async () => {
    if (!impact || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmDelete(impact.token);
      onClose();
    } catch (err) {
      // telemetry-exempt: the failure is shown, and the inventory must be refreshed before retrying.
      setImpact(null);
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const list = (label: string, values: string[]) => (
    <div><dt className="font-medium text-ctp-text">{label} ({values.length})</dt><dd className="break-words">{values.length ? values.join(', ') : 'None'}</dd></div>
  );

  return (
    <Modal open onClose={onClose} busy={busy} title={`Delete ${name}?`} width="w-[520px] max-w-[calc(100vw-2rem)]" footer={<>
      <Button onClick={onClose} disabled={busy}>Cancel</Button>
      <Button kind="danger" onClick={() => void remove()} disabled={!impact || busy}>{busy ? 'Deleting...' : 'Delete permanently'}</Button>
    </>}>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-xs text-ctp-subtext1">
        <p>This permanently deletes the group project and its board. There is no undo.</p>
        {error && <div role="alert">Could not complete deletion: {error} <Button onClick={() => setAttempt((n) => n + 1)}>Refresh impact</Button></div>}
        {!impact && !error && <p role="status">Checking impact...</p>}
        {impact && <dl className="flex flex-col gap-2">
          {list('Members', impact.members)}
          {list('Canvases', impact.canvases)}
          {list('Owned Actions', impact.actions)}
          {list('Grants', impact.grants)}
          <div><dt className="font-medium text-ctp-text">Board</dt><dd>{impact.messages} messages in {impact.topics} topics</dd></div>
          {list('Other machines', impact.machines)}
        </dl>}
      </div>
    </Modal>
  );
}
