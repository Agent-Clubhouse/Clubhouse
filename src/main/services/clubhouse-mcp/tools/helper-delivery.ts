/**
 * Helper updates to a parent, batched (#2414). message_parent reports and
 * Clubhouse's helper notices reach a busy parent as one message per short
 * window rather than one steer (Claude, Codex) or terminal injection each.
 * Updates for an idle parent go at once, and the window closes early when a
 * chat parent goes idle. A chat parent that queues client-side (ACP) skips
 * the window: its runtime merges queued updates itself.
 *
 * A terminal's turn state is only known in the renderer, so a terminal parent
 * always waits out the window.
 *
 * Helper questions (#2366) don't wait: routeHelperQuestion flushes the
 * pending batch first, so the question still arrives after earlier updates.
 */

import { coalesceUpdateTexts, parseRoutedText, type ChatSessionState, type RoutedMessagePart } from '../../../../shared/chat';
import { getAgentRuntime } from '../../agent-runtime';
import { isAgentStoppingError } from '../../agent-runtime/agent-stopping';

export type Delivery = 'delivered' | 'not_running' | 'stopping';

/** How long a busy parent's updates wait for company. */
export const HELPER_UPDATE_WINDOW_MS = 3000;

interface Batch {
  texts: string[];
  routed: RoutedMessagePart[];
  timer: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  waiters: Array<{ resolve: (d: Delivery) => void; reject: (err: unknown) => void }>;
}

const batches = new Map<string, Batch>();

const BUSY: ReadonlySet<ChatSessionState> = new Set(['running', 'waiting_permission', 'waiting_input']);

type Runtime = NonNullable<ReturnType<typeof getAgentRuntime>>;

/** Busy: a chat parent mid-turn, or any terminal parent. */
function isBusy(runtime: Runtime): boolean {
  return runtime.kind !== 'chat' || BUSY.has(runtime.getState());
}

/** A chat runtime that holds mid-turn messages in its own queue, merging MCP ones. */
function mergesItsQueue(runtime: Runtime): boolean {
  const caps = runtime.kind === 'chat' ? runtime.getCapabilities?.() : undefined;
  return !!caps && !caps.steer && caps.queue === 'client';
}

/**
 * Deliver text to a running agent's input now, as Clubhouse MCP send_message
 * does. A terminal agent that is shutting down refuses the text (its runtime
 * throws AgentStoppingError), which comes back as 'stopping'.
 */
export async function deliverNow(targetId: string, text: string, routed?: RoutedMessagePart[]): Promise<Delivery> {
  const runtime = getAgentRuntime(targetId);
  // A chat runtime that is ending is still registered for a moment.
  if (!runtime?.isRunning()) return 'not_running';
  try {
    await runtime.sendMessage(text, { source: 'mcp', taskId: `helper_${Date.now().toString(36)}`, ...(routed && { routed }) });
  } catch (err) {
    if (isAgentStoppingError(err)) return 'stopping';
    throw err;
  }
  return 'delivered';
}

/** One update's display part; an update without one is parsed, so a batch stays in step. */
function routedFor(text: string, part?: RoutedMessagePart): RoutedMessagePart[] {
  return part ? [part] : parseRoutedText(text);
}

/**
 * Deliver an update to a parent: at once when it is idle, otherwise with the
 * others that arrive within the window. Resolves when the update is handed to
 * the parent's runtime.
 */
export function deliverHelperUpdate(targetId: string, text: string, part?: RoutedMessagePart): Promise<Delivery> {
  const runtime = getAgentRuntime(targetId);
  if (!runtime) return Promise.resolve('not_running');
  const pending = batches.get(targetId);
  if (!pending && (!isBusy(runtime) || mergesItsQueue(runtime))) return deliverNow(targetId, text, routedFor(text, part));

  return new Promise<Delivery>((resolve, reject) => {
    if (pending) {
      pending.texts.push(text);
      pending.routed.push(...routedFor(text, part));
      pending.waiters.push({ resolve, reject });
      return;
    }
    const batch: Batch = {
      texts: [text],
      routed: routedFor(text, part),
      timer: setTimeout(() => { void flushHelperUpdates(targetId); }, HELPER_UPDATE_WINDOW_MS),
      waiters: [{ resolve, reject }],
    };
    if (runtime.kind === 'chat') {
      // Idle: the batch goes now. Stopped: the flush reports it. Starting
      // (a context clear) has no session to take it yet.
      batch.unsubscribe = runtime.onStateChange((state) => {
        if (!BUSY.has(state) && state !== 'starting') void flushHelperUpdates(targetId);
      });
    }
    batches.set(targetId, batch);
  });
}

/** Send a parent's pending updates now, as one message. Never throws. */
export async function flushHelperUpdates(targetId: string): Promise<void> {
  const batch = batches.get(targetId);
  if (!batch) return;
  batches.delete(targetId);
  clearTimeout(batch.timer);
  batch.unsubscribe?.();
  try {
    const delivery = await deliverNow(targetId, coalesceUpdateTexts(batch.texts), batch.routed);
    for (const w of batch.waiters) w.resolve(delivery);
  } catch (err) {
    // telemetry-exempt: every waiter gets the error, as an unbatched send would
    for (const w of batch.waiters) w.reject(err);
  }
}

export function _resetHelperDeliveryForTesting(): void {
  for (const batch of batches.values()) {
    clearTimeout(batch.timer);
    batch.unsubscribe?.();
  }
  batches.clear();
}
