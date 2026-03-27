/**
 * useWireActivity — tracks MCP tool call activity per wire for animation.
 *
 * Listens for TOOL_ACTIVITY IPC events from the main process and maintains
 * a map of wire keys → activity state. Activity decays after ACTIVITY_DECAY_MS.
 *
 * Wire states:
 * - 'idle'           — one or both endpoints are dead
 * - 'ambient'        — both endpoints alive, no recent traffic
 * - 'active-forward' — recent tool call source→target
 * - 'active-reverse' — recent read_output (data flowing target→source)
 * - 'active-both'    — recent traffic in both directions
 */

import { useEffect, useSyncExternalStore } from 'react';

/** How long activity persists after the last tool call (ms). */
export const ACTIVITY_DECAY_MS = 4000;

/** How often to check for expired activity (ms). */
const DECAY_CHECK_INTERVAL = 500;

export type WireActivityState = 'idle' | 'ambient' | 'active-forward' | 'active-reverse' | 'active-both';

export interface ToolActivityEvent {
  sourceAgentId: string;
  targetId: string;
  direction: 'forward' | 'reverse';
  toolSuffix: string;
  timestamp: number;
}

interface WireTimestamps {
  lastForward: number;
  lastReverse: number;
}

/**
 * Build the canonical wire key for a source→target binding.
 * Must match the key format used in WireOverlay: `${agentId}--${targetId}`.
 */
export function wireKeyFromActivity(sourceAgentId: string, targetId: string): string {
  return `${sourceAgentId}--${targetId}`;
}

/**
 * Compute the activity state for a wire given its timestamps.
 * Exported for testing.
 */
export function computeActivityState(
  timestamps: WireTimestamps | undefined,
  now: number,
  alive: boolean,
): WireActivityState {
  if (!alive) return 'idle';
  if (!timestamps) return 'ambient';

  const fwdActive = (now - timestamps.lastForward) < ACTIVITY_DECAY_MS;
  const revActive = (now - timestamps.lastReverse) < ACTIVITY_DECAY_MS;

  if (fwdActive && revActive) return 'active-both';
  if (fwdActive) return 'active-forward';
  if (revActive) return 'active-reverse';
  return 'ambient';
}

// ── Singleton activity store (shared across all hook consumers) ─────

const activityMap = new Map<string, WireTimestamps>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function notifyListeners(): void {
  snapshotVersion++;
  for (const fn of listeners) fn();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): number {
  return snapshotVersion;
}

/** Record a tool activity event. Exported for testing. */
export function recordActivity(event: ToolActivityEvent): void {
  // The wire key is always source→target (matches WireOverlay key format).
  // For bidirectional wires, both directions map to the same key via sorted pair
  // in WireOverlay, but activity events come with the calling agent as source.
  // We need to check both orderings.
  const key = wireKeyFromActivity(event.sourceAgentId, event.targetId);

  const existing = activityMap.get(key) ?? { lastForward: 0, lastReverse: 0 };

  if (event.direction === 'forward') {
    existing.lastForward = event.timestamp;
  } else {
    existing.lastReverse = event.timestamp;
  }

  activityMap.set(key, existing);

  // For bidirectional wires, the reverse key might also exist
  const reverseKey = wireKeyFromActivity(event.targetId, event.sourceAgentId);
  if (activityMap.has(reverseKey) || reverseKey !== key) {
    // Also update the reverse key with swapped direction
    const reverseExisting = activityMap.get(reverseKey) ?? { lastForward: 0, lastReverse: 0 };
    if (event.direction === 'forward') {
      reverseExisting.lastReverse = event.timestamp;
    } else {
      reverseExisting.lastForward = event.timestamp;
    }
    activityMap.set(reverseKey, reverseExisting);
  }

  notifyListeners();
}

/** Get timestamps for a specific wire. Exported for testing. */
export function getWireTimestamps(wireKey: string): WireTimestamps | undefined {
  return activityMap.get(wireKey);
}

/** Clear all activity data. Exported for testing. */
export function _resetForTesting(): void {
  activityMap.clear();
  snapshotVersion = 0;
}

// ── React hook ──────────────────────────────────────────────────────

/**
 * Hook that provides the activity state for a specific wire.
 *
 * @param wireKey - The wire key (e.g. "durable_123--durable_456")
 * @param alive - Whether both endpoints are alive/connected
 */
export function useWireActivity(wireKey: string, alive: boolean = true): WireActivityState {
  // Subscribe to the singleton store
  useSyncExternalStore(subscribe, getSnapshot);

  // Set up decay timer to re-render when activity expires.
  // Capture the interval ID directly in the cleanup closure so that rapid
  // wireKey changes always clear the correct (old) interval.
  useEffect(() => {
    const timer = setInterval(() => {
      const ts = activityMap.get(wireKey);
      if (ts) {
        const now = Date.now();
        const fwdExpired = ts.lastForward > 0 && (now - ts.lastForward) >= ACTIVITY_DECAY_MS;
        const revExpired = ts.lastReverse > 0 && (now - ts.lastReverse) >= ACTIVITY_DECAY_MS;
        if (fwdExpired || revExpired) {
          notifyListeners(); // trigger re-render to update state
        }
      }
    }, DECAY_CHECK_INTERVAL);

    return () => {
      clearInterval(timer);
    };
  }, [wireKey]);

  const timestamps = activityMap.get(wireKey);
  return computeActivityState(timestamps, Date.now(), alive);
}

/**
 * Initialize the IPC listener for tool activity events.
 * Call once at app startup. Returns cleanup function.
 */
export function initToolActivityListener(): () => void {
  if (!window.clubhouse?.mcpBinding?.onToolActivity) {
    return () => {};
  }
  return window.clubhouse.mcpBinding.onToolActivity((event) => {
    recordActivity(event);
  });
}
