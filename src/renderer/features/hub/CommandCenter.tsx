import { useEffect, useState, useCallback, useMemo } from 'react';
import { useHubStore } from '../../stores/hubStore';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { PaneContainer } from './PaneContainer';
import { CloseConfirmDialog } from './CloseConfirmDialog';
import { DeleteAgentDialog } from '../agents/DeleteAgentDialog';

interface CloseRequest {
  paneId: string;
  agentId: string;
}

export function CommandCenter() {
  const paneTree = useHubStore((s) => s.paneTree);
  const loadHub = useHubStore((s) => s.loadHub);
  const closePane = useHubStore((s) => s.closePane);
  const agents = useAgentStore((s) => s.agents);
  const killAgent = useAgentStore((s) => s.killAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null);

  const knownAgentIds = useMemo(() => new Set(Object.keys(agents)), [agents]);

  useEffect(() => {
    if (activeProjectId) {
      loadHub(activeProjectId, knownAgentIds);
    }
  }, [activeProjectId, loadHub, knownAgentIds]);

  const handleCloseConfirm = useCallback((paneId: string, agentId: string) => {
    const agent = agents[agentId];
    if (!agent) return;

    // Running durable agents with worktree: use the full DeleteAgentDialog
    if (agent.kind === 'durable' && agent.status === 'running') {
      setCloseRequest({ paneId, agentId });
      return;
    }

    // Running quick agents: show simple confirm
    if (agent.kind === 'quick' && agent.status === 'running') {
      setCloseRequest({ paneId, agentId });
      return;
    }
  }, [agents]);

  const confirmClose = useCallback(async () => {
    if (!closeRequest) return;
    const { paneId, agentId } = closeRequest;
    const agent = agents[agentId];

    if (agent?.status === 'running') {
      await killAgent(agentId);
    }

    if (agent?.kind === 'quick') {
      removeAgent(agentId);
    }

    closePane(paneId);
    setCloseRequest(null);
  }, [closeRequest, agents, killAgent, removeAgent, closePane]);

  const cancelClose = useCallback(() => {
    setCloseRequest(null);
  }, []);

  if (!paneTree) return null;

  const closeAgent = closeRequest ? agents[closeRequest.agentId] : null;
  const closeMessage = closeAgent?.kind === 'durable'
    ? 'The agent will go to sleep.'
    : 'This will end the session.';

  return (
    <div className="h-full w-full bg-ctp-base overflow-hidden">
      <PaneContainer node={paneTree} onCloseConfirm={handleCloseConfirm} />

      {closeRequest && closeAgent && (
        <CloseConfirmDialog
          agentName={closeAgent.name}
          message={closeMessage}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      )}

      <DeleteAgentDialog />
    </div>
  );
}
