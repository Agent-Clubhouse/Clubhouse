import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import type { ChatCapabilities } from '../../../../shared/chat';
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

interface BlockProps {
  block: StreamBlock;
  turnNumber: number;
  capabilities: ChatCapabilities | null;
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Blocks are rebuilt on every event, but the items inside keep their identity
 * unless that event changed them, so compare contents: a streamed chunk then
 * re-renders only the message it extends.
 */
function sameBlock(prev: BlockProps, next: BlockProps): boolean {
  if (prev.turnNumber !== next.turnNumber || prev.capabilities !== next.capabilities) return false;
  const a = prev.block;
  const b = next.block;
  if (a.type === 'item' && b.type === 'item') return a.item === b.item;
  if (a.type === 'explore' && b.type === 'explore') return sameItems(a.tools, b.tools);
  if (a.type === 'subagent' && b.type === 'subagent') return a.info === b.info && a.tool === b.tool && sameItems(a.children, b.children);
  return false;
}

const Block = memo(function Block({ block, turnNumber, capabilities }: BlockProps) {
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
    case 'turn_end': return <TurnFooter item={item} turnNumber={turnNumber} capabilities={capabilities} />;
    case 'session_divider': return <SessionDivider item={item} />;
    default: return null;
  }
}, sameBlock);

export function ChatStream({ state }: { state: ChatViewState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const { items, subagents, capabilities } = state;
  const blocks = useMemo(() => buildStreamBlocks({ items, subagents, capabilities }), [items, subagents, capabilities]);
  const turnNumbers = useMemo(() => {
    const m = new Map<string, number>();
    let n = 0;
    for (const item of items) {
      if (item.kind === 'session_divider') n = 0;
      if (item.kind === 'turn_end') m.set(item.id, ++n);
    }
    return m;
  }, [items]);

  // Screen readers hear each reply once it's complete, not every streamed chunk.
  const announcement = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'agent_message' && !it.subagentId) return it.streaming ? '' : it.text;
    }
    return '';
  }, [items]);

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
        <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-live-region">{announcement}</div>
        {blocks.length === 0 && (
          <div className="text-center text-[13px] text-ctp-overlay0 py-10">No messages yet. Send one to start.</div>
        )}
        {blocks.map((b) => (
          <Block key={b.key} block={b} turnNumber={b.type === 'item' ? turnNumbers.get(b.item.id) ?? 0 : 0} capabilities={capabilities} />
        ))}
      </div>
    </div>
  );
}
