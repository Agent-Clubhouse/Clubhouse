/**
 * The review dialog for an agent's Clubhouse permission requests (#2970):
 * selecting the agent's Needs you entry opens it. It works the same for the
 * Dispatcher, which has no agent settings page of its own in the sidebar.
 *
 * It shows the oldest request, and its answers sit in the footer of a panel
 * of fixed size, so Allow and Decline stay where they are as requests
 * resolve and the next one takes its place (#3606).
 */

import { Modal } from '../../components/Modal';
import { useAgentStore } from '../../stores/agentStore';
import { grantRequestsFor, useGrantRequestStore } from '../../stores/grantRequestStore';
import { GrantRequestActions, GrantRequestBody, GrantRequestError, useGrantAnswering } from './GrantRequestList';

export function GrantRequestDialog() {
  const reviewing = useGrantRequestStore((s) => s.reviewing);
  // A request object from the store is stable between renders, so selecting the first one is safe.
  const first = useGrantRequestStore((s) => (s.reviewing ? grantRequestsFor(s.requests, s.reviewing)[0] : undefined));
  const waiting = useGrantRequestStore((s) => (s.reviewing ? grantRequestsFor(s.requests, s.reviewing).length : 0));
  const review = useGrantRequestStore((s) => s.review);
  const liveName = useAgentStore((s) => (reviewing ? s.agents[reviewing]?.name : undefined));
  const answering = useGrantAnswering();
  if (!reviewing || !first) return null;
  const name = liveName ?? first.agentName;
  return (
    <Modal
      open
      onClose={() => review(null)}
      title={`${name} is asking`}
      width="w-[460px]"
      height="h-[min(520px,calc(100vh-48px))]"
      testId="grant-request-dialog"
      footer={(
        <div className="flex w-full flex-col gap-1.5">
          <GrantRequestError r={first} answering={answering} />
          <div className="flex justify-end"><GrantRequestActions r={first} answering={answering} /></div>
        </div>
      )}
    >
      <div data-testid="grant-request-list" aria-label={`${name}'s permission requests`}>
        <div data-testid={`grant-request-${first.requestId}`}>
          {waiting > 1 && <p className="mb-2 text-xs text-ctp-overlay1" role="status">{`1 of ${waiting} waiting`}</p>}
          <GrantRequestBody r={first} />
        </div>
      </div>
    </Modal>
  );
}
