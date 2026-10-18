// ── Wire reconciliation ──────────────────────────────────────────────
//
// Keeps the live MCP bindings in step with the canvas's wire definitions:
// when a definition has no binding (an agent's bindings were cleaned up while
// it slept, or a wire was just added), bind it again. Failed binds back off
// exponentially (1 s, 2 s, 4 s … capped at 60 s) so a sleeping agent isn't
// spammed.
//
// It gives up on a wire (#2071) rather than retrying forever when:
// - its target can't exist here, e.g. a group project that isn't on this
//   machine. Such a wire is never bound, so no binding points at a dead id;
// - bind keeps failing: MAX_BIND_FAILURES in a row.
// Either way it's reported once through onGiveUp. A wire that gets a binding
// some other way, or is removed and added again, starts fresh.

import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

export const MAX_BIND_FAILURES = 8;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

/** Whether a wire's target exists here: 'unknown' waits (e.g. group projects still loading). */
export type WireTargetState = 'ok' | 'missing' | 'unknown';
export type WireGiveUpReason = 'missing_target' | 'bind_failed';

export interface WireReconcilerDeps {
  bind: (def: McpBindingEntry) => Promise<void>;
  targetState?: (def: McpBindingEntry) => WireTargetState;
  onGiveUp?: (def: McpBindingEntry, reason: WireGiveUpReason) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface WireReconciler {
  reconcile: (defs: McpBindingEntry[], bindings: Pick<McpBindingEntry, 'agentId' | 'targetId'>[]) => void;
  dispose: () => void;
}

const keyOf = (w: Pick<McpBindingEntry, 'agentId' | 'targetId'>) => `${w.agentId}\0${w.targetId}`;

export function createWireReconciler(deps: WireReconcilerDeps): WireReconciler {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const backoff = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  const gaveUp = new Set<string>();

  const forget = (key: string) => {
    backoff.delete(key);
    failures.delete(key);
    gaveUp.delete(key);
    const timer = timers.get(key);
    if (timer) { clearTimer(timer); timers.delete(key); }
  };

  const reconcile: WireReconciler['reconcile'] = (defs, bindings) => {
    // A definition that went away and comes back later starts fresh.
    const current = new Set(defs.map(keyOf));
    for (const key of new Set([...backoff.keys(), ...failures.keys(), ...gaveUp])) {
      if (!current.has(key)) forget(key);
    }
    if (defs.length === 0) return;

    const live = new Set(bindings.map(keyOf));
    for (const def of defs) {
      const key = keyOf(def);
      if (live.has(key)) { forget(key); continue; }
      if (gaveUp.has(key) || timers.has(key)) continue;

      const target = deps.targetState?.(def) ?? 'ok';
      if (target === 'unknown') continue;
      if (target === 'missing') {
        gaveUp.add(key);
        deps.onGiveUp?.(def, 'missing_target');
        continue;
      }

      const delay = backoff.get(key) || 0;
      const attempt = () => {
        timers.delete(key);
        deps.bind(def).catch(() => {
          const failed = (failures.get(key) ?? 0) + 1;
          failures.set(key, failed);
          if (failed >= MAX_BIND_FAILURES) {
            gaveUp.add(key);
            backoff.delete(key);
            deps.onGiveUp?.(def, 'bind_failed');
            return;
          }
          backoff.set(key, Math.min((delay || FIRST_RETRY_MS) * 2, MAX_RETRY_MS));
        });
      };
      if (delay === 0) {
        attempt();
        backoff.set(key, FIRST_RETRY_MS);
      } else {
        timers.set(key, setTimer(attempt, delay));
      }
    }
  };

  return {
    reconcile,
    dispose: () => {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
}
