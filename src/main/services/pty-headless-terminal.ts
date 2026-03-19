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

interface HeadlessSession {
  terminal: Terminal;
  serializer: SerializeAddon;
}

const sessions = new Map<string, HeadlessSession>();

/** Default dimensions — updated by the first pty:resize. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** Max scrollback lines kept by headless terminals. */
const SCROLLBACK_LINES = 10_000;

/**
 * Get or create a headless terminal for a PTY session.
 * The headless terminal mirrors the live PTY state by processing
 * all the same output data.
 */
function getOrCreate(agentId: string): HeadlessSession {
  let session = sessions.get(agentId);
  if (session) return session;

  const terminal = new Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
  });

  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);

  session = { terminal, serializer };
  sessions.set(agentId, session);
  return session;
}

/**
 * Feed PTY output into the headless terminal. Call this every time
 * the PTY emits data (alongside the normal buffer/broadcast path).
 */
export function feedData(agentId: string, data: string): void {
  const session = getOrCreate(agentId);
  session.terminal.write(data);
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
