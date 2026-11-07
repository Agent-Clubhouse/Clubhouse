import { useAgentStore } from '../../stores/agentStore';
import { DeleteAgentDialog } from '../../features/agents/DeleteAgentDialog';
import { HelperDisposeRequestDialog } from '../../features/agents/helpers/HelperDisposeRequestDialog';
import { ManagedRestartHost } from '../../features/managed/restart';

/**
 * Agent dialogs for the new chrome. The legacy shell renders these inside
 * AgentList; the new sidebar has no AgentList, so it hosts them here. New
 * durable and quick agents are made on the New agent page instead
 * (pages/NewAgentPage.tsx).
 */
export function ChromeAgentDialogs() {
  const deleteDialogAgent = useAgentStore((s) => s.deleteDialogAgent);

  return (
    <>
      {deleteDialogAgent && <DeleteAgentDialog />}
      <ManagedRestartHost />
      <HelperDisposeRequestDialog />
    </>
  );
}
