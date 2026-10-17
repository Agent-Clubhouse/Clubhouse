import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ChatCapabilities } from '../../../../shared/chat';
import type { ChatViewState } from '../../../stores/chatStore';
import { buildStreamBlocks, type StreamBlock } from './view-model';
import { scrollWithin } from './scroll';
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
  /** Set on the first block of a run of inline subagent work (subagents not nested): its subagent id. */
  inlineSubagentId?: string;
  /** Open the agent map at a subagent; omitted hides the jump links. */
  onOpenSubagent?: (subagentId: string) => void;
}

/** The subagent a top-level block belongs to, when its work shows inline (ids_only, or nesting off). */
function blockSubagentId(block: StreamBlock): string | undefined {
  if (block.type === 'item') return 'subagentId' in block.item ? block.item.subagentId : undefined;
  if (block.type === 'explore') {
    const id = block.tools[0]?.subagentId;
    return id && block.tools.every((t) => t.subagentId === id) ? id : undefined;
  }
  return undefined;
}

function SubagentJump({ subagentId, onOpen }: { subagentId: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(subagentId)}
      className="self-start text-[11.5px] text-ctp-overlay1 hover:text-ctp-text underline-offset-2 hover:underline"
      data-testid="chat-subagent-jump"
    >
      Subagent work: open in agent map
    </button>
  );
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
  if (prev.inlineSubagentId !== next.inlineSubagentId || prev.onOpenSubagent !== next.onOpenSubagent) return false;
  const a = prev.block;
  const b = next.block;
  if (a.type === 'item' && b.type === 'item') return a.item === b.item;
  if (a.type === 'explore' && b.type === 'explore') return sameItems(a.tools, b.tools);
  if (a.type === 'subagent' && b.type === 'subagent') return a.info === b.info && a.tool === b.tool && sameItems(a.children, b.children);
  return false;
}

const Block = memo(function Block(props: BlockProps) {
  const { block, inlineSubagentId, onOpenSubagent } = props;
  if (block.type === 'subagent') return <SubagentCard block={block} onOpenInMap={onOpenSubagent} />;
  const subagentId = blockSubagentId(block);
  if (subagentId) {
    // Inline subagent work: tag it so "Show in conversation" can find it.
    return (
      <div className="flex flex-col gap-1" data-subagent-id={subagentId}>
        {inlineSubagentId && onOpenSubagent && <SubagentJump subagentId={inlineSubagentId} onOpen={onOpenSubagent} />}
        <BlockBody {...props} />
      </div>
    );
  }
  return <BlockBody {...props} />;
}, sameBlock);

function BlockBody({ block, turnNumber, capabilities }: BlockProps) {
  if (block.type === 'explore') return <ExploreGroup tools={block.tools} />;
  if (block.type === 'subagent') return null;
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
}

/** A request to scroll the stream to a subagent's work; `nonce` repeats a jump to the same one. */
export interface StreamJump {
  subagentId: string;
  nonce: number;
}

/** How long a jumped-to subagent stays outlined. */
const JUMP_HIGHLIGHT_MS = 1600;
const JUMP_HIGHLIGHT_CLASSES = ['outline', 'outline-1', 'outline-offset-2', 'outline-ctp-mauve/60', 'rounded-lg'];

export interface ChatStreamProps {
  state: ChatViewState;
  onOpenSubagent?: (subagentId: string) => void;
  jump?: StreamJump | null;
  /** Reports whether a jump found its target in the rendered conversation. */
  onJumpResult?: (jump: StreamJump, found: boolean) => void;
  /** Announce finished replies to screen readers. Off for views that aren't the focused one. */
  announce?: boolean;
  /** Shown as "Show earlier" above the first message when earlier history wasn't loaded. */
  onShowEarlier?: () => void;
}

export function ChatStream({ state, onOpenSubagent, jump, onJumpResult, announce = true, onShowEarlier }: ChatStreamProps) {
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

  // The first block of each consecutive run of inline subagent work gets a jump link.
  const inlineJumps = useMemo(() => {
    const m = new Map<string, string>();
    let previous: string | undefined;
    for (const b of blocks) {
      const id = b.type === 'subagent' ? undefined : blockSubagentId(b);
      if (id && id !== previous) m.set(b.key, id);
      previous = id;
    }
    return m;
  }, [blocks]);

  useEffect(() => {
    if (!jump) return;
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(jump.subagentId)}"]`);
    onJumpResult?.(jump, !!target);
    if (!root || !target) return;
    pinned.current = false;
    scrollWithin(root, target, 'center', 'smooth');
    target.classList.add(...JUMP_HIGHLIGHT_CLASSES);
    target.setAttribute('data-jump-highlight', 'true');
    const clear = () => {
      target.classList.remove(...JUMP_HIGHLIGHT_CLASSES);
      target.removeAttribute('data-jump-highlight');
    };
    const t = setTimeout(clear, JUMP_HIGHLIGHT_MS);
    // A newer jump (or unmount) clears this one's outline straight away.
    return () => { clearTimeout(t); clear(); };
    // Only a new jump re-runs this; a new onJumpResult callback alone isn't a jump.
  }, [jump]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  };

  return (
    <div ref={scroller} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-7 pt-5 pb-2.5" data-testid="chat-stream">
      <div className="mx-auto w-full max-w-[740px] flex flex-col gap-2.5 min-h-full justify-end">
        {announce && <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-live-region">{announcement}</div>}
        {onShowEarlier && (
          <button
            type="button"
            onClick={() => { pinned.current = false; onShowEarlier(); }}
            className="self-center h-7 px-3 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px]"
            data-testid="chat-show-earlier"
          >
            Show earlier
          </button>
        )}
        {blocks.length === 0 && (
          <div className="text-center text-[13px] text-ctp-overlay0 py-10">No messages yet. Send one to start.</div>
        )}
        {blocks.map((b) => (
          <Block
            key={b.key}
            block={b}
            turnNumber={b.type === 'item' ? turnNumbers.get(b.item.id) ?? 0 : 0}
            capabilities={capabilities}
            inlineSubagentId={inlineJumps.get(b.key)}
            onOpenSubagent={onOpenSubagent}
          />
        ))}
      </div>
    </div>
  );
}
