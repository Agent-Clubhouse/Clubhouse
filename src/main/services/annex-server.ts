import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomInt, randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as annexTls from './annex-tls';
import Bonjour, { Service } from 'bonjour-service';
import * as annexEventBus from './annex-event-bus';
import * as annexSettings from './annex-settings';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import * as ptyManager from './pty-manager';
import * as themeService from './theme-service';
import * as eventReplay from './annex-event-replay';
import * as permissionQueue from './annex-permission-queue';
import * as structuredManager from './structured-manager';
import * as pluginManifestRegistry from './plugin-manifest-registry';
import { readKey as readPluginStorageKey, writeKey as writePluginStorageKey } from './plugin-storage';
import { groupProjectRegistry } from './group-project-registry';
import { getBulletinBoard } from './group-project-bulletin';
import { executeShoulderTap } from './group-project-shoulder-tap';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import * as fileService from './file-service';
import * as gitService from './git-service';
import { normalizeSessionEvents, buildSessionSummary, paginateEvents } from './session-reader';
import { isSessionCapable } from '../orchestrators';
import { spawnAgent, getAvailableOrchestrators, isHeadlessAgent, listSessions, resolveOrchestrator, resolveProfileEnv } from './agent-system';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import { THEMES } from '../../renderer/themes';
import { generateQuickName } from '../../shared/name-generator';
import { generateQuickAgentId } from '../../shared/agent-id';
import type { StructuredEvent } from '../../shared/structured-events';
import type {
  AnnexStatus,
  AgentHookEvent,
  AgentDetailedStatus,
  AgentDetailedState,
  AgentExecutionMode,
  HookEventKind,
  ThemeColors,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

// Pairing port (plain HTTP): POST /pair, GET /api/v1/identity, OPTIONS
let pairingServer: http.Server | null = null;
let pairingPort = 0;

// Main port (TLS with mTLS): all authenticated endpoints + WSS
let tlsServer: https.Server | null = null;
let httpServer: http.Server | null = null; // Legacy fallback — to be removed when mTLS is fully validated
let wss: WebSocketServer | null = null;
let bonjour: InstanceType<typeof Bonjour> | null = null;
let bonjourService: Service | null = null;
let serverPort = 0; // Main TLS port
let currentPin = '';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessionTokens = new Map<string, { issuedAt: number }>();

// Tag WebSocket connections with auth type for security gating
type WsAuthType = 'bearer' | 'mtls';
const wsAuthTypes = new WeakMap<WebSocket, WsAuthType>();
// Track peer fingerprint per WebSocket connection (for mTLS connections)
const wsPeerFingerprints = new WeakMap<WebSocket, string>();

let unsubPtyData: (() => void) | null = null;
let unsubHookEvent: (() => void) | null = null;
let unsubPtyExit: (() => void) | null = null;
let unsubAgentSpawned: (() => void) | null = null;
let unsubPermissionRequest: (() => void) | null = null;
let unsubStructuredEvent: (() => void) | null = null;
let unsubGroupProjectChanged: (() => void) | null = null;
let unsubBulletinMessage: (() => void) | null = null;
let unsubGroupProjectRegistry: (() => void) | null = null;
let staleEvictionInterval: ReturnType<typeof setInterval> | null = null;

/** Whether the satellite session is currently paused (tracks across reconnects). */
let sessionPaused = false;

/** Unsubscribe all event bus listeners to prevent accumulation on restart cycles. */
function unsubscribeEventBus(): void {
  unsubPtyData?.();
  unsubHookEvent?.();
  unsubPtyExit?.();
  unsubAgentSpawned?.();
  unsubPermissionRequest?.();
  unsubStructuredEvent?.();
  unsubGroupProjectChanged?.();
  unsubBulletinMessage?.();
  unsubGroupProjectRegistry?.();
  unsubPtyData = null;
  unsubHookEvent = null;
  unsubPtyExit = null;
  unsubAgentSpawned = null;
  unsubPermissionRequest = null;
  unsubStructuredEvent = null;
  unsubGroupProjectChanged = null;
  unsubBulletinMessage = null;
  unsubGroupProjectRegistry = null;
}

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
    permission_resolved: 'idle',
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
    case 'permission_resolved':
      message = 'Thinking';
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

/** Derive a detailed status from a StructuredEvent (for structured mode agents). */
function structuredEventToDetailedStatus(event: StructuredEvent): AgentDetailedStatus | null {
  switch (event.type) {
    case 'tool_start': {
      const data = event.data as { name: string; displayVerb: string };
      return { state: 'working', message: data.displayVerb || 'Working', toolName: data.name, timestamp: event.timestamp };
    }
    case 'tool_end': {
      const data = event.data as { name: string };
      return { state: 'idle', message: 'Thinking', toolName: data.name, timestamp: event.timestamp };
    }
    case 'permission_request': {
      const data = event.data as { toolName: string };
      return { state: 'needs_permission', message: 'Needs permission', toolName: data.toolName, timestamp: event.timestamp };
    }
    case 'error':
      return { state: 'tool_error', message: (event.data as { message: string }).message, timestamp: event.timestamp };
    case 'end':
      return { state: 'idle', message: 'Idle', timestamp: event.timestamp };
    default:
      return null; // text_delta, thinking, usage, etc. don't update detailed status
  }
}

/** Resolve the execution mode of an agent. */
export function getAgentExecutionMode(agentId: string): AgentExecutionMode {
  if (structuredManager.isStructuredSession(agentId)) return 'structured';
  if (isHeadlessAgent(agentId)) return 'headless';
  return 'pty';
}

// ---------------------------------------------------------------------------
// Clipboard image forwarding
// ---------------------------------------------------------------------------

const CLIPBOARD_IMAGE_CLEANUP_MS = 30 * 60 * 1000; // 30 minutes

function handleClipboardImage(agentId: string, base64: string, mimeType: string): void {
  const ext = mimeType === 'image/png' ? '.png'
    : mimeType === 'image/jpeg' ? '.jpg'
    : mimeType === 'image/gif' ? '.gif'
    : mimeType === 'image/webp' ? '.webp'
    : '.png';
  const fileName = `clipboard-paste-${randomUUID().slice(0, 8)}${ext}`;
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, fileName);

  try {
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(filePath, buffer);

    appLog('core:annex-server', 'info', 'clipboard:image — wrote temp file', {
      meta: { agentId, filePath, size: buffer.length },
    });

    // Inject the file path into the agent's PTY input using bracketed paste
    // so the terminal treats it as pasted content (same as Cmd+V text paste).
    ptyManager.write(agentId, `\x1b[200~${filePath}\x1b[201~`);

    // Schedule cleanup (30 minutes — long enough for the agent to read the file)
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch (err) {
        appLog('core:annex', 'debug', 'Clipboard image cleanup failed (file may already be removed)', {
          meta: { filePath, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }, CLIPBOARD_IMAGE_CLEANUP_MS);
  } catch (err) {
    appLog('core:annex-server', 'error', 'clipboard:image — failed to write temp file', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
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
  if (!token) return false;
  const entry = sessionTokens.get(token);
  if (!entry) return false;
  if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) {
    sessionTokens.delete(token);
    return false;
  }
  return true;
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

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      if (body.length + chunk.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Body exceeded maximum allowed size'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

function parseJsonBody(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: Record<string, unknown>) => void,
): void {
  readBody(req).then((raw) => {
    const body = parseJsonBody(raw);
    if (!body) {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    handler(body);
  }).catch((err) => {
    appLog('core:annex', 'error', 'readBody failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    res.writeHead(400);
    res.end();
  });
}

function getThemeColors(): ThemeColors {
  const { themeId } = themeService.getSettings();
  const theme = THEMES[themeId];
  return theme ? theme.colors : THEMES['catppuccin-mocha'].colors;
}

function getTerminalColors(): import('../../shared/types').TerminalColors {
  const { themeId } = themeService.getSettings();
  const theme = THEMES[themeId];
  return theme ? theme.terminal : THEMES['catppuccin-mocha'].terminal;
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

function mapDurableAgent(d: Awaited<ReturnType<typeof agentConfig.listDurable>>[number], projectId: string) {
  const agentId = d.id;
  const isRunning = ptyManager.isRunning(agentId) || isHeadlessAgent(agentId) || structuredManager.isStructuredSession(agentId);
  const status = isRunning ? 'running' : 'sleeping';

  return {
    id: d.id,
    projectId,
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
    executionMode: isRunning ? getAgentExecutionMode(agentId) : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot (Issues 1, 3, 6, 8)
// ---------------------------------------------------------------------------

async function buildSnapshot(): Promise<object> {
  const projects = await projectStore.list();
  const agents: Record<string, unknown[]> = {};
  const quickAgents: Record<string, unknown[]> = {};
  const projectIcons: Record<string, string> = {};
  const agentIcons: Record<string, string> = {};

  // Fetch project icons in parallel
  await Promise.all(projects.map(async (proj) => {
    if (proj.icon) {
      const dataUrl = await projectStore.readIconData(proj.icon);
      if (dataUrl) projectIcons[proj.id] = dataUrl;
    }
  }));

  // Fetch agents and their icons per project in parallel
  await Promise.all(projects.map(async (proj) => {
    const durables = await agentConfig.listDurable(proj.path);
    agents[proj.id] = durables.map((d) => mapDurableAgent(d, proj.id));
    quickAgents[proj.id] = [];

    // Fetch agent icons in parallel within this project
    await Promise.all(durables.map(async (d) => {
      if (d.icon) {
        const dataUrl = await agentConfig.readAgentIconData(d.icon);
        if (dataUrl) agentIcons[d.id] = dataUrl;
      }
    }));
  }));

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

  // Build agents metadata (execution modes, detailed statuses)
  const agentsMeta: Record<string, { executionMode: string | null; detailedStatus: AgentDetailedStatus | null }> = {};
  for (const projectAgents of Object.values(agents)) {
    for (const agent of projectAgents as Array<{ id: string; status: string; executionMode: string | null }>) {
      if (agent.status === 'running') {
        agentsMeta[agent.id] = {
          executionMode: agent.executionMode,
          detailedStatus: getDetailedStatus(agent.id),
        };
      }
    }
  }

  // Collect installed plugin summaries for remote plugin matching
  const plugins = pluginManifestRegistry.listAllManifests().map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    scope: m.scope,
    contributes: m.contributes,
    annexEnabled: (m.permissions ?? []).includes('annex'),
  }));

  // Read per-project canvas state in parallel
  const canvasState: Record<string, { canvases: unknown[]; activeCanvasId: string }> = {};
  await Promise.all(projects.map(async (proj) => {
    try {
      const [canvases, activeId] = await Promise.all([
        readPluginStorageKey({
          pluginId: 'canvas',
          scope: 'project-local',
          key: 'canvas-instances',
          projectPath: proj.path,
        }),
        readPluginStorageKey({
          pluginId: 'canvas',
          scope: 'project-local',
          key: 'canvas-active-id',
          projectPath: proj.path,
        }),
      ]);
      if (canvases && Array.isArray(canvases) && canvases.length > 0) {
        canvasState[proj.id] = {
          canvases,
          activeCanvasId: (activeId as string) || (canvases[0] as any)?.id || '',
        };
      }
    } catch {
      // Canvas data not available — skip
    }
  }));

  // Read app-level (global scope) canvas state
  let appCanvasState: { canvases: unknown[]; activeCanvasId: string } | null = null;
  try {
    const [appCanvases, appActiveId] = await Promise.all([
      readPluginStorageKey({
        pluginId: 'canvas',
        scope: 'global',
        key: 'canvas-instances',
      }),
      readPluginStorageKey({
        pluginId: 'canvas',
        scope: 'global',
        key: 'canvas-active-id',
      }),
    ]);
    if (appCanvases && Array.isArray(appCanvases) && appCanvases.length > 0) {
      appCanvasState = {
        canvases: appCanvases,
        activeCanvasId: (appActiveId as string) || (appCanvases[0] as any)?.id || '',
      };
    }
  } catch {
    // App-level canvas data not available — skip
  }

  // Read group project data
  const groupProjects = await groupProjectRegistry.list();
  const bulletinDigests: Record<string, unknown[]> = {};
  await Promise.all(groupProjects.map(async (gp) => {
    try {
      const board = getBulletinBoard(gp.id);
      bulletinDigests[gp.id] = await board.getDigest();
    } catch {
      // Bulletin not available — skip
    }
  }));

  // Read group project members from binding manager
  const groupProjectMembers: Record<string, Array<{ agentId: string; agentName: string; status: string }>> = {};
  try {
    const allBindings = bindingManager.getAllBindings();
    for (const gp of groupProjects) {
      const members = allBindings
        .filter(b => b.targetKind === 'group-project' && b.targetId === gp.id)
        .map(b => ({
          agentId: b.agentId,
          agentName: b.agentName || b.agentId,
          status: ptyManager.isRunning(b.agentId) ? 'connected' : 'sleeping',
        }));
      if (members.length > 0) {
        groupProjectMembers[gp.id] = members;
      }
    }
  } catch {
    // Binding manager not available — skip
  }

  return {
    protocolVersion: 2,
    projects,
    agents,
    quickAgents,
    agentsMeta,
    theme: getThemeColors(),
    terminalColors: getTerminalColors(),
    orchestrators: getOrchestratorsMap(),
    pendingPermissions: permissionQueue.listPending(),
    lastSeq: eventReplay.getLastSeq(),
    plugins,
    projectIcons,
    agentIcons,
    canvasState,
    appCanvasState,
    sessionPaused,
    groupProjects,
    bulletinDigests,
    groupProjectMembers,
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
      try {
        client.send(data);
      } catch (err) {
        appLog('core:annex', 'warn', 'broadcastWs: failed to send to client', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
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

async function handleIconRequest(res: http.ServerResponse, url: string): Promise<boolean> {
  // GET /api/v1/icons/agent/:agentId
  const agentIconMatch = url.match(/^\/api\/v1\/icons\/agent\/([^/]+)$/);
  if (agentIconMatch) {
    const agentId = decodeURIComponent(agentIconMatch[1]);
    // Find the agent's icon filename across all projects
    const projects = await projectStore.list();
    let iconFilename: string | undefined;
    for (const proj of projects) {
      const durables = await agentConfig.listDurable(proj.path);
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
    const dataUrl = await agentConfig.readAgentIconData(iconFilename);
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
    const projects = await projectStore.list();
    const project = projects.find((p) => p.id === projectId);
    if (!project?.icon) {
      sendJson(res, 404, { error: 'icon_not_found' });
      return true;
    }
    const dataUrl = await projectStore.readIconData(project.icon);
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

async function findProjectById(projectId: string) {
  const projects = await projectStore.list();
  return projects.find((p) => p.id === projectId);
}

async function findAgentAcrossProjects(agentId: string): Promise<{ config: Awaited<ReturnType<typeof agentConfig.listDurable>>[number]; project: Awaited<ReturnType<typeof projectStore.list>>[number] } | null> {
  for (const proj of await projectStore.list()) {
    const durables = await agentConfig.listDurable(proj.path);
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

  const project = await findProjectById(projectId);
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
    const parentInfo = await findAgentAcrossProjects(parentAgentId);
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

  const agentId = generateQuickAgentId();
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

    // Notify the desktop renderer so the agent appears in the UI
    broadcastToAllWindows(IPC.ANNEX.AGENT_SPAWNED, {
      id: agentId,
      name,
      kind: 'quick',
      status: 'running',
      prompt,
      model: model || null,
      orchestrator: orchestrator || null,
      freeAgentMode,
      parentAgentId,
      projectId,
      headless: true,
    });

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
  const resume = !!body.resume;

  const agentInfo = await findAgentAcrossProjects(agentId);
  if (!agentInfo) {
    sendJson(res, 404, { error: 'agent_not_found' });
    return;
  }

  // Check if already running
  if (ptyManager.isRunning(agentId) || isHeadlessAgent(agentId) || structuredManager.isStructuredSession(agentId)) {
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
      resume,
      sessionId: resume ? config.lastSessionId : undefined,
    });

    // Broadcast agent:woken + refresh snapshot so controllers see updated status
    broadcastAndBuffer('agent:woken', {
      agentId: config.id,
      message,
      source: 'annex',
    });
    broadcastSnapshotRefresh();

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
// Structured permission response (Issue 396)
// ---------------------------------------------------------------------------

async function handleStructuredPermissionResponse(
  res: http.ServerResponse,
  agentId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const requestId = body.requestId as string | undefined;
  const approved = body.approved as boolean | undefined;
  const reason = body.reason as string | undefined;

  if (!requestId) {
    sendJson(res, 400, { error: 'missing_request_id' });
    return;
  }

  if (typeof approved !== 'boolean') {
    sendJson(res, 400, { error: 'missing_approved' });
    return;
  }

  if (!structuredManager.isStructuredSession(agentId)) {
    sendJson(res, 404, { error: 'no_structured_session' });
    return;
  }

  try {
    await structuredManager.respondToPermission(agentId, requestId, approved, reason);

    // Broadcast confirmation
    broadcastAndBuffer('permission:response', {
      requestId,
      agentId,
      decision: approved ? 'allow' : 'deny',
    });

    // Clear the needs_permission detailed status
    const current = detailedStatusCache.get(agentId);
    if (current?.state === 'needs_permission') {
      detailedStatusCache.delete(agentId);
    }

    sendJson(res, 200, { ok: true, requestId, approved });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'permission_failed' });
  }
}

// ---------------------------------------------------------------------------
// Pairing-port request handler (plain HTTP, unauthenticated)
// ---------------------------------------------------------------------------

async function handlePairingRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/v1/identity — public identity info
  if (method === 'GET' && url === '/api/v1/identity') {
    const identity = annexIdentity.getPublicIdentity();
    if (!identity) {
      sendJson(res, 503, { error: 'identity_not_ready' });
      return;
    }
    const settings = annexSettings.getSettings();
    sendJson(res, 200, {
      alias: settings.alias,
      icon: settings.icon,
      color: settings.color,
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey,
    });
    return;
  }

  // POST /pair — with brute-force protection
  if (method === 'POST' && url === '/pair') {
    const source = req.socket.remoteAddress || 'unknown';
    const bruteCheck = annexPeers.checkBruteForce(source);

    if (!bruteCheck.allowed) {
      if (bruteCheck.locked) {
        sendJson(res, 429, { error: 'pairing_locked', message: 'Too many failed attempts. Pairing is locked.' });
      } else {
        sendJson(res, 429, { error: 'rate_limited', retryAfterMs: bruteCheck.delayMs });
      }
      return;
    }

    readBody(req).then((raw) => {
      const body = parseJsonBody(raw);
      if (!body) { sendJson(res, 400, { error: 'invalid_json' }); return; }
      const pin = body.pin;
      if (typeof pin !== 'string') { sendJson(res, 400, { error: 'invalid_json' }); return; }

      if (pin !== currentPin) {
        annexPeers.recordFailedAttempt(source);
        sendJson(res, 401, { error: 'invalid_pin' });
        return;
      }

      annexPeers.recordSuccessfulAttempt(source);
      const token = randomUUID();
      sessionTokens.set(token, { issuedAt: Date.now() });

      const identity = annexIdentity.getOrCreateIdentity();
      const settings = annexSettings.getSettings();

      const clientPublicKey = body.publicKey as string | undefined;
      if (clientPublicKey) {
        // Validate public key: must be a valid Ed25519 SPKI/DER key encoded as base64
        try {
          const keyBuf = Buffer.from(clientPublicKey, 'base64');
          const keyObj = require('crypto').createPublicKey({ key: keyBuf, format: 'der', type: 'spki' });
          if (keyObj.asymmetricKeyType !== 'ed25519') {
            sendJson(res, 400, { error: 'invalid_public_key' });
            return;
          }
        } catch {
          sendJson(res, 400, { error: 'invalid_public_key' });
          return;
        }
        annexPeers.addPeer({
          fingerprint: annexIdentity.computeFingerprint(clientPublicKey),
          publicKey: clientPublicKey,
          alias: (body.alias as string) || 'Unknown',
          icon: (body.icon as string) || 'computer',
          color: (body.color as string) || 'indigo',
          pairedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          role: 'controller', // This peer initiated pairing → they control us
        });
      }

      sendJson(res, 200, {
        token,
        publicKey: identity.publicKey,
        alias: settings.alias,
        icon: settings.icon,
        color: settings.color,
        fingerprint: identity.fingerprint,
      });
    }).catch((err) => {
      appLog('core:annex', 'error', 'readBody failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
      res.writeHead(400);
      res.end();
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// Main-port request handler (serves authenticated endpoints)
// ---------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  // All endpoints on the main server require auth (mTLS or bearer token).
  // Check mTLS first (matching the WebSocket upgrade handler), then fall back
  // to bearer token. Without this, REST calls from the controller using only
  // mTLS certs (e.g. buffer fetch) would be rejected with 401.
  let authenticated = false;
  let isMtlsAuthenticated = false;
  if (req.socket && 'getPeerCertificate' in req.socket) {
    const peerFingerprint = annexTls.extractPeerFingerprint(req.socket as tls.TLSSocket);
    if (peerFingerprint) {
      const peer = annexPeers.getPeer(peerFingerprint);
      if (peer && (peer.role === 'controller' || !peer.role)) {
        authenticated = true;
        isMtlsAuthenticated = true;
        annexPeers.updateLastSeen(peerFingerprint);
      }
    }
  }
  if (!authenticated) {
    const token = extractBearerToken(req);
    if (!isValidToken(token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
  }

  /** Require mTLS for destructive operations when TLS is active. Returns true if rejected. */
  function requireMtls(): boolean {
    // Only enforce mTLS when the server is running with TLS.
    // In HTTP fallback mode, bearer tokens are sufficient (no TLS available).
    if (tlsServer && !isMtlsAuthenticated) {
      appLog('core:annex', 'warn', 'Rejected destructive REST request — mTLS required', {
        meta: { method, url },
      });
      sendJson(res, 403, { error: 'mtls_required', message: 'Destructive operations require mTLS authentication' });
      return true;
    }
    return false;
  }

  // GET /api/v1/status
  if (method === 'GET' && url === '/api/v1/status') {
    const settings = annexSettings.getSettings();
    const projects = await projectStore.list();
    let agentCount = 0;
    for (const p of projects) {
      const durables = await agentConfig.listDurable(p.path);
      agentCount += durables.length;
    }
    sendJson(res, 200, {
      version: '1',
      deviceName: settings.deviceName,
      agentCount,
      orchestratorCount: getAvailableOrchestrators().length,
    });
    return;
  }

  // GET /api/v1/projects
  if (method === 'GET' && url === '/api/v1/projects') {
    sendJson(res, 200, await projectStore.list());
    return;
  }

  // GET /api/v1/projects/:id/agents
  const agentsMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents$/);
  if (method === 'GET' && agentsMatch) {
    const projectId = decodeURIComponent(agentsMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    const durables = await agentConfig.listDurable(project.path);
    sendJson(res, 200, durables.map((d) => mapDurableAgent(d, projectId)));
    return;
  }

  // GET /api/v1/agents/:id/buffer
  const bufferMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/buffer$/);
  if (method === 'GET' && bufferMatch) {
    const agentId = decodeURIComponent(bufferMatch[1]);
    const buffer = ptyManager.getSerializedBuffer(agentId);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(buffer),
    });
    res.end(buffer);
    return;
  }

  // --- File system endpoints (plugin remote file access) ---

  // GET /api/v1/projects/:id/files/tree?path=<relative>&depth=<n>&includeHidden=<bool>
  const fileTreeMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/files\/tree(\?.*)?$/);
  if (method === 'GET' && fileTreeMatch) {
    const projectId = decodeURIComponent(fileTreeMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    const params = new URLSearchParams(fileTreeMatch[2]?.slice(1) || '');
    const relPath = params.get('path') || '.';
    const depth = parseInt(params.get('depth') || '2', 10);
    const includeHidden = params.get('includeHidden') === 'true';

    // Resolve and validate path stays within project
    const resolvedProject = path.resolve(project.path);
    const fullPath = relPath === '.' ? resolvedProject : path.resolve(resolvedProject, relPath);
    if (fullPath !== resolvedProject && !fullPath.startsWith(resolvedProject + path.sep)) {
      sendJson(res, 403, { error: 'path_traversal' });
      return;
    }

    try {
      const tree = await fileService.readTree(fullPath, { depth, includeHidden });
      sendJson(res, 200, tree);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'read_tree_failed' });
    }
    return;
  }

  // GET /api/v1/projects/:id/files/read?path=<relative>
  const fileReadMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/files\/read(\?.*)?$/);
  if (method === 'GET' && fileReadMatch) {
    const projectId = decodeURIComponent(fileReadMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    const params = new URLSearchParams(fileReadMatch[2]?.slice(1) || '');
    const relPath = params.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'path_required' });
      return;
    }

    const resolvedProject = path.resolve(project.path);
    const fullPath = path.resolve(resolvedProject, relPath);
    if (fullPath !== resolvedProject && !fullPath.startsWith(resolvedProject + path.sep)) {
      sendJson(res, 403, { error: 'path_traversal' });
      return;
    }

    try {
      const content = await fileService.readFile(fullPath);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(content),
      });
      res.end(content);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        sendJson(res, 404, { error: 'file_not_found' });
      } else {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'read_failed' });
      }
    }
    return;
  }

  // --- Git endpoints (remote plugin support) ---

  // GET /api/v1/projects/:id/git/info
  const gitInfoMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/git\/info$/);
  if (method === 'GET' && gitInfoMatch) {
    const projectId = decodeURIComponent(gitInfoMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    try {
      const info = await gitService.getGitInfo(project.path);
      sendJson(res, 200, info);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'git_info_failed' });
    }
    return;
  }

  // GET /api/v1/projects/:id/git/log?limit=N&offset=N
  const gitLogMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/git\/log(\?.*)?$/);
  if (method === 'GET' && gitLogMatch) {
    const projectId = decodeURIComponent(gitLogMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    const params = new URLSearchParams(gitLogMatch[2]?.slice(1) || '');
    const limit = parseInt(params.get('limit') || '50', 10);
    const offset = parseInt(params.get('offset') || '0', 10);
    try {
      const log = await gitService.getLog(project.path, limit, offset);
      sendJson(res, 200, log);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'git_log_failed' });
    }
    return;
  }

  // GET /api/v1/projects/:id/git/diff?file=PATH&staged=BOOL
  const gitDiffMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/git\/diff(\?.*)?$/);
  if (method === 'GET' && gitDiffMatch) {
    const projectId = decodeURIComponent(gitDiffMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    const params = new URLSearchParams(gitDiffMatch[2]?.slice(1) || '');
    const filePath = params.get('file');
    if (!filePath) { sendJson(res, 400, { error: 'file_required' }); return; }
    const staged = params.get('staged') === 'true';
    try {
      const diff = await gitService.getFileDiff(project.path, filePath, staged);
      sendJson(res, 200, diff);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'git_diff_failed' });
    }
    return;
  }

  // GET /api/v1/projects/:id/git/show-commit?hash=HASH
  const gitShowCommitMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/git\/show-commit(\?.*)?$/);
  if (method === 'GET' && gitShowCommitMatch) {
    const projectId = decodeURIComponent(gitShowCommitMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    const params = new URLSearchParams(gitShowCommitMatch[2]?.slice(1) || '');
    const hash = params.get('hash');
    if (!hash) { sendJson(res, 400, { error: 'hash_required' }); return; }
    try {
      const detail = await gitService.showCommit(project.path, hash);
      sendJson(res, 200, detail);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'git_show_commit_failed' });
    }
    return;
  }

  // GET /api/v1/projects/:id/git/commit-diff?hash=HASH&file=PATH
  const gitCommitDiffMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/git\/commit-diff(\?.*)?$/);
  if (method === 'GET' && gitCommitDiffMatch) {
    const projectId = decodeURIComponent(gitCommitDiffMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    const params = new URLSearchParams(gitCommitDiffMatch[2]?.slice(1) || '');
    const hash = params.get('hash');
    const filePath = params.get('file');
    if (!hash || !filePath) { sendJson(res, 400, { error: 'hash_and_file_required' }); return; }
    try {
      const diff = await gitService.getCommitFileDiff(project.path, hash, filePath);
      sendJson(res, 200, diff);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'git_commit_diff_failed' });
    }
    return;
  }

  // POST /api/v1/projects/:id/git/:operation (destructive — requires mTLS)
  const gitOpMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/git\/(stage|unstage|stage-all|unstage-all|commit|push|pull|checkout|stash|stash-pop)$/);
  if (method === 'POST' && gitOpMatch) {
    if (requireMtls()) return;
    const projectId = decodeURIComponent(gitOpMatch[1]);
    const operation = gitOpMatch[2];
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    readJsonBody(req, res, async (body) => {
      try {
        let result;
        switch (operation) {
          case 'stage': result = await gitService.stage(project.path, body.path as string); break;
          case 'unstage': result = await gitService.unstage(project.path, body.path as string); break;
          case 'stage-all': result = await gitService.stageAll(project.path); break;
          case 'unstage-all': result = await gitService.unstageAll(project.path); break;
          case 'commit': result = await gitService.commit(project.path, body.message as string); break;
          case 'push': result = await gitService.push(project.path); break;
          case 'pull': result = await gitService.pull(project.path); break;
          case 'checkout': result = await gitService.checkout(project.path, body.branch as string); break;
          case 'stash': result = await gitService.stash(project.path); break;
          case 'stash-pop': result = await gitService.stashPop(project.path); break;
          default: sendJson(res, 400, { error: 'unknown_operation' }); return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'git_operation_failed' });
      }
    });
    return;
  }

  // --- Session endpoints (remote sessions plugin support) ---

  // GET /api/v1/agents/:agentId/sessions?projectId=ID&orchestrator=NAME
  const sessionsListMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/sessions(\?.*)?$/);
  if (method === 'GET' && sessionsListMatch) {
    const agentId = decodeURIComponent(sessionsListMatch[1]);
    const params = new URLSearchParams(sessionsListMatch[2]?.slice(1) || '');
    const projectId = params.get('projectId');
    const orchestrator = params.get('orchestrator') || undefined;
    if (!projectId) { sendJson(res, 400, { error: 'projectId_required' }); return; }
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    try {
      const sessions = await listSessions(project.path, agentId, orchestrator);
      sendJson(res, 200, sessions);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'list_sessions_failed' });
    }
    return;
  }

  // GET /api/v1/agents/:agentId/sessions/:sessionId/transcript?projectId=ID&offset=N&limit=N&orchestrator=NAME
  const transcriptMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/transcript(\?.*)?$/);
  if (method === 'GET' && transcriptMatch) {
    const agentId = decodeURIComponent(transcriptMatch[1]);
    const sessionId = decodeURIComponent(transcriptMatch[2]);
    const params = new URLSearchParams(transcriptMatch[3]?.slice(1) || '');
    const projectId = params.get('projectId');
    const orchestrator = params.get('orchestrator') || undefined;
    const offset = parseInt(params.get('offset') || '0', 10);
    const limit = parseInt(params.get('limit') || '100', 10);
    if (!projectId) { sendJson(res, 400, { error: 'projectId_required' }); return; }
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    try {
      const config = await agentConfig.getDurableConfig(project.path, agentId);
      const provider = await resolveOrchestrator(project.path, orchestrator || config?.orchestrator);
      if (!isSessionCapable(provider)) { sendJson(res, 200, null); return; }
      const cwd = config?.worktreePath || project.path;
      const profileEnv = await resolveProfileEnv(project.path, provider.id);
      const rawEvents = await provider.readSessionTranscript(sessionId, cwd, profileEnv);
      if (!rawEvents) { sendJson(res, 200, null); return; }
      const events = normalizeSessionEvents(rawEvents);
      sendJson(res, 200, paginateEvents(events, offset, limit));
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'read_transcript_failed' });
    }
    return;
  }

  // GET /api/v1/agents/:agentId/sessions/:sessionId/summary?projectId=ID&orchestrator=NAME
  const summaryMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/summary(\?.*)?$/);
  if (method === 'GET' && summaryMatch) {
    const agentId = decodeURIComponent(summaryMatch[1]);
    const sessionId = decodeURIComponent(summaryMatch[2]);
    const params = new URLSearchParams(summaryMatch[3]?.slice(1) || '');
    const projectId = params.get('projectId');
    const orchestrator = params.get('orchestrator') || undefined;
    if (!projectId) { sendJson(res, 400, { error: 'projectId_required' }); return; }
    const project = await findProjectById(projectId);
    if (!project) { sendJson(res, 404, { error: 'project_not_found' }); return; }
    try {
      const config = await agentConfig.getDurableConfig(project.path, agentId);
      const provider = await resolveOrchestrator(project.path, orchestrator || config?.orchestrator);
      if (!isSessionCapable(provider)) { sendJson(res, 200, null); return; }
      const cwd = config?.worktreePath || project.path;
      const profileEnv = await resolveProfileEnv(project.path, provider.id);
      const rawEvents = await provider.readSessionTranscript(sessionId, cwd, profileEnv);
      if (!rawEvents) { sendJson(res, 200, null); return; }
      const events = normalizeSessionEvents(rawEvents);
      sendJson(res, 200, buildSessionSummary(events, provider.id));
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'get_summary_failed' });
    }
    return;
  }

  // --- Icon endpoints (Issue 2) ---
  if (method === 'GET' && await handleIconRequest(res, url)) {
    return;
  }

  // --- POST endpoints (Issues 4, 6, 7) ---

  // POST /api/v1/projects/:id/agents/quick (destructive — requires mTLS)
  const quickProjectMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents\/quick$/);
  if (method === 'POST' && quickProjectMatch) {
    if (requireMtls()) return;
    const projectId = decodeURIComponent(quickProjectMatch[1]);
    readJsonBody(req, res, (body) => handleSpawnQuickAgent(res, projectId, null, body));
    return;
  }

  // POST /api/v1/agents/:id/agents/quick (destructive — requires mTLS)
  const quickAgentMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/agents\/quick$/);
  if (method === 'POST' && quickAgentMatch) {
    if (requireMtls()) return;
    const parentAgentId = decodeURIComponent(quickAgentMatch[1]);
    const parentInfo = await findAgentAcrossProjects(parentAgentId);
    if (!parentInfo) {
      sendJson(res, 404, { error: 'agent_not_found' });
      return;
    }
    readJsonBody(req, res, (body) => handleSpawnQuickAgent(res, parentInfo.project.id, parentAgentId, body));
    return;
  }

  // POST /api/v1/agents/:id/wake (destructive — requires mTLS)
  const wakeMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/wake$/);
  if (method === 'POST' && wakeMatch) {
    if (requireMtls()) return;
    const agentId = decodeURIComponent(wakeMatch[1]);
    readJsonBody(req, res, (body) => handleWakeAgent(res, agentId, body));
    return;
  }

  // POST /api/v1/agents/:id/permission-response (control — requires mTLS)
  const permissionMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/permission-response$/);
  if (method === 'POST' && permissionMatch) {
    if (requireMtls()) return;
    const agentId = decodeURIComponent(permissionMatch[1]);
    readJsonBody(req, res, (body) => handlePermissionResponse(res, agentId, body));
    return;
  }

  // POST /api/v1/agents/:id/structured-permission (control — requires mTLS)
  const structuredPermMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/structured-permission$/);
  if (method === 'POST' && structuredPermMatch) {
    if (requireMtls()) return;
    const agentId = decodeURIComponent(structuredPermMatch[1]);
    readJsonBody(req, res, (body) => handleStructuredPermissionResponse(res, agentId, body));
    return;
  }

  // POST /api/v1/agents/:id/message (control — requires mTLS)
  const messageMatch = url.match(/^\/api\/v1\/agents\/([^/]+)\/message$/);
  if (method === 'POST' && messageMatch) {
    if (requireMtls()) return;
    const agentId = decodeURIComponent(messageMatch[1]);
    readJsonBody(req, res, async (body) => {
      const message = body.message as string | undefined;
      if (!message || typeof message !== 'string') {
        sendJson(res, 400, { error: 'message is required' });
        return;
      }
      if (message.length > MAX_PTY_INPUT_SIZE) {
        sendJson(res, 400, { error: 'message exceeds 64KB limit' });
        return;
      }
      const mode = getAgentExecutionMode(agentId);
      try {
        if (mode === 'structured') {
          await structuredManager.sendMessage(agentId, message);
        } else if (mode === 'pty' && ptyManager.isRunning(agentId)) {
          ptyManager.write(agentId, message);
        } else {
          sendJson(res, 400, { error: `cannot send message to agent in '${mode}' mode` });
          return;
        }
        sendJson(res, 200, { ok: true, agentId, mode });
      } catch (err) {
        appLog('core:annex', 'error', 'Failed to send message to agent', {
          meta: { agentId, mode, error: err instanceof Error ? err.message : String(err) },
        });
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'send_failed' });
      }
    });
    return;
  }

  // POST /api/v1/projects/:id/agents/durable — create a durable agent (destructive — requires mTLS)
  const durableCreateMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents\/durable$/);
  if (method === 'POST' && durableCreateMatch) {
    if (requireMtls()) return;
    const projectId = decodeURIComponent(durableCreateMatch[1]);
    const project = await findProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    readJsonBody(req, res, async (body) => {
      const name = body.name as string;
      const color = body.color as string;
      if (!name || !color) {
        sendJson(res, 400, { error: 'name and color are required' });
        return;
      }
      try {
        const config = await agentConfig.createDurable(
          project.path,
          name,
          color,
          body.model as string | undefined,
          body.useWorktree !== false,
          body.orchestrator as string | undefined,
          body.freeAgentMode as boolean | undefined,
          body.mcpIds as string[] | undefined,
        );
        // Broadcast snapshot refresh so controllers see the new agent
        broadcastSnapshotRefresh();
        sendJson(res, 201, config);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'create_failed' });
      }
    });
    return;
  }

  // POST /api/v1/projects/:id/agents/:agentId/delete — delete a durable agent (destructive — requires mTLS)
  const durableDeleteMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents\/([^/]+)\/delete$/);
  if (method === 'POST' && durableDeleteMatch) {
    if (requireMtls()) return;
    const projectId = decodeURIComponent(durableDeleteMatch[1]);
    const agentId = decodeURIComponent(durableDeleteMatch[2]);
    const project = await findProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    readJsonBody(req, res, async (body) => {
      const mode = (body.mode as string) || 'force';
      // Kill the agent if it's running
      if (ptyManager.isRunning(agentId) || isHeadlessAgent(agentId)) {
        ptyManager.gracefulKill(agentId);
      }
      try {
        let result: { ok: boolean; message: string };
        switch (mode) {
          case 'commit-push':
            result = await agentConfig.deleteCommitAndPush(project.path, agentId);
            break;
          case 'cleanup-branch':
            result = await agentConfig.deleteWithCleanupBranch(project.path, agentId);
            break;
          case 'force':
            result = await agentConfig.deleteForce(project.path, agentId);
            break;
          case 'unregister':
            result = await agentConfig.deleteUnregister(project.path, agentId);
            break;
          default:
            result = await agentConfig.deleteForce(project.path, agentId);
        }
        // Broadcast snapshot refresh so controllers see the removal
        broadcastSnapshotRefresh();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'delete_failed' });
      }
    });
    return;
  }

  // GET /api/v1/projects/:id/agents/:agentId/worktree-status
  const worktreeStatusMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/agents\/([^/]+)\/worktree-status$/);
  if (method === 'GET' && worktreeStatusMatch) {
    const projectId = decodeURIComponent(worktreeStatusMatch[1]);
    const agentId = decodeURIComponent(worktreeStatusMatch[2]);
    const project = await findProjectById(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'project_not_found' });
      return;
    }
    try {
      const status = await agentConfig.getWorktreeStatus(project.path, agentId);
      sendJson(res, 200, status);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'status_failed' });
    }
    return;
  }

  // --- Group Project endpoints (bulletin board wire protocol) ---

  // GET /api/v1/group-projects
  if (method === 'GET' && url === '/api/v1/group-projects') {
    const projects = await groupProjectRegistry.list();
    sendJson(res, 200, projects);
    return;
  }

  // GET /api/v1/group-projects/:id
  const gpGetMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+?)(\?.*)?$/);
  if (method === 'GET' && gpGetMatch && !url.includes('/bulletin/')) {
    const gpId = decodeURIComponent(gpGetMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    // Include members
    let members: Array<{ agentId: string; agentName: string; status: string }> = [];
    try {
      const allBindings = bindingManager.getAllBindings();
      members = allBindings
        .filter(b => b.targetKind === 'group-project' && b.targetId === gpId)
        .map(b => ({
          agentId: b.agentId,
          agentName: b.agentName || b.agentId,
          status: ptyManager.isRunning(b.agentId) ? 'connected' : 'sleeping',
        }));
    } catch { /* ignore */ }
    sendJson(res, 200, { ...project, members });
    return;
  }

  // GET /api/v1/group-projects/:id/bulletin/digest?since=<ISO8601>
  const gpDigestMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/digest(\?.*)?$/);
  if (method === 'GET' && gpDigestMatch) {
    const gpId = decodeURIComponent(gpDigestMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    const params = new URLSearchParams(gpDigestMatch[2]?.slice(1) || '');
    const since = params.get('since') || undefined;
    const board = getBulletinBoard(gpId);
    const digest = await board.getDigest(since);
    sendJson(res, 200, digest);
    return;
  }

  // GET /api/v1/group-projects/:id/bulletin/topics/:topic?since=<ISO8601>&limit=<n>
  const gpTopicMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/topics\/([^/?]+)(\?.*)?$/);
  if (method === 'GET' && gpTopicMatch) {
    const gpId = decodeURIComponent(gpTopicMatch[1]);
    const topic = decodeURIComponent(gpTopicMatch[2]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    const params = new URLSearchParams(gpTopicMatch[3]?.slice(1) || '');
    const since = params.get('since') || undefined;
    const limit = params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined;
    const board = getBulletinBoard(gpId);
    const messages = await board.getTopicMessages(topic, since, limit);
    sendJson(res, 200, messages);
    return;
  }

  // GET /api/v1/group-projects/:id/bulletin/messages?since=<ISO8601>&limit=<n>
  const gpAllMsgsMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/messages(\?.*)?$/);
  if (method === 'GET' && gpAllMsgsMatch) {
    const gpId = decodeURIComponent(gpAllMsgsMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    const params = new URLSearchParams(gpAllMsgsMatch[2]?.slice(1) || '');
    const since = params.get('since') || undefined;
    const limit = params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined;
    const board = getBulletinBoard(gpId);
    const messages = await board.getAllMessages(since, limit);
    sendJson(res, 200, messages);
    return;
  }

  // POST /api/v1/group-projects/:id/bulletin/messages (destructive — requires mTLS)
  const gpPostMsgMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/messages$/);
  if (method === 'POST' && gpPostMsgMatch) {
    if (requireMtls()) return;
    const gpId = decodeURIComponent(gpPostMsgMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    readJsonBody(req, res, async (body) => {
      const sender = body.sender as string;
      const topic = body.topic as string;
      const msgBody = body.body as string;
      if (!sender || !topic || !msgBody) {
        sendJson(res, 400, { error: 'sender, topic, and body are required' });
        return;
      }
      if (topic === 'system') {
        sendJson(res, 400, { error: 'system topic is reserved' });
        return;
      }
      try {
        const board = getBulletinBoard(gpId);
        const message = await board.postMessage(sender, topic, msgBody);
        annexEventBus.emitBulletinMessage(gpId, message);
        sendJson(res, 201, message);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'post_failed' });
      }
    });
    return;
  }

  // POST /api/v1/group-projects/:id/shoulder-tap (destructive — requires mTLS)
  const gpShoulderTapMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+)\/shoulder-tap$/);
  if (method === 'POST' && gpShoulderTapMatch) {
    if (requireMtls()) return;
    const gpId = decodeURIComponent(gpShoulderTapMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    readJsonBody(req, res, async (body) => {
      const sender = (body.sender as string) || 'remote';
      const targetAgentId = (body.targetAgentId as string) || null;
      const message = body.message as string;
      if (!message) {
        sendJson(res, 400, { error: 'message is required' });
        return;
      }
      try {
        const result = await executeShoulderTap({
          projectId: gpId,
          senderLabel: sender,
          targetAgentId,
          message,
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'shoulder_tap_failed' });
      }
    });
    return;
  }

  // GET /api/v1/group-projects/:id/members
  const gpMembersMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+)\/members$/);
  if (method === 'GET' && gpMembersMatch) {
    const gpId = decodeURIComponent(gpMembersMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    let members: Array<{ agentId: string; agentName: string; status: string }> = [];
    try {
      const allBindings = bindingManager.getAllBindings();
      members = allBindings
        .filter(b => b.targetKind === 'group-project' && b.targetId === gpId)
        .map(b => ({
          agentId: b.agentId,
          agentName: b.agentName || b.agentId,
          status: ptyManager.isRunning(b.agentId) ? 'connected' : 'sleeping',
        }));
    } catch { /* ignore */ }
    sendJson(res, 200, members);
    return;
  }

  // PATCH /api/v1/group-projects/:id (destructive — requires mTLS)
  const gpPatchMatch = url.match(/^\/api\/v1\/group-projects\/([^/]+?)$/);
  if (method === 'PATCH' && gpPatchMatch && !url.includes('/bulletin/')) {
    if (requireMtls()) return;
    const gpId = decodeURIComponent(gpPatchMatch[1]);
    const project = await groupProjectRegistry.get(gpId);
    if (!project) {
      sendJson(res, 404, { error: 'group_project_not_found' });
      return;
    }
    readJsonBody(req, res, async (body) => {
      const fields: Record<string, unknown> = {};
      if (body.name !== undefined) fields.name = body.name;
      if (body.description !== undefined) fields.description = body.description;
      if (body.instructions !== undefined) fields.instructions = body.instructions;
      if (body.metadata !== undefined) fields.metadata = body.metadata;
      if (Object.keys(fields).length === 0) {
        sendJson(res, 400, { error: 'no_fields_to_update' });
        return;
      }
      try {
        const updated = await groupProjectRegistry.update(gpId, fields as any);
        if (!updated) {
          sendJson(res, 404, { error: 'group_project_not_found' });
          return;
        }
        annexEventBus.emitGroupProjectChanged('updated', updated);
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : 'update_failed' });
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// WebSocket message handler (Issue 8 — bidirectional)
// ---------------------------------------------------------------------------

const MAX_PTY_INPUT_SIZE = 64 * 1024; // 64KB

function handleWsMessage(ws: WebSocket, data: string): void {
  let msg: { type?: string; payload?: Record<string, unknown>; since?: number };
  try {
    msg = JSON.parse(data);
  } catch {
    appLog('core:annex', 'warn', 'Malformed JSON in WebSocket message', {
      meta: { preview: data.slice(0, 200) },
    });
    return;
  }

  const type = msg.type;

  // --- Replay (available to all authenticated connections) ---
  if (type === 'replay' && typeof msg.since === 'number') {
    const events = eventReplay.getEventsSince(msg.since);

    if (events === null) {
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
    return;
  }

  // --- Control messages (mTLS-only) ---
  const authType = wsAuthTypes.get(ws);
  const isMtls = authType === 'mtls';

  if (!isMtls && (type === 'pty:input' || type === 'pty:resize' || type === 'pty:spawn-shell' || type === 'agent:spawn' || type === 'agent:wake' || type === 'agent:kill' || type === 'agent:reorder' || type === 'clipboard:image')) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Control messages require mTLS authentication' } }));
    return;
  }

  const payload = msg.payload || {};

  switch (type) {
    case 'pty:input': {
      const agentId = payload.agentId as string;
      const inputData = payload.data as string;
      if (!agentId || typeof inputData !== 'string') break;
      if (inputData.length > MAX_PTY_INPUT_SIZE) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'pty:input data exceeds 64KB limit' } }));
        break;
      }
      ptyManager.write(agentId, inputData);
      break;
    }

    case 'pty:resize': {
      const agentId = payload.agentId as string;
      const cols = payload.cols as number;
      const rows = payload.rows as number;
      if (!agentId || typeof cols !== 'number' || typeof rows !== 'number') break;
      ptyManager.resize(agentId, cols, rows);
      break;
    }

    case 'clipboard:image': {
      const agentId = payload.agentId as string;
      const base64 = payload.base64 as string;
      const mimeType = payload.mimeType as string;
      if (!agentId || !base64 || !mimeType) break;
      // Limit to 10MB of base64 data (~7.5MB raw image)
      if (base64.length > 10 * 1024 * 1024) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'clipboard:image data exceeds 10MB limit' } }));
        break;
      }
      handleClipboardImage(agentId, base64, mimeType);
      break;
    }

    case 'pty:spawn-shell': {
      const sessionId = payload.sessionId as string;
      const projectId = payload.projectId as string;
      if (!sessionId || !projectId) break;
      findProjectById(projectId).then(async (project) => {
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project_not_found' } }));
          return;
        }
        try {
          await ptyManager.spawnShell(sessionId, project.path);
          ws.send(JSON.stringify({ type: 'pty:spawn-shell:ack', payload: { sessionId } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: err instanceof Error ? err.message : 'spawn_failed' } }));
        }
      });
      break;
    }

    case 'agent:spawn': {
      const projectId = payload.projectId as string;
      const prompt = payload.prompt as string;
      if (!projectId || !prompt) break;
      // Reuse the quick agent spawn logic
      findProjectById(projectId).then((project) => {
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project_not_found' } }));
          return;
        }
        handleSpawnQuickAgentWs(ws, project, payload);
      });
      break;
    }

    case 'agent:wake': {
      const agentId = payload.agentId as string;
      if (!agentId) break;
      handleWakeAgentWs(ws, agentId, {
        resume: !!payload.resume,
        mission: payload.mission as string | undefined,
        model: payload.model as string | undefined,
      });
      break;
    }

    case 'agent:kill': {
      const agentId = payload.agentId as string;
      if (!agentId) break;
      ptyManager.gracefulKill(agentId);
      ws.send(JSON.stringify({ type: 'agent:kill:ack', payload: { agentId } }));
      break;
    }

    case 'canvas:mutation': {
      // Apply canvas mutation server-side and broadcast the result directly
      // to controller clients.  Also forward to the local renderer so its
      // in-memory store stays in sync (this is the path that previously was
      // the *only* path, but it fails when the renderer's canvas store for
      // the target project isn't loaded).
      const projectId = payload.projectId as string;
      const canvasId = payload.canvasId as string;
      const scope = (payload.scope as string) || 'project';
      const mutation = payload.mutation as Record<string, unknown>;
      if (!canvasId || !mutation) break;

      // Forward to renderer for in-memory sync (best-effort)
      broadcastToAllWindows(IPC.WINDOW.REQUEST_CANVAS_MUTATION, canvasId, scope, mutation, projectId);

      // Server-side: read → apply → write → broadcast
      applyCanvasMutationServerSide(projectId, canvasId, mutation).catch((err) => {
        const message = err instanceof Error ? err.message : 'canvas_mutation_failed';
        appLog('core:annex', 'error', 'Canvas mutation failed server-side', {
          meta: { projectId, canvasId, mutationType: mutation.type, error: message },
        });
        ws.send(JSON.stringify({
          type: 'canvas:mutation:error',
          payload: { projectId, canvasId, mutationType: mutation.type, message },
        }));
      });
      break;
    }

    case 'agent:reorder': {
      const projectId = payload.projectId as string;
      const orderedIds = payload.orderedIds as string[];
      if (!projectId || !Array.isArray(orderedIds)) break;
      findProjectById(projectId).then((project) => {
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project_not_found' } }));
          return;
        }
        agentConfig.reorderDurable(project.path, orderedIds).then(() => {
          broadcastSnapshotRefresh();
          ws.send(JSON.stringify({ type: 'agent:reorder:ack', payload: { projectId } }));
        }).catch(() => {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'reorder_failed' } }));
        });
      });
      break;
    }
  }
}

// WS-based quick agent spawn (mirrors HTTP handler)
async function handleSpawnQuickAgentWs(
  ws: WebSocket,
  project: Awaited<ReturnType<typeof findProjectById>> & {},
  payload: Record<string, unknown>,
): Promise<void> {
  const prompt = payload.prompt as string;
  const parentAgentId = payload.parentAgentId as string | null;
  const agentId = generateQuickAgentId();
  const name = generateQuickName();
  const model = payload.model as string | undefined;
  const orchestrator = (payload.orchestrator as string) || project.orchestrator || 'claude-code';
  const freeAgentMode = (payload.freeAgentMode as boolean) ?? false;

  const tracked: TrackedQuickAgent = {
    id: agentId, name, kind: 'quick', status: 'starting', prompt,
    model: model || null, orchestrator, freeAgentMode,
    parentAgentId: parentAgentId || null, projectId: project.id, spawnedAt: Date.now(),
  };
  trackedQuickAgents.set(agentId, tracked);

  broadcastAndBuffer('agent:spawned', {
    id: agentId, name, kind: 'quick', status: 'starting', prompt,
    model: model || null, orchestrator, freeAgentMode, parentAgentId, projectId: project.id,
  });

  try {
    await spawnAgent({
      agentId, projectPath: project.path, cwd: project.path,
      kind: 'quick', model, mission: prompt, orchestrator, freeAgentMode,
    });
    tracked.status = 'running';
    broadcastToAllWindows(IPC.ANNEX.AGENT_SPAWNED, {
      id: agentId, name, kind: 'quick', status: 'running', prompt,
      model: model || null, orchestrator, freeAgentMode,
      parentAgentId, projectId: project.id, headless: true,
    });
    ws.send(JSON.stringify({ type: 'agent:spawn:ack', payload: { id: agentId, name, status: 'starting' } }));
  } catch {
    tracked.status = 'failed';
    trackedQuickAgents.delete(agentId);
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'spawn_failed' } }));
  }
}

// WS-based agent wake (mirrors HTTP handler)
async function handleWakeAgentWs(
  ws: WebSocket,
  agentId: string,
  options: { resume?: boolean; mission?: string; model?: string },
): Promise<void> {
  const agentInfo = await findAgentAcrossProjects(agentId);
  if (!agentInfo) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'agent_not_found' } }));
    return;
  }
  if (ptyManager.isRunning(agentId) || isHeadlessAgent(agentId) || structuredManager.isStructuredSession(agentId)) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'agent_already_running' } }));
    return;
  }
  const { config, project } = agentInfo;
  const agentModel = options.model || config.model;
  const cwd = config.worktreePath || project.path;

  try {
    await spawnAgent({
      agentId: config.id, projectPath: project.path, cwd,
      kind: 'durable', model: agentModel, mission: options.mission,
      orchestrator: config.orchestrator, freeAgentMode: config.freeAgentMode,
      resume: options.resume,
      sessionId: options.resume ? config.lastSessionId : undefined,
    });
    broadcastAndBuffer('agent:woken', { agentId: config.id, source: 'annex-v2' });
    broadcastSnapshotRefresh();
    ws.send(JSON.stringify({ type: 'agent:wake:ack', payload: { agentId: config.id, status: 'starting' } }));
  } catch {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'wake_failed' } }));
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export function start(): void {
  if (tlsServer || httpServer) {
    appLog('core:annex', 'debug', 'Annex server start() called but already running');
    return;
  }

  appLog('core:annex', 'info', 'Annex server starting...');

  // Generate identity on first enable (lazy creation)
  const identity = annexIdentity.getOrCreateIdentity();
  appLog('core:annex', 'info', 'Annex identity ready', {
    meta: { fingerprint: identity.fingerprint },
  });

  currentPin = generatePin();

  // --- Pairing server (plain HTTP) ---
  pairingServer = http.createServer(handlePairingRequest);

  // --- Main server (TLS with mTLS) ---
  let tlsOptions: tls.TlsOptions;
  try {
    tlsOptions = annexTls.createTlsServerOptions(identity);
    tlsServer = https.createServer(tlsOptions, handleRequest);
  } catch (err) {
    appLog('core:annex', 'warn', 'TLS server creation failed, falling back to plain HTTP', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    // Fallback: use plain HTTP for the main server (legacy/iOS compat)
    tlsServer = null;
  }

  // If TLS failed, fall back to HTTP for the main server
  const mainServer = tlsServer || http.createServer(handleRequest);
  if (!tlsServer) {
    httpServer = mainServer as http.Server;
  }

  wss = new WebSocketServer({ noServer: true });

  // WebSocket upgrade handler for the main server
  mainServer.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host}`);

    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Check auth: mTLS peer cert OR bearer token
    let authType: WsAuthType = 'bearer';

    let peerFingerprintForWs: string | undefined;
    if (tlsServer && socket instanceof tls.TLSSocket) {
      const peerFingerprint = annexTls.extractPeerFingerprint(socket);
      if (peerFingerprint) {
        const peer = annexPeers.getPeer(peerFingerprint);
        // Only grant mTLS auth to peers with role 'controller' (or legacy peers without a role)
        if (peer && (peer.role === 'controller' || !peer.role)) {
          authType = 'mtls';
          peerFingerprintForWs = peerFingerprint;
          annexPeers.updateLastSeen(peerFingerprint);
        }
      }
    }

    if (authType !== 'mtls') {
      // Fall back to bearer token auth
      const token = urlObj.searchParams.get('token');
      if (!isValidToken(token || undefined)) {
        appLog('core:annex', 'warn', 'WebSocket upgrade rejected — unauthorized', {
          meta: { remoteAddress: req.socket.remoteAddress, hasToken: !!token },
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    appLog('core:annex', 'info', 'WebSocket upgrade accepted', {
      meta: { authType, peerFingerprint: peerFingerprintForWs || 'none', remoteAddress: req.socket.remoteAddress },
    });

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wsAuthTypes.set(ws, authType);
      if (peerFingerprintForWs) {
        wsPeerFingerprints.set(ws, peerFingerprintForWs);
      }
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws) => {
    // Send snapshot on connect
    try {
      ws.send(JSON.stringify({ type: 'snapshot', payload: await buildSnapshot() }));
    } catch (err) {
      appLog('core:annex', 'error', 'Failed to send snapshot on connect', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      try {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'snapshot_failed' } }));
      } catch (sendErr) {
        appLog('core:annex', 'debug', 'Failed to send error to client (client likely disconnected)', {
          meta: { error: sendErr instanceof Error ? sendErr.message : String(sendErr) },
        });
      }
    }

    // Broadcast lock state when an mTLS controller connects
    const authType = wsAuthTypes.get(ws);
    if (authType === 'mtls') {
      const fingerprint = wsPeerFingerprints.get(ws);
      const peer = fingerprint ? annexPeers.getPeer(fingerprint) : null;
      broadcastToAllWindows(IPC.ANNEX.LOCK_STATE_CHANGED, {
        locked: true,
        controllerAlias: peer?.alias || 'Remote Controller',
        controllerIcon: peer?.icon || '',
        controllerColor: peer?.color || 'indigo',
        controllerFingerprint: fingerprint || '',
        remainingMs: 0,
      });
    }

    // Listen for client messages (replay requests)
    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString());
    });

    // Broadcast unlock when mTLS controller disconnects
    ws.on('close', (code, reason) => {
      appLog('core:annex', 'info', 'WebSocket client disconnected', {
        meta: { authType, code, reason: reason?.toString() || '' },
      });
      if (authType === 'mtls') {
        // Check if any other mTLS connections are still open
        const hasMtlsClient = Array.from(wss?.clients || []).some(
          (client) => client !== ws && client.readyState === WebSocket.OPEN && wsAuthTypes.get(client) === 'mtls',
        );
        if (!hasMtlsClient) {
          sessionPaused = false;
          broadcastToAllWindows(IPC.ANNEX.LOCK_STATE_CHANGED, {
            locked: false,
            remainingMs: 0,
          });
        }
      }
    });
  });

  // Subscribe to event bus (clean up any stale listeners first)
  unsubscribeEventBus();
  annexEventBus.setActive(true);

  unsubPtyData = annexEventBus.onPtyData((agentId, data) => {
    broadcastAndBuffer('pty:data', { agentId, data });
  });

  unsubHookEvent = annexEventBus.onHookEvent((agentId, event) => {
    const detailedStatus = hookEventToDetailedStatus(event);
    detailedStatusCache.set(agentId, detailedStatus);
    broadcastAndBuffer('hook:event', { agentId, event, detailedStatus });
  });

  unsubStructuredEvent = annexEventBus.onStructuredEvent((agentId, event) => {
    const detailedStatus = structuredEventToDetailedStatus(event);
    if (detailedStatus) {
      detailedStatusCache.set(agentId, detailedStatus);
    }
    broadcastAndBuffer('structured:event', { agentId, event, detailedStatus });
  });

  unsubPtyExit = annexEventBus.onPtyExit((agentId, exitCode) => {
    detailedStatusCache.delete(agentId);
    permissionQueue.clearForAgent(agentId);
    eventReplay.clearForAgent(agentId);

    broadcastAndBuffer('pty:exit', { agentId, exitCode });

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
      setTimeout(() => { trackedQuickAgents.delete(agentId); }, 60_000);
    }
  });

  unsubAgentSpawned = annexEventBus.onAgentSpawned((agentId, kind, projectId, meta) => {
    broadcastAndBuffer('agent:spawned', { id: agentId, kind, projectId, ...meta });
  });

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

  unsubGroupProjectChanged = annexEventBus.onGroupProjectChanged((action, project) => {
    broadcastWs({ type: 'group-project:changed', payload: { action, project } });
  });

  unsubBulletinMessage = annexEventBus.onBulletinMessage((projectId, message) => {
    broadcastWs({ type: 'bulletin:message', payload: { projectId, message } });
  });

  // Listen for group project registry changes and broadcast them
  unsubGroupProjectRegistry = groupProjectRegistry.onChange(() => {
    // Registry changed — broadcast updated list to all clients
    void groupProjectRegistry.list().then((projects) => {
      broadcastWs({ type: 'group-project:list', payload: { projects } });
    });
  });

  staleEvictionInterval = setInterval(() => {
    eventReplay.evictStale();
    // Evict expired session tokens (SEC-11)
    const now = Date.now();
    for (const [token, entry] of sessionTokens) {
      if (now - entry.issuedAt > TOKEN_TTL_MS) {
        sessionTokens.delete(token);
      }
    }
  }, 60_000);

  // Start both servers
  let mainReady = false;
  let pairingReady = false;

  function publishBonjour() {
    if (!mainReady || !pairingReady) return;
    try {
      appLog('core:annex', 'info', 'Creating Bonjour instance for mDNS advertisement...');
      bonjour = new Bonjour();
      const settings = annexSettings.getSettings();
      const serviceConfig = {
        name: settings.deviceName,
        type: 'clubhouse-annex',
        port: serverPort,
        txt: {
          v: '2',
          pairingPort: String(pairingPort),
          fingerprint: identity.fingerprint,
        },
      };
      appLog('core:annex', 'info', 'Publishing mDNS service', {
        meta: { name: serviceConfig.name, type: serviceConfig.type, port: serviceConfig.port, pairingPort },
      });
      bonjourService = bonjour.publish(serviceConfig);

      if (bonjourService) {
        bonjourService.on('error', (err: Error) => {
          appLog('core:annex', 'error', 'Bonjour service error after publish', {
            meta: { error: err.message, stack: err.stack },
          });
        });
        bonjourService.on('up', () => {
          appLog('core:annex', 'info', 'Bonjour service confirmed UP by mDNS stack');
        });
      }

      appLog('core:annex', 'info', 'mDNS service published (v2)', {
        meta: { name: settings.deviceName, mainPort: serverPort, pairingPort, fingerprint: identity.fingerprint },
      });

      // Broadcast updated status to renderer so UI reflects "Advertising" instead of "Starting..."
      broadcastToAllWindows(IPC.ANNEX.STATUS_CHANGED, getStatus());
    } catch (err) {
      appLog('core:annex', 'error', 'Failed to publish mDNS', {
        meta: { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
      });
    }
  }

  mainServer.listen(0, '0.0.0.0', () => {
    const addr = mainServer.address();
    if (addr && typeof addr === 'object') {
      serverPort = addr.port;
      appLog('core:annex', 'info', `Annex main server listening on 0.0.0.0:${serverPort} (${tlsServer ? 'TLS' : 'HTTP'})`);
      mainReady = true;
      publishBonjour();
    }
  });

  pairingServer.listen(0, '0.0.0.0', () => {
    const addr = pairingServer?.address();
    if (addr && typeof addr === 'object') {
      pairingPort = addr.port;
      appLog('core:annex', 'info', `Annex pairing server listening on 0.0.0.0:${pairingPort} (HTTP)`);
      pairingReady = true;
      publishBonjour();
    }
  });
}

export function stop(): void {
  // Unsubscribe from event bus
  unsubscribeEventBus();

  if (staleEvictionInterval) {
    clearInterval(staleEvictionInterval);
    staleEvictionInterval = null;
  }

  annexEventBus.setActive(false);

  // Close all WebSocket clients
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(); } catch (err) {
        appLog('core:annex', 'debug', 'Failed to close WebSocket client during shutdown', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    wss.close();
    wss = null;
  }

  // Un-publish mDNS
  if (bonjourService) {
    try { bonjourService.stop?.(); } catch (err) {
      appLog('core:annex', 'debug', 'Failed to stop Bonjour service during shutdown', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    bonjourService = null;
  }
  if (bonjour) {
    try { bonjour.destroy(); } catch (err) {
      appLog('core:annex', 'debug', 'Failed to destroy Bonjour instance during shutdown', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    bonjour = null;
  }

  // Close servers
  if (tlsServer) {
    tlsServer.close();
    tlsServer = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (pairingServer) {
    pairingServer.close();
    pairingServer = null;
  }

  serverPort = 0;
  pairingPort = 0;
  currentPin = '';
  sessionTokens.clear();
  detailedStatusCache.clear();
  trackedQuickAgents.clear();
  eventReplay.reset();
  permissionQueue.reset();

  appLog('core:annex', 'info', 'Annex server stopped');
}

export function getStatus(): AnnexStatus & { pairingPort: number; tlsEnabled: boolean } {
  const settings = annexSettings.getSettings();
  const identity = annexIdentity.getPublicIdentity();
  return {
    advertising: !!bonjourService,
    port: serverPort,
    pin: currentPin,
    connectedCount: wss ? wss.clients.size : 0,
    fingerprint: identity?.fingerprint || '',
    alias: settings.alias,
    icon: settings.icon,
    color: settings.color,
    pairingPort,
    tlsEnabled: !!tlsServer,
  };
}

/**
 * Broadcast a fresh snapshot to all connected WS clients.
 * Call after durable agent config changes (create, delete, rename) so
 * controllers see the update without needing to reconnect.
 */
export function broadcastSnapshotRefresh(): void {
  buildSnapshot().then((snapshot) => {
    broadcastWs({ type: 'snapshot', payload: snapshot });
  }).catch((err) => {
    appLog('core:annex', 'warn', 'broadcastSnapshotRefresh failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** Broadcast theme change to all connected WS clients. */
export function broadcastThemeChanged(): void {
  broadcastWs({ type: 'theme:changed', payload: { ...getThemeColors(), terminalColors: getTerminalColors() } });
}

// ---------------------------------------------------------------------------
// Server-side canvas mutation processing
// ---------------------------------------------------------------------------
//
// Reads the persisted canvas state from plugin storage, applies the mutation
// in-memory, writes the result back, and broadcasts to WS clients.  This
// runs in the main process and does not depend on the renderer's canvas
// store being loaded for the target project.

interface CanvasInstanceJSON {
  id: string;
  name: string;
  views: any[];
  viewport: { panX: number; panY: number; zoom: number };
  nextZIndex: number;
  zoomedViewId?: string | null;
  selectedViewId?: string | null;
}

/**
 * Strip `remote||satelliteId||originalId` namespace prefixes from agent/project
 * IDs in view update payloads.  Controllers send namespaced IDs but the
 * satellite must store originals so its renderer can resolve agents locally.
 */
function stripNamespacedIds(updates: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...updates };
  for (const key of ['agentId', 'projectId'] as const) {
    if (typeof cleaned[key] === 'string') {
      const parts = (cleaned[key] as string).split('||');
      if (parts.length === 3 && parts[0] === 'remote') {
        cleaned[key] = parts[2];
      }
    }
  }
  if (cleaned.metadata && typeof cleaned.metadata === 'object') {
    const meta = { ...(cleaned.metadata as Record<string, unknown>) };
    for (const key of ['agentId', 'projectId'] as const) {
      if (typeof meta[key] === 'string') {
        const parts = (meta[key] as string).split('||');
        if (parts.length === 3 && parts[0] === 'remote') {
          meta[key] = parts[2];
        }
      }
    }
    cleaned.metadata = meta;
  }
  return cleaned;
}

async function applyCanvasMutationServerSide(
  projectId: string,
  canvasId: string,
  mutation: Record<string, unknown>,
): Promise<void> {
  const project = await findProjectById(projectId);
  if (!project) return;

  // Read current canvas state
  const raw = await readPluginStorageKey({
    pluginId: 'canvas',
    scope: 'project-local',
    key: 'canvas-instances',
    projectPath: project.path,
  });

  let canvases: CanvasInstanceJSON[] = Array.isArray(raw) && raw.length > 0
    ? (raw as CanvasInstanceJSON[])
    : [{ id: canvasId, name: 'Canvas', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }];

  const activeIdRaw = await readPluginStorageKey({
    pluginId: 'canvas',
    scope: 'project-local',
    key: 'canvas-active-id',
    projectPath: project.path,
  });
  let activeCanvasId = (typeof activeIdRaw === 'string' && activeIdRaw) || canvases[0]?.id || canvasId;

  // Apply the mutation to the JSON data
  const type = mutation.type as string;

  switch (type) {
    case 'addCanvas': {
      const newId = `hub_${randomUUID().slice(0, 8)}`;
      canvases.push({ id: newId, name: 'Canvas', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null });
      activeCanvasId = newId;
      break;
    }
    case 'removeCanvas': {
      const removeId = mutation.canvasId as string;
      if (canvases.length <= 1) break;
      canvases = canvases.filter((c) => c.id !== removeId);
      if (activeCanvasId === removeId) activeCanvasId = canvases[0].id;
      break;
    }
    case 'renameCanvas': {
      const renameId = mutation.canvasId as string;
      const name = mutation.name as string;
      const canvas = canvases.find((c) => c.id === renameId);
      if (canvas) canvas.name = name;
      break;
    }
    case 'setActiveCanvas': {
      const setId = mutation.canvasId as string;
      if (canvases.find((c) => c.id === setId)) activeCanvasId = setId;
      break;
    }
    default: {
      // View-level mutations — find the target canvas
      const canvas = canvases.find((c) => c.id === canvasId);
      if (!canvas) return;

      switch (type) {
        case 'addView': {
          const viewId = `cv_${randomUUID().slice(0, 8)}`;
          canvas.views.push({
            id: viewId,
            type: mutation.viewType as string || 'agent',
            position: mutation.position || { x: 200, y: 200 },
            size: { width: 480, height: 480 },
            title: mutation.viewType === 'anchor' ? 'Anchor' : 'Agent',
            displayName: mutation.viewType === 'anchor' ? 'Anchor' : 'Agent',
            zIndex: canvas.nextZIndex,
            metadata: {},
          });
          canvas.nextZIndex++;
          break;
        }
        case 'addPluginView': {
          const viewId = `cv_${randomUUID().slice(0, 8)}`;
          const defaultSize = mutation.defaultSize as { width: number; height: number } | undefined;
          canvas.views.push({
            id: viewId,
            type: 'plugin',
            pluginId: mutation.pluginId,
            pluginWidgetType: mutation.qualifiedType,
            position: mutation.position || { x: 300, y: 300 },
            size: defaultSize || { width: 480, height: 480 },
            title: mutation.label as string || 'Plugin',
            displayName: mutation.label as string || 'Plugin',
            zIndex: canvas.nextZIndex,
            metadata: {},
          });
          canvas.nextZIndex++;
          break;
        }
        case 'removeView': {
          const viewId = mutation.viewId as string;
          canvas.views = canvas.views.filter((v: any) => v.id !== viewId);
          break;
        }
        case 'moveView': {
          const viewId = mutation.viewId as string;
          const pos = mutation.position as { x: number; y: number };
          const view = canvas.views.find((v: any) => v.id === viewId);
          if (view) view.position = pos;
          break;
        }
        case 'moveViews': {
          const positions = mutation.positions as Record<string, { x: number; y: number }>;
          if (positions) {
            for (const [vid, pos] of Object.entries(positions)) {
              const view = canvas.views.find((v: any) => v.id === vid);
              if (view) view.position = pos;
            }
          }
          break;
        }
        case 'resizeView': {
          const viewId = mutation.viewId as string;
          const size = mutation.size as { width: number; height: number };
          const view = canvas.views.find((v: any) => v.id === viewId);
          if (view) view.size = size;
          break;
        }
        case 'updateView': {
          const viewId = mutation.viewId as string;
          const updates = mutation.updates as Record<string, unknown>;
          const idx = canvas.views.findIndex((v: any) => v.id === viewId);
          if (idx >= 0 && updates) {
            // Strip namespace prefixes from agent/project IDs — controllers
            // send namespaced IDs (remote||satId||origId) but the satellite
            // stores original IDs so its own renderer can resolve them.
            const cleaned = stripNamespacedIds(updates);
            canvas.views[idx] = { ...canvas.views[idx], ...cleaned };
          }
          break;
        }
        case 'focusView': {
          const viewId = mutation.viewId as string;
          const view = canvas.views.find((v: any) => v.id === viewId);
          if (view) {
            view.zIndex = canvas.nextZIndex;
            canvas.nextZIndex++;
          }
          break;
        }
        case 'setViewport': {
          const vp = mutation.viewport as { panX: number; panY: number; zoom: number };
          if (vp) canvas.viewport = vp;
          break;
        }
        case 'zoomView': {
          canvas.zoomedViewId = (mutation.viewId as string) ?? null;
          break;
        }
        case 'selectView': {
          canvas.selectedViewId = (mutation.viewId as string) ?? null;
          break;
        }
      }
      break;
    }
  }

  // Write updated state back to plugin storage
  await writePluginStorageKey({
    pluginId: 'canvas',
    scope: 'project-local',
    key: 'canvas-instances',
    value: canvases,
    projectPath: project.path,
  });
  await writePluginStorageKey({
    pluginId: 'canvas',
    scope: 'project-local',
    key: 'canvas-active-id',
    value: activeCanvasId,
    projectPath: project.path,
  });

  // Broadcast the updated canvas state directly to WS clients
  const targetCanvas = canvases.find((c) => c.id === canvasId) || canvases.find((c) => c.id === activeCanvasId);
  if (targetCanvas) {
    broadcastCanvasStateToClients(projectId, {
      canvasId: targetCanvas.id,
      name: targetCanvas.name,
      views: targetCanvas.views,
      viewport: targetCanvas.viewport,
      nextZIndex: targetCanvas.nextZIndex,
      zoomedViewId: targetCanvas.zoomedViewId ?? null,
      selectedViewId: targetCanvas.selectedViewId ?? null,
      allCanvasTabs: canvases.map((c) => ({ id: c.id, name: c.name })),
      activeCanvasId,
    });
  }
}

/** Broadcast canvas state update to all connected controller clients. */
export function broadcastCanvasStateToClients(projectId: string, state: unknown): void {
  broadcastWs({ type: 'canvas:state', payload: { projectId, state } });
}

/** Broadcast session pause/resume to all connected WS clients. */
export function notifySessionPause(paused: boolean): void {
  sessionPaused = paused;
  broadcastWs({ type: paused ? 'session:paused' : 'session:resumed', payload: { paused } });
}

export function regeneratePin(): void {
  currentPin = generatePin();
  sessionTokens.clear();
  // Close all WS clients so they must re-pair
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(); } catch (err) {
        appLog('core:annex', 'debug', 'Failed to close WebSocket client during pin regeneration', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
}

/** Disconnect a specific peer's WebSocket connection by fingerprint. */
export function disconnectPeer(fingerprint: string): void {
  appLog('core:annex', 'info', `disconnectPeer called`, { meta: { fingerprint } });
  if (!wss) return;
  for (const client of wss.clients) {
    if (wsPeerFingerprints.get(client) === fingerprint) {
      try { client.close(1000, 'disconnected_by_satellite'); } catch (err) {
        appLog('core:annex', 'debug', 'Failed to close peer WebSocket connection', {
          meta: { fingerprint, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
}

/** Get the auth type of a WebSocket connection. Used by protocol V2 to gate control messages. */
export function getWsAuthType(ws: WebSocket): WsAuthType {
  return wsAuthTypes.get(ws) || 'bearer';
}

/** @internal Exposed for testing only. */
export const _testing = {
  get sessionTokens() { return sessionTokens; },
  isValidToken,
  TOKEN_TTL_MS,
};
