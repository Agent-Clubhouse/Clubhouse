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
import * as eventReplay from './annex-event-replay';
import * as permissionQueue from './annex-permission-queue';
import { spawnAgent, getAvailableOrchestrators, isHeadlessAgent } from './agent-system';
import { appLog } from './log-service';
import { THEMES } from '../../renderer/themes';
import { generateQuickName } from '../../shared/name-generator';
import type {
  AnnexStatus,
  AgentHookEvent,
  AgentDetailedStatus,
  AgentDetailedState,
  HookEventKind,
  ThemeColors,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

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
let unsubAgentSpawned: (() => void) | null = null;
let unsubPermissionRequest: (() => void) | null = null;
let staleEvictionInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Detailed status cache (Issue 3)
// ---------------------------------------------------------------------------

const detailedStatusCache = new Map<string, AgentDetailedStatus>();
const STALE_THRESHOLD_MS = 30_000;

function hookEventToDetailedStatus(event: AgentHookEvent): AgentDetailedStatus {
  const KIND_STATE_MAP: Record<HookEventKind, AgentDetailedState> = {
    pre_tool: 'working',
    post_tool: 'idle',
    tool_error: 'tool_error',
    stop: 'idle',
    notification: 'idle',
    permission_request: 'needs_permission',
  };

  const state = KIND_STATE_MAP[event.kind] || 'idle';
  let message = 'Idle';

  switch (event.kind) {
    case 'pre_tool':
      message = event.toolVerb || 'Working';
      break;
    case 'post_tool':
      message = 'Thinking';
      break;
    case 'tool_error':
      message = event.toolName ? `${event.toolName} failed` : 'Tool failed';
      break;
    case 'stop':
      message = 'Idle';
      break;
    case 'notification':
      message = event.message || 'Notification';
      break;
    case 'permission_request':
      message = 'Needs permission';
      break;
  }

  return { state, message, toolName: event.toolName, timestamp: event.timestamp };
}

function getDetailedStatus(agentId: string): AgentDetailedStatus | null {
  const status = detailedStatusCache.get(agentId);
  if (!status) return null;

  // Clear stale statuses (except needs_permission, which persists)
  if (status.state !== 'needs_permission' && Date.now() - status.timestamp > STALE_THRESHOLD_MS) {
    detailedStatusCache.delete(agentId);
    return null;
  }
  return status;
}

// ---------------------------------------------------------------------------
// Quick agent tracking (Issue 6)
// ---------------------------------------------------------------------------

interface TrackedQuickAgent {
  id: string;
  name: string;
  kind: 'quick';
  status: string;
  prompt: string;
  model: string | null;
  orchestrator: string | null;
  freeAgentMode: boolean;
  parentAgentId: string | null;
  projectId: string;
  spawnedAt: number;
}

const trackedQuickAgents = new Map<string, TrackedQuickAgent>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Agent mapping (Issue 1 — defaults + runtime status)
// ---------------------------------------------------------------------------

function mapDurableAgent(d: ReturnType<typeof agentConfig.listDurable>[number]) {
  const agentId = d.id;
  const isRunning = ptyManager.isRunning(agentId) || isHeadlessAgent(agentId);
  const status = isRunning ? 'running' : 'sleeping';

  return {
    id: d.id,
    name: d.name,
    kind: 'durable' as const,
    color: d.color,
    branch: d.branch || null,
    model: d.model || null,
    orchestrator: d.orchestrator || null,
    freeAgentMode: d.freeAgentMode ?? false,
    icon: d.icon || null,
    status,
    detailedStatus: isRunning ? getDetailedStatus(agentId) : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot (Issues 1, 3, 6, 8)
// ---------------------------------------------------------------------------

function buildSnapshot(): object {
  const projects = projectStore.list();
  const agents: Record<string, unknown[]> = {};
  const quickAgents: Record<string, unknown[]> = {};

  for (const proj of projects) {
    const durables = agentConfig.listDurable(proj.path);
    agents[proj.id] = durables.map(mapDurableAgent);
    quickAgents[proj.id] = [];
  }

  // Add tracked quick agents to their project buckets
  for (const qa of trackedQuickAgents.values()) {
    if (!quickAgents[qa.projectId]) {
      quickAgents[qa.projectId] = [];
    }
    quickAgents[qa.projectId].push({
      ...qa,
      detailedStatus: getDetailedStatus(qa.id),
    });
  }

  return {
    projects,
    agents,
    quickAgents,
    theme: getThemeColors(),
    orchestrators: getOrchestratorsMap(),
    pendingPermissions: permissionQueue.listPending(),
    lastSeq: eventReplay.getLastSeq(),
  };
}

// ---------------------------------------------------------------------------
// WebSocket broadcast with replay buffer (Issue 8)
// ---------------------------------------------------------------------------

function broadcastWs(message: object): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/** Broadcast a message and push it to the replay buffer. */
function broadcastAndBuffer(type: string, payload: unknown): void {
  const seq = eventReplay.pushEvent(type, payload);
  const message = { type, payload, seq };
  broadcastWs(message);
}

// ---------------------------------------------------------------------------
// Icon endpoints (Issue 2)
// ---------------------------------------------------------------------------

function handleIconRequest(res: http.ServerResponse, url: string): boolean {
  // GET /api/v1/icons/agent/:agentId
  const agentIconMatch = url.match(/^\/api\/v1\/icons\/agent\/([^/]+)$/);
  if (agentIconMatch) {
    const agentId = decodeURIComponent(agentIconMatch[1]);
    // Find the agent's icon filename across all projects
    const projects = projectStore.list();
    let iconFilename: string | undefined;
    for (const proj of projects) {
      const durables = agentConfig.listDurable(proj.path);
      const agent = durables.find((d) => d.id === agentId);
      if (agent?.icon) {
        iconFilename = agent.icon;
        break;
      }
    }
    if (!iconFilename) {
      sendJson(res, 404, { error: 'icon_not_found' });
      return true;
    }
    const dataUrl = agentConfig.readAgentIconData(iconFilename);
    if (!dataUrl) {
      sendJson(res, 404, { error: 'icon_not_found' });
      return true;
    }
    // Parse data URL → binary
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      sendJson(res, 500, { error: 'invalid_icon_data' });
      return true;
    }
    const [, mime, base64] = match;
    const buf = Buffer.from(base64, 'base64');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buf);
    return true;
  }

  // GET /api/v1/icons/project/:projectId
  const projectIconMatch = url.match(/^\/api\/v1\/icons\/project\/([^/]+)$/);
  if (projectIconMatch) {
    const projectId = decodeURIComponent(projectIconMatch[1]);
    const project = projectStore.list().find((p) => p.id === projectId);
    if (!project?.icon) {
      sendJson(res, 404, { error: 'icon_not_found' });
      return true;
    }
    const dataUrl = projectStore.readIconData(project.icon);
    if (!dataUrl) {
      sendJson(res, 404, { error: 'icon_not_found' });
      return true;
    }
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      sendJson(res, 500, { error: 'invalid_icon_data' });
      return true;
    }
    const [, mime, base64] = match;
    const buf = Buffer.from(base64, 'base64');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buf);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Quick agent helpers (Issue 6)
// ---------------------------------------------------------------------------

function findProjectById(projectId: string) {
  return projectStore.list().find((p) => p.id === projectId);
}

function findAgentAcrossProjects(agentId: string): { config: ReturnType<typeof agentConfig.listDurable>[number]; project: ReturnType<typeof projectStore.list>[number] } | null {
  for (const proj of projectStore.list()) {
    const durables = agentConfig.listDurable(proj.path);
    const agent = durables.find((d) => d.id === agentId);
    if (agent) return { config: agent, project: proj };
  }
  return null;
}

async function handleSpawnQuickAgent(
  res: http.ServerResponse,
  projectId: string,
  parentAgentId: string | null,
  body: Record<string, unknown>,
): Promise<void> {
  const prompt = body.prompt as string | undefined;
  if (!prompt) {
    sendJson(res, 400, { error: 'missing_prompt' });
    return;
  }

  const project = findProjectById(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'project_not_found' });
    return;
  }

  // Resolve defaults from parent agent if applicable
  let cwd = project.path;
  let defaultOrchestrator = project.orchestrator || 'claude-code';
  let defaultModel: string | undefined;
  let defaultFreeAgentMode = false;
  let systemPrompt: string | undefined;

  if (parentAgentId) {
    const parentInfo = findAgentAcrossProjects(parentAgentId);
    if (!parentInfo) {
      sendJson(res, 404, { error: 'agent_not_found' });
      return;
    }
    cwd = parentInfo.config.worktreePath || project.path;
    defaultOrchestrator = parentInfo.config.orchestrator || defaultOrchestrator;
    defaultModel = parentInfo.config.quickAgentDefaults?.defaultModel || parentInfo.config.model;
    defaultFreeAgentMode = parentInfo.config.quickAgentDefaults?.freeAgentMode ?? parentInfo.config.freeAgentMode ?? false;
    systemPrompt = (body.systemPrompt as string | undefined) || parentInfo.config.quickAgentDefaults?.systemPrompt;
  }

  const agentId = `quick_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const name = generateQuickName();
  const model = (body.model as string | undefined) || defaultModel;
  const orchestrator = (body.orchestrator as string | undefined) || defaultOrchestrator;
  const freeAgentMode = (body.freeAgentMode as boolean | undefined) ?? defaultFreeAgentMode;

  // Track the quick agent
  const tracked: TrackedQuickAgent = {
    id: agentId,
    name,
    kind: 'quick',
    status: 'starting',
    prompt,
    model: model || null,
    orchestrator: orchestrator || null,
    freeAgentMode,
    parentAgentId,
    projectId,
    spawnedAt: Date.now(),
  };
  trackedQuickAgents.set(agentId, tracked);

  // Broadcast agent:spawned
  broadcastAndBuffer('agent:spawned', {
    id: agentId,
    name,
    kind: 'quick',
    status: 'starting',
    prompt,
    model: model || null,
    orchestrator: orchestrator || null,
    freeAgentMode,
    parentAgentId,
    projectId,
  });

  // Spawn the agent
  try {
    await spawnAgent({
      agentId,
      projectPath: project.path,
      cwd,
      kind: 'quick',
      model,
      mission: prompt,
      systemPrompt,
      orchestrator,
      freeAgentMode,
    });

    tracked.status = 'running';

    sendJson(res, 201, {
      id: agentId,
      name,
      kind: 'quick',
      status: 'starting',
      prompt,
      model: model || null,
      orchestrator: orchestrator || null,
      freeAgentMode,
      parentAgentId,
      projectId,
    });
  } catch (err) {
    tracked.status = 'failed';
    trackedQuickAgents.delete(agentId);
    appLog('core:annex', 'error', 'Failed to spawn quick agent', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    sendJson(res, 500, { error: 'spawn_failed' });
  }
}

// ---------------------------------------------------------------------------
// Wake sleeping agent (Issue 7)
// ---------------------------------------------------------------------------

async function handleWakeAgent(
  res: http.ServerResponse,
  agentId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const message = body.message as string | undefined;
  if (!message) {
    sendJson(res, 400, { error: 'missing_message' });
    return;
  }

  const agentInfo = findAgentAcrossProjects(agentId);
  if (!agentInfo) {
    sendJson(res, 404, { error: 'agent_not_found' });
    return;
  }

  // Check if already running
  if (ptyManager.isRunning(agentId) || isHeadlessAgent(agentId)) {
    sendJson(res, 409, { error: 'agent_already_running' });
    return;
  }

  const { config, project } = agentInfo;
  const model = (body.model as string | undefined) || config.model;
  const cwd = config.worktreePath || project.path;

  try {
    await spawnAgent({
      agentId: config.id,
      projectPath: project.path,
      cwd,
      kind: 'durable',
      model,
      mission: message,
      orchestrator: config.orchestrator,
      freeAgentMode: config.freeAgentMode,
    });

    // Broadcast agent:woken
    broadcastAndBuffer('agent:woken', {
      agentId: config.id,
      message,
      source: 'annex',
    });

    sendJson(res, 200, {
      id: config.id,
      name: config.name,
      kind: 'durable',
      status: 'starting',
      message,
      model: model || null,
      orchestrator: config.orchestrator || null,
      color: config.color,
      branch: config.branch || null,
      freeAgentMode: config.freeAgentMode ?? false,
    });
  } catch (err) {
    appLog('core:annex', 'error', 'Failed to wake agent', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    sendJson(res, 500, { error: 'wake_failed' });
  }
}

// ---------------------------------------------------------------------------
// Permission response (Issue 4)
// ---------------------------------------------------------------------------

function handlePermissionResponse(
  res: http.ServerResponse,
  agentId: string,
  body: Record<string, unknown>,
): void {
  const decision = body.decision as string | undefined;
  const requestId = body.requestId as string | undefined;

  if (!decision || (decision !== 'allow' && decision !== 'deny')) {
    sendJson(res, 400, { error: 'invalid_decision' });
    return;
  }

  if (!requestId) {
    sendJson(res, 400, { error: 'missing_request_id' });
    return;
  }

  const resolved = permissionQueue.resolvePermission(requestId, decision);
  if (!resolved) {
    sendJson(res, 404, { error: 'request_not_found' });
    return;
  }

  // Broadcast confirmation
  broadcastAndBuffer('permission:response', {
    requestId,
    agentId,
    decision,
  });

  // Clear the needs_permission detailed status
  if (decision === 'allow' || decision === 'deny') {
    const current = detailedStatusCache.get(agentId);
    if (current?.state === 'needs_permission') {
      detailedStatusCache.delete(agentId);
    }
  }

  sendJson(res, 200, { ok: true, requestId, decision });
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

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
    const project = findProjectById(projectId);
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

  // --- Icon endpoints (Issue 2) ---
  if (method === 'GET' && handleIconRequest(res, url)) {
    return;
  }

  // --- POST endpoints (Issues 4, 6, 7) ---

  // POST /api/v1/projects/:id/agents/quick
  const quickProjectMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents\/quick$/);
  if (method === 'POST' && quickProjectMatch) {
    const projectId = decodeURIComponent(quickProjectMatch[1]);
    readBody(req).then((raw) => {
      const body = parseJsonBody(raw);
      if (!body) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      handleSpawnQuickAgent(res, projectId, null, body);
    });
    return;
  }

  // POST /api/v1/agents/:id/agents/quick
  const quickAgentMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/agents\/quick$/);
  if (method === 'POST' && quickAgentMatch) {
    const parentAgentId = decodeURIComponent(quickAgentMatch[1]);
    const parentInfo = findAgentAcrossProjects(parentAgentId);
    if (!parentInfo) {
      sendJson(res, 404, { error: 'agent_not_found' });
      return;
    }
    readBody(req).then((raw) => {
      const body = parseJsonBody(raw);
      if (!body) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      handleSpawnQuickAgent(res, parentInfo.project.id, parentAgentId, body);
    });
    return;
  }

  // POST /api/v1/agents/:id/wake
  const wakeMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/wake$/);
  if (method === 'POST' && wakeMatch) {
    const agentId = decodeURIComponent(wakeMatch[1]);
    readBody(req).then((raw) => {
      const body = parseJsonBody(raw);
      if (!body) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      handleWakeAgent(res, agentId, body);
    });
    return;
  }

  // POST /api/v1/agents/:id/permission-response
  const permissionMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/permission-response$/);
  if (method === 'POST' && permissionMatch) {
    const agentId = decodeURIComponent(permissionMatch[1]);
    readBody(req).then((raw) => {
      const body = parseJsonBody(raw);
      if (!body) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      handlePermissionResponse(res, agentId, body);
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// WebSocket message handler (Issue 8 — bidirectional)
// ---------------------------------------------------------------------------

function handleWsMessage(ws: WebSocket, data: string): void {
  let msg: { type?: string; since?: number };
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  if (msg.type === 'replay' && typeof msg.since === 'number') {
    const events = eventReplay.getEventsSince(msg.since);

    if (events === null) {
      // Gap — client's seq is too old for the buffer
      ws.send(JSON.stringify({
        type: 'replay:gap',
        oldestAvailable: eventReplay.getOldestSeq(),
        lastSeq: eventReplay.getLastSeq(),
      }));
      return;
    }

    ws.send(JSON.stringify({
      type: 'replay:start',
      fromSeq: events.length > 0 ? events[0].seq : msg.since,
      toSeq: eventReplay.getLastSeq(),
      count: events.length,
    }));

    for (const event of events) {
      ws.send(JSON.stringify({
        type: event.type,
        payload: event.payload,
        seq: event.seq,
        replayed: true,
      }));
    }

    ws.send(JSON.stringify({ type: 'replay:end' }));
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

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

    // Listen for client messages (replay requests)
    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString());
    });
  });

  // Subscribe to event bus
  annexEventBus.setActive(true);

  unsubPtyData = annexEventBus.onPtyData((agentId, data) => {
    broadcastAndBuffer('pty:data', { agentId, data });
  });

  unsubHookEvent = annexEventBus.onHookEvent((agentId, event) => {
    // Update detailed status cache
    detailedStatusCache.set(agentId, hookEventToDetailedStatus(event));

    broadcastAndBuffer('hook:event', { agentId, event });
  });

  unsubPtyExit = annexEventBus.onPtyExit((agentId, exitCode) => {
    // Clear detailed status for exited agent
    detailedStatusCache.delete(agentId);
    // Clear pending permissions for exited agent
    permissionQueue.clearForAgent(agentId);
    // Clear replay buffer events for this agent
    eventReplay.clearForAgent(agentId);

    broadcastAndBuffer('pty:exit', { agentId, exitCode });

    // If this was a tracked quick agent, broadcast completion
    const tracked = trackedQuickAgents.get(agentId);
    if (tracked) {
      tracked.status = exitCode === 0 ? 'completed' : 'failed';
      broadcastAndBuffer('agent:completed', {
        id: agentId,
        kind: 'quick',
        status: tracked.status,
        exitCode,
        projectId: tracked.projectId,
        parentAgentId: tracked.parentAgentId,
      });
      // Remove from tracked list after a short delay (so clients can read the final state)
      setTimeout(() => {
        trackedQuickAgents.delete(agentId);
      }, 60_000);
    }
  });

  unsubAgentSpawned = annexEventBus.onAgentSpawned((agentId, kind, projectId, meta) => {
    broadcastAndBuffer('agent:spawned', { id: agentId, kind, projectId, ...meta });
  });

  // Subscribe to permission requests from the queue
  unsubPermissionRequest = permissionQueue.onPermissionRequest((permission) => {
    broadcastAndBuffer('permission:request', {
      requestId: permission.requestId,
      agentId: permission.agentId,
      toolName: permission.toolName,
      toolInput: permission.toolInput,
      message: permission.message,
      timeout: permission.timeoutMs,
      deadline: permission.createdAt + permission.timeoutMs,
    });
  });

  // Periodically evict stale replay buffer entries
  staleEvictionInterval = setInterval(() => {
    eventReplay.evictStale();
  }, 60_000);

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
  unsubAgentSpawned?.();
  unsubPermissionRequest?.();
  unsubPtyData = null;
  unsubHookEvent = null;
  unsubPtyExit = null;
  unsubAgentSpawned = null;
  unsubPermissionRequest = null;

  if (staleEvictionInterval) {
    clearInterval(staleEvictionInterval);
    staleEvictionInterval = null;
  }

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
  detailedStatusCache.clear();
  trackedQuickAgents.clear();
  eventReplay.reset();
  permissionQueue.reset();

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
