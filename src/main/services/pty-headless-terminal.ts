/**
 * Headless terminal manager — maintains a virtual xterm for each PTY session
 * so the Annex server can serve processed terminal state (visible lines +
 * scrollback) instead of raw escape-sequence buffers.
 *
 * Raw buffer replay into a fresh xterm causes visual artifacts (alt-screen
 * enter/exit, screen clears, cursor jumps) that make the remote terminal
 * look nothing like what the satellite user sees. By processing output
 * through a headless xterm in real time, we can serialize the terminal
 * state exactly as it would appear if the user were local.
 */
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { WindowsPtyInfo } from '../../shared/windows-pty';

interface HeadlessSession {
  terminal: Terminal;
  serializer: SerializeAddon;
  /** Output seq at the end of the last chunk fed, if the caller tracks one. */
  seq: number | undefined;
  /** Pending `snapshot` calls, settled if the terminal is disposed first. */
  waiters: Set<() => void>;
}

export interface HeadlessOptions {
  cols?: number;
  rows?: number;
  /** xterm's `windowsPty` hint for the PTY this mirrors (#2320, #2352). */
  windowsPty?: WindowsPtyInfo;
}

const sessions = new Map<string, HeadlessSession>();

/** Default dimensions, used when the caller does not know the PTY's size. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** Max scrollback lines kept by headless terminals. */
const SCROLLBACK_LINES = 10_000;

function create(agentId: string, options: HeadlessOptions): HeadlessSession {
  const terminal = new Terminal({
    cols: options.cols ?? DEFAULT_COLS,
    rows: options.rows ?? DEFAULT_ROWS,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
    ...(options.windowsPty && { windowsPty: { ...options.windowsPty } }),
  });

  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  const session: HeadlessSession = { terminal, serializer, seq: undefined, waiters: new Set() };
  sessions.set(agentId, session);
  return session;
}

/**
 * Create the headless terminal for a PTY session if it does not exist yet.
 * Pass the PTY's current size so the mirror wraps output like the PTY does
 * (#2325). An existing terminal is left as it is. Returns whether it created
 * one.
 */
export function ensure(agentId: string, options: HeadlessOptions = {}): boolean {
  if (sessions.has(agentId)) return false;
  create(agentId, options);
  return true;
}

/**
 * Replace a session's headless terminal with an empty one. Size and
 * `windowsPty` default to the replaced terminal's.
 */
export function reset(agentId: string, options: HeadlessOptions = {}): void {
  const old = sessions.get(agentId);
  const merged: HeadlessOptions = {
    cols: options.cols ?? old?.terminal.cols,
    rows: options.rows ?? old?.terminal.rows,
    windowsPty: options.windowsPty ?? (old?.terminal.options.windowsPty?.backend
      ? old.terminal.options.windowsPty as WindowsPtyInfo
      : undefined),
  };
  dispose(agentId);
  create(agentId, merged);
}

/**
 * Feed PTY output into the headless terminal. Call this every time
 * the PTY emits data (alongside the normal buffer/broadcast path).
 * `seq` is the output seq at the end of `data`; `snapshot` reports it.
 */
export function feedData(agentId: string, data: string, seq?: number): void {
  const session = sessions.get(agentId) ?? create(agentId, {});
  session.terminal.write(data);
  if (seq !== undefined) session.seq = seq;
}

/**
 * Resize the headless terminal to match the live PTY dimensions.
 * Call this whenever pty:resize is processed.
 */
export function resize(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (session) {
    session.terminal.resize(cols, rows);
  }
}

/** The headless terminal's size, or undefined when there is none. */
export function getSize(agentId: string): { cols: number; rows: number } | undefined {
  const session = sessions.get(agentId);
  return session ? { cols: session.terminal.cols, rows: session.terminal.rows } : undefined;
}

/**
 * Serialize the terminal once everything fed so far has been parsed, with
 * the seq of the last chunk fed. xterm parses writes asynchronously, so a
 * synchronous `serialize` can miss recent output that `seq` already counts.
 * Resolves to null when there is no headless terminal for the session.
 */
export function snapshot(agentId: string): Promise<{ data: string; seq: number | undefined } | null> {
  const session = sessions.get(agentId);
  if (!session) return Promise.resolve(null);
  const seq = session.seq;
  return new Promise((resolve) => {
    // A disposed terminal never runs its write callbacks. Retry once the
    // reset (if that is what disposed it) has created the replacement.
    const abandon = () => resolve(Promise.resolve().then(() => snapshot(agentId)));
    session.waiters.add(abandon);
    // The callback runs right after everything written before it is parsed
    // and before anything written after it, so the buffer matches `seq`.
    session.terminal.write('', () => {
      session.waiters.delete(abandon);
      resolve({ data: session.serializer.serialize({ scrollback: SCROLLBACK_LINES }), seq });
    });
  });
}

/**
 * Serialize the full terminal state: scrollback + visible buffer.
 * Returns a string that can be written directly to a fresh xterm on the
 * controller to reproduce the exact visual state.
 */
export function serialize(agentId: string): string {
  const session = sessions.get(agentId);
  if (!session) return '';
  return session.serializer.serialize({ scrollback: SCROLLBACK_LINES });
}

/**
 * Dispose the headless terminal for a session (on PTY exit).
 */
export function dispose(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    session.serializer.dispose();
    session.terminal.dispose();
    sessions.delete(agentId);
    for (const abandon of session.waiters) abandon();
    session.waiters.clear();
  }
}

/**
 * Dispose all headless terminals (shutdown).
 */
export function disposeAll(): void {
  for (const [id] of sessions) {
    dispose(id);
  }
}
