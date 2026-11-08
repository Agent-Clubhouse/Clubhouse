/**
 * The app-level event bus (#2950): an always-on main-process bus of what
 * agents, repos and the app do. Actions (#2918) subscribe to it, and other
 * features can too. Unlike the Annex bus it runs whether or not Annex does.
 *
 * Publishers call the typed helpers below from the one place each fact is
 * known (agent start, agent exit, config create and delete, chat events,
 * terminal hooks, the git watcher). The bus imports none of its consumers.
 */

import type { HookEventKind } from '../../shared/types';
import type { ChatEvent, TurnStopReason } from '../../shared/chat';
import { COMPACTION_SETTLED } from '../../shared/chat';

export type TurnOutcome = 'completed' | 'failed' | 'interrupted';

/** Where a turn event came from: a chat runtime, or a terminal CLI's hooks. */
export type TurnVia = 'chat' | 'hook';

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
  | { type: 'helper.finished'; agentId: string; parentAgentId: string; projectPath: string }
  | { type: 'git.commit'; repoPath: string; branch: string; agentId?: string }
  | { type: 'git.branch_switched'; repoPath: string; branch: string; previousBranch?: string; agentId?: string }
  | { type: 'git.remote_updated'; repoPath: string; branch: string; remote: string; agentId?: string }
  | { type: 'app.started' }
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
 * protection). Called by Actions when a step acts on the agent.
 */
export function setAgentChain(agentId: string, chain: string[], now = Date.now()): void {
  agentChains.set(agentId, { chain: [...chain], until: now + CHAIN_WINDOW_MS });
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
const hookTurns = new Map<string, number>();

/**
 * A turn that has said nothing for this long is treated as over: Claude runs
 * no Stop hook when the person interrupts a turn.
 */
const HOOK_TURN_STALE_MS = 5 * 60 * 1000;

/** Raw hook names that mean the person (or Clubhouse) sent a prompt. */
const PROMPT_HOOKS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'userPromptSubmitted']);
/** Raw hook names that mean a turn finished. Copilot's sessionEnd is the process ending, not a turn. */
const TURN_END_HOOKS: ReadonlySet<string> = new Set(['Stop']);
/** Tools that put a question to the person. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

export interface HookFacts {
  /** The normalized kind. */
  kind: HookEventKind;
  /** The CLI's own hook name (e.g. Stop, UserPromptSubmit, sessionEnd). */
  rawName?: string;
  toolName?: string;
}

function startHookTurn(agentId: string, at: number): void {
  hookTurns.set(agentId, at);
  publishAppEvent({ type: 'turn.started', agentId, via: 'hook', at });
}

/**
 * Turn a terminal CLI hook into bus events. Terminal coverage is what the
 * CLIs' hooks allow:
 * - a turn starts at a prompt hook, or at the first tool when the CLI has no
 *   prompt hook registered (Claude);
 * - it ends at a Stop hook (Claude, Codex); Copilot has none per turn;
 * - waiting on you is a permission request, or a question tool;
 * - tool failures are not "hits an error" (a failed grep is routine), and
 *   session start and notification hooks publish nothing.
 */
export function publishFromHookEvent(agentId: string, facts: HookFacts, now = Date.now()): void {
  const { kind, rawName, toolName } = facts;
  if (rawName && PROMPT_HOOKS.has(rawName)) {
    startHookTurn(agentId, now);
    return;
  }
  switch (kind) {
    case 'pre_tool':
    case 'post_tool': {
      const last = hookTurns.get(agentId);
      if (last === undefined || now - last > HOOK_TURN_STALE_MS) startHookTurn(agentId, now);
      else hookTurns.set(agentId, now);
      if (kind === 'pre_tool' && toolName && QUESTION_TOOLS.has(toolName)) {
        publishAppEvent({ type: 'agent.waiting', agentId, via: 'hook', reason: 'question', at: now });
      }
      return;
    }
    case 'stop':
      if (rawName && !TURN_END_HOOKS.has(rawName)) return;
      hookTurns.delete(agentId);
      publishAppEvent({ type: 'turn.ended', agentId, via: 'hook', outcome: 'completed', at: now });
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
}

/** For tests. */
export function resetAppEventBus(): void {
  listeners.clear();
  agentChains.clear();
  hookTurns.clear();
}
