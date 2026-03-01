import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { StructuredEvent } from '../../shared/structured-events';
import type { AgentHookEvent } from '../../shared/types';
import type { StructuredAdapter, StructuredSessionOpts } from '../orchestrators/types';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import { appLog } from './log-service';

// ── Session state ───────────────────────────────────────────────────────────

interface StructuredSession {
  adapter: StructuredAdapter;
  agentId: string;
  transcriptPath: string;
  logStream: fs.WriteStream;
  startedAt: number;
  abortController: AbortController;
}

const sessions = new Map<string, StructuredSession>();

const LOGS_DIR = path.join(app.getPath('userData'), 'agent-logs');

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Start a structured session for an agent.
 * Pipes StructuredEvents from the adapter to:
 *   - Renderer via IPC (STRUCTURED_EVENT)
 *   - Annex event bus (as hook events)
 *   - Transcript persistence (JSONL on disk)
 */
export async function startStructuredSession(
  agentId: string,
  adapter: StructuredAdapter,
  opts: StructuredSessionOpts,
): Promise<void> {
  // Clean up any existing session for this agent
  if (sessions.has(agentId)) {
    await cancelSession(agentId);
  }

  ensureLogsDir();
  const transcriptPath = path.join(LOGS_DIR, `${agentId}-structured.jsonl`);
  const logStream = fs.createWriteStream(transcriptPath, { flags: 'w' });
  const abortController = new AbortController();

  const session: StructuredSession = {
    adapter,
    agentId,
    transcriptPath,
    logStream,
    startedAt: Date.now(),
    abortController,
  };
  sessions.set(agentId, session);

  appLog('core:structured', 'info', 'Starting structured session', {
    meta: { agentId, cwd: opts.cwd, model: opts.model },
  });

  // Consume the event stream in the background
  consumeEvents(session, opts).catch((err) => {
    if (!abortController.signal.aborted) {
      appLog('core:structured', 'error', 'Structured session stream failed', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
      const errorEvent: StructuredEvent = {
        type: 'error',
        timestamp: Date.now(),
        data: { code: 'ADAPTER_ERROR', message: err instanceof Error ? err.message : String(err) },
      };
      broadcastEvent(agentId, errorEvent, logStream);
    }
  });
}

async function consumeEvents(session: StructuredSession, opts: StructuredSessionOpts): Promise<void> {
  const { adapter, agentId, logStream, abortController } = session;

  try {
    const stream = adapter.start(opts);

    for await (const event of stream) {
      if (abortController.signal.aborted) break;
      broadcastEvent(agentId, event, logStream);
    }
  } finally {
    cleanupSession(agentId);
  }
}

function broadcastEvent(agentId: string, event: StructuredEvent, logStream: fs.WriteStream): void {
  // Persist to disk
  const serialized = JSON.stringify(event);
  logStream.write(serialized + '\n');

  // Send to renderer
  broadcastToAllWindows(IPC.AGENT.STRUCTURED_EVENT, agentId, event);

  // Forward to annex event bus as a hook event for cross-process monitoring
  const hookEvent = mapStructuredToHookEvent(event);
  if (hookEvent) {
    annexEventBus.emitHookEvent(agentId, hookEvent);
  }
}

/**
 * Map a StructuredEvent to a NormalizedHookEvent for the annex event bus.
 * Only maps events that have meaningful hook equivalents.
 */
function mapStructuredToHookEvent(event: StructuredEvent): AgentHookEvent | null {
  switch (event.type) {
    case 'tool_start': {
      const data = event.data as { name: string; input: Record<string, unknown> };
      return { kind: 'pre_tool', toolName: data.name, toolInput: data.input, timestamp: event.timestamp };
    }
    case 'tool_end': {
      const data = event.data as { name: string };
      return { kind: 'post_tool', toolName: data.name, timestamp: event.timestamp };
    }
    case 'permission_request': {
      const data = event.data as { toolName: string; toolInput: Record<string, unknown>; description: string };
      return { kind: 'permission_request', toolName: data.toolName, toolInput: data.toolInput, message: data.description, timestamp: event.timestamp };
    }
    case 'error': {
      const data = event.data as { message: string };
      return { kind: 'tool_error', message: data.message, timestamp: event.timestamp };
    }
    case 'end': {
      const data = event.data as { summary?: string };
      return { kind: 'stop', message: data.summary, timestamp: event.timestamp };
    }
    default:
      return null;
  }
}

// ── Bidirectional communication ─────────────────────────────────────────────

/** Send a follow-up user message to a running structured session. */
export async function sendMessage(agentId: string, message: string): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) {
    throw new Error(`No structured session found for agent ${agentId}`);
  }
  await session.adapter.sendMessage(message);
}

/** Respond to a permission request in a running structured session. */
export async function respondToPermission(
  agentId: string,
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) {
    throw new Error(`No structured session found for agent ${agentId}`);
  }
  await session.adapter.respondToPermission(requestId, approved, reason);
}

// ── Cancellation & cleanup ──────────────────────────────────────────────────

/** Cancel a running structured session. */
export async function cancelSession(agentId: string): Promise<void> {
  const session = sessions.get(agentId);
  if (!session) return;

  session.abortController.abort();
  try {
    await session.adapter.cancel();
  } catch (err) {
    appLog('core:structured', 'warn', 'Error cancelling structured adapter', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
  cleanupSession(agentId);
}

function cleanupSession(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) return;

  try {
    session.adapter.dispose();
  } catch {
    // Adapter cleanup is best-effort
  }
  try {
    session.logStream.end();
  } catch {
    // Stream cleanup is best-effort
  }
  sessions.delete(agentId);

  appLog('core:structured', 'info', 'Structured session cleaned up', {
    meta: { agentId },
  });
}

// ── Query ───────────────────────────────────────────────────────────────────

/** Check if an agent has an active structured session. */
export function isStructuredSession(agentId: string): boolean {
  return sessions.has(agentId);
}

/** Get the number of active structured sessions (for diagnostics). */
export function activeSessionCount(): number {
  return sessions.size;
}
