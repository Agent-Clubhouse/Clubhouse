import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ChatViewState } from '../../../stores/chatStore';
import { buildStreamBlocks, type StreamBlock } from './view-model';
import {
  AgentMessage,
  ErrorRow,
  NoticeRow,
  PlanDocumentCard,
  SessionDivider,
  ThoughtRow,
  TurnFooter,
  UserMessage,
} from './MessageBlocks';
import { ExploreGroup, SubagentCard, ToolCallView } from './ToolBlocks';

/** Distance from the bottom (px) within which new content keeps the view pinned. */
const STICK_THRESHOLD = 80;

function Block({ block, turnNumbers, state }: { block: StreamBlock; turnNumbers: Map<string, number>; state: ChatViewState }) {
  if (block.type === 'explore') return <ExploreGroup tools={block.tools} />;
  if (block.type === 'subagent') return <SubagentCard block={block} />;
  const item = block.item;
  switch (item.kind) {
    case 'user_message': return <UserMessage item={item} />;
    case 'agent_message': return <AgentMessage item={item} />;
    case 'thought': return <ThoughtRow item={item} />;
    case 'tool_call': return <ToolCallView tool={item} />;
    case 'plan_document': return <PlanDocumentCard item={item} />;
    case 'notice': return <NoticeRow item={item} />;
    case 'error': return <ErrorRow item={item} />;
    case 'turn_end': return <TurnFooter item={item} turnNumber={turnNumbers.get(item.id) ?? 0} capabilities={state.capabilities} />;
    case 'session_divider': return <SessionDivider item={item} />;
    default: return null;
  }
}

export function ChatStream({ state }: { state: ChatViewState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const blocks = useMemo(() => buildStreamBlocks(state), [state]);
  const turnNumbers = useMemo(() => {
    const m = new Map<string, number>();
    let n = 0;
    for (const item of state.items) {
      if (item.kind === 'session_divider') n = 0;
      if (item.kind === 'turn_end') m.set(item.id, ++n);
    }
    return m;
  }, [state.items]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  };

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-7 pt-5 pb-2.5" data-testid="chat-stream">
      <div className="mx-auto w-full max-w-[740px] flex flex-col gap-2.5 min-h-full justify-end">
        {blocks.length === 0 && (
          <div className="text-center text-[13px] text-ctp-overlay0 py-10">No messages yet. Send one to start.</div>
        )}
        {blocks.map((b) => <Block key={b.key} block={b} turnNumbers={turnNumbers} state={state} />)}
      </div>
    </div>
  );
}
