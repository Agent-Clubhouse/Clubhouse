/**
 * The Dispatcher's usage, split into conversations and background work
 * (#3040). Counted from the chat events of its two agents: each finished turn
 * adds what the provider reported to today's totals.
 *
 * A turn is background work when a background delivery was noted for that
 * agent just before it started: Clubhouse's hidden upkeep and check-ins, and
 * the Actions the Dispatcher set up for itself, note one when they message it
 * (actions/index.ts). Every other turn, the user's chat and the work it hands
 * over, is a conversation.
 *
 * Totals are kept per local day in `dispatcher-usage.json` beside the
 * Dispatcher's folders, for the last USAGE_KEEP_DAYS days, saved after each turn. Settings and
 * telemetry read them with getDispatcherUsageSplit. A Dispatcher running in a
 * terminal publishes no chat events, so it counts nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ChatEvent, TokenUsage } from '../../../shared/chat';
import { emptyUsageSplit, type DispatcherUsageKind, type DispatcherUsageSplit, type DispatcherUsageTotals } from '../../../shared/dispatcher-usage';
import { onChatEvent } from '../agent-runtime/chat-event-bus';
import { getBaseDirPath } from '../base-dir';
import { appLog } from '../log-service';
import { writeFileAtomic } from './dispatcher-memory';
import { isDispatcherIdentityAgentId } from './dispatcher-service';
import { dayKey } from './dispatcher-memory-timeline';

/** Days of totals kept on disk. */
export const USAGE_KEEP_DAYS = 31;

/** A background delivery marks the agent's next turn, if it starts within this long. */
export const BACKGROUND_MARK_MS = 10 * 60 * 1000;

interface OpenTurn {
  kind: DispatcherUsageKind;
  tokens?: TokenUsage;
  costUsd?: number;
  costIsEstimate?: boolean;
}

interface Deps {
  isDispatcherAgent(agentId: string): boolean;
  file(): string;
  now(): number;
}

let deps: Deps | null = null;
let days = new Map<string, DispatcherUsageSplit>();
let loaded = false;
const pendingBackground = new Map<string, number>();
const openTurns = new Map<string, OpenTurn>();
/** Saves run one after another; a turn that ends while one is going is in the next. */
let saving: Promise<void> = Promise.resolve();
let saveQueued = false;
let stopListening: (() => void) | null = null;

function usageFile(): string {
  return deps?.file() ?? path.join(getBaseDirPath(), 'dispatcher-usage.json');
}

function now(): number {
  return deps?.now() ?? Date.now();
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(usageFile(), 'utf-8')) as { days?: Record<string, DispatcherUsageSplit> };
    for (const [day, split] of Object.entries(raw.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !split) continue;
      const base = emptyUsageSplit(day);
      days.set(day, {
        day,
        conversations: { ...base.conversations, ...split.conversations },
        background: { ...base.background, ...split.background },
      });
    }
  } catch (err) {
    // telemetry-exempt: no file yet, or an unreadable one, starts the totals over
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      appLog('core:dispatcher', 'warn', 'Could not read the Dispatcher usage totals', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
}

function trim(): void {
  const keys = [...days.keys()].sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - USAGE_KEEP_DAYS))) days.delete(key);
}

async function save(): Promise<void> {
  trim();
  const body = { days: Object.fromEntries([...days.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  try {
    await writeFileAtomic(usageFile(), `${JSON.stringify(body, null, 2)}\n`);
  } catch (err) {
    // telemetry-exempt: logged; the totals stay in memory and are written with the next turn
    appLog('core:dispatcher', 'warn', 'Could not save the Dispatcher usage totals', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

function scheduleSave(): void {
  if (saveQueued) return;
  saveQueued = true;
  saving = saving.then(() => {
    saveQueued = false;
    return save();
  });
}

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function add(totals: DispatcherUsageTotals, turn: OpenTurn): void {
  totals.turns++;
  const t = turn.tokens;
  let reported = false;
  for (const key of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) {
    const value = t?.[key];
    if (valid(value)) {
      totals[key] += Math.trunc(value);
      reported = true;
    }
  }
  if (valid(turn.costUsd)) {
    totals.costUsd += turn.costUsd;
    if (turn.costIsEstimate) totals.costIsEstimate = true;
    reported = true;
  }
  if (!reported) totals.turnsWithoutUsage++;
}

function isDispatcherAgent(agentId: string): boolean {
  return deps ? deps.isDispatcherAgent(agentId) : isDispatcherIdentityAgentId(agentId);
}

/**
 * Note that background work is about to reach one of the Dispatcher's agents,
 * so its next turn counts as background.
 */
export function noteDispatcherBackgroundWork(agentId: string): void {
  pendingBackground.set(agentId, now() + BACKGROUND_MARK_MS);
}

/** Forget a background mark whose delivery didn't happen, so it can't claim the next conversation. */
export function clearDispatcherBackgroundWork(agentId: string): void {
  pendingBackground.delete(agentId);
}

/** Count one chat event. Exported for tests; startDispatcherUsage feeds it. */
export function countDispatcherChatEvent(event: ChatEvent): void {
  if (event.type !== 'turn_started' && event.type !== 'usage' && event.type !== 'turn_ended') return;
  if (!isDispatcherAgent(event.agentId)) return;
  const key = `${event.agentId}:${event.turnId ?? ''}`;
  if (event.type === 'turn_started') {
    const until = pendingBackground.get(event.agentId);
    pendingBackground.delete(event.agentId);
    openTurns.set(key, { kind: until !== undefined && until >= now() ? 'background' : 'conversations' });
    return;
  }
  if (event.type === 'usage') {
    // The turn's own figures; a subagent's and the session's running totals are not the turn's.
    if (event.data.scope !== 'turn' || event.data.subagentId !== undefined) return;
    const turn = openTurns.get(key);
    if (!turn) return;
    if (event.data.tokens) turn.tokens = event.data.tokens;
    if (event.data.costUsd !== undefined) {
      turn.costUsd = event.data.costUsd;
      turn.costIsEstimate = event.data.costIsEstimate === true;
    }
    return;
  }
  const turn = openTurns.get(key) ?? { kind: 'conversations' as const };
  openTurns.delete(key);
  if (event.data.usage) turn.tokens = event.data.usage;
  if (event.data.costUsd !== undefined) turn.costUsd = event.data.costUsd;
  load();
  const day = dayKey(new Date(now()));
  const split = days.get(day) ?? emptyUsageSplit(day);
  add(split[turn.kind], turn);
  days.set(day, split);
  scheduleSave();
}

/**
 * Today's split (or the given local day's, `YYYY-MM-DD`): what conversations
 * and background work used. A day with nothing counted is all zeros.
 */
export function getDispatcherUsageSplit(day: string = dayKey(new Date(now()))): DispatcherUsageSplit {
  load();
  const split = days.get(day);
  return split ? structuredClone(split) : emptyUsageSplit(day);
}

/** Every day kept, oldest first. For telemetry (#3052). */
export function getDispatcherUsageDays(): DispatcherUsageSplit[] {
  load();
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((s) => structuredClone(s));
}

/** Start counting. Idempotent. */
export function startDispatcherUsage(): void {
  if (stopListening) return;
  load();
  stopListening = onChatEvent(countDispatcherChatEvent);
}

export async function stopDispatcherUsage(): Promise<void> {
  stopListening?.();
  stopListening = null;
  await saving;
}

/** For tests: where to save, which agents are the Dispatcher's, and the clock. */
export function _setDispatcherUsageDepsForTesting(next: Deps | null): void {
  deps = next;
}

export async function _flushDispatcherUsageForTesting(): Promise<void> {
  await saving;
}

export function _resetDispatcherUsageForTesting(): void {
  stopListening?.();
  stopListening = null;
  saving = Promise.resolve();
  saveQueued = false;
  days = new Map();
  loaded = false;
  pendingBackground.clear();
  openTurns.clear();
  deps = null;
}
