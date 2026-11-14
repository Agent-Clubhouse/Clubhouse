import { createContext, useContext, useState, type ReactNode } from 'react';
import { useAnswering, type PermissionItem, type QuestionItem } from '../../../stores/chatStore';

export const ApprovalAgentContext = createContext('');
function useAnsweringContext(requestId: string) {
  return useAnswering(useContext(ApprovalAgentContext), requestId);
}

/** Both locations use the same actions and in-flight guard owned by ChatView. */
export const InlineApprovalContext = createContext<((requestId: string, busy: boolean) => ReactNode) | null>(null);

export function InlineApproval({ item, children }: { item: PermissionItem | QuestionItem; children?: ReactNode }) {
  const render = useContext(InlineApprovalContext);
  const [open, setOpen] = useState(false);
  const requestId = item.kind === 'permission' ? item.request.requestId : item.requestId;
  const busy = useAnsweringContext(requestId);
  const card = render?.(requestId, busy);
  return (
    <div className="flex flex-col gap-2" data-testid="chat-inline-approval">
      {children}
      {item.kind === 'permission' && (
        <div className="text-[12.5px] text-ctp-subtext0">
          <span className="text-ctp-text">{item.request.title}</span>
          <span className="ml-2">{item.decision ?? (card ? 'Waiting for approval' : 'No longer pending')}</span>
        </div>
      )}
      {card && <button type="button" className="self-start text-[12px] text-ctp-subtext0 hover:text-ctp-text" onClick={() => setOpen((v) => !v)}>{open ? 'Hide actions' : 'Answer here'}</button>}
      {open && card}
    </div>
  );
}
