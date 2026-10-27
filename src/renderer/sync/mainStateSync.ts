/**
 * Keeps a renderer store in step with state main owns, so a phone can see and
 * change it: project pins and idle (#2458), finished quick agents (#2467).
 *
 * The store applies each op at once, as it always has, then hands it here. Ops
 * wait until main has answered the first hydrate (which also moves the
 * localStorage copy into main, once), then go to main in order. Each state
 * main broadcasts becomes the base, with the ops main hasn't acknowledged yet
 * applied on top, so a phone's change and the user's own never undo each other.
 */

export interface MainStateApi<S, O> {
  hydrate: (legacy: S) => Promise<S>;
  apply: (clientId: string, seq: number, op: O) => Promise<void>;
  onChanged: (callback: (change: { state: S; acked: Record<string, number> }) => void) => () => void;
}

export interface MainStateTarget<S> {
  /** The localStorage copy, handed to main if it has none yet. */
  legacy: () => S;
  /** Show main's state (with pending ops applied) without sending it back. */
  replace: (state: S) => void;
  /** An op couldn't be applied in main. */
  onError?: (err: unknown) => void;
}

export interface MainStateSync<O> {
  send: (op: O) => void;
  stop: () => void;
}

interface Pending<O> { seq: number; op: O }

export function startMainStateSync<S, O>(
  api: MainStateApi<S, O>,
  target: MainStateTarget<S>,
  applyOp: (state: S, op: O) => S,
): MainStateSync<O> {
  const clientId = globalThis.crypto?.randomUUID?.() ?? `window-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0;
  let pending: Pending<O>[] = [];
  let base: S | null = null;
  /** Main answered the hydrate: ops go straight out, after the ones queued before it. */
  let hydrated = false;
  let stopped = false;

  const show = () => {
    if (base === null || stopped) return;
    target.replace(pending.reduce((state, p) => applyOp(state, p.op), base));
  };
  const settle = (upTo: number) => { pending = pending.filter((p) => p.seq > upTo); };
  const push = (p: Pending<O>) => {
    api.apply(clientId, p.seq, p.op).then(
      () => { settle(p.seq); show(); },
      (err) => {
        // Main refused it: drop it, so the store shows what main holds.
        pending = pending.filter((q) => q.seq !== p.seq);
        show();
        target.onError?.(err);
      },
    );
  };

  const unsubscribe = api.onChanged((change) => {
    base = change.state;
    const acked = change.acked[clientId];
    if (acked !== undefined) settle(acked);
    show();
  });

  api.hydrate(target.legacy()).then((state) => {
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
