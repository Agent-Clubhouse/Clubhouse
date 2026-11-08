import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ChatCapabilities, ChatMcpServer } from '../../../../shared/chat';
import type { ChatViewState } from '../../../stores/chatStore';
import { stripTaskMarker } from '../../../../shared/chat';
import { useAgentStore } from '../../../stores/agentStore';
import { agentMessagesToName, buildStreamBlocks, commandOutputIds, isNavigationStop, toolErrorText, type StreamBlock } from './view-model';
import { firstVisibleIndex, measureScroll, movedAScreen, scrollLogLimiter, scrollWithin, unexplainedMoveCause, type ScrollMeasure, type ScrollMoveCause } from './scroll';
import { Tooltip } from '../../../components/Tooltip';
import { NEXT_AGENT_MESSAGE_EVENT, PREVIOUS_AGENT_MESSAGE_EVENT } from '../../../stores/keyboardShortcutsStore';
import { RichLinkProvider } from './rich/RichLinks';
import { useRichChatContent } from './rich/rich-flag';
import { ChatMediaContext } from './rich/ChatImages';
import { FileChipProvider } from './rich/FileChips';
import { useRemoteChat } from './remote-chat';
import { rendererLog } from '../../../plugins/renderer-logger';
import { fnv1a } from '../../../../shared/telemetry/diag';
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
/** How long after the reader's input a moving scrollTop still counts as theirs: the browser moves it a frame or an animation later. */
const USER_SCROLL_MS = 400;
/** Lines each stream may log a minute about following and large moves. */
const SCROLL_LOG_PER_MINUTE = 12;

const SCROLL_KEYS_UP = new Set(['ArrowUp', 'PageUp', 'Home']);
const SCROLL_KEYS_DOWN = new Set(['ArrowDown', 'PageDown', 'End', ' ']);

/** Which way a key would scroll the stream, or null when it wouldn't. Typing in a field moves its caret instead. */
function keyScrollDirection(e: KeyboardEvent): 'up' | 'down' | null {
  // Tab scrolls to wherever focus lands, which can be above the view.
  if (e.key === 'Tab') return 'up';
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .xterm')) return null;
  if (SCROLL_KEYS_UP.has(e.key) || (e.key === ' ' && e.shiftKey)) return 'up';
  return SCROLL_KEYS_DOWN.has(e.key) ? 'down' : null;
}

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
  /** Bump to go back to the bottom and follow it: sending a message does. */
  latestRequest?: number;
  /** Saved conversations cannot invite the user to send a message. */
  emptyMessage?: string;
  /** The agent's name. Saved history leaves it out: the agent's record has it, while it exists. */
  agentName?: string;
  /** The Dispatcher's group chat (#3043): agents' interjections stay separate rows. */
  groupChat?: boolean;
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
  latestRequest = 0,
  emptyMessage = 'No messages yet. Send one to start.',
  onShowEarlier,
  agentName,
  groupChat = false,
}: ChatStreamProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The reader's place: a row's key and how far its top sits below the viewport's. */
  const anchor = useRef<{ key: string; top: number } | null>(null);
  /** Where the view last was, to tell what moved it since. */
  const measured = useRef<ScrollMeasure>({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, start: 0 });
  /** The reader's last input that scrolls. Only this stops a pinned view following (#2748). */
  const userInput = useRef<{ kind: string; up: boolean; at: number } | null>(null);
  const pointerHeld = useRef(false);
  const scrollLogAllowed = useMemo(() => scrollLogLimiter(SCROLL_LOG_PER_MINUTE), []);
  /** Where the viewport goes once a window move has mounted its rows. */
  const pendingScroll = useRef<{ edge: 'top' | 'bottom' } | { key: string } | null>(null);
  /** The stop Previous/Next last landed on, while the viewport stays there. */
  const navStop = useRef<{ key: string; scrollTop: number } | null>(null);
  const loggedSideways = useRef(false);
  const expansionStore = useMemo(() => createTranscriptExpansionStore(), []);
  const onJumpResultRef = useRef(onJumpResult);
  onJumpResultRef.current = onJumpResult;
  const { items, subagents, capabilities, commands } = state;
  // Rich content reads files and media by path on this machine: not for an agent on another desktop (#2390).
  const remoteChat = useRemoteChat();
  const rich = useRichChatContent() && !remoteChat;
  // Tool calls whose permission request is still open (only those say "waiting for approval").
  const awaitingKey = state.pendingPermissions.map((p) => p.toolCallId ?? '').join('\n');
  const awaiting = useMemo(() => new Set(awaitingKey.split('\n').filter(Boolean)), [awaitingKey]);
  const blocks = useMemo(() => buildStreamBlocks({ items, subagents, capabilities }, { mediaVisible: rich, awaitingApproval: awaiting, groupChat }), [items, subagents, capabilities, rich, awaiting, groupChat]);
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
  const viewRef = useRef({ blocks, start, end, followTail });
  viewRef.current = { blocks, start, end, followTail };
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

  const noteUserInput = useCallback((kind: string, up: boolean) => {
    userInput.current = { kind, up, at: Date.now() };
  }, []);

  /** Whether the reader just scrolled (or is dragging): `up` asks for a scroll that can leave the bottom. */
  const userScrolling = useCallback((direction?: 'up') => {
    if (pointerHeld.current) return true;
    const input = userInput.current;
    return !!input && (direction !== 'up' || input.up) && Date.now() - input.at < USER_SCROLL_MS;
  }, []);

  /** Local diagnostics only (`app:chat`): sizes and positions, and a hash of the anchor row's key, never its text. */
  const logScroll = useCallback((level: 'info' | 'warn', msg: string, meta: Record<string, unknown>) => {
    const suppressed = scrollLogAllowed(Date.now());
    if (suppressed === null) return;
    const { blocks: all, start: first, end: last, followTail: following } = viewRef.current;
    const key = anchor.current?.key;
    rendererLog('app:chat', level, msg, {
      meta: {
        ...meta,
        start: first,
        end: last,
        blocks: all.length,
        followTail: following,
        pinned: pinned.current,
        anchorIndex: key === undefined ? null : all.findIndex((b) => b.key === key),
        anchorHash: key === undefined ? null : fnv1a(key),
        ...(suppressed > 0 && { suppressed }),
      },
    });
  }, [scrollLogAllowed]);

  const logMove = useCallback((cause: ScrollMoveCause, before: ScrollMeasure, after: ScrollMeasure) => {
    logScroll('warn', 'Chat view moved more than a screen without a user scroll', { cause, before, after });
  }, [logScroll]);

  /** Stops following, for a reason the reader chose. Their place is saved by whoever moves them. */
  const leaveBottom = useCallback((why: string) => {
    if (pinned.current) logScroll('info', 'Chat stopped following the bottom', { why });
    pinned.current = false;
  }, [logScroll]);

  /** At the bottom there is no place to go back to: everything saved about one goes. */
  const resumeFollowing = useCallback((why: string) => {
    const wasPinned = pinned.current;
    pinned.current = true;
    anchor.current = null;
    pendingScroll.current = null;
    userInput.current = null;
    setFollowTail(true);
    if (!wasPinned) logScroll('info', 'Chat resumed following the bottom', { why });
  }, [logScroll]);

  const rowElement = (key: string) => scroller.current?.querySelector<HTMLElement>(`[data-block-key="${CSS.escape(key)}"]`) ?? null;

  /** Keeps the view where it belongs after anything changed its height, then says whether it's at the bottom. */
  const settle = useCallback(() => {
    const root = scroller.current;
    // Hidden, every size reads 0: nothing can be kept, and a paused reader isn't at the bottom. Showing it settles again.
    if (!root || root.clientHeight === 0) return;
    const { start: first } = viewRef.current;
    const before = measured.current;
    if (pinned.current) {
      const found = measureScroll(root, first);
      const fell = before.scrollTop - found.scrollTop;
      // The reader moved up and its scroll event hasn't fired yet: don't snap them back. onScroll takes it from here.
      if (fell > MOVED_UP_PX && found.scrollHeight - found.scrollTop - found.clientHeight > MOVED_UP_PX && userScrolling('up')) {
        leaveBottom(userInput.current?.kind ?? 'pointer');
        captureAnchor();
        return;
      }
      // Nobody scrolled: a shrink, a clamp or the window moved it. A pinned view goes back.
      if (fell >= found.clientHeight) logMove(unexplainedMoveCause(before, found), before, found);
      root.scrollTop = root.scrollHeight;
    } else if (anchor.current) {
      const row = rowElement(anchor.current.key);
      if (row) {
        const moved = row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.current.top;
        if (Math.abs(moved) >= 0.5) {
          root.scrollTop += moved;
          if (Math.abs(moved) >= root.clientHeight) logMove('anchor-restore', before, measureScroll(root, first));
        }
      }
    }
    measured.current = measureScroll(root, first);
    const distance = root.scrollHeight - root.scrollTop - root.clientHeight;
    // Content shrank under a paused reader (a card closed, the window grew): the true bottom always resumes.
    if (!pinned.current && distance <= MOVED_UP_PX && atTailRef.current) resumeFollowing('content-shrank');
    setAwayFromBottom(!pinned.current || distance > STICK_THRESHOLD);
  }, [captureAnchor, leaveBottom, logMove, resumeFollowing, userScrolling]);

  // New rows, a slid window, a loaded history page.
  useLayoutEffect(() => {
    const root = scroller.current;
    const pending = pendingScroll.current;
    if (root && pending) {
      pendingScroll.current = null;
      const before = measured.current;
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
      const after = measureScroll(root, viewRef.current.start);
      if (movedAScreen(before, after)) logMove('pending-scroll', before, after);
    }
    settle();
  }, [visibleBlocks, settle, captureAnchor, logMove]);

  // Heights that change without a new row: an opened card, a loaded image, a message still rendering.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(settle);
    observer.observe(el);
    // The dock below it grows and shrinks the view without changing the rows.
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [settle]);

  // What the reader does to scroll, as opposed to anything else that moves the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const direction = keyScrollDirection(e);
      if (direction) noteUserInput('key', direction === 'up');
    };
    const onRelease = (e: Event) => {
      // A scrollbar can swallow the release, so a move with no button down ends the drag too.
      if (pointerHeld.current && (e.type !== 'pointermove' || (e as PointerEvent).buttons === 0)) pointerHeld.current = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerup', onRelease, true);
    window.addEventListener('pointercancel', onRelease, true);
    window.addEventListener('pointermove', onRelease, true);
    window.addEventListener('blur', onRelease);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
      window.removeEventListener('pointermove', onRelease, true);
      window.removeEventListener('blur', onRelease);
    };
  }, [noteUserInput]);

  // Keep the reader's row mounted as rows change, and keep a window that reached the tail attached to it.
  const previousTail = useRef({ length: blocks.length, end });
  useLayoutEffect(() => {
    const previous = previousTail.current;
    previousTail.current = { length: blocks.length, end };
    // A pinned reader has no row to keep, so the window never re-centers for them.
    if (followTail || pinned.current) return;
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
      leaveBottom('jump');
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
    leaveBottom('jump');
    noteUserInput('jump', false);
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
  }, [jumpRequest, jumpTargetStatus, jumpWindowStart, leaveBottom, noteUserInput]);

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
    const before = measured.current;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const movedUp = el.scrollTop < before.scrollTop - MOVED_UP_PX;
    const leaving = movedUp && distance > MOVED_UP_PX && userScrolling('up');
    if (pinned.current && !leaving) {
      // Following, and the reader didn't move it: back to the bottom.
      settle();
    } else {
      const after = measureScroll(el, start);
      if (!pinned.current && !userScrolling() && movedAScreen(before, after)) logMove(unexplainedMoveCause(before, after), before, after);
      const atBottom = distance <= STICK_THRESHOLD && !(movedUp && distance > MOVED_UP_PX);
      // The bottom of a window that stops short of the tail isn't the bottom.
      const isPinned = atBottom && atTail;
      measured.current = after;
      setAwayFromBottom(!isPinned);
      if (isPinned) {
        resumeFollowing('reached-bottom');
      } else {
        leaveBottom(userInput.current?.kind ?? 'pointer');
        captureAnchor();
        if (followTail) {
          setFollowTail(false);
          setWindowStart(start);
        }
      }
    }
    // A long fling or an animated scroll goes on after its input.
    if (userInput.current && userScrolling() && (movedUp || !pinned.current)) userInput.current.at = Date.now();
    if (navStop.current && Math.abs(el.scrollTop - navStop.current.scrollTop) > 2) navStop.current = null;
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
    leaveBottom('previous-next');
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
    measured.current = measureScroll(root, start);
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
    leaveBottom('show-older');
    anchor.current = null;
    pendingScroll.current = { edge: 'bottom' };
    setFollowTail(false);
    setWindowStart(Math.max(0, start - CHAT_STREAM_WINDOW_SIZE));
  };

  const showLater = () => {
    const next = Math.min(tailStart, start + CHAT_STREAM_WINDOW_SIZE);
    leaveBottom('show-later');
    anchor.current = null;
    pendingScroll.current = { edge: 'top' };
    setFollowTail(false);
    setWindowStart(next);
  };

  const showLatest = (why: string) => {
    navStop.current = null;
    resumeFollowing(why);
    setWindowStart(tailStart);
    settle();
  };

  const showLatestRef = useRef(showLatest);
  showLatestRef.current = showLatest;
  useLayoutEffect(() => {
    if (latestRequest) showLatestRef.current('send');
  }, [latestRequest]);

  const showLatestButton = awayFromBottom || !atTail;

  return (
    <ChatMediaContext.Provider value={rich ? state.agentId : null}>
    <LiveTurnContext.Provider value={state.turnId}>
    <AwaitingApprovalContext.Provider value={awaiting}>
    <div className="relative flex-1 min-h-0 flex flex-col">
    <div
      ref={scroller}
      onScroll={onScroll}
      onWheel={(e) => { if (e.deltaY !== 0) noteUserInput('wheel', e.deltaY < 0); }}
      onTouchMove={() => noteUserInput('touch', true)}
      onPointerDown={() => { pointerHeld.current = true; noteUserInput('pointer', true); }}
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-7 pt-5 pb-10" data-testid="chat-stream">
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
            onClick={() => { leaveBottom('show-earlier'); captureAnchor(); onShowEarlier(); }}
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
          <button type="button" onClick={() => showLatest('latest')} className={`${NAV_BUTTON} text-[12px]`} data-testid="chat-window-latest">Latest</button>
        )}
      </div>
    )}
    </div>
    </AwaitingApprovalContext.Provider>
    </LiveTurnContext.Provider>
    </ChatMediaContext.Provider>
  );
});
