/**
 * The setup-changed bar (#2896): a running managed agent whose setup changed
 * after its session started keeps what it started with until it restarts.
 * The bar says what changed and offers Restart, which resumes the
 * conversation (or starts a new one when the CLI changed), What changed
 * (the builder's Preview page) and Dismiss, which hides it until the next
 * change. It sits above the composer in chat and above the terminal in the
 * CLI view. Sleeping agents get no bar: they wake on the new setup.
 */
import { create } from 'zustand';
import type { Agent } from '../../../shared/types';
import type { ManagedAgentStatus } from '../../../shared/managed-agents-types';
import { Button } from '../../components/Button';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { useProjectPath } from '../agents/details/AgentDetails';
import { openAgentSettingsOn } from '../agents/agentSettingsPages';
import { XIcon } from '../agents/chat/icons';
import { useManagedFlag } from './managed-flag';
import { useManagedStatus } from './managedApi';
import { PENDING_RESTART_NOTE, useManagedRestart } from './restart';

export const RESUME_NOTE = 'Restart keeps the conversation. The new setup applies from the next turn.';
export const CLI_CHANGED_NOTE = 'The CLI changed, so restarting starts a new conversation.';

/** "Setup changed since this session started: Coding standards was edited; Playwright was added." */
export function setupChangedText(changes: string[]): string {
  const list = changes.map((c) => c.trim().replace(/\.$/, '')).filter(Boolean);
  return list.length > 0
    ? `Setup changed since this session started: ${list.join('; ')}.`
    : 'Setup changed since this session started.';
}

/** What a dismissal covers: this set of changes to this session. A new change shows the bar again. */
function dismissKey(status: ManagedAgentStatus): string {
  return `${status.deliveredAt ?? ''}\n${status.cliChanged}\n${status.changes.join('\n')}`;
}

/** Dismissals per agent, shared by its chat and CLI views and kept while the window is open. */
const useDismissed = create<{ byAgent: Record<string, string> }>(() => ({ byAgent: {} }));

export function resetSetupBarDismissals(): void {
  useDismissed.setState({ byAgent: {} });
}

/** The managed status of a local running agent, read only with the flag on. */
export function useRunningManagedStatus(agent: Agent): { status: ManagedAgentStatus | null; projectPath: string | undefined } {
  const flag = useManagedFlag();
  const projectPath = useProjectPath(agent.projectId);
  const eligible = flag && agent.kind === 'durable' && !isRemoteProjectId(agent.projectId) && !!projectPath;
  const { value } = useManagedStatus(eligible ? projectPath : undefined, eligible ? agent.id : undefined);
  return { status: eligible ? value : null, projectPath };
}

export function SetupChangedBar({ agent, variant }: {
  agent: Agent;
  /** `dock`: a card above the composer. `strip`: a line under the terminal's toolbar. */
  variant: 'dock' | 'strip';
}) {
  const { status, projectPath } = useRunningManagedStatus(agent);
  const dismissed = useDismissed((s) => s.byAgent[agent.id]);
  const target = projectPath ? { projectPath, agentId: agent.id, agentName: agent.name } : null;
  const { restart, busy, pending, error, dialog } = useManagedRestart(target);

  const showing = !!status && status.managed && status.running && status.waiting && dismissed !== dismissKey(status);
  const text = !status || !showing ? '' : status.deliveryFailed ? `Setup couldn't be written: ${status.deliveryFailed}` : setupChangedText(status.changes);
  // Always mounted, so a screen reader hears the bar appear and change.
  const live = <span role="status" className="sr-only" data-testid="setup-changed-live">{text}</span>;
  if (!status || !showing) return <>{live}{dialog}</>;

  const note = pending ? PENDING_RESTART_NOTE : status.cliChanged ? CLI_CHANGED_NOTE : RESUME_NOTE;
  const dismiss = () => useDismissed.setState((s) => ({ byAgent: { ...s.byAgent, [agent.id]: dismissKey(status) } }));
  const frame = variant === 'dock'
    ? 'border border-surface-0 rounded-lg bg-ctp-mantle px-3 py-2 text-[12.5px]'
    : 'flex-shrink-0 pl-3.5 pr-3 py-1 border-b border-surface-0 bg-ctp-base text-xs';

  return (<>{live}
    <div className={`flex flex-col gap-1 min-w-0 ${frame}`} data-testid="setup-changed-bar" data-variant={variant}>
      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap min-w-0">
        <span className="flex-1 min-w-[180px] text-ctp-text" data-testid="setup-changed-text">{text}</span>
        <span className="flex items-center gap-1.5 flex-wrap ml-auto">
          <span className="text-ctp-overlay1 mr-1" data-testid="setup-changed-note">{note}</span>
          <Button kind="quiet" onClick={() => openAgentSettingsOn(agent.id, 'preview')} data-testid="setup-changed-what">What changed</Button>
          <Button kind="primary" onClick={() => restart({ fresh: status.cliChanged })} disabled={busy || !target} data-testid="setup-changed-restart">
            {busy ? 'Restarting' : 'Restart'}
          </Button>
          <Button kind="quiet" icon={<XIcon size={12} />} aria-label="Dismiss" onClick={dismiss} data-testid="setup-changed-dismiss" />
        </span>
      </div>
      {error && <span className="text-ctp-error" role="alert" data-testid="setup-changed-error">{error}</span>}
      {dialog}
    </div>
  </>);
}
