/**
 * The dispose confirmation for an orchestrator's request (#2229, #2232):
 * under "Ask for everything" a dispose_helper call comes to the user as a
 * Needs you entry. Selecting it opens this, the same dialog as disposing from
 * the Helpers card, saying who asked. Disposing or declining dismisses the
 * request.
 */

import { useAgentStore } from '../../../stores/agentStore';
import { useHelperDisposeRequestStore } from '../../../stores/helperDisposeRequestStore';
import { DisposeHelperDialog } from './DisposeHelperDialog';

export function HelperDisposeRequestDialog() {
  const pending = useHelperDisposeRequestStore((s) => (s.reviewing ? s.requests[s.reviewing] : undefined));
  const dismiss = useHelperDisposeRequestStore((s) => s.dismiss);
  const helper = useAgentStore((s) => (pending ? s.agents[pending.request.helperId] : undefined));
  if (!pending) return null;
  const { request, orchestratorName } = pending;
  return (
    <DisposeHelperDialog
      key={`${request.helperId}:${pending.at}`}
      helper={{
        id: request.helperId,
        name: helper?.name ?? request.helperName,
        projectId: helper?.projectId ?? '',
        worktreePath: helper?.worktreePath,
        status: helper?.status,
      }}
      projectPath={request.projectPath}
      requestedBy={orchestratorName}
      onClose={() => dismiss(request.helperId)}
    />
  );
}
