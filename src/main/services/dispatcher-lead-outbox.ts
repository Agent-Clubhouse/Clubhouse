/**
 * Messages typed to the lead's Dispatcher while its computer is offline (#3353).
 *
 * A follower's pane is the lead's chat (#3352). While the lead is offline,
 * what the person types waits here, in order, and goes to the lead's chat when
 * its computer is back, as a `chat.send` like any other. Each message keeps
 * one command id across tries, so the lead takes it once while it hasn't
 * restarted (its commands are idempotent per peer and epoch). A lead chat that
 * is asleep there is woken with the message as its first, as a phone does. A
 * message waits
 * at most a day; one that's dropped, or that the lead refuses, is counted and
 * shown in the pane until the person dismisses it.
 *
 * Messages go to the computer they were written for, even if the lead changes
 * or this computer takes back meanwhile: they were written to that chat.
 */

import { randomUUID } from 'crypto';
import { appLog } from './log-service';
import { createSettingsStore } from './settings-store';
import { LEAD_OUTBOX_EXPIRY_MS, LEAD_OUTBOX_MAX, LEAD_OUTBOX_MAX_CHARS, type LeadOutboxState } from '../../shared/dispatcher-lead';

interface Waiting {
  id: string;
  machine: string;
  text: string;
  queuedAt: string;
}

interface OutboxFile {
  items: Waiting[];
  expired: number;
  failed: string | null;
}

const store = createSettingsStore<OutboxFile>('dispatcher-lead-outbox.json', { items: [], expired: 0, failed: null }, undefined, { atomic: true });

export interface LeadOutboxHooks {
  connected: (machine: string) => boolean;
  /** The lead's Dispatcher chat agent on that computer, from its snapshot. */
  dispatcherAgentId: (machine: string) => string | undefined;
  /** That chat's current session, and whether a chat session runs it now, from its chat page. */
  chatSession: (machine: string, agentId: string) => Promise<{ sessionId: string | null; live: boolean }>;
  /** Sends a chat command with this id; answers the receipt (a refusal is a receipt too). */
  send: (machine: string, command: Record<string, unknown>, commandId: string) => Promise<unknown>;
  /** Wakes the chat with this message as its first (`agent.start`, resume), with this id. */
  wake: (machine: string, agentId: string, message: string, commandId: string) => Promise<unknown>;
  onConnected: (listener: (machine: string) => void) => () => void;
}

let hooks: LeadOutboxHooks | undefined;
const listeners = new Set<() => void>();
const flushing = new Set<string>();

export function onLeadOutboxChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function read(): OutboxFile {
  const file = store.get();
  return { items: Array.isArray(file.items) ? file.items : [], expired: file.expired ?? 0, failed: file.failed ?? null };
}

async function save(next: OutboxFile): Promise<void> {
  await store.save(next);
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
  }
}

/** Drops what has waited too long, counting it. */
async function expire(now: number): Promise<OutboxFile> {
  const file = read();
  const kept = file.items.filter((item) => now - Date.parse(item.queuedAt) < LEAD_OUTBOX_EXPIRY_MS);
  if (kept.length === file.items.length) return file;
  const next = { ...file, items: kept, expired: file.expired + file.items.length - kept.length };
  await save(next);
  appLog('core:dispatcher', 'info', 'Messages for the lead Dispatcher expired', { meta: { count: file.items.length - kept.length } });
  return next;
}

export function leadOutboxState(machine: string | null, now = Date.now()): LeadOutboxState {
  const file = read();
  const live = file.items.filter((item) => now - Date.parse(item.queuedAt) < LEAD_OUTBOX_EXPIRY_MS);
  const mine = machine ? live.filter((item) => item.machine === machine) : live;
  return { waiting: mine.length, oldestAt: mine[0]?.queuedAt ?? null, expired: file.expired, failed: file.failed };
}

/** A message for the lead's chat on `machine`, kept until that computer is back. */
export async function queueForLead(machine: string, text: string, now = Date.now()): Promise<{ id: string }> {
  if (!text.trim()) throw new Error('There’s nothing to send.');
  if (text.length > LEAD_OUTBOX_MAX_CHARS) throw new Error('That message is too long to keep while the lead is offline. Shorten it, or send it when it’s back.');
  const file = await expire(now);
  if (file.items.length >= LEAD_OUTBOX_MAX) throw new Error(`${LEAD_OUTBOX_MAX} messages are already waiting for the lead. Send more when it’s back.`);
  const item: Waiting = { id: randomUUID(), machine: machine.toLowerCase(), text, queuedAt: new Date(now).toISOString() };
  await save({ ...file, items: [...file.items, item] });
  if (hooks?.connected(item.machine)) void flushLeadOutbox(item.machine);
  return { id: item.id };
}

/** Clears the expired and refused notices once the person has seen them. */
export async function dismissLeadOutboxNotice(): Promise<void> {
  const file = read();
  if (file.expired === 0 && !file.failed) return;
  await save({ ...file, expired: 0, failed: null });
}

const REFUSED = 'The lead’s Dispatcher refused a waiting message.';
/** Refusals that mean "not now" rather than "no". */
const RETRY_CODES = new Set(['not_chat', 'session_mismatch', 'command_capacity', 'revert_in_progress', 'epoch_mismatch', 'already_running', 'agent_busy']);
const RETRY_MS = 5_000;
const RETRY_MAX = 12;
const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; count: number }>();

/** One more try in a few seconds, at most a minute's worth in a row; the next connect starts over. */
function retrySoon(machine: string): void {
  const prior = retries.get(machine);
  if (prior && prior.count >= RETRY_MAX) return;
  if (prior) clearTimeout(prior.timer);
  const timer = setTimeout(() => { void flushLeadOutbox(machine); }, RETRY_MS);
  timer.unref?.();
  retries.set(machine, { timer, count: (prior?.count ?? 0) + 1 });
}

/** Sends what waits for `machine`, in order, while it's connected. Stops at the first message that doesn't go. */
export async function flushLeadOutbox(machine: string, now = Date.now()): Promise<void> {
  const fp = machine.toLowerCase();
  if (!hooks || flushing.has(fp)) return;
  flushing.add(fp);
  try {
    await expire(now);
    for (;;) {
      const item = read().items.find((i) => i.machine === fp);
      if (!item || !hooks.connected(fp)) return;
      const agentId = hooks.dispatcherAgentId(fp);
      // The lead's Dispatcher is off there, or its snapshot hasn't come yet: wait for the next connect.
      if (!agentId) return;
      const { sessionId, live } = await hooks.chatSession(fp, agentId);
      // Asleep there: the message wakes it, as a phone's would.
      const receipt = (live && sessionId
        ? await hooks.send(fp, { type: 'chat.send', agentId, sessionId, text: item.text, delivery: 'auto' }, item.id)
        : await hooks.wake(fp, agentId, item.text, item.id)) as { status?: string; error?: { code?: string; message?: string } } | null;
      const file = read();
      const rest = file.items.filter((i) => i.id !== item.id);
      if (receipt?.status === 'completed') {
        retries.delete(fp);
        await save({ ...file, items: rest });
        continue;
      }
      // The chat was between states (waking, a new session, busy): try again shortly.
      if (receipt?.status === 'rejected' && RETRY_CODES.has(receipt.error?.code ?? '')) {
        retrySoon(fp);
        return;
      }
      // A refusal won't change on a retry: drop it and say so. Anything else waits for the next connect.
      if (receipt?.status === 'rejected') {
        await save({ ...file, items: rest, failed: receipt.error?.message || REFUSED });
        appLog('core:dispatcher', 'warn', 'The lead Dispatcher refused a waiting message', { meta: { code: receipt.error?.code ?? null } });
        continue;
      }
      return;
    }
  } catch (err) {
    // telemetry-exempt: logged; the message stays and goes on the next connect.
    appLog('core:dispatcher', 'warn', 'Could not send waiting messages to the lead Dispatcher', { meta: { error: err instanceof Error ? err.message : String(err) } });
  } finally {
    flushing.delete(fp);
  }
}

function clearRetry(machine: string): void {
  const prior = retries.get(machine);
  if (prior) clearTimeout(prior.timer);
  retries.delete(machine);
}

export function startLeadOutbox(h: LeadOutboxHooks): () => void {
  hooks = h;
  const off = h.onConnected((machine) => { clearRetry(machine); void flushLeadOutbox(machine); });
  // Once an hour, so a message that expires while nothing else happens still says so.
  const timer = setInterval(() => { void expire(Date.now()).catch(() => { /* telemetry-exempt: retried next hour */ }); }, 60 * 60 * 1000);
  timer.unref?.();
  for (const machine of new Set(read().items.map((i) => i.machine))) void flushLeadOutbox(machine);
  return () => {
    off();
    clearInterval(timer);
    if (hooks === h) hooks = undefined;
  };
}

/** For tests. */
export function _resetLeadOutboxForTesting(): void {
  hooks = undefined;
  listeners.clear();
  flushing.clear();
  for (const machine of [...retries.keys()]) clearRetry(machine);
}
