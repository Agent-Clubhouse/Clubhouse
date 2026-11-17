/**
 * The review dialog for an agent's Clubhouse permission requests (#2970):
 * selecting the agent's Needs you entry opens it. It works the same for the
 * Dispatcher, which has no agent settings page of its own in the sidebar.
 *
 * It shows the oldest request, and its answers sit in the footer of a panel
 * of fixed size, so Allow and Decline stay where they are as requests
 * resolve and the next one takes its place (#3606). After an answer focus goes
 * to the count, not to the next Allow, so a repeated key can't answer it; when
 * none is left the dialog closes and focus returns to where it was.
 */

import { useEffect, useRef } from 'react';
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
  const focusAfterAnswer = useRef(false);
  const answering = useGrantAnswering(() => { focusAfterAnswer.current = true; });
  const status = useRef<HTMLParagraphElement>(null);
  const headId = first?.requestId;
  useEffect(() => {
    if (!focusAfterAnswer.current) return;
    focusAfterAnswer.current = false;
    // Not the next Allow: a second press of the key that answered would answer it too (#3606).
    status.current?.focus();
  }, [headId]);
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
          {/* Always here, so a screen reader hears the count change; seen only when more than one waits. */}
          <p ref={status} tabIndex={-1} role="status" className={`outline-none ${waiting > 1 ? 'mb-2 text-xs text-ctp-overlay1' : 'sr-only'}`}>{waiting > 1 ? `1 of ${waiting} waiting` : '1 waiting'}</p>
          <GrantRequestBody r={first} />
        </div>
      </div>
    </Modal>
  );
}
