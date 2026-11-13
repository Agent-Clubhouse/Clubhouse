/**
 * The app-level event bus (#2950): an always-on main-process bus of what
 * agents, repos and the app do. Actions (#2918) subscribe to it, and other
 * features can too. Unlike the Annex bus it runs whether or not Annex does.
 *
 * Publishers call the typed helpers below from the one place each fact is
 * known (agent start, agent exit, config create and delete, chat events,
 * terminal hooks, the git watcher). The bus imports none of its consumers.
 */

import type { HookEventKind, QuickAgentOwner, TurnOutcome } from '../../shared/types';
import type { ChatEvent, TurnStopReason } from '../../shared/chat';
import { COMPACTION_SETTLED } from '../../shared/chat';

export type { TurnOutcome } from '../../shared/types';

/** Where a turn event came from: chat, terminal hooks, or a headless run. */
export type TurnVia = 'chat' | 'hook' | 'headless';

export interface DevicePresence {
  id: string;
  name: string;
  kind: 'computer' | 'phone';
}

interface Stamp {
  /** Epoch ms when it was published. */
  at: number;
  /**
   * Ids of the actions whose steps led to this event, oldest first. Set by
   * the publisher when it knows (see setAgentChain); empty otherwise.
   */
  chain?: string[];
}

export type AppEvent = Stamp & (
  | { type: 'agent.awake'; agentId: string }
  | { type: 'agent.asleep'; agentId: string; exitCode?: number }
  | { type: 'agent.created'; agentId: string; projectPath: string; name?: string; parentAgentId?: string }
  | { type: 'agent.deleted'; agentId: string; projectPath: string; name?: string; parentAgentId?: string }
  | { type: 'turn.started'; agentId: string; via: TurnVia }
  | { type: 'turn.ended'; agentId: string; via: TurnVia; outcome: TurnOutcome }
  | { type: 'agent.waiting'; agentId: string; via: TurnVia; reason: 'permission' | 'question' }
  | { type: 'agent.error'; agentId: string; via: TurnVia; message: string }
  | { type: 'agent.compacted'; agentId: string }
  | { type: 'agent.quick_finished'; agentId: string; name: string; owner: QuickAgentOwner; parentAgentId?: string; projectPath: string; durationMs: number; outcome: 'completed' | 'failed' | 'cancelled' }
  | { type: 'helper.finished'; agentId: string; parentAgentId: string; projectPath: string }
  | { type: 'group_project.message_posted'; groupProjectId: string; topic: string }
  | { type: 'group_project.member_joined' | 'group_project.member_left'; groupProjectId: string; memberAddress: string }
  | { type: 'git.commit'; repoPath: string; branch: string; agentId?: string }
  | { type: 'git.branch_switched'; repoPath: string; branch: string; previousBranch?: string; agentId?: string }
  | { type: 'git.remote_updated'; repoPath: string; branch: string; remote: string; agentId?: string }
  | { type: 'app.started' }
  | { type: 'actions.changed' }
  | { type: 'device.online'; device: DevicePresence }
  | { type: 'device.offline'; device: DevicePresence }
  /** Only qualifying subscriptions, never absence timestamps or duration. */
  | { type: 'app.returned'; actionIds: string[] }
  | { type: 'project.added'; projectId: string; projectPath: string }
  | { type: 'project.removed'; projectId: string; projectPath: string }
);

export type AppEventType = AppEvent['type'];
export type AppEventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>;

/** An event without its stamp, as publishers pass it. */
type Unstamped<E> = E extends unknown ? Omit<E, 'at'> & { at?: number } : never;
export type AppEventInput = Unstamped<AppEvent>;

export type AppEventListener = (event: AppEvent) => void;

const listeners = new Set<AppEventListener>();

/** Subscribe to every event. Returns the unsubscribe. */
export function onAppEvent(listener: AppEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Publish an event. A failing listener never breaks the publisher or other listeners. */
export function publishAppEvent(input: AppEventInput): void {
  const agentId = 'agentId' in input ? input.agentId : undefined;
  const chain = input.chain ?? (agentId ? currentAgentChain(agentId, input.at ?? Date.now()) : undefined);
  const event = { ...input, at: input.at ?? Date.now(), ...(chain?.length ? { chain } : {}) } as AppEvent;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // telemetry-exempt: a failing consumer must not break the publisher or the others.
    }
  }
}

// ── Chains ──────────────────────────────────────────────────────────────────

/**
 * How long an agent's events count as caused by the action that just woke,
 * messaged or started it. Long enough to cover the turn it started.
 */
export const CHAIN_WINDOW_MS = 30 * 60 * 1000;

const agentChains = new Map<string, { chain: string[]; until: number }>();

/**
 * Mark an agent's next events as caused by these actions (for loop
 * protection). Quick launches use runScoped until their final event.
 */
export function setAgentChain(agentId: string, chain: string[], now = Date.now(), runScoped = false): void {
  agentChains.set(agentId, { chain: [...chain], until: runScoped ? Infinity : now + CHAIN_WINDOW_MS });
}

function currentAgentChain(agentId: string, now: number): string[] | undefined {
  const entry = agentChains.get(agentId);
  if (!entry) return undefined;
  if (entry.until < now) {
    agentChains.delete(agentId);
    return undefined;
  }
  return entry.chain;
}

/** Forget an agent's chain, e.g. when the person sends it a message of their own. */
export function clearAgentChain(agentId: string): void {
  agentChains.delete(agentId);
}

// ── Normalizers ─────────────────────────────────────────────────────────────

/** Notice codes that mean a compaction finished (not failed or cancelled). */
const COMPACTION_DONE_CODES: readonly string[] = COMPACTION_SETTLED.filter((c) => c !== 'compaction_failed' && c !== 'compaction_cancelled');

export function turnOutcomeFromStopReason(reason: TurnStopReason): TurnOutcome {
  if (reason === 'cancelled') return 'interrupted';
  if (reason === 'error' || reason === 'refusal' || reason === 'timeout') return 'failed';
  return 'completed';
}

/** Turn a chat event into bus events. Most chat events publish nothing. */
export function publishFromChatEvent(event: ChatEvent): void {
  const agentId = event.agentId;
  switch (event.type) {
    case 'turn_started':
      publishAppEvent({ type: 'turn.started', agentId, via: 'chat' });
      return;
    case 'turn_ended':
      publishAppEvent({ type: 'turn.ended', agentId, via: 'chat', outcome: turnOutcomeFromStopReason(event.data.stopReason) });
      return;
    case 'permission_request':
      publishAppEvent({ type: 'agent.waiting', agentId, via: 'chat', reason: 'permission' });
      return;
    case 'question':
      publishAppEvent({ type: 'agent.waiting', agentId, via: 'chat', reason: 'question' });
      return;
    case 'error':
      // A retried error isn't the agent hitting one yet.
      if (!event.data.willRetry) publishAppEvent({ type: 'agent.error', agentId, via: 'chat', message: event.data.message });
      return;
    case 'notice':
      if (COMPACTION_DONE_CODES.includes(event.data.code)) {
        publishAppEvent({ type: 'agent.compacted', agentId });
      }
      return;
    case 'user_message':
      // The person (or a phone) talking to the agent ends any action chain on it.
      if (event.data.source === 'user' || event.data.source === 'annex') clearAgentChain(agentId);
      return;
    default:
      return;
  }
}

/** Terminal agents whose turn is under way, as far as their hooks tell, and when they last reported. */
const hookTurns = new Map<string, { lastAt: number; ended: boolean; turnId?: string }>();

/** Copilot's stop hook has no turn ID; only a new prompt re-arms completion. */
const completedCopilotHookTurns = new Set<string>();
export interface HeadlessTurn {
  agentId: string;
  ended: boolean;
  chain?: string[];
  outcome?: TurnOutcome;
}

const headlessTurns = new Map<string, HeadlessTurn>();

/** One headless process is one turn. Its finalizer, not its hooks, owns the end. */
export function startHeadlessTurn(agentId: string): HeadlessTurn {
  const previous = headlessTurns.get(agentId);
  if (previous) finishHeadlessTurn(previous, 'interrupted');
  const turn: HeadlessTurn = { agentId, ended: false, chain: currentAgentChain(agentId, Date.now()) };
  headlessTurns.set(agentId, turn);
  hookTurns.set(agentId, { lastAt: Date.now(), ended: false });
  publishAppEvent({ type: 'turn.started', agentId, via: 'headless', chain: turn.chain });
  return turn;
}

export function finishHeadlessTurn(turn: HeadlessTurn, outcome: TurnOutcome, errorCategory?: string): void {
  if (turn.ended) return;
  turn.ended = true;
  publishAppEvent({ type: 'turn.ended', agentId: turn.agentId, via: 'headless', outcome, chain: turn.chain });
  if (outcome === 'failed' && errorCategory) {
    publishAppEvent({ type: 'agent.error', agentId: turn.agentId, via: 'headless', message: errorCategory, chain: turn.chain });
  }
}

/**
 * A turn that has said nothing for this long is treated as over: Claude runs
 * no interruption hook when the person interrupts a turn. Silence alone is
 * not evidence of an interrupted outcome, so this only resets start detection.
 */
const HOOK_TURN_STALE_MS = 5 * 60 * 1000;

/** Raw hook names that mean the person (or Clubhouse) sent a prompt. */
const PROMPT_HOOKS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'userPromptSubmitted']);
/** Raw hook names that mean a turn finished. Copilot's sessionEnd is the process ending, not a turn. */
const TURN_END_HOOKS: ReadonlySet<string> = new Set(['Stop', 'StopFailure', 'Interrupt', 'agentStop']);
/** Tools that put a question to the person. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

export interface HookFacts {
  /** The normalized kind. */
  kind: HookEventKind;
  /** The CLI's own hook name (e.g. Stop, UserPromptSubmit, sessionEnd). */
  rawName?: string;
  toolName?: string;
  turnId?: string;
  outcome?: TurnOutcome;
  message?: string;
}

function startHookTurn(agentId: string, at: number, turnId?: string): void {
  hookTurns.set(agentId, { lastAt: at, ended: false, turnId });
  publishAppEvent({ type: 'turn.started', agentId, via: 'hook', at });
}

/**
 * Turn a terminal CLI hook into bus events. Terminal coverage is what the
 * CLIs' hooks allow:
 * - a turn starts at a prompt hook, or at the first tool without one;
 * - it ends at Stop, StopFailure (Claude), Interrupt (Codex) or agentStop (Copilot);
 * - waiting on you is a permission request, or a question tool;
 * - tool failures are not "hits an error" (a failed grep is routine), and
 *   session start and notification hooks publish nothing.
 */
export function publishFromHookEvent(agentId: string, facts: HookFacts, now = Date.now()): void {
  const { kind, rawName, toolName, turnId } = facts;
  const headless = headlessTurns.get(agentId);
  if (headless) {
    if (headless.ended) return;
    if (kind === 'stop') {
      const outcome = facts.outcome ?? (rawName === 'StopFailure' ? 'failed' : rawName === 'Interrupt' ? 'interrupted' : undefined);
      if (outcome && headless.outcome !== 'failed') headless.outcome = outcome;
    } else if (kind === 'permission_request' || (kind === 'pre_tool' && toolName && QUESTION_TOOLS.has(toolName))) {
      publishAppEvent({ type: 'agent.waiting', agentId, via: 'headless', reason: kind === 'permission_request' ? 'permission' : 'question', at: now });
    } else if (rawName === 'PostCompact') {
      publishAppEvent({ type: 'agent.compacted', agentId, at: now });
    }
    return;
  }
  const turn = hookTurns.get(agentId);
  if (rawName && PROMPT_HOOKS.has(rawName)) {
    if (turnId && turn?.turnId === turnId) return;
    if (rawName === 'userPromptSubmitted') completedCopilotHookTurns.delete(agentId);
    startHookTurn(agentId, now, turnId);
    return;
  }
  if (rawName === 'PostCompact') {
    publishAppEvent({ type: 'agent.compacted', agentId, at: now });
    return;
  }
  switch (kind) {
    case 'pre_tool':
    case 'post_tool': {
      if (completedCopilotHookTurns.has(agentId)) return;
      if (turnId && turn?.turnId) {
        if (turnId === turn.turnId && turn.ended) return;
        if (turnId !== turn.turnId) return;
      }
      if (!turn || turn.ended || now - turn.lastAt > HOOK_TURN_STALE_MS) startHookTurn(agentId, now, turnId);
      else turn.lastAt = now;
      if (kind === 'pre_tool' && toolName && QUESTION_TOOLS.has(toolName)) {
        publishAppEvent({ type: 'agent.waiting', agentId, via: 'hook', reason: 'question', at: now });
      }
      return;
    }
    case 'stop':
      if (rawName && !TURN_END_HOOKS.has(rawName)) return;
      if (turnId && turn?.turnId && turnId !== turn.turnId) return;
      // The first explicit end wins; a later failure cannot revise a published completion.
      if (turn?.ended) return;
      if (rawName === 'agentStop') {
        if (completedCopilotHookTurns.has(agentId)) return;
        completedCopilotHookTurns.add(agentId);
      }
      hookTurns.set(agentId, { lastAt: now, ended: true, turnId: turnId ?? turn?.turnId });
      {
        const outcome = facts.outcome ?? (rawName === 'Interrupt' ? 'interrupted' : rawName === 'StopFailure' ? 'failed' : 'completed');
        publishAppEvent({ type: 'turn.ended', agentId, via: 'hook', outcome, at: now });
        if (outcome === 'failed' && facts.message) {
          publishAppEvent({ type: 'agent.error', agentId, via: 'hook', message: facts.message, at: now });
        }
      }
      return;
    case 'permission_request':
      publishAppEvent({ type: 'agent.waiting', agentId, via: 'hook', reason: 'permission', at: now });
      return;
    default:
      return;
  }
}

/** An agent's process ended: its terminal turn state goes with it. */
export function forgetHookTurn(agentId: string): void {
  hookTurns.delete(agentId);
  completedCopilotHookTurns.delete(agentId);
  headlessTurns.delete(agentId);
}

/** For tests. */
export function resetAppEventBus(): void {
  listeners.clear();
  agentChains.clear();
  hookTurns.clear();
  completedCopilotHookTurns.clear();
  headlessTurns.clear();
}
