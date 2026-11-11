import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import type { ManagedPartConsumer } from '../../../shared/managed-agents-types';
import { AgentDot } from './parts-ui';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Save Coding standards for 3 agents and 1 template?" */
export function impactTitle(partName: string, agents: number, templates: number): string {
  const who = [agents > 0 || templates === 0 ? plural(agents, 'agent') : null, templates > 0 ? plural(templates, 'template') : null].filter(Boolean).join(' and ');
  return `Save ${partName} for ${who}?`;
}

/** Whether saving a part asks first: anything besides one agent uses it (#2897, D93). */
export function needsImpactDialog(part: { usedBy: unknown[]; templates: unknown[] }, otherAgents = 0): boolean {
  return part.usedBy.length + part.templates.length > 1 || otherAgents > 0;
}

/**
 * Saving a part several agents or templates use (#2897): who it reaches,
 * which agents are running, and an optional restart for the running ones.
 * Restart resumes the conversation; the caller restarts a working agent when
 * its turn ends (restartAfterSave).
 */
export function ImpactDialog({ open, partName, consumers, templates = [], busy, error, onSave, onCancel, onForkInstead, forkLabel }: {
  open: boolean;
  partName: string;
  consumers: ManagedPartConsumer[];
  /** Templates that list the part: agents made from them later get the new version. */
  templates?: Array<{ id: string; name: string }>;
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
      busy={busy}
      title={impactTitle(partName, consumers.length, templates.length)}
      width="w-[560px]"
      testId="managed-impact-dialog"
      footer={(dismiss) => <>
        {onForkInstead && <Button kind="quiet" className="mr-auto" onClick={onForkInstead} disabled={busy}>{forkLabel ?? 'Fork for this agent instead'}</Button>}
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        <Button kind="primary" disabled={busy} onClick={() => onSave(running.filter((c) => restart.has(c.agentId)))} data-testid="managed-impact-save">
          {restart.size > 0 ? `Save and restart ${restart.size}` : 'Save'}
        </Button>
      </>}
    >
      <p className="text-[13px] text-ctp-subtext1">{consumers.length > 0 ? 'Each agent gets the new version when its next session starts.' : 'No agent uses it yet.'}</p>
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
      {templates.length > 0 && (
        <>
          <p className="mt-4 text-[13px] text-ctp-subtext1">Templates that list it. Agents made from them later get the new version too.</p>
          <ul className="mt-1 flex flex-col" data-testid="managed-impact-templates">
            {templates.map((t) => (
              <li key={t.id} className="py-2 border-t border-surface-0 text-[13px] text-ctp-text truncate">{t.name}</li>
            ))}
          </ul>
        </>
      )}
      {running.length > 0 && <p className="mt-3 text-xs text-ctp-overlay1">Restart keeps the conversation. The new setup applies from the next turn. An agent in the middle of a turn restarts when that turn ends.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-ctp-error">{error}</p>}
    </Modal>
  );
}
