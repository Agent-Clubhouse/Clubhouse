import * as http from 'http';
import { IPC } from '../../shared/ipc-channels';
import { getAgentProjectPath, getAgentOrchestrator, getAgentNonce, resolveOrchestrator } from './agent-registry';
import { isHookCapable } from '../orchestrators';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import * as annexEventBus from './annex-event-bus';
import * as permissionQueue from './annex-permission-queue';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

let server: any = null;
let serverPort = 0;
let readyPromise: Promise<number> | null = null;

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
 * until the Annex client sends a decision (allow/deny) or the request times out.
 */
function handlePermissionRequest(
  agentId: string,
  normalized: { toolName?: string; toolInput?: Record<string, unknown>; message?: string },
  res: http.ServerResponse,
): void {
  const toolName = normalized.toolName || 'unknown';
  const { decision } = permissionQueue.createPermission(
    agentId,
    toolName,
    normalized.toolInput,
    normalized.message,
    120_000, // 120 second timeout
  );

  decision.then((result) => {
    const permissionDecision = result === 'timeout' ? 'ask' : result;
    const responseBody = JSON.stringify({
      hookSpecificOutput: { permissionDecision },
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(responseBody),
    });
    res.end(responseBody);

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
    appLog('core:hook-server', 'error', 'Failed to send permission response', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
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

  try {
    const raw = JSON.parse(body);
    // Inject event type hint from URL when not present in payload
    // (GHCP doesn't include hook_event_name in stdin, unlike Claude Code)
    if (eventHint && !raw.hook_event_name) {
      raw.hook_event_name = eventHint;
    }
    const projectPath = getAgentProjectPath(agentId);
    const orchestrator = getAgentOrchestrator(agentId);

    if (projectPath) {
      if (!validateNonce(agentId, req)) {
        res.writeHead(200);
        res.end();
        return;
      }

      const provider = await resolveOrchestrator(projectPath, orchestrator);
      if (!isHookCapable(provider)) {
        res.writeHead(200);
        res.end();
        return;
      }
      const normalized = provider.parseHookEvent(raw);

      if (normalized) {
        const hookEvent = buildHookEvent(provider, normalized);
        broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent);
        annexEventBus.emitHookEvent(agentId, hookEvent as any);

        if (normalized.kind === 'permission_request') {
          handlePermissionRequest(agentId, normalized, res);
          return; // Don't respond yet — the promise will handle it
        }
      }
    }
  } catch (err) {
    appLog('core:hook-server', 'error', 'Failed to parse hook event', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }

  // For non-permission events, respond immediately
  res.writeHead(200);
  res.end();
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
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
    readyPromise = null;
  }
}
