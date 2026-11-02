import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChatCapabilities, ChatMcpServer } from '../../../../shared/chat';
import type { ChatViewState } from '../../../stores/chatStore';
import { stripTaskMarker } from '../../../../shared/chat';
import { useAgentStore } from '../../../stores/agentStore';
import { agentMessagesToName, buildStreamBlocks, commandOutputIds, isNavigationStop, toolErrorText, type StreamBlock } from './view-model';
import { firstVisibleIndex, scrollWithin } from './scroll';
import { Tooltip } from '../../../components/Tooltip';
import { NEXT_AGENT_MESSAGE_EVENT, PREVIOUS_AGENT_MESSAGE_EVENT } from '../../../stores/keyboardShortcutsStore';
import { RichLinkProvider } from './rich/RichLinks';
import { useRichChatContent } from './rich/rich-flag';
import { ChatMediaContext } from './rich/ChatImages';
import { FileChipProvider } from './rich/FileChips';
import { rendererLog } from '../../../plugins/renderer-logger';
import {
  AgentMessage,
  ErrorRow,
  NoticeRow,
  PlanDocumentCard,
  QuestionRow,
  ThoughtRow,
  TurnFooter,
  UserMessage,
} from './MessageBlocks';
import { ChevronDown, ChevronUp } from './icons';
import {
  AwaitingApprovalContext,
  ChatterGroup,
  ExploreGroup,
  LiveTurnContext,
  SubagentCard,
  ToolCallView,
} from './ToolBlocks';
import { createTranscriptExpansionStore, TranscriptExpansionProvider } from './transcript-expansion';

/** Distance from the bottom (px) that counts as being there: new content follows, and Latest hides. */
const STICK_THRESHOLD = 16;
/** Upward movement (px) that means the reader left, even inside STICK_THRESHOLD. Smaller is sub-pixel noise. */
const MOVED_UP_PX = 1;
/** Rows kept mounted above the reader's place when a window attached to the tail slides. */
const WINDOW_OVERSCAN = 25;

/**
 * The block that makes the stream wider than its column, for the sideways
 * scroll log (#2292): the first whose content is wider than it is.
 */
function overflowingBlock(root: HTMLElement): Record<string, unknown> | null {
  for (const block of root.querySelectorAll<HTMLElement>('[data-testid="chat-stream-block"]')) {
    if (block.scrollWidth > block.clientWidth) {
      return {
        index: Number(block.dataset.blockIndex),
        testId: block.firstElementChild?.getAttribute('data-testid') ?? null,
        scrollWidth: block.scrollWidth,
        clientWidth: block.clientWidth,
      };
    }
  }
  return null;
}

const NAV_BUTTON = 'h-6 min-w-6 px-1.5 flex items-center justify-center rounded text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ctp-accent';

/** Maximum transcript rows mounted at once. */
export const CHAT_STREAM_WINDOW_SIZE = 250;

interface BlockProps {
  block: StreamBlock;
  turnNumber: number;
  capabilities: ChatCapabilities | null;
  /** The session's MCP servers, so a tool name splits on a known server first. */
  mcpServers?: ChatMcpServer[] | null;
  /** Set on the first block of a run of inline subagent work (subagents not nested): its subagent id. */
  inlineSubagentId?: string;
  /** Open the agent map at a subagent; omitted hides the jump links. */
  onOpenSubagent?: (subagentId: string) => void;
  /** An agent message that is a slash command's laid-out output. */
  preformatted?: boolean;
  /** The name to show on an agent message that starts a run of them. */
  agentName?: string;
}

/** The subagent a top-level block belongs to, when its work shows inline (ids_only, or nesting off). */
function blockSubagentId(block: StreamBlock): string | undefined {
  if (block.type === 'item') return 'subagentId' in block.item ? block.item.subagentId : undefined;
  if (block.type === 'explore' || block.type === 'group') {
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
  if (prev.turnNumber !== next.turnNumber || prev.capabilities !== next.capabilities || prev.mcpServers !== next.mcpServers) return false;
  if (prev.inlineSubagentId !== next.inlineSubagentId || prev.onOpenSubagent !== next.onOpenSubagent || prev.preformatted !== next.preformatted || prev.agentName !== next.agentName) return false;
  const a = prev.block;
  const b = next.block;
  if (a.type === 'item' && b.type === 'item') return a.item === b.item && a.tool === b.tool;
  if ((a.type === 'explore' && b.type === 'explore') || (a.type === 'group' && b.type === 'group')) return sameItems(a.items, b.items);
  if (a.type === 'subagent' && b.type === 'subagent') return a.info === b.info && a.tool === b.tool && sameItems(a.children, b.children);
  return false;
}

const Block = memo(function Block(props: BlockProps) {
  const { block, inlineSubagentId, onOpenSubagent } = props;
  if (block.type === 'subagent') return <SubagentCard block={block} onOpenInMap={onOpenSubagent} expansionKey={`${block.key}:subagent`} />;
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

function BlockBody(props: BlockProps) {
  const { block, turnNumber, capabilities, mcpServers, preformatted, agentName } = props;
  if (block.type === 'explore') return <ExploreGroup tools={block.tools} items={block.items} expansionKey={`${block.key}:run`} />;
  if (block.type === 'group') {
    // A row keeps its key inside the group, so its open state survives the group forming or splitting.
    return <ChatterGroup block={block} expansionKey={`${block.key}:run`} renderItem={(item) => <BlockBody {...props} block={{ type: 'item', key: item.id, item }} />} />;
  }
  if (block.type === 'subagent') return null;
  const item = block.item;
  switch (item.kind) {
    case 'user_message': return <UserMessage item={item} expansionKey={block.key} />;
    case 'agent_message': return <AgentMessage item={item} preformatted={preformatted} name={agentName} />;
    case 'thought': return <ThoughtRow item={item} />;
    case 'tool_call': return <ToolCallView tool={item} mcpServers={mcpServers} expansionKey={`${block.key}:tool`} />;
    case 'plan_document': return <PlanDocumentCard item={item} error={block.tool && toolErrorText(block.tool)} />;
    case 'question': return <QuestionRow item={item} error={block.tool && toolErrorText(block.tool)} />;
    case 'notice': return <NoticeRow item={item} />;
    case 'error': return <ErrorRow item={item} />;
    case 'turn_end': return <TurnFooter item={item} turnNumber={turnNumber} capabilities={capabilities} />;
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
  /** Saved conversations cannot invite the user to send a message. */
  emptyMessage?: string;
  /** The agent's name. Saved history leaves it out: the agent's record has it, while it exists. */
  agentName?: string;
}

function sameTranscriptShape(a: ChatViewState, b: ChatViewState): boolean {
  if (a.agentId !== b.agentId || a.sessionId !== b.sessionId || a.items.length !== b.items.length) return false;
  if (a.capabilities !== b.capabilities || a.subagents !== b.subagents || a.mcpServers !== b.mcpServers) return false;
  if (a.items.length === 0) return true;
  return a.items[0].id === b.items[0].id && a.items[a.items.length - 1].id === b.items[b.items.length - 1].id;
}

/** Coalesce repeated live updates without delaying the first or structural render. */
function useFrameState(state: ChatViewState): ChatViewState {
  const shown = useRef(state);
  const latest = useRef(state);
  const frame = useRef<number | null>(null);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  latest.current = state;
  if (!sameTranscriptShape(shown.current, state)) shown.current = state;

  useLayoutEffect(() => {
    if (state === shown.current) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      return;
    }
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        shown.current = latest.current;
        forceRender();
      });
    }
  }, [state]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  return shown.current;
}

function targetBlockIndex(blocks: StreamBlock[], subagentId: string): number {
  return blocks.findIndex((block) => (
    block.type === 'subagent'
      ? block.info.subagentId === subagentId
      : blockSubagentId(block) === subagentId
  ));
}

export function ChatStream(props: ChatStreamProps) {
  const state = useFrameState(props.state);
  return <ChatStreamInner key={`${state.agentId}:${state.sessionId ?? ''}`} {...props} state={state} />;
}

const ChatStreamInner = memo(function ChatStreamInner({
  state,
  onOpenSubagent,
  jump,
  onJumpResult,
  announce = true,
  emptyMessage = 'No messages yet. Send one to start.',
  onShowEarlier,
  agentName,
}: ChatStreamProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The reader's place: a row's key and how far its top sits below the viewport's. */
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const lastScrollTop = useRef(0);
  /** Where the viewport goes once a window move has mounted its rows. */
  const pendingScroll = useRef<{ edge: 'top' | 'bottom' } | { key: string } | null>(null);
  /** The stop Previous/Next last landed on, while the viewport stays there. */
  const navStop = useRef<{ key: string; scrollTop: number } | null>(null);
  const loggedSideways = useRef(false);
  const expansionStore = useMemo(() => createTranscriptExpansionStore(), []);
  const onJumpResultRef = useRef(onJumpResult);
  onJumpResultRef.current = onJumpResult;
  const { items, subagents, capabilities, commands } = state;
  const rich = useRichChatContent();
  // Tool calls whose permission request is still open (only those say "waiting for approval").
  const awaitingKey = state.pendingPermissions.map((p) => p.toolCallId ?? '').join('\n');
  const awaiting = useMemo(() => new Set(awaitingKey.split('\n').filter(Boolean)), [awaitingKey]);
  const blocks = useMemo(() => buildStreamBlocks({ items, subagents, capabilities }, { mediaVisible: rich, awaitingApproval: awaiting }), [items, subagents, capabilities, rich, awaiting]);
  const stops = useMemo(() => blocks.flatMap((b, i) => (isNavigationStop(b) ? [i] : [])), [blocks]);
  const commandOutput = useMemo(() => commandOutputIds(items, commands), [items, commands]);
  const storedName = useAgentStore((s) => s.agents[state.agentId]?.name);
  const shownName = agentName ?? storedName ?? 'Agent';
  const named = useMemo(() => agentMessagesToName(items), [items]);
  const [windowStart, setWindowStart] = useState(() => Math.max(0, blocks.length - CHAT_STREAM_WINDOW_SIZE));
  const [followTail, setFollowTail] = useState(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const tailStart = Math.max(0, blocks.length - CHAT_STREAM_WINDOW_SIZE);
  const start = followTail ? tailStart : Math.min(windowStart, tailStart);
  const end = Math.min(blocks.length, start + CHAT_STREAM_WINDOW_SIZE);
  const visibleBlocks = useMemo(() => blocks.slice(start, end), [blocks, start, end]);
  const atTail = end === blocks.length;
  const atTailRef = useRef(atTail);
  atTailRef.current = atTail;
  const turnNumbers = useMemo(() => {
    const m = new Map<string, number>();
    let n = 0;
    for (const item of items) {
      if (item.kind === 'turn_end') m.set(item.id, ++n);
    }
    return m;
  }, [items]);

  // Screen readers hear each reply once it's complete, not every streamed chunk.
  const announcement = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'agent_message' && !it.subagentId) return it.streaming ? '' : stripTaskMarker(it.text);
    }
    return '';
  }, [items]);

  const captureAnchor = useCallback(() => {
    const root = scroller.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLElement>('[data-block-key]');
    const first = firstVisibleIndex(root, rows);
    anchor.current = first < 0 ? null : {
      key: rows[first].dataset.blockKey!,
      top: rows[first].getBoundingClientRect().top - root.getBoundingClientRect().top,
    };
  }, []);

  const rowElement = (key: string) => scroller.current?.querySelector<HTMLElement>(`[data-block-key="${CSS.escape(key)}"]`) ?? null;

  /** Keeps the view where it belongs after anything changed its height, then says whether it's at the bottom. */
  const settle = useCallback(() => {
    const root = scroller.current;
    if (!root) return;
    if (pinned.current) {
      root.scrollTop = root.scrollHeight;
    } else if (anchor.current) {
      const row = rowElement(anchor.current.key);
      if (row) {
        const moved = row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.current.top;
        if (Math.abs(moved) >= 0.5) root.scrollTop += moved;
      }
    }
    lastScrollTop.current = root.scrollTop;
    const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
    // Content shrank under a paused reader (a card closed, the window grew): the true bottom always resumes.
    if (!pinned.current && distance <= MOVED_UP_PX && atTailRef.current) {
      pinned.current = true;
      setFollowTail(true);
    }
    setAwayFromBottom(!pinned.current || distance > STICK_THRESHOLD);
  }, []);

  // New rows, a slid window, a loaded history page.
  useLayoutEffect(() => {
    const root = scroller.current;
    const pending = pendingScroll.current;
    if (root && pending) {
      pendingScroll.current = null;
      if ('edge' in pending) {
        root.scrollTop = pending.edge === 'top' ? 0 : root.scrollHeight;
        captureAnchor();
      } else {
        const row = rowElement(pending.key);
        if (row) {
          scrollWithin(root, row, 'start');
          navStop.current = { key: pending.key, scrollTop: root.scrollTop };
          captureAnchor();
        }
      }
    }
    settle();
  }, [visibleBlocks, settle, captureAnchor]);

  // Heights that change without a new row: an opened card, a loaded image, a message still rendering.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(settle);
    observer.observe(el);
    return () => observer.disconnect();
  }, [settle]);

  // Keep the reader's row mounted as rows change, and keep a window that reached the tail attached to it.
  const previousTail = useRef({ length: blocks.length, end });
  useLayoutEffect(() => {
    const previous = previousTail.current;
    previousTail.current = { length: blocks.length, end };
    if (followTail) return;
    const index = anchor.current ? blocks.findIndex((b) => b.key === anchor.current!.key) : -1;
    if (index >= 0 && (index < start || index >= end)) {
      setWindowStart(Math.max(0, Math.min(index - Math.floor(CHAT_STREAM_WINDOW_SIZE / 2), tailStart)));
    } else if (blocks.length > previous.length && previous.end === previous.length && end < blocks.length && (index < 0 || index - tailStart >= WINDOW_OVERSCAN)) {
      setWindowStart(tailStart);
    }
  }, [blocks, followTail, start, end, tailStart]);

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

  const jumpRequest = useMemo(
    () => jump ? { subagentId: jump.subagentId, nonce: jump.nonce } : null,
    [jump?.subagentId, jump?.nonce],
  );
  const jumpTargetIndex = useMemo(
    () => jumpRequest ? targetBlockIndex(blocks, jumpRequest.subagentId) : -1,
    [blocks, jumpRequest],
  );
  const jumpTargetOutsideWindow = jumpTargetIndex >= 0 && (jumpTargetIndex < start || jumpTargetIndex >= end);
  const jumpWindowStart = jumpTargetOutsideWindow
    ? Math.max(0, Math.min(jumpTargetIndex - Math.floor(CHAT_STREAM_WINDOW_SIZE / 2), tailStart))
    : null;
  const jumpTargetStatus = jumpTargetIndex < 0 ? 'missing' : jumpTargetOutsideWindow ? 'outside' : 'visible';

  useEffect(() => {
    if (!jumpRequest) return;
    if (jumpTargetStatus === 'missing') {
      onJumpResultRef.current?.(jumpRequest, false);
      return;
    }
    if (jumpTargetStatus === 'outside') {
      pinned.current = false;
      // The reader is going elsewhere: don't let their old place pull the window back.
      anchor.current = null;
      setFollowTail(false);
      setWindowStart(jumpWindowStart!);
      return;
    }
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(jumpRequest.subagentId)}"]`);
    onJumpResultRef.current?.(jumpRequest, !!target);
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
  }, [jumpRequest, jumpTargetStatus, jumpWindowStart]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollLeft !== 0) {
      // The stream only scrolls vertically; anything that slides it sideways
      // hides the start of every line (#2292). Log what overflowed, once.
      if (!loggedSideways.current) {
        loggedSideways.current = true;
        rendererLog('app:chat', 'warn', 'Chat stream scrolled sideways; reset to the left edge', {
          meta: {
            scrollLeft: el.scrollLeft,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            provider: state.provider,
            block: overflowingBlock(el),
          },
        });
      }
      el.scrollLeft = 0;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const movedUp = el.scrollTop < lastScrollTop.current - MOVED_UP_PX;
    lastScrollTop.current = el.scrollTop;
    const atBottom = distance <= STICK_THRESHOLD && !(movedUp && distance > MOVED_UP_PX);
    // The bottom of a window that stops short of the tail isn't the bottom.
    const isPinned = atBottom && atTail;
    setAwayFromBottom(!isPinned);
    pinned.current = isPinned;
    if (navStop.current && Math.abs(el.scrollTop - navStop.current.scrollTop) > 2) navStop.current = null;
    if (!isPinned) captureAnchor();
    if (!isPinned && followTail) {
      setFollowTail(false);
      setWindowStart(start);
    } else if (isPinned && !followTail) {
      setFollowTail(true);
    }
  };

  /** Previous or next stop from the reader's place: `blocks` index, or -1 when there's nowhere further. */
  const stopFrom = (direction: -1 | 1): number => {
    const root = scroller.current;
    if (!root) return -1;
    const landed = navStop.current ? blocks.findIndex((b) => b.key === navStop.current!.key) : -1;
    let from = landed;
    let offset = 0;
    if (from < 0) {
      const rows = root.querySelectorAll<HTMLElement>('[data-block-key]');
      const first = firstVisibleIndex(root, rows);
      from = first < 0 ? end - 1 : start + first;
      if (first >= 0) offset = rows[first].getBoundingClientRect().top - root.getBoundingClientRect().top;
    }
    if (direction < 0) {
      // A stop partly scrolled past: Previous goes back to its top first.
      for (let i = stops.length - 1; i >= 0; i--) {
        if (stops[i] < from || (stops[i] === from && offset < -2)) return stops[i];
      }
      return -1;
    }
    return stops.find((s) => s > from || (s === from && offset > 2)) ?? -1;
  };

  const goToStop = (direction: -1 | 1) => {
    const index = stopFrom(direction);
    if (index < 0) return;
    const root = scroller.current;
    const key = blocks[index].key;
    pinned.current = false;
    setFollowTail(false);
    if (index < start || index >= end) {
      pendingScroll.current = { key };
      anchor.current = null;
      setWindowStart(Math.max(0, Math.min(index - Math.floor(CHAT_STREAM_WINDOW_SIZE / 2), tailStart)));
      return;
    }
    // Stop following without letting the window jump: it holds where it is.
    setWindowStart(start);
    const row = rowElement(key);
    if (!root || !row) return;
    scrollWithin(root, row, 'start');
    navStop.current = { key, scrollTop: root.scrollTop };
    lastScrollTop.current = root.scrollTop;
    captureAnchor();
    settle();
  };

  // The shortcut, for the one stream that announces: canvas cards and saved history keep their buttons.
  const goToStopRef = useRef(goToStop);
  goToStopRef.current = goToStop;
  useEffect(() => {
    if (!announce) return;
    const go = (direction: -1 | 1) => () => {
      if (!scroller.current?.closest('.hidden')) goToStopRef.current(direction);
    };
    const previous = go(-1);
    const next = go(1);
    window.addEventListener(PREVIOUS_AGENT_MESSAGE_EVENT, previous);
    window.addEventListener(NEXT_AGENT_MESSAGE_EVENT, next);
    return () => {
      window.removeEventListener(PREVIOUS_AGENT_MESSAGE_EVENT, previous);
      window.removeEventListener(NEXT_AGENT_MESSAGE_EVENT, next);
    };
  }, [announce]);

  // Older rows replace the window, so read on from where they meet the ones just left.
  const showOlder = () => {
    pinned.current = false;
    anchor.current = null;
    pendingScroll.current = { edge: 'bottom' };
    setFollowTail(false);
    setWindowStart(Math.max(0, start - CHAT_STREAM_WINDOW_SIZE));
  };

  const showLater = () => {
    const next = Math.min(tailStart, start + CHAT_STREAM_WINDOW_SIZE);
    pinned.current = false;
    anchor.current = null;
    pendingScroll.current = { edge: 'top' };
    setFollowTail(false);
    setWindowStart(next);
  };

  const showLatest = () => {
    pinned.current = true;
    navStop.current = null;
    setFollowTail(true);
    setWindowStart(tailStart);
    settle();
  };

  const showLatestButton = awayFromBottom || !atTail;

  return (
    <ChatMediaContext.Provider value={rich ? state.agentId : null}>
    <LiveTurnContext.Provider value={state.turnId}>
    <AwaitingApprovalContext.Provider value={awaiting}>
    <div className="relative flex-1 min-h-0 flex flex-col">
    <div ref={scroller} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-7 pt-5 pb-10" data-testid="chat-stream">
      <div ref={content} className="mx-auto w-full min-w-0 max-w-[740px] flex flex-col gap-2.5 min-h-full justify-end">
        {announce && <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-live-region">{announcement}</div>}
        {start > 0 && (
          <button
            type="button"
            onClick={showOlder}
            className="self-center h-7 px-3 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px]"
            data-testid="chat-window-older"
          >
            Show older messages
          </button>
        )}
        {start === 0 && onShowEarlier && (
          <button
            type="button"
            onClick={() => { pinned.current = false; captureAnchor(); onShowEarlier(); }}
            className="self-center h-7 px-3 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px]"
            data-testid="chat-show-earlier"
          >
            Show earlier
          </button>
        )}
        {blocks.length === 0 && (
          <div className="text-center text-[13px] text-ctp-overlay0 py-10">{emptyMessage}</div>
        )}
        <TranscriptExpansionProvider store={expansionStore}>
          <RichLinkProvider agentId={state.agentId}>
          <FileChipProvider agentId={rich ? state.agentId : null}>
            {visibleBlocks.map((b, index) => (
              <div key={b.key} data-testid="chat-stream-block" data-block-index={start + index} data-block-key={b.key}>
                <Block
                  block={b}
                  turnNumber={b.type === 'item' ? turnNumbers.get(b.item.id) ?? 0 : 0}
                  capabilities={capabilities}
                  mcpServers={state.mcpServers}
                  inlineSubagentId={inlineJumps.get(b.key)}
                  onOpenSubagent={onOpenSubagent}
                  preformatted={b.type === 'item' && commandOutput.has(b.item.id)}
                  agentName={b.type === 'item' && named.has(b.item.id) ? shownName : undefined}
                />
              </div>
            ))}
          </FileChipProvider>
          </RichLinkProvider>
        </TranscriptExpansionProvider>
        {!atTail && (
          <button
            type="button"
            onClick={showLater}
            className="self-center h-7 px-3 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px]"
            data-testid="chat-window-later"
          >
            Show later messages
          </button>
        )}
      </div>
    </div>
    {(stops.length > 1 || showLatestButton) && (
      <div className="absolute bottom-2 right-4 flex items-center gap-0.5 p-0.5 rounded-md bg-ctp-mantle border border-surface-0" role="group" aria-label="Move through the conversation" data-testid="chat-stream-nav">
        {stops.length > 1 && (
          <>
            <Tooltip content="Previous agent message" shortcutAction="chat-previous-message">
              <button type="button" onClick={() => goToStop(-1)} className={NAV_BUTTON} aria-label="Previous agent message" data-testid="chat-nav-previous"><ChevronUp /></button>
            </Tooltip>
            <Tooltip content="Next agent message" shortcutAction="chat-next-message">
              <button type="button" onClick={() => goToStop(1)} className={NAV_BUTTON} aria-label="Next agent message" data-testid="chat-nav-next"><ChevronDown /></button>
            </Tooltip>
          </>
        )}
        {showLatestButton && (
          <button type="button" onClick={showLatest} className={`${NAV_BUTTON} text-[12px]`} data-testid="chat-window-latest">Latest</button>
        )}
      </div>
    )}
    </div>
    </AwaitingApprovalContext.Provider>
    </LiveTurnContext.Provider>
    </ChatMediaContext.Provider>
  );
});
