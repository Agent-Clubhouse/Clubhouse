/**
 * Bridge Server — HTTP server on localhost that handles MCP JSON-RPC
 * requests from bridge scripts. Same lifecycle pattern as hook-server.ts.
 */

import * as http from 'http';
import { appLog } from '../log-service';
import { getAgentNonce } from '../agent-registry';
import { getScopedToolList, callTool, parseToolName, buildToolKey } from './tool-registry';
import { bindingManager } from './binding-manager';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { IPC } from '../../../shared/ipc-channels';
import type { JsonRpcRequest, JsonRpcResponse } from './types';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const MCP_PROTOCOL_VERSION = '2024-11-05';

let server: http.Server | null = null;
let serverPort = 0;
let readyPromise: Promise<number> | null = null;

/** Active SSE connections keyed by agentId. */
const sseConnections = new Map<string, Set<http.ServerResponse>>();

export function getPort(): number {
  return serverPort;
}

export function waitReady(): Promise<number> {
  if (serverPort > 0) return Promise.resolve(serverPort);
  if (readyPromise) return readyPromise;
  return Promise.reject(new Error('MCP bridge server not started'));
}

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

/** Parse route: /mcp/:agentId or /mcp/:agentId/:action */
function parseRoute(url: string): { agentId: string; action: string } | null {
  if (!url.startsWith('/mcp/')) return null;
  const rest = url.slice('/mcp/'.length);
  const parts = rest.split('/');
  if (parts.length < 1 || !parts[0]) return null;
  return { agentId: parts[0], action: parts.length > 1 ? parts.slice(1).join('/') : '' };
}

function validateNonce(agentId: string, req: http.IncomingMessage): boolean {
  const expectedNonce = getAgentNonce(agentId);
  const receivedNonce = req.headers['x-clubhouse-nonce'] as string | undefined;
  if (!expectedNonce || receivedNonce !== expectedNonce) {
    if (!expectedNonce) {
      appLog('core:mcp', 'warn', 'Rejected MCP request — no nonce registered for agent', { meta: { agentId } });
    } else {
      appLog('core:mcp', 'warn', 'Rejected MCP request with invalid nonce', { meta: { agentId } });
    }
    return false;
  }
  return true;
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function jsonRpcSuccess(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle MCP initialize handshake. */
function handleInitialize(id: number | string | null): JsonRpcResponse {
  return jsonRpcSuccess(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: true },
    },
    serverInfo: {
      name: 'clubhouse',
      version: '1.0.0',
    },
  });
}

/** Handle tools/list request. */
function handleToolsList(agentId: string, id: number | string | null): JsonRpcResponse {
  const tools = getScopedToolList(agentId);
  appLog('core:mcp', 'info', 'Tools list requested', {
    meta: { agentId, toolCount: tools.length, toolNames: tools.map(t => t.name) },
  });
  return jsonRpcSuccess(id, { tools });
}

/** Handle tools/call request. */
async function handleToolsCall(
  agentId: string,
  id: number | string | null,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const toolName = params.name as string;
  const args = (params.arguments as Record<string, unknown>) || {};

  if (!toolName) {
    return jsonRpcError(id, -32602, 'Missing tool name');
  }

  appLog('core:mcp', 'info', 'Tool call', {
    meta: { agentId, toolName, args: Object.keys(args) },
  });

  try {
    const result = await callTool(agentId, toolName, args);
    const errorText = result.isError
      ? result.content?.find(c => c.type === 'text')?.text
      : undefined;
    appLog('core:mcp', result.isError ? 'warn' : 'info', `Tool call ${result.isError ? 'returned error' : 'completed'}`, {
      meta: {
        agentId,
        toolName,
        ...(errorText ? { errorDetail: errorText } : {}),
      },
    });

    // Broadcast tool activity for wire animation (even on error — the agent tried)
    const parsed = parseToolName(toolName);
    if (parsed) {
      const bindings = bindingManager.getBindingsForAgent(agentId);
      const binding = bindings.find(b => {
        const expectedPrefix = b.targetKind === 'agent' ? 'clubhouse'
          : b.targetKind === 'group-project' ? 'group'
          : b.targetKind === 'agent-queue' ? 'queue'
          : b.targetKind;
        return expectedPrefix === parsed.prefix && buildToolKey(b) === parsed.toolKey;
      });
      if (binding) {
        // read_output pulls data FROM the target → reverse direction
        const direction = parsed.suffix === 'read_output' ? 'reverse' : 'forward';
        broadcastToAllWindows(IPC.MCP_BINDING.TOOL_ACTIVITY, {
          sourceAgentId: agentId,
          targetId: binding.targetId,
          direction,
          toolSuffix: parsed.suffix,
          timestamp: Date.now(),
        });
      }
    }

    return jsonRpcSuccess(id, result);
  } catch (err) {
    appLog('core:mcp', 'error', 'Tool call threw exception', {
      meta: { agentId, toolName, error: err instanceof Error ? err.message : String(err) },
    });
    return jsonRpcError(id, -32000, err instanceof Error ? err.message : String(err));
  }
}

/** Handle SSE connection for tool list change notifications. */
function handleSSE(agentId: string, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial ping
  res.write('event: ping\ndata: {}\n\n');

  let connections = sseConnections.get(agentId);
  if (!connections) {
    connections = new Set();
    sseConnections.set(agentId, connections);
  }
  connections.add(res);

  res.on('close', () => {
    const conns = sseConnections.get(agentId);
    if (conns) {
      conns.delete(res);
      if (conns.size === 0) sseConnections.delete(agentId);
    }
  });
}

/** Send tools/list_changed notification to an agent's SSE connections. */
function notifyToolsChanged(agentId: string): void {
  const connections = sseConnections.get(agentId);
  if (!connections || connections.size === 0) return;

  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  });

  for (const res of connections) {
    try {
      res.write(`data: ${notification}\n\n`);
    } catch {
      // Connection dead — will be cleaned up on close event
    }
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const route = parseRoute(req.url || '');
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }

  const { agentId, action } = route;

  if (!validateNonce(agentId, req)) {
    res.writeHead(403);
    res.end();
    return;
  }

  // SSE endpoint
  if (req.method === 'GET' && action === 'events') {
    handleSSE(agentId, res);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const body = await readBody(req, res);
  if (body === null) return;

  let rpcRequest: JsonRpcRequest;
  try {
    rpcRequest = JSON.parse(body);
  } catch {
    jsonResponse(res, 200, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  const { method, id, params } = rpcRequest;

  let response: JsonRpcResponse;

  switch (method) {
    case 'initialize':
      response = handleInitialize(id ?? null);
      break;
    case 'notifications/initialized':
      // Client ack — no response needed
      appLog('core:mcp', 'info', 'Agent MCP connection initialized', { meta: { agentId } });
      res.writeHead(200);
      res.end();
      return;
    case 'tools/list':
      response = handleToolsList(agentId, id ?? null);
      break;
    case 'tools/call':
      response = await handleToolsCall(agentId, id ?? null, (params || {}) as Record<string, unknown>);
      break;
    default:
      response = jsonRpcError(id ?? null, -32601, `Method not found: ${method}`);
  }

  jsonResponse(res, 200, response);
}

let unsubscribeBindingChanges: (() => void) | null = null;

export function start(): Promise<number> {
  // Subscribe to binding changes to notify agents
  unsubscribeBindingChanges = bindingManager.onChange((agentId) => {
    notifyToolsChanged(agentId);
  });

  readyPromise = new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        appLog('core:mcp', 'info', `MCP bridge server listening on 127.0.0.1:${serverPort}`, {
          meta: { port: serverPort },
        });
        resolve(serverPort);
      } else {
        const err = new Error('Failed to get MCP bridge server address');
        appLog('core:mcp', 'error', err.message);
        reject(err);
      }
    });

    server.on('error', (err: Error) => {
      appLog('core:mcp', 'error', 'MCP bridge server error', {
        meta: { error: err.message, stack: err.stack },
      });
      reject(err);
    });
  });

  return readyPromise;
}

export function stop(): void {
  if (unsubscribeBindingChanges) {
    unsubscribeBindingChanges();
    unsubscribeBindingChanges = null;
  }

  // Close all SSE connections
  for (const connections of sseConnections.values()) {
    for (const res of connections) {
      try { res.end(); } catch { /* ignore */ }
    }
  }
  sseConnections.clear();

  if (server) {
    server.close();
    server = null;
    serverPort = 0;
    readyPromise = null;
    appLog('core:mcp', 'info', 'MCP bridge server stopped');
  }
}
