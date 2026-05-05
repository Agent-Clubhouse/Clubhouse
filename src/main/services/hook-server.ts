import * as http from 'http';
import { IPC } from '../../shared/ipc-channels';
import { getAgentProjectPath, getAgentOrchestrator, getAgentNonce, resolveOrchestrator } from './agent-registry';
import { isHookCapable } from '../orchestrators';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import * as permissionQueue from './annex-permission-queue';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Interval at which we scan for pending permissions older than
 * STUCK_PERMISSION_AGE_MS and log them at WARN.  Helps diagnose stuck-state
 * bugs (the kind that motivated this whole logging pass) by surfacing the
 * stuck queue state instead of leaving it invisible until a user reports it.
 */
const STUCK_PERMISSION_SCAN_INTERVAL_MS = 30_000;
const STUCK_PERMISSION_AGE_MS = 30_000;

let server: any = null;
let serverPort = 0;
let readyPromise: Promise<number> | null = null;
let stuckScanTimer: ReturnType<typeof setInterval> | null = null;

export function getPort(): number {
  return serverPort;
}

/** Wait for the server to be ready and return the port */
export function waitReady(): Promise<number> {
  if (serverPort > 0) return Promise.resolve(serverPort);
  if (readyPromise) return readyPromise;
  return Promise.reject(new Error('Hook server not started'));
}

/** Parse URL path into agentId and optional event hint */
function parseRoute(url: string): { agentId: string; eventHint?: string } | null {
  if (!url.startsWith('/hook/')) return null;
  const urlPath = url.slice('/hook/'.length);
  const slashIdx = urlPath.indexOf('/');
  const agentId = slashIdx === -1 ? urlPath : urlPath.slice(0, slashIdx);
  const eventHint = slashIdx === -1 ? undefined : urlPath.slice(slashIdx + 1);
  return agentId ? { agentId, eventHint } : null;
}

/** Read request body with size limit enforcement. Returns null if limit exceeded. */
function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let bodySize = 0;
    let limitExceeded = false;
    req.on('data', (chunk: Buffer) => {
      if (limitExceeded) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        limitExceeded = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!limitExceeded) resolve(body);
    });
  });
}

/** Validate nonce header against expected value for the agent */
function validateNonce(agentId: string, req: http.IncomingMessage): boolean {
  const expectedNonce = getAgentNonce(agentId);
  const receivedNonce = req.headers['x-clubhouse-nonce'] as string | undefined;
  if (!expectedNonce || receivedNonce !== expectedNonce) {
    if (!expectedNonce) {
      appLog('core:hook-server', 'warn', 'Rejected hook event — no nonce registered for agent', {
        meta: { agentId },
      });
    } else {
      appLog('core:hook-server', 'warn', 'Rejected hook event with invalid nonce', {
        meta: { agentId },
      });
    }
    return false;
  }
  return true;
}

/** Build hook event object from normalized event with resolved tool verb */
function buildHookEvent(
  provider: { toolVerb(name: string): string | undefined },
  normalized: { kind: string; toolName?: string; toolInput?: Record<string, unknown>; message?: string },
) {
  const toolVerb = normalized.toolName
    ? (provider.toolVerb(normalized.toolName) || `Using ${normalized.toolName}`)
    : undefined;

  return {
    kind: normalized.kind,
    toolName: normalized.toolName,
    toolInput: normalized.toolInput,
    message: normalized.message,
    toolVerb,
    timestamp: Date.now(),
  };
}

/**
 * Handle permission request lifecycle — holds the HTTP response open
 * until the Annex client sends a decision (allow/deny) or the request times
 * out.  Queue timeout < orchestrator hook timeout (see PERMISSION_QUEUE_TIMEOUT_MS)
 * so we always respond before the orchestrator kills the curl child.
 */
function handlePermissionRequest(
  agentId: string,
  normalized: { toolName?: string; toolInput?: Record<string, unknown>; message?: string },
  res: http.ServerResponse,
): void {
  const toolName = normalized.toolName || 'unknown';
  const startedAt = Date.now();
  const { requestId, decision } = permissionQueue.createPermission(
    agentId,
    toolName,
    normalized.toolInput,
    normalized.message,
  );

  decision.then((result) => {
    const permissionDecision = result === 'timeout' ? 'ask' : result;
    const responseBody = JSON.stringify({
      hookSpecificOutput: { permissionDecision },
    });
    const elapsedMs = Date.now() - startedAt;
    try {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(responseBody),
      });
      res.end(responseBody);
      appLog('core:hook-server', 'info', 'Permission hook decision sent to orchestrator', {
        meta: { agentId, requestId, toolName, decision: permissionDecision, queueResult: result, elapsedMs },
      });
    } catch (err) {
      appLog('core:hook-server', 'error', 'Failed to write permission response', {
        meta: {
          agentId,
          requestId,
          toolName,
          decision: permissionDecision,
          elapsedMs,
          error: err instanceof Error ? err.message : String(err),
          writableEnded: res.writableEnded,
        },
      });
    }

    // Broadcast permission_resolved so the renderer clears the
    // needs_permission status.  Without this, denied / timed-out
    // permissions leave the agent status stuck.
    const resolvedEvent = {
      kind: 'permission_resolved' as const,
      toolName,
      message: permissionDecision, // 'allow' | 'deny' | 'ask'
      timestamp: Date.now(),
    };
    broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, resolvedEvent);
    annexEventBus.emitHookEvent(agentId, resolvedEvent as any);
  }).catch((err) => {
    appLog('core:hook-server', 'error', 'Permission decision promise rejected', {
      meta: { agentId, requestId, toolName, error: err instanceof Error ? err.message : String(err) },
    });
    try { if (!res.writableEnded) res.end(); } catch { /* response already closed */ }
  });
}

/** Main request handler for the hook server */
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || !req.url?.startsWith('/hook/')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const route = parseRoute(req.url);
  if (!route) {
    res.writeHead(400);
    res.end();
    return;
  }

  const body = await readBody(req, res);
  if (body === null) return; // size limit exceeded, response already sent

  const { agentId, eventHint } = route;
  const bodyBytes = Buffer.byteLength(body);

  try {
    const raw = JSON.parse(body);
    // Inject event type hint from URL when not present in payload
    // (GHCP doesn't include hook_event_name in stdin, unlike Claude Code)
    if (eventHint && !raw.hook_event_name) {
      raw.hook_event_name = eventHint;
    }
    const projectPath = getAgentProjectPath(agentId);
    const orchestrator = getAgentOrchestrator(agentId);

    if (!projectPath) {
      appLog('core:hook-server', 'warn', 'Hook event ignored (no project path for agent)', {
        meta: { agentId, eventHint, orchestrator, bodyBytes },
      });
      res.writeHead(200);
      res.end();
      return;
    }

    if (!validateNonce(agentId, req)) {
      res.writeHead(200);
      res.end();
      return;
    }

    const provider = await resolveOrchestrator(projectPath, orchestrator);
    if (!isHookCapable(provider)) {
      appLog('core:hook-server', 'warn', 'Hook event ignored (provider not hook-capable)', {
        meta: { agentId, eventHint, orchestrator: provider?.id, bodyBytes },
      });
      res.writeHead(200);
      res.end();
      return;
    }
    const normalized = provider.parseHookEvent(raw);

    if (!normalized) {
      appLog('core:hook-server', 'warn', 'Hook event ignored (unknown event for orchestrator)', {
        meta: {
          agentId,
          eventHint,
          orchestrator: provider.id,
          rawEventName: raw?.hook_event_name,
          bodyBytes,
        },
      });
      res.writeHead(200);
      res.end();
      return;
    }

    appLog('core:hook-server', 'info', 'Hook event received', {
      meta: {
        agentId,
        eventHint,
        orchestrator: provider.id,
        kind: normalized.kind,
        toolName: normalized.toolName,
        bodyBytes,
      },
    });

    const hookEvent = buildHookEvent(provider, normalized);
    broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent);
    annexEventBus.emitHookEvent(agentId, hookEvent as any);

    if (normalized.kind === 'permission_request') {
      handlePermissionRequest(agentId, normalized, res);
      return; // Don't respond yet — the promise will handle it
    }
  } catch (err) {
    appLog('core:hook-server', 'error', 'Failed to parse hook event', {
      meta: { agentId, eventHint, bodyBytes, error: err instanceof Error ? err.message : String(err) },
    });
  }

  // For non-permission events, respond immediately
  res.writeHead(200);
  res.end();
}

/**
 * Periodic scan for stuck pending permissions.  Logs a WARN line for any
 * permission that has been pending longer than STUCK_PERMISSION_AGE_MS.
 * Without this, a stuck queue is silent until a user reports the symptom.
 */
function scanForStuckPermissions(): void {
  const now = Date.now();
  const pending = permissionQueue.listPending();
  for (const p of pending) {
    const ageMs = now - p.createdAt;
    if (ageMs >= STUCK_PERMISSION_AGE_MS) {
      const remainingMs = (p.createdAt + p.timeoutMs) - now;
      appLog('core:permission-queue', 'warn', 'Stuck pending permission', {
        meta: {
          requestId: p.requestId,
          agentId: p.agentId,
          toolName: p.toolName,
          ageMs,
          timeoutMs: p.timeoutMs,
          remainingMs,
        },
      });
    }
  }
}

export function start(): Promise<number> {
  readyPromise = new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        appLog('core:hook-server', 'info', `Hook server listening on 127.0.0.1:${serverPort}`, {
          meta: { port: serverPort },
        });
        if (!stuckScanTimer) {
          stuckScanTimer = setInterval(scanForStuckPermissions, STUCK_PERMISSION_SCAN_INTERVAL_MS);
          // Don't keep the event loop alive on the scan timer alone
          if (typeof stuckScanTimer.unref === 'function') stuckScanTimer.unref();
        }
        resolve(serverPort);
      } else {
        const err = new Error('Failed to get hook server address');
        appLog('core:hook-server', 'error', err.message);
        reject(err);
      }
    });

    server.on('error', (err: Error) => {
      appLog('core:hook-server', 'error', 'Hook server error', {
        meta: { error: err.message, stack: err.stack },
      });
      reject(err);
    });
  });

  return readyPromise;
}

export function stop(): void {
  if (stuckScanTimer) {
    clearInterval(stuckScanTimer);
    stuckScanTimer = null;
  }
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
    readyPromise = null;
  }
}
