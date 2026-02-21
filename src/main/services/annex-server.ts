import * as http from 'http';
import { randomInt, randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import Bonjour, { Service } from 'bonjour-service';
import * as annexEventBus from './annex-event-bus';
import * as annexSettings from './annex-settings';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import * as ptyManager from './pty-manager';
import * as themeService from './theme-service';
import { getAvailableOrchestrators } from './agent-system';
import { appLog } from './log-service';
import { THEMES } from '../../renderer/themes';
import type { AnnexStatus, AgentHookEvent, ThemeColors } from '../../shared/types';

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let bonjour: InstanceType<typeof Bonjour> | null = null;
let bonjourService: Service | null = null;
let serverPort = 0;
let currentPin = '';
const sessionTokens = new Set<string>();

let unsubPtyData: (() => void) | null = null;
let unsubHookEvent: (() => void) | null = null;
let unsubPtyExit: (() => void) | null = null;

function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function isValidToken(token: string | undefined): boolean {
  return !!token && sessionTokens.has(token);
}

function extractBearerToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return undefined;
  return auth.slice(7);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function getThemeColors(): ThemeColors {
  const { themeId } = themeService.getSettings();
  const theme = THEMES[themeId];
  return theme ? theme.colors : THEMES['catppuccin-mocha'].colors;
}

function getOrchestratorsMap(): Record<string, { displayName: string; shortName: string; badge?: string }> {
  const result: Record<string, { displayName: string; shortName: string; badge?: string }> = {};
  for (const o of getAvailableOrchestrators()) {
    result[o.id] = { displayName: o.displayName, shortName: o.shortName, badge: o.badge };
  }
  return result;
}

function mapDurableAgent(d: ReturnType<typeof agentConfig.listDurable>[number]) {
  return {
    id: d.id,
    name: d.name,
    kind: 'durable' as const,
    color: d.color,
    branch: d.branch,
    model: d.model,
    orchestrator: d.orchestrator || null,
    freeAgentMode: d.freeAgentMode || false,
    icon: d.icon || null,
  };
}

function buildSnapshot(): object {
  const projects = projectStore.list();
  const agents: Record<string, unknown[]> = {};
  for (const proj of projects) {
    const durables = agentConfig.listDurable(proj.path);
    agents[proj.id] = durables.map(mapDurableAgent);
  }
  return {
    projects,
    agents,
    theme: getThemeColors(),
    orchestrators: getOrchestratorsMap(),
  };
}

function broadcastWs(message: object): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // CORS headers for local network
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /pair — no auth required
  if (method === 'POST' && url === '/pair') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      try {
        const { pin } = JSON.parse(body);
        if (pin === currentPin) {
          const token = randomUUID();
          sessionTokens.add(token);
          sendJson(res, 200, { token });
        } else {
          sendJson(res, 401, { error: 'invalid_pin' });
        }
      } catch {
        sendJson(res, 400, { error: 'invalid_json' });
      }
    });
    return;
  }

  // All other endpoints require auth
  const token = extractBearerToken(req);
  if (!isValidToken(token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  // GET /api/v1/status
  if (method === 'GET' && url === '/api/v1/status') {
    const settings = annexSettings.getSettings();
    const projects = projectStore.list();
    sendJson(res, 200, {
      version: '1',
      deviceName: settings.deviceName,
      agentCount: projects.reduce((sum, p) => sum + agentConfig.listDurable(p.path).length, 0),
      orchestratorCount: getAvailableOrchestrators().length,
    });
    return;
  }

  // GET /api/v1/projects
  if (method === 'GET' && url === '/api/v1/projects') {
    sendJson(res, 200, projectStore.list());
    return;
  }

  // GET /api/v1/projects/:id/agents
  const agentsMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents$/);
  if (method === 'GET' && agentsMatch) {
    const projectId = decodeURIComponent(agentsMatch[1]);
    const projects = projectStore.list();
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    const durables = agentConfig.listDurable(project.path);
    sendJson(res, 200, durables.map(mapDurableAgent));
    return;
  }

  // GET /api/v1/agents/:id/buffer
  const bufferMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/buffer$/);
  if (method === 'GET' && bufferMatch) {
    const agentId = decodeURIComponent(bufferMatch[1]);
    const buffer = ptyManager.getBuffer(agentId);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(buffer),
    });
    res.end(buffer);
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

export function start(): void {
  if (httpServer) return;

  currentPin = generatePin();

  httpServer = http.createServer(handleRequest);

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host}`);

    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = urlObj.searchParams.get('token');
    if (!isValidToken(token || undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    // Send snapshot on connect
    ws.send(JSON.stringify({ type: 'snapshot', payload: buildSnapshot() }));
  });

  // Subscribe to event bus
  annexEventBus.setActive(true);

  unsubPtyData = annexEventBus.onPtyData((agentId, data) => {
    broadcastWs({ type: 'pty:data', payload: { agentId, data } });
  });

  unsubHookEvent = annexEventBus.onHookEvent((agentId, event) => {
    broadcastWs({ type: 'hook:event', payload: { agentId, event } });
  });

  unsubPtyExit = annexEventBus.onPtyExit((agentId, exitCode) => {
    broadcastWs({ type: 'pty:exit', payload: { agentId, exitCode } });
  });

  httpServer.listen(0, '0.0.0.0', () => {
    const addr = httpServer?.address();
    if (addr && typeof addr === 'object') {
      serverPort = addr.port;
      appLog('core:annex', 'info', `Annex server listening on 0.0.0.0:${serverPort}`);

      // Publish mDNS
      try {
        bonjour = new Bonjour();
        const settings = annexSettings.getSettings();
        bonjourService = bonjour.publish({
          name: settings.deviceName,
          type: 'clubhouse-annex',
          port: serverPort,
          txt: { v: '1' },
        });
        appLog('core:annex', 'info', 'mDNS service published', {
          meta: { name: settings.deviceName, port: serverPort },
        });
      } catch (err) {
        appLog('core:annex', 'error', 'Failed to publish mDNS', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });
}

export function stop(): void {
  // Unsubscribe from event bus
  unsubPtyData?.();
  unsubHookEvent?.();
  unsubPtyExit?.();
  unsubPtyData = null;
  unsubHookEvent = null;
  unsubPtyExit = null;

  annexEventBus.setActive(false);

  // Close all WebSocket clients
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    wss.close();
    wss = null;
  }

  // Un-publish mDNS
  if (bonjourService) {
    try { bonjourService.stop?.(); } catch { /* ignore */ }
    bonjourService = null;
  }
  if (bonjour) {
    try { bonjour.destroy(); } catch { /* ignore */ }
    bonjour = null;
  }

  // Close HTTP server
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  serverPort = 0;
  currentPin = '';
  sessionTokens.clear();

  appLog('core:annex', 'info', 'Annex server stopped');
}

export function getStatus(): AnnexStatus {
  return {
    advertising: !!bonjourService,
    port: serverPort,
    pin: currentPin,
    connectedCount: wss ? wss.clients.size : 0,
  };
}

/** Broadcast theme change to all connected WS clients. */
export function broadcastThemeChanged(): void {
  broadcastWs({ type: 'theme:changed', payload: getThemeColors() });
}

export function regeneratePin(): void {
  currentPin = generatePin();
  sessionTokens.clear();
  // Close all WS clients so they must re-pair
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
  }
}
