import { applyProjectStateOp, type ProjectState, type ProjectStateChange, type ProjectStateOp } from '../../shared/project-state';

/**
 * Keeps the sidebar's pins, inactive marks and activity in step with main,
 * which owns them (#2458) so a phone can see and change them.
 *
 * The chrome store applies each op at once, as it always has, then hands it
 * here. Ops wait until main has answered the first hydrate (which also moves
 * the localStorage copy into main, once), then go to main in order. Each state
 * main broadcasts becomes the base, with the ops main hasn't acknowledged yet
 * applied on top, so a phone's change and the user's own never undo each other.
 */

export interface ProjectStateApi {
  hydrateState: (legacy: ProjectState) => Promise<ProjectState>;
  applyStateOp: (clientId: string, seq: number, op: ProjectStateOp) => Promise<void>;
  onStateChanged: (callback: (change: ProjectStateChange) => void) => () => void;
}

export interface ProjectStateTarget {
  /** The localStorage copy, handed to main if it has none yet. */
  legacy: () => ProjectState;
  /** Show main's state (with pending ops applied) without sending it back. */
  replace: (state: ProjectState) => void;
  /** An op couldn't be applied in main. */
  onError?: (err: unknown) => void;
}

interface Pending { seq: number; op: ProjectStateOp }

export interface ProjectStateSync {
  send: (op: ProjectStateOp) => void;
  stop: () => void;
}

export function startProjectStateSync(api: ProjectStateApi, target: ProjectStateTarget): ProjectStateSync {
  const clientId = globalThis.crypto?.randomUUID?.() ?? `window-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;
  let pending: Pending[] = [];
  let base: ProjectState | null = null;
  /** Main answered the hydrate: ops go straight out, after the ones queued before it. */
  let hydrated = false;
  let stopped = false;

  const show = () => {
    if (!base || stopped) return;
    target.replace(pending.reduce((state, p) => applyProjectStateOp(state, p.op), base));
  };
  const settle = (upTo: number) => { pending = pending.filter((p) => p.seq > upTo); };
  const push = (p: Pending) => {
    api.applyStateOp(clientId, p.seq, p.op).then(
      () => { settle(p.seq); show(); },
      (err) => {
        // Main refused it: drop it, so the sidebar shows what main holds.
        pending = pending.filter((q) => q.seq !== p.seq);
        show();
        target.onError?.(err);
      },
    );
  };

  const unsubscribe = api.onStateChanged((change) => {
    base = change.state;
    const acked = change.acked[clientId];
    if (acked !== undefined) settle(acked);
    show();
  });

  api.hydrateState(target.legacy()).then((state) => {
    if (stopped) return;
    base = state;
    hydrated = true;
    for (const p of pending) push(p);
    show();
  }, (err) => {
    // No main state this session: keep the local behaviour.
    stopped = true;
    pending = [];
    target.onError?.(err);
  });

  return {
    send: (op) => {
      if (stopped) return;
      const p = { seq: ++seq, op };
      pending.push(p);
      if (hydrated) push(p);
    },
    stop: () => { stopped = true; pending = []; unsubscribe(); },
  };
}
