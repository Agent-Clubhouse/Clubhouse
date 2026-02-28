import { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Channel-specific throttle policies
// ---------------------------------------------------------------------------

export interface ThrottlePolicy {
  /**
   * Batching interval in milliseconds. Events are accumulated and flushed at
   * this cadence. 0 or unset = immediate (no throttling).
   */
  intervalMs: number;

  /**
   * When true, args for the same grouping key are merged into a single
   * broadcast (e.g. concatenating PTY data chunks). When false, args are
   * queued and each entry is broadcast individually on flush.
   */
  merge: boolean;

  /**
   * Extract a grouping key from the broadcast args. Events with the same key
   * are batched together. Defaults to '' (all events share one batch).
   */
  keyFn?: (...args: unknown[]) => string;

  /**
   * Custom merge function. Called with (existingArgs, incomingArgs) and must
   * return the merged args array. Only used when `merge` is true.
   * Default behaviour: replace with the latest args.
   */
  mergeFn?: (existing: unknown[], incoming: unknown[]) => unknown[];
}

const channelPolicies = new Map<string, ThrottlePolicy>();

/**
 * Register a throttle policy for a specific IPC channel.
 */
export function setChannelPolicy(channel: string, policy: ThrottlePolicy): void {
  channelPolicies.set(channel, policy);
}

/**
 * Remove a previously registered throttle policy.
 */
export function clearChannelPolicy(channel: string): void {
  channelPolicies.delete(channel);
}

/**
 * Remove all registered throttle policies.
 */
export function clearAllPolicies(): void {
  channelPolicies.clear();
}

// ---------------------------------------------------------------------------
// Internal batch state
// ---------------------------------------------------------------------------

interface MergedEntry {
  channel: string;
  args: unknown[];
}

interface QueuedEntry {
  channel: string;
  items: unknown[][];
}

const pendingMerged = new Map<string, MergedEntry>();
const pendingQueued = new Map<string, QueuedEntry>();
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Send an IPC message to every open BrowserWindow, skipping destroyed ones.
 * This is the low-level send — no throttling.
 */
function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

function flushKey(key: string): void {
  activeTimers.delete(key);

  const merged = pendingMerged.get(key);
  if (merged) {
    pendingMerged.delete(key);
    sendToAllWindows(merged.channel, ...merged.args);
    return;
  }

  const queued = pendingQueued.get(key);
  if (queued) {
    pendingQueued.delete(key);
    for (const args of queued.items) {
      sendToAllWindows(queued.channel, ...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an IPC message to all open BrowserWindows.
 * Skips any windows that have already been destroyed.
 *
 * Channels with registered throttle policies will be batched to reduce
 * main-thread IPC serialization overhead during high-frequency events
 * (PTY data, hook events).
 */
export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  const policy = channelPolicies.get(channel);

  // No policy or zero interval — send immediately
  if (!policy || policy.intervalMs <= 0) {
    sendToAllWindows(channel, ...args);
    return;
  }

  const groupKey = policy.keyFn
    ? `${channel}\0${policy.keyFn(...args)}`
    : channel;

  if (policy.merge) {
    const existing = pendingMerged.get(groupKey);
    if (existing) {
      existing.args = policy.mergeFn
        ? policy.mergeFn(existing.args, args)
        : args;
    } else {
      pendingMerged.set(groupKey, { channel, args: [...args] });
    }
  } else {
    const existing = pendingQueued.get(groupKey);
    if (existing) {
      existing.items.push(args);
    } else {
      pendingQueued.set(groupKey, { channel, items: [args] });
    }
  }

  // Schedule flush if not already pending
  if (!activeTimers.has(groupKey)) {
    activeTimers.set(
      groupKey,
      setTimeout(() => flushKey(groupKey), policy.intervalMs),
    );
  }
}

/**
 * Flush all pending batched broadcasts immediately.
 * Call during shutdown to ensure no events are lost.
 */
export function flushAllPending(): void {
  // Snapshot keys — flushKey mutates the maps
  const keys = [...activeTimers.keys()];
  for (const key of keys) {
    const timer = activeTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    flushKey(key);
  }
}

/**
 * Return the number of currently pending batch keys (for diagnostics/tests).
 */
export function pendingCount(): number {
  return activeTimers.size;
}
