import { useEffect, useState, type ReactNode } from 'react';
import type { Agent } from '../../../../shared/types';
import type { RemoteAgentSettings } from '../../../../shared/remote-agent-settings';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { accessLabel } from '../../../../shared/agent-access';
import type { ChatViewState } from '../../../stores/chatStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { parseNamespacedId, useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { contextSummary } from '../ContextWindowField';
import { changedLine } from '../../managed/attribution';
import { Button } from '../../../components/Button';
import { CardNote, CardRow, DetailsCard } from './DetailsCard';
import { useAgentDetailsStore } from './detailsStore';

export type RemoteSettingsResult = ControllerReadResult<RemoteAgentSettings> | { status: 'loading' };
type Result = RemoteSettingsResult;
const message = (result: Result): string | null => {
  switch (result.status) {
    case 'loading': return 'Loading settings from the other machine…';
    case 'unavailable': return 'This host doesn’t share these settings. It may need an update, or the agent is no longer available.';
    case 'offline': return 'Reconnect to the other machine to read its settings.';
    case 'forbidden': return 'The host does not allow this settings read.';
    case 'rate_limited': return 'The host is busy. Try reading settings again shortly.';
    case 'error': return 'Couldn’t read settings from the other machine. Try again.';
    case 'ok': return null;
  }
};

/** A separate remote surface keeps every local setup, filesystem and editing hook out of this path. */
export function RemoteSettingsCard({ agent, chat, result: supplied, onRetry, runtimeUnconfirmed, children }: { agent: Agent; chat?: ChatViewState; result?: Result; onRetry?: () => void; runtimeUnconfirmed?: boolean; children?: ReactNode }) {
  const open = useAgentDetailsStore((s) => s.settingsOpen);
  const setOpen = useAgentDetailsStore((s) => s.setSettingsOpen);
  const address = parseNamespacedId(agent.id);
  const satellite = useAnnexClientStore((s) => s.satellites.find((sat) => sat.id === address?.satelliteId));
  const projectHost = useRemoteProjectStore((s) => Object.values(s.satelliteProjects).flat().find((p) => p.id === agent.projectId)?.satelliteName);
  const host = satellite?.alias || satellite?.snapshot?.machine?.name || projectHost || 'the other machine';
  const connected = satellite?.state === 'connected';
  const snapshot = satellite?.snapshot;
  const [retry, setRetry] = useState(0);
  const key = `${agent.id}:${agent.status}:${retry}`;
  const [read, setRead] = useState<{ key: string; snapshot: typeof snapshot; result: Result } | null>(null);
  const satelliteId = address?.satelliteId;
  const agentId = address?.agentId;
  useEffect(() => {
    if (supplied) return;
    if (!connected) { setRead(null); return; }
    if (!open || !satelliteId || !agentId || agent.kind !== 'durable') return;
    let active = true;
    // A snapshot is sent on reconnect and host config changes. Wake/sleep also changes the key.
    Promise.resolve().then(() => window.clubhouse.annexClient.agentSettings(satelliteId, agentId)).then(
      (result) => { if (active) setRead({ key, snapshot, result }); },
      // telemetry-exempt: the card shows a bounded retryable error.
      () => { if (active) setRead({ key, snapshot, result: { status: 'error' } }); },
    );
    return () => { active = false; };
  }, [open, connected, satelliteId, agentId, agent.kind, key, snapshot, supplied]);
  const result: Result = supplied ?? (agent.kind !== 'durable' ? { status: 'unavailable' }
    : !connected ? { status: 'offline' }
      : read?.key === key && read.snapshot === snapshot ? read.result : { status: 'loading' });
  const value = result.status === 'ok' ? result.value : null;
  const asleep = agent.status === 'sleeping' || agent.status === 'error';
  const session = asleep ? undefined : chat;
  const liveModel = session?.model ? session.models.find((m) => m.id === session.model)?.label ?? session.model : null;
  const model = value ? liveModel && session?.model !== value.model ? `${liveModel} now, next start: ${value.model}` : liveModel ?? value.model : liveModel;
  const liveAccess = session?.level ? accessLabel(session.level) : null;
  const access = liveAccess && value && liveAccess !== value.access ? `${liveAccess} now, starts at ${value.access}` : liveAccess ?? value?.access;
  const liveRuntime = session || agent.executionMode === 'chat' ? 'Chat' : agent.executionMode ? 'CLI' : null;
  const nextRuntime = value?.runtime === 'chat' ? 'Chat' : value ? 'CLI' : null;
  const runtime = asleep ? nextRuntime : runtimeUnconfirmed ? `${nextRuntime ?? 'Host setting'} on next wake; current run not confirmed` : liveRuntime ?? (nextRuntime ? `${nextRuntime} on next wake` : null);
  const summary = [value?.setup.managed ? 'Managed' : null, runtime, model, access].filter(Boolean).join(' · ') || message(result);
  const row = (id: string, label: string, text: string | null | undefined) => text == null ? null
    : <CardRow key={id} label={label} labelWidth="wide" testId={`details-setting-${id}`}>{text}</CardRow>;
  const names = (items: string[] | null) => items === null ? 'Not shared by host' : items.join(', ') || 'None';
  const setup = value?.setup;
  return (
    <DetailsCard id="settings" title="Settings" summary={summary} open={open} onToggle={() => setOpen(!open)}>
      {row('cli', 'CLI', [value?.provider ?? session?.provider, session?.cliVersion].filter(Boolean).join(' ') || null)}
      {row('runs-in', asleep ? 'Next wake' : 'Runs in', runtime)}
      {!asleep && liveRuntime && nextRuntime && liveRuntime !== nextRuntime && row('next-runtime', 'Next wake', nextRuntime)}
      {row('model', 'Model', model)}
      {row('effort', 'Effort', session?.effortReported && session.effort ? session.effort[0].toUpperCase() + session.effort.slice(1) + (session.effortIsDefault ? ' (default)' : '') : null)}
      {row('access', 'Access', access)}
      {value && <>
        {row('execution-policy', 'Sandbox and approvals', value.executionPolicy)}
        {row('auto-sleep', 'Auto-sleep', value.autoSleep)}
        {row('context', 'Context', [session ? contextSummary(session.contextLimits, session.usage.context?.size) : null, value.context ? `Next start: ${value.context}` : null].filter(Boolean).join(' · ') || null)}
        {setup?.state === 'ok' ? <>
          {setup.managed && row('managed', 'Managed', 'By Clubhouse')}
          {setup.managed && row('template', 'Template', setup.template ?? 'None')}
          {row('instructions', 'Instructions', setup.instructions)}
          {row('skills', 'Skills', names(setup.skills))}
          {row('mcp', 'MCP servers', names(setup.mcps))}
          {setup.updatedAt && <CardNote>{changedLine(setup.updatedAt, setup.updatedBy)}</CardNote>}
          {setup.waiting && <CardNote>Setup changed. Applies when it restarts or next wakes.</CardNote>}
          <CardNote>{setup.managed ? 'Desired setup on the host. ' : 'Configured on the host. '}This does not confirm provider loading or use. Live skills and MCP status are shown separately when reported.</CardNote>
        </> : <CardNote>Couldn’t read the host’s configured instructions, skills and MCP summary.</CardNote>}
      </>}
      {message(result) && <CardNote><span role="status">{message(result)}</span></CardNote>}
      {children}
      {['error', 'rate_limited'].includes(result.status) && <Button kind="ghost" onClick={() => supplied ? onRetry?.() : setRetry((n) => n + 1)}>Try again</Button>}
      <CardNote><span data-testid="details-settings-remote">Change on {host}</span></CardNote>
    </DetailsCard>
  );
}
