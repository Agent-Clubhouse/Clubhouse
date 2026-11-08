/**
 * The review dialog for an agent's Clubhouse permission requests (#2970):
 * selecting the agent's Needs you entry opens it. It works the same for the
 * Dispatcher, which has no agent settings page of its own in the sidebar.
 */

import { Modal } from '../../components/Modal';
import { useAgentStore } from '../../stores/agentStore';
import { grantRequestsFor, useGrantRequestStore } from '../../stores/grantRequestStore';
import { GrantRequestList } from './GrantRequestList';

export function GrantRequestDialog() {
  const reviewing = useGrantRequestStore((s) => s.reviewing);
  // A request object from the store is stable between renders, so selecting the first one is safe.
  const first = useGrantRequestStore((s) => (s.reviewing ? grantRequestsFor(s.requests, s.reviewing)[0] : undefined));
  const review = useGrantRequestStore((s) => s.review);
  const liveName = useAgentStore((s) => (reviewing ? s.agents[reviewing]?.name : undefined));
  if (!reviewing || !first) return null;
  const name = liveName ?? first.agentName;
  return (
    <Modal open onClose={() => review(null)} title={`${name} is asking`} width="w-[460px]" testId="grant-request-dialog">
      <GrantRequestList agentId={reviewing} agentName={name} />
    </Modal>
  );
}
