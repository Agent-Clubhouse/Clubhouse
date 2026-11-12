import { useEffect, useState } from 'react';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import type { AgentConnectionSources } from '../../../../shared/connection-sources';
import type { ConnectionDirection } from '../../../../shared/connection-grants';
import { isDispatcherAgent } from '../../dispatcher/dispatcherStore';
import { ConnectionSourcesDialog } from './ConnectionSourcesDialog';
import { reportChromeActionFailed } from '../../../chrome/telemetry';

export function ConnectionEditorDialog({ binding, onClose, backdropTestId = 'wire-instructions-dialog' }: { binding: McpBindingEntry; onClose: () => void; backdropTestId?: string }) {
  const bindings = useMcpBindingStore((state) => state.bindings);
  const agents = useAgentStore((state) => state.agents);
  const [data, setData] = useState<{ sources: AgentConnectionSources; grants: ConnectionDirection[] } | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => window.clubhouse.mcpBinding.onConnectionGrantsChanged(() => setReload((value) => value + 1)), []);
  useEffect(() => {
    let active = true;
    setError('');
    Promise.all([
      window.clubhouse.mcpBinding.getConnectionSources(binding.agentId),
      window.clubhouse.mcpBinding.getConnectionGrants(binding.agentId),
    ]).then(([sources, grants]) => {
      if (active) setData({ sources, grants });
    }).catch((cause: unknown) => {
      reportChromeActionFailed('agent_settings_save', cause);
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [binding.agentId, bindings, reload]);
  const from = agents[binding.agentId];
  const to = agents[binding.targetId];
  const agentName = from?.name ?? binding.agentName ?? binding.agentId;
  const otherName = to?.name ?? binding.targetName ?? binding.label;
  const related = bindings.filter((entry) => (entry.agentId === binding.agentId && entry.targetId === binding.targetId)
    || (binding.targetKind === 'agent' && entry.agentId === binding.targetId && entry.targetId === binding.agentId));
  const pairs = data?.sources.pairs.filter((pair) => (pair.agentId === binding.agentId && pair.targetId === binding.targetId)
    || (binding.targetKind === 'agent' && pair.agentId === binding.targetId && pair.targetId === binding.agentId)) ?? [];
  for (const entry of related) {
    if (!pairs.some((pair) => pair.agentId === entry.agentId && pair.targetId === entry.targetId)) {
      pairs.push({ agentId: entry.agentId, targetId: entry.targetId, bound: true, sources: [], unresolved: true });
    }
  }
  return (
    <div onMouseDown={(event) => event.stopPropagation()}>
      {!data ? (
        <Modal open onClose={onClose} title="Edit connection" backdropTestId={backdropTestId}>
          {error ? <><p role="alert" className="text-xs text-ctp-error">Couldn't read this connection: {error}</p><Button onClick={() => setReload((value) => value + 1)}>Try again</Button></> : <p className="text-xs text-ctp-overlay1">Loading connection...</p>}
        </Modal>
      ) : (
        <ConnectionSourcesDialog
          agentId={binding.agentId} otherId={binding.targetId} agentName={agentName} otherName={otherName}
          targetKind={binding.targetKind} grants={data.grants} pairs={pairs} unreadable={data.sources.unreadable}
          dispatcherEnd={isDispatcherAgent(from ?? { id: binding.agentId, projectId: '' }) ? otherName
            : isDispatcherAgent(to ?? { id: binding.targetId, projectId: '' }) ? agentName : undefined}
          familyLink={from?.parentAgentId === binding.targetId || to?.parentAgentId === binding.agentId || pairs.some((pair) => pair.sources.some((source) => source.kind === 'helper'))}
          liveTools={new Map(related.map((entry) => [`${entry.agentId}>${entry.targetId}`, entry.disabledTools ?? []]))}
          liveEnabled={new Map(related.map((entry) => [`${entry.agentId}>${entry.targetId}`, entry.enabledTools ?? []]))}
          onClose={onClose} onRemoved={() => setReload((value) => value + 1)} backdropTestId={backdropTestId}
          readError={error} onRetry={() => setReload((value) => value + 1)}
        />
      )}
    </div>
  );
}
