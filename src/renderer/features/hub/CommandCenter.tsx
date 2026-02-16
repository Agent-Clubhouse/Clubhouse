import { useEffect, useMemo } from 'react';
import { useHubStore } from '../../stores/hubStore';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { PaneContainer } from './PaneContainer';
import { DeleteAgentDialog } from '../agents/DeleteAgentDialog';

export function CommandCenter() {
  const paneTree = useHubStore((s) => s.paneTree);
  const loadHub = useHubStore((s) => s.loadHub);
  const agents = useAgentStore((s) => s.agents);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const knownAgentIds = useMemo(() => new Set(Object.keys(agents)), [agents]);

  useEffect(() => {
    if (activeProjectId) {
      loadHub(activeProjectId, knownAgentIds);
    }
  }, [activeProjectId, loadHub, knownAgentIds]);

  if (!paneTree) return null;

  return (
    <div className="h-full w-full bg-ctp-base overflow-hidden">
      <PaneContainer node={paneTree} />
      <DeleteAgentDialog />
    </div>
  );
}
