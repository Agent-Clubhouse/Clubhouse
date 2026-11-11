import { Button } from '../../components/Button';
import { describeGrantRequests, grantRequestsByAgent, useGrantRequestStore } from '../../stores/grantRequestStore';
import { useDispatcherStore, visibleRequestAgentId } from './dispatcherStore';

export function PendingApprovals({ agentId }: { agentId: string }) {
  const state = useDispatcherStore((s) => s.state);
  const requests = useGrantRequestStore((s) => s.requests);
  const review = useGrantRequestStore((s) => s.review);
  const pending = grantRequestsByAgent(requests, (id) => visibleRequestAgentId(id, state))[agentId] ?? [];
  const first = pending[0];

  return (
    <div aria-live="polite" aria-atomic="true">
      {first && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-surface-0 px-3 py-2 text-sm" data-testid="dispatcher-pending-approvals">
          <span>Clubhouse approval: {describeGrantRequests(pending)}</span>
          <Button onClick={() => review(first.agentId)}>Review</Button>
        </div>
      )}
    </div>
  );
}
