import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import type { ManagedPartConsumer } from '../../../shared/managed-agents-types';
import { AgentDot } from './parts-ui';

/**
 * Saving a part several agents use (#2897): who it reaches, which are running,
 * and an optional restart for the running ones. Restart resumes the conversation;
 * the caller restarts a working agent when its turn ends (restartAfterSave).
 */
export function ImpactDialog({ open, partName, consumers, busy, error, onSave, onCancel, onForkInstead, forkLabel }: {
  open: boolean;
  partName: string;
  consumers: ManagedPartConsumer[];
  busy?: boolean;
  error?: string | null;
  onSave: (restart: ManagedPartConsumer[]) => void;
  onCancel: () => void;
  onForkInstead?: () => void;
  forkLabel?: string;
}) {
  const [restart, setRestart] = useState<Set<string>>(() => new Set());
  const running = consumers.filter((c) => c.running);
  const toggle = (id: string) => setRestart((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Save ${partName} for ${consumers.length} agent${consumers.length === 1 ? '' : 's'}?`}
      width="w-[560px]"
      testId="managed-impact-dialog"
      footer={<>
        {onForkInstead && <Button kind="quiet" className="mr-auto" onClick={onForkInstead} disabled={busy}>{forkLabel ?? 'Fork for this agent instead'}</Button>}
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="primary" disabled={busy} onClick={() => onSave(running.filter((c) => restart.has(c.agentId)))} data-testid="managed-impact-save">
          {restart.size > 0 ? `Save and restart ${restart.size}` : 'Save'}
        </Button>
      </>}
    >
      <p className="text-[13px] text-ctp-subtext1">Each agent gets the new version when its next session starts.</p>
      <ul className="mt-3 flex flex-col" data-testid="managed-impact-agents">
        {consumers.map((c) => (
          <li key={`${c.projectPath}:${c.agentId}`} className="flex items-center gap-2.5 py-2 border-t border-surface-0 text-[13px]">
            <AgentDot name={c.agentName} color={c.color} />
            <span className="text-ctp-text truncate">{c.agentName}</span>
            <span className="text-xs text-ctp-overlay1 truncate">{c.projectName}</span>
            <span className="ml-auto flex items-center gap-3 text-xs text-ctp-overlay1">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${c.running ? 'bg-ctp-success' : 'border border-ctp-overlay0'}`} />
                {c.running ? 'Running' : 'Sleeping'}
              </span>
              {c.running && (
                <label className="flex items-center gap-1.5 text-ctp-subtext1 cursor-pointer">
                  <input type="checkbox" checked={restart.has(c.agentId)} onChange={() => toggle(c.agentId)} aria-label={`Restart ${c.agentName}`} />
                  Restart
                </label>
              )}
            </span>
          </li>
        ))}
      </ul>
      {running.length > 0 && <p className="mt-3 text-xs text-ctp-overlay1">Restart keeps the conversation. The new setup applies from the next turn. An agent in the middle of a turn restarts when that turn ends.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-ctp-error">{error}</p>}
    </Modal>
  );
}
