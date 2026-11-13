import { useEffect, useState } from 'react';
import type { ImportStatus } from '../../../shared/project-import';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { useProjectStore } from '../../stores/projectStore';
import { openDispatcher } from '../dispatcher/dispatcherNav';
import { useDispatcherStore } from '../dispatcher/dispatcherStore';
import { rendererLog } from '../../plugins/renderer-logger';

const ACTIVE = new Set(['reserved', 'initializing', 'fetching', 'checking_out', 'cloned', 'registering']);

export function RepositoryImports() {
  const [receipts, setReceipts] = useState<ImportStatus[]>([]);
  const [open, setOpen] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dispatcher = useDispatcherStore((s) => !!s.project);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await window.clubhouse.project.listImports();
        if (!disposed) {
          if (result.ok === true) { setReceipts(result.value); setReadError(null); }
          else setReadError(result.message);
        }
      } catch {
        // telemetry-exempt: raw IPC diagnostics stay private; visible failure is actionable.
        rendererLog('core:project', 'warn', 'Repository import status could not be read');
        if (!disposed) setReadError('Import status is unavailable. Check the recorded destination before retrying.');
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 1_000);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);

  const cancel = async (receipt: ImportStatus) => {
    setBusy(receipt.id);
    setActionError(null);
    try {
      const result = await window.clubhouse.project.cancelImport(receipt.id, receipt.plan.destination);
      if (result.ok === false) setActionError(result.message);
    } catch {
      // telemetry-exempt: report the visible cancellation error without raw diagnostics.
      rendererLog('core:project', 'warn', 'Repository import cancellation could not be sent');
      setActionError('Cancellation could not be sent. Check status; no files were deleted.');
    } finally { setBusy(null); }
  };
  const error = actionError ?? readError;
  if (!receipts.length && !error) return null;
  const running = receipts.filter((r) => ACTIVE.has(r.phase)).length;
  return <>
    <div className="fixed bottom-3 right-3 z-30">
      <Button onClick={() => setOpen(true)} data-testid="repository-imports-open">
        Repository imports{running ? ` (${running} running)` : ''}
      </Button>
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title="Repository imports" width="w-[600px]" testId="repository-imports">
      <div className="flex flex-col gap-4 text-sm">
        {error && <p role="alert">{error}</p>}
        {receipts.map((r) => <div key={r.id} className="flex flex-col gap-2 break-words" data-testid={`repository-import-${r.id}`}>
          <strong>{r.plan.url}</strong>
          <p>{r.plan.destination}</p>
          <p role="status">Import: {r.phase}{r.progress !== undefined && ACTIVE.has(r.phase) ? ` (${r.progress}%)` : ''}</p>
          {r.failedAt && <p>Failed operation: {r.failedAt}</p>}
          {r.message && <p>{r.message}</p>}
          <p>{r.recovery}</p>
          <p>Agent creation: {r.agentCreation?.phase ?? 'not requested'}{r.agentCreation?.agentId ? ` (${r.agentCreation.agentId})` : ''}. Import never starts an agent.</p>
          {r.agentRecovery && <p>{r.agentRecovery}</p>}
          <div className="flex gap-2">
            {ACTIVE.has(r.phase) && <Button disabled={busy !== null} onClick={() => void cancel(r)}>Cancel this import</Button>}
            {r.projectId && <Button onClick={() => { useProjectStore.getState().setActiveProject(r.projectId ?? null); setOpen(false); }}>Open existing project</Button>}
            {r.projectId && !r.agentCreation && dispatcher && <Button onClick={() => { setOpen(false); openDispatcher(); }}>Choose agent with Dispatcher</Button>}
          </div>
          {r.projectId && !r.agentCreation && <p className="text-xs">Ask for a template, CLI/model, access, Free Agent Mode, orchestration and connection choices. Approve the exact creation in Needs you. Create only leaves it asleep; starting it is a separate requested and authorized action.</p>}
        </div>)}
      </div>
    </Modal>
  </>;
}
