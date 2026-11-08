import { hasSessionCaptureFailure } from './session-capture-barrier';
import { waitForAgentStopped } from './agent-system';
import { previewAgentProvider, changeAgentProvider, persistGuidedSessionCapture } from './agent-provider-control';
import { withAgentTransition } from './agent-transition';
import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as annexTls from './annex-tls';
import { MOBILE_COMMAND_TYPES, type AnnexAgentUpdate, type MobileCommand, type MobileResponse } from '../../shared/mobile-control';
import { applyProjectStateChange, getProjectState, isProjectStateReady, onProjectStateChange } from './project-state-store';
import { isProjectIdle } from '../../shared/project-state';
import { applyFinishedQuickAgentChange, getFinishedQuickAgents, isFinishedQuickAgentsReady, onFinishedQuickAgentsChange } from './finished-quick-agents-store';
import type { CompletedQuickAgent, Project } from '../../shared/types';
import { ANNEX_FRAME_MAX_BYTES, MOBILE_WS_FRAME_MAX_BYTES, SNAPSHOT_FRAME_MAX_BYTES, SNAPSHOT_ICONS_MAX_BYTES } from '../../shared/icon-limits';
import { MobileCommandService, MobileControlError, chatControls, executeChatCommand, pendingInteractions, MOBILE_COMMAND_MAX_ENTRIES, MOBILE_COMMAND_TTL_MS } from './mobile-control';
import { isRevertRunning } from './agent-runtime/checkpoint-tracker';
import { readChatTranscript, listChatSessions } from './agent-runtime/chat-transcript';
import { isGraduatedFeatureOn } from './experimental-settings';
import { RICH_CHAT_CONTENT_FLAG } from '../../shared/chat';
import { readMobileChatContent } from './annex-chat-content';
import { agentFolders } from './agent-runtime/chat-files';
import { buildAgentDetails, buildAgentSettings, buildAgentSettingsOptions, buildCreateOptions, createMobileAgent, mobileOrchestration, updateMobileAgent, updateMobileDispatcher } from './mobile-agents';
import {
  DISPATCHER_CHANGED_EVENT, DISPATCHER_PROJECT_ID, activeDispatcher, assertDispatcherCommand, dispatcherCapability, dispatcherChange, dispatcherFolderProject,
  dispatcherOffFields, dispatcherRecord, dispatcherShellProject, dispatcherSnapshotFlags, isDisabledDispatcherId, isDispatcherProjectId,
  setDispatcherEnabledFromPhone,
} from './mobile-dispatcher';
import { getDispatcherState, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { helperRoutingRevision, onHelperRoutingChanged } from './helper-routing';
import { HELPER_ROUTING_CHANGED_EVENT, helperRoutingCapability, mobileHelperRouting, runHelperRoutingUpdate } from './mobile-helper-routing';
import { minimalRouting } from '../../shared/helper-routing';
import { resolveOrchestrationPolicies } from './orchestration-policy';
import { MOBILE_SLASH_COMMANDS_MAX, latestSlashCommands, remoteChatEvent } from './annex-chat-echo';
import { buildMobileHelperRequests, runHelperCommand } from './mobile-helper-requests';
import { onStartRequestsChanged } from './helper-start-requests';
import { onDisposeRequestsChanged } from './helper-dispose-requests';
import { MOBILE_ATTACHMENTS_CAPABILITY, MobileAttachmentService, MobileUploadError, isUploadContentType, readCappedBody } from './mobile-attachments';
import { sniffImage } from './agent-runtime/chat-attachments';

import Bonjour, { Service } from 'bonjour-service';
import * as annexEventBus from './annex-event-bus';
import * as annexSettings from './annex-settings';
import { annexNetworkProfile } from './annex-network-profile';
import { listenPreferringPort, type ListenFn } from './annex-listen';
import { buildPairingUrl, pairingHosts } from './annex-pairing-url';
import * as annexIdentity from './annex-identity';
import * as annexPeers from './annex-peers';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import { isDisposedAgent } from '../../shared/agent-helpers';
import * as ptyManager from './pty-manager';
import * as themeService from './theme-service';
import { getActiveTheme, resolveAnnexTheme, type AnnexTheme } from './active-theme-store';
import * as eventReplay from './annex-event-replay';
import * as permissionQueue from './annex-permission-queue';
import * as pluginManifestRegistry from './plugin-manifest-registry';
import { readKey as readPluginStorageKey, writeKey as writePluginStorageKey } from './plugin-storage';
import { groupProjectRegistry } from './group-project-registry';
import { getBulletinBoard } from './group-project-bulletin';
import { executeShoulderTap } from './group-project-shoulder-tap';
import { setProjectPolling } from './group-project-polling';
import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import * as fileService from './file-service';
import * as gitService from './git-service';
import { normalizeSessionEvents, buildSessionSummary, paginateEvents, SUMMARY_TRANSCRIPT_MAX_BYTES } from './session-reader';
import { isSessionCapable, getProvider } from '../orchestrators';
import { getAgentRuntime, isChatAgent, onChatEvent } from './agent-runtime';
import { chatDetailedStatus } from '../../shared/chat-agent-status';
import { CHAT_IMAGE_MAX_BYTES, type ChatEvent, type ChatSessionState } from '../../shared/chat';
import { injectPtyText } from './agent-runtime/pty-input';
import { AgentStoppingError } from './agent-runtime/agent-stopping';
import { spawnAgent, killAgent, getAvailableOrchestrators, isHeadlessAgent, resolveOrchestrator } from './agent-system';
import { appLog } from './log-service';
import { buildChatPage } from './annex-chat-pages';
import { forgetAppendedNotes, MOBILE_PERSISTENT_APPROVALS, OUTER_TOOL_INPUT_MAX_BYTES, PERMISSION_INPUT_MAX_BYTES, boundChatEvent, boundToolInput, toolInputSizeBucket } from './annex-chat-bounds';
import { ICON_TEMPORARILY_UNAVAILABLE, TEMPORARY_FAILURE_RETRY_MS as ICON_RETRY_MS, readIconImage, type IconImage } from './icon-images';

/**
 * Check if an agent is currently running in any execution mode.
 * Centralises the compound check so new execution modes only need updating here.
 */
function isAgentRunning(agentId: string): boolean {
  return ptyManager.isRunning(agentId) || isHeadlessAgent(agentId) || isChatAgent(agentId);
}
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import type { DigestSince } from '../../shared/group-project-types';
import { decodeDigestSince, SINCE_CHANNELS_PARAM } from '../../shared/digest-since';
import { THEMES } from '../../renderer/themes';
import { generateQuickName } from '../../shared/name-generator';
import { generateQuickAgentId } from '../../shared/agent-id';
import { observeQuickAgents, startQuickAgent } from './quick-agent-service';
import { ANNEX_PROTOCOL_VERSION } from '../../shared/types';
import { handshakeAttributes, parseTelemetryHello, telemetryHelloAck } from '../telemetry/annex-handshake';
import { rememberAnnexIncidentPhone, rememberAnnexIncidentTrace } from '../telemetry/feedback-incident';
import { currentRequestTraceparent, tel, withRemoteParent } from '../telemetry/facade';
import { annexCommandFlow } from '../telemetry/annex-telemetry';
import { traceHttpResponse } from '../telemetry/annex-request';
import { validatedTraceparent } from '../telemetry/trace-context';
import { chatEventTraceparent } from '../telemetry/chat-trace-context';
import {
  annexRestFlow,
  pairResultFor,
  recordBroadcast,
  recordClients,
  recordControlDenied,
  recordChatPageOverflow,
  recordFrameOverLimit,
  recordToolInputSize,
  recordPairServed,
  recordReplay,
  recordServerStarted,
  recordSnapshot,
  recordSnapshotBuild,
  recordSnapshotFailure,
  recordTlsFallback,
  restTraceparent,
  type SnapshotResult,
  type SnapshotTrigger,
  wsTraceparent,
} from '../telemetry/annex-telemetry';
import { validateAgentGitName } from '../../shared/agent-name';
import { ANNEX_BUFFER_HEADERS, annexPtyHost } from '../../shared/annex-pty';
import { detectWindowsPty } from '../util/windows-pty';
import type {
  AnnexStatus,
  AnnexPeer,
  AgentHookEvent,
  AgentDetailedStatus,
  AgentDetailedState,
  AgentExecutionMode,
  HookEventKind,
  ThemeColors,
  ThemeGradients,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

/** Check if a CORS origin is allowed (file:// or localhost). */
function isAllowedCorsOrigin(origin: string): boolean {
  if (!origin) return false;
  if (origin === 'file://') return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// Pairing port (plain HTTP): POST /pair, GET /api/v1/identity, OPTIONS
const mobileCommands = new MobileCommandService();
const mobileAttachments = new MobileAttachmentService();
/** Explicit session-only mobile pairing never writes the peer store. */
const mobileSessionPeers = new Map<string, AnnexPeer>();
function findPairedPeer(fingerprint: string): AnnexPeer | undefined {
  return mobileSessionPeers.get(fingerprint) ?? annexPeers.getPeer(fingerprint);
}
const mobileStartingAgents = new Map<string, { cancelled: boolean }>();
function finishMobileStart(agentId: string, start: { cancelled: boolean }): void {
  if (mobileStartingAgents.get(agentId) === start) mobileStartingAgents.delete(agentId);
}
let pairingServer: http.Server | null = null;
let pairingPort = 0;

// Main port (TLS with mTLS): all authenticated endpoints + WSS
let tlsServer: https.Server | null = null;
let httpServer: http.Server | null = null; // Legacy fallback — to be removed when mTLS is fully validated
let wss: WebSocketServer | null = null;
let bonjour: InstanceType<typeof Bonjour> | null = null;
let bonjourService: Service | null = null;
let serverPort = 0; // Main TLS port
let boundHost = ''; // networkProfile.host while running
let currentPin = '';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessionTokens = new Map<string, { issuedAt: number; peerFingerprint?: string }>();
/** Tokens revoked on peer removal — checked during validation, cleaned on TTL expiry. */
const revokedTokens = new Set<string>();

// Tag WebSocket connections with auth type for security gating
type WsAuthType = 'bearer' | 'mtls';
const wsAuthTypes = new WeakMap<WebSocket, WsAuthType>();
// Track peer fingerprint per WebSocket connection (for mTLS connections)
const wsPeerFingerprints = new WeakMap<WebSocket, string>();
// Track bearer token per WebSocket connection (for revocation on peer removal)
const wsBearerTokens = new WeakMap<WebSocket, string>();
/**
 * Shells a controller spawned over `pty:spawn-shell`, by session id (#2476).
 * Their output goes to that controller only, and they end when it disconnects.
 */
const shellOwners = new Map<string, WebSocket>();
const MAX_SHELLS_PER_CONNECTION = 8;
const MAX_SHELL_SESSION_ID_LENGTH = 128;

let unsubHelperRouting: (() => void) | null = null;
let unsubPtyData: (() => void) | null = null;
let unsubHookEvent: (() => void) | null = null;
let unsubChatEvent: (() => void) | null = null;
let unsubPtyExit: (() => void) | null = null;
let unsubAgentSpawned: (() => void) | null = null;
let unsubPermissionRequest: (() => void) | null = null;
let unsubGroupProjectChanged: (() => void) | null = null;
let unsubBulletinMessage: (() => void) | null = null;
let unsubGroupProjectRegistry: (() => void) | null = null;
let unsubHelperRequests: (() => void) | null = null;
let unsubDispatcher: (() => void) | null = null;
let staleEvictionInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Server-side WebSocket heartbeat: detect dead controller connections (e.g. mobile app killed)
const SERVER_HEARTBEAT_INTERVAL_MS = 30_000; // 30s ping interval
const wsAlive = new WeakMap<WebSocket, boolean>();

/** Whether the satellite session is currently paused (tracks across reconnects). */
let sessionPaused = false;
/** Fingerprint of the controller that owns the current session pause (lock). */
let sessionPauseOwner: string | null = null;

/**
 * Release the mTLS session-pause lock only when no mTLS clients remain.
 * Returns true if the lock was released, false if other clients are still
 * connected and the lock is kept (LB-OA-2026-05-01).
 *
 * The lock must NOT be released just because the "owner" fingerprint
 * disconnects — other controllers may still be connected, so the satellite
 * should remain locked until ALL mTLS clients are gone.
 */
function releaseMtlsLockIfLastClient(hasMtlsClient: boolean): boolean {
  if (hasMtlsClient) return false;
  sessionPaused = false;
  sessionPauseOwner = null;
  return true;
}

/** Unsubscribe all event bus listeners to prevent accumulation on restart cycles. */
function unsubscribeEventBus(): void {
  unsubPtyData?.();
  unsubHookEvent?.();
  unsubChatEvent?.();
  unsubPtyExit?.();
  unsubAgentSpawned?.();
  unsubPermissionRequest?.();
  unsubGroupProjectChanged?.();
  unsubBulletinMessage?.();
  unsubGroupProjectRegistry?.();
  unsubHelperRequests?.();
  unsubDispatcher?.();
  unsubHelperRouting?.();
  unsubHelperRouting = null;
  unsubPtyData = null;
  unsubHookEvent = null;
  unsubChatEvent = null;
  unsubPtyExit = null;
  unsubAgentSpawned = null;
  unsubPermissionRequest = null;
  unsubGroupProjectChanged = null;
  unsubBulletinMessage = null;
  unsubGroupProjectRegistry = null;
  unsubHelperRequests = null;
  unsubDispatcher = null;
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

/**
 * `chatState` lets a chat event say the state it moves to before the runtime
 * reports it: turn_started is published before the runtime sets 'running'.
 */
function getDetailedStatus(agentId: string, chatState?: ChatSessionState): AgentDetailedStatus | null {
  let status = detailedStatusCache.get(agentId);

  // Clear stale statuses (except needs_permission, which persists)
  if (status && status.state !== 'needs_permission' && Date.now() - status.timestamp > STALE_THRESHOLD_MS) {
    detailedStatusCache.delete(agentId);
    status = undefined;
  }

  // A chat agent's hook status only moves on tool and permission events, so
  // a long think or tool call goes stale mid-turn. Its chat session's state
  // says Working, as the app's chat header does (#2208).
  const runtime = getAgentRuntime(agentId);
  if (runtime?.kind === 'chat' && runtime.isRunning()) {
    status = chatDetailedStatus({ status: 'running' }, status, { state: chatState ?? runtime.getState(), turnStartedAt: runtime.getTurnStartedAt?.() ?? null });
  }
  return status ?? null;
}

// ---------------------------------------------------------------------------
// Live chat status push (#2211)
// ---------------------------------------------------------------------------

/** Last status pushed per chat agent, as a key, so repeated states aren't re-sent. */
const lastChatStatusPush = new Map<string, string>();

/** The chat session state a chat event moves to, or null when it isn't a state transition. */
function chatStateTransition(event: ChatEvent): ChatSessionState | null {
  switch (event.type) {
    case 'session_state': return event.data.state;
    case 'turn_started': return 'running';
    case 'turn_ended': return 'idle';
    default: return null;
  }
}

/**
 * Satellites and the iOS app get a chat agent's status from snapshots, and
 * between snapshots only from hook events, which a chat agent makes only for
 * tools, permissions and turn ends. So a turn that thinks before its first
 * tool showed Done (#2211). On each chat state transition this pushes the
 * status the snapshot would report, as `agent:status` with `detailedStatus`.
 * Streamed chunks and other events push nothing.
 */
function pushChatStatus(event: ChatEvent): void {
  const agentId = event.agentId;
  if (event.type === 'session_ended') {
    lastChatStatusPush.delete(agentId);
    return;
  }
  const chatState = chatStateTransition(event);
  if (!chatState) return;
  const runtime = getAgentRuntime(agentId);
  if (runtime?.kind !== 'chat' || !runtime.isRunning()) return;
  if (chatState !== 'running' && chatState !== 'waiting_permission' && chatState !== 'waiting_input' && chatState !== 'idle') return;

  // Done with no hook status left (it went stale): say Idle, as a stop event does.
  const detailedStatus = getDetailedStatus(agentId, chatState)
    ?? (chatState === 'idle' ? { state: 'idle' as const, message: 'Idle', timestamp: event.ts } : null);
  if (!detailedStatus) return;

  const key = `${detailedStatus.state}|${detailedStatus.message}|${detailedStatus.toolName ?? ''}`;
  if (lastChatStatusPush.get(agentId) === key) return;
  lastChatStatusPush.set(agentId, key);

  // agent:status is in the protocol already: the iOS app decodes it and only
  // updates a quick agent's run status from it, which stays 'running' here.
  const quick = trackedQuickAgents.get(agentId);
  broadcastAndBuffer('agent:status', {
    id: agentId,
    agentId,
    kind: quick ? 'quick' : 'durable',
    status: 'running',
    ...(quick ? { projectId: quick.projectId, parentAgentId: quick.parentAgentId } : {}),
    detailedStatus,
    lastActivityAt: noteAgentActivity(agentId, event.ts),
  });
}

/** Resolve the execution mode of an agent. */
export function getAgentExecutionMode(agentId: string): AgentExecutionMode {
  if (isChatAgent(agentId)) return 'chat';
  if (isHeadlessAgent(agentId)) return 'headless';
  return 'pty';
}

// ---------------------------------------------------------------------------
// Clipboard image forwarding
// ---------------------------------------------------------------------------

const CLIPBOARD_IMAGE_CLEANUP_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Save a pasted image and paste its path into the agent's terminal. Returns
 * the error to send back when the terminal is shutting down (nothing is
 * written then), else undefined.
 */
export function handleClipboardImage(agentId: string, base64: string, _mimeType: string): { code: string; message: string } | undefined {
  // Chat agents have no terminal to paste a path into; they take images through
  // POST /api/v1/mobile/agents/:id/attachments and chat.send (#2453).
  if (isChatAgent(agentId)) {
    return { code: 'chat_agent_unsupported', message: 'Chat agents take images as chat attachments, not clipboard pastes' };
  }
  if (ptyManager.isStopping(agentId)) {
    // The process is exiting and would swallow the pasted path.
    return { code: 'agent_stopping', message: new AgentStoppingError(agentId).message };
  }
  const buffer = Buffer.from(base64, 'base64');
  // The bytes decide the type: the claimed mimeType is never trusted.
  const sniffed = sniffImage(buffer.subarray(0, 16));
  if (!sniffed) return { code: 'unsupported_image', message: 'Only PNG, JPEG, GIF or WebP images can be pasted' };
  const ext = sniffed === 'image/png' ? '.png'
    : sniffed === 'image/jpeg' ? '.jpg'
    : sniffed === 'image/gif' ? '.gif'
    : '.webp';
  const fileName = `clipboard-paste-${randomUUID().slice(0, 8)}${ext}`;
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, fileName);

  try {
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
/** Pending removals of exited quick agents. Kept out of the entries because those are sent to phones, and a Timeout can't be serialized (#2639). */
const quickAgentCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Quick agents don't inherit a colour: the desktop always draws them gray. */
const QUICK_AGENT_COLOR = 'gray';

function cancelQuickAgentCleanup(agentId: string): void {
  clearTimeout(quickAgentCleanupTimers.get(agentId));
  quickAgentCleanupTimers.delete(agentId);
}

function setTrackedQuickAgent(agentId: string, entry: TrackedQuickAgent): void {
  cancelQuickAgentCleanup(agentId);
  trackedQuickAgents.set(agentId, entry);
  noteAgentActivity(agentId, entry.spawnedAt);
}

function untrackQuickAgent(agentId: string): void {
  cancelQuickAgentCleanup(agentId);
  trackedQuickAgents.delete(agentId);
}

// Quick agents started through the shared service (#2951): from here, and
// from Actions. Phones see them in the snapshot and get agent:spawned.
// Only while the server runs: its exit cleanup untracks them, and a stopped
// server would keep them as running forever.
observeQuickAgents({
  starting(entry) {
    if (!wss) return;
    setTrackedQuickAgent(entry.id, entry);
    broadcastAndBuffer('agent:spawned', quickAgentWireFields(entry));
  },
  failed(entry) {
    untrackQuickAgent(entry.id);
  },
});

/** What a tracked quick agent sends to controllers. Named, so a field added to the entry stays off the wire until it's listed here. */
function quickAgentWireFields(qa: TrackedQuickAgent) {
  return {
    id: qa.id,
    name: qa.name,
    kind: qa.kind,
    status: qa.status,
    prompt: qa.prompt,
    model: qa.model,
    orchestrator: qa.orchestrator,
    freeAgentMode: qa.freeAgentMode,
    parentAgentId: qa.parentAgentId,
    projectId: qa.projectId,
    spawnedAt: qa.spawnedAt,
  };
}

// ---------------------------------------------------------------------------
// Last activity per agent, so phones can sort by it
// ---------------------------------------------------------------------------

/** ms since epoch of each agent's latest chat event, status change, spawn or wake while the server runs. */
const agentLastActivity = new Map<string, number>();

/** Record activity (never moving the time backwards) and return the agent's latest. */
function noteAgentActivity(agentId: string, at: number = Date.now()): number {
  const latest = Math.max(at, agentLastActivity.get(agentId) ?? 0);
  agentLastActivity.set(agentId, latest);
  return latest;
}

/** Latest activity, else when the agent was created (0 if unknown). */
function lastActivityAt(agentId: string, createdAt?: string | number): number {
  const recorded = agentLastActivity.get(agentId);
  if (recorded !== undefined) return recorded;
  const created = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt ?? '');
  return Number.isFinite(created) ? created : 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PIN_LENGTH = 6;
const PIN_PATTERN = /^\d{6}$/;

function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(PIN_LENGTH, '0');
}

function comparePins(providedPin: string, expectedPin: string): boolean {
  if (!PIN_PATTERN.test(providedPin) || !PIN_PATTERN.test(expectedPin)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(providedPin, 'utf8'),
    Buffer.from(expectedPin, 'utf8'),
  );
}

function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  if (revokedTokens.has(token)) return false;
  const entry = sessionTokens.get(token);
  if (!entry) return false;
  if (entry.peerFingerprint) {
    const peer = findPairedPeer(entry.peerFingerprint);
    if (!peer || (peer.role && peer.role !== 'controller')) { sessionTokens.delete(token); return false; }
  }
  if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) {
    sessionTokens.delete(token);
    revokedTokens.delete(token);
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

/** How much of a refused upload is discarded, and for how long, so the client gets to read its answer. */
const OVERSIZED_BODY_DRAIN_BYTES = 16 * 1024 * 1024;
const OVERSIZED_BODY_DRAIN_MS = 10_000;

/**
 * Answers a request whose upload won't be read, such as a body over its limit.
 * Ending the response closes the socket, and closing on unread upload bytes can
 * reset the connection and lose the answer, so the answer goes out now and the
 * response ends once the upload is over or a bound is hit.
 */
function sendJsonAndDrain(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), Connection: 'close' });
  res.write(json);
  if (req.readableEnded || req.destroyed) { res.end(); return; }
  let discarded = 0;
  const finish = () => {
    clearTimeout(timer);
    req.off('data', discard);
    req.off('end', finish);
    req.off('close', finish);
    res.end();
  };
  const discard = (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > OVERSIZED_BODY_DRAIN_BYTES) finish();
  };
  const timer = setTimeout(finish, OVERSIZED_BODY_DRAIN_MS);
  req.on('data', discard);
  req.on('end', finish);
  req.on('close', finish);
  req.resume();
}

function isBodyTooLarge(err: unknown): boolean {
  return err instanceof MobileUploadError && err.code === 'too_large';
}

/** A body over the 1 MB cap: drained, then answered with a 413 the client can read. Never its content. */
function refuseOversizedBody(req: http.IncomingMessage, res: http.ServerResponse): void {
  appLog('core:annex', 'warn', 'Annex request body too large', { meta: { method: req.method, path: req.url?.split('?')[0], maxBytes: MAX_BODY_SIZE } });
  sendJsonAndDrain(req, res, 413, { error: 'too_large', maxBytes: MAX_BODY_SIZE });
}

/** The request body as text, at most MAX_BODY_SIZE bytes; over that it rejects with a `too_large` MobileUploadError. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return readCappedBody(req, MAX_BODY_SIZE).then((body) => body.toString());
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
    return handler(body);
  }).catch((err) => {
    if (isBodyTooLarge(err) && !res.headersSent) { refuseOversizedBody(req, res); return; }
    appLog('core:annex', 'error', 'readBody failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    res.writeHead(400);
    res.end();
  });
}

/** The selected theme, with the renderer's synced colors for plugin and custom themes. */
function getAnnexTheme(): AnnexTheme {
  return resolveAnnexTheme(themeService.getSettings().themeId, getActiveTheme(), THEMES);
}

/** The snapshot's `theme`: the colors plus, additively, `gradients` when the theme has any. */
function getThemeColors(): ThemeColors & { gradients?: ThemeGradients } {
  const { colors, gradients } = getAnnexTheme();
  return { ...colors, ...(gradients ? { gradients } : {}) };
}

function getTerminalColors(): import('../../shared/types').TerminalColors {
  return getAnnexTheme().terminal;
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

/**
 * One project's pins, inactive mark and activity for a phone (#2458). `idle` is
 * the desktop's rule, so the phone doesn't re-implement it; the desktop's own
 * selection exemption doesn't apply to a phone.
 */
function projectStateEntry(projectId: string, runningIds: ReadonlySet<string>, now = Date.now()) {
  const state = getProjectState();
  return {
    lastActivityAt: state.projectActivity[projectId] ?? null,
    pinned: state.pinnedProjectIds.includes(projectId),
    inactive: state.inactiveProjectIds.includes(projectId),
    idle: isProjectIdle(projectId, {
      activity: state.projectActivity, pinnedIds: state.pinnedProjectIds, inactiveIds: state.inactiveProjectIds,
      runningIds, activeProjectId: null, idleDays: state.idleDays, now,
    }),
  };
}

/** The snapshot's `projectState` and `idleDays`, or nothing before the state has moved into main. */
function projectStateSnapshot(projectIds: string[], agents: Record<string, unknown[]>, quickAgents: Record<string, unknown[]>) {
  if (!isProjectStateReady()) return {};
  // Running as the sidebar counts it: a project with an agent whose status is running.
  const runningIds = new Set(projectIds.filter((id) => [...(agents[id] ?? []), ...(quickAgents[id] ?? [])]
    .some((a) => (a as { status?: string }).status === 'running')));
  const now = Date.now();
  return {
    projectState: Object.fromEntries(projectIds.map((id) => [id, projectStateEntry(id, runningIds, now)])),
    idleDays: getProjectState().idleDays,
  };
}

// Pins, marks or activity changed on the desktop or from a phone: tell connected phones.
onProjectStateChange(() => {
  if (wss && wss.clients.size > 0) broadcastSnapshotRefresh();
});

/**
 * One entry of the start page's "Finished, waiting on you" list for a phone
 * (#2467). No paths, transcripts or stderr: only what the list shows.
 */
function finishedQuickAgentEntry(r: CompletedQuickAgent) {
  return {
    agentId: r.id,
    name: r.name,
    prompt: r.mission,
    summary: r.summary,
    exitCode: r.exitCode,
    finishedAt: r.completedAt,
    ...(r.parentAgentId && { parentAgentId: r.parentAgentId }),
    ...(r.cancelled && { cancelled: true }),
  };
}

function finishedQuickAgentList(projectId: string, all = getFinishedQuickAgents()) {
  return (all[projectId] ?? []).map(finishedQuickAgentEntry);
}

/** The snapshot's `finishedQuickAgents`, every project newest first, or nothing before the lists have moved into main. */
function finishedQuickAgentsSnapshot(projectIds: string[]) {
  if (!isFinishedQuickAgentsReady()) return {};
  const all = getFinishedQuickAgents();
  return { finishedQuickAgents: Object.fromEntries(projectIds.map((id) => [id, finishedQuickAgentList(id, all)])) };
}

// A quick agent finished, or one was dismissed, on the desktop or from a phone: tell connected phones.
onFinishedQuickAgentsChange(() => {
  if (wss && wss.clients.size > 0) broadcastSnapshotRefresh();
});

type DurableConfigs = Awaited<ReturnType<typeof agentConfig.listDurable>>;

/** Each agent's orchestration policy for the catalog (#2228); none when it can't be read, so the list still loads. */
async function catalogOrchestration(projectPath: string, durables: DurableConfigs) {
  try {
    return await resolveOrchestrationPolicies(projectPath, durables);
  } catch (err) {
    appLog('core:annex', 'warn', 'Could not resolve orchestration policies for the mobile catalog', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return new Map<string, never>();
  }
}

/** The Dispatcher can't start while it is off, though its history can still be read. */
function isDispatcherOffForStart(agentId: string): boolean {
  const state = getDispatcherState();
  return state.agentId === agentId && !state.enabled;
}

/** The Dispatcher as the snapshot, dispatcher:changed and the capabilities carry it: the same shape in all three. */
function dispatcherAgentView(config: DurableConfigs[number]) {
  return { ...mapDurableAgent(config, DISPATCHER_PROJECT_ID), isDispatcher: true as const };
}

function mapDurableAgent(d: DurableConfigs[number], projectId: string, policies?: Awaited<ReturnType<typeof catalogOrchestration>>) {
  const agentId = d.id;
  const isRunning = isAgentRunning(agentId);
  const status = isRunning ? 'running' : 'sleeping';

  return {
    id: d.id,
    projectId,
    name: d.name,
    kind: 'durable' as const,
    color: d.color,
    /** The agent's emoji avatar, which the desktop draws in place of initials when set. */
    emoji: d.emoji || null,
    branch: d.branch || null,
    model: d.model || null,
    orchestrator: d.orchestrator || null,
    freeAgentMode: d.freeAgentMode ?? false,
    icon: d.icon || null,
    status,
    detailedStatus: isRunning ? getDetailedStatus(agentId) : null,
    executionMode: isRunning ? getAgentExecutionMode(agentId) : null,
    /** There's a CLI session to resume, so a controller's default Wake can ask for one. */
    hasSession: !!d.lastSessionId,
    lastActivityAt: lastActivityAt(agentId, d.createdAt),
    /** The agent that started it, so a controller can tell a helper. Absent on a top-level agent. */
    ...(d.parentAgentId && { parentAgentId: d.parentAgentId }),
    /** What a helper's start decided, in codes (#2671). Details are in its settings. */
    ...(d.routing && { routing: minimalRouting(d.routing) }),
    /** The Orchestration card's policy; agent.update's `orchestration` changes it. */
    ...(policies?.has(agentId) && { orchestration: mobileOrchestration(policies.get(agentId)!) }),
  };
}

// ---------------------------------------------------------------------------
// Snapshot (Issues 1, 3, 6, 8)
// ---------------------------------------------------------------------------

interface SnapshotIconStats {
  iconCount: number;
  iconBytes: number;
  iconsLeftOut: number;
}

/** An icon as a phone that fetches them sees it: what to ask for and what will come. */
type IconRef = Pick<IconImage, 'version' | 'type' | 'bytes' | 'width' | 'height'>;

interface IconRefs {
  agents: Record<string, IconRef>;
  projects: Record<string, IconRef>;
}

interface BuiltSnapshot {
  payload: { projects: unknown[]; agents: Record<string, unknown[]>; [field: string]: unknown };
  icons: SnapshotIconStats;
  iconRefs: IconRefs;
}

/**
 * A snapshot's reads get this long, then count as a failure. Everyone waiting on a
 * build waits on all of it. `snapshot_failed` is what starts a phone's 30 second grace,
 * after which it reconnects, so a phone waiting on a hung build has about 45 seconds
 * from connecting. The reads can't be cancelled: whatever they return later is ignored.
 */
const SNAPSHOT_BUILD_TIMEOUT_MS = 15_000;
/** Reads given up on and still running. While there's one, no more start, so retries can't pile up behind a hung disk. */
const abandonedSnapshotReads = new Set<Promise<unknown>>();

/** A snapshot's disk reads. */
async function readSnapshotSources(): Promise<SnapshotSources> {
  const startMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (abandonedSnapshotReads.size > 0) throw new Error('snapshot_build_stuck');
    const generation = refreshGeneration;
    const read = readSnapshotSourcesData();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // The server stopped since this began, so it says nothing about the one running now.
        if (generation === refreshGeneration) abandonedSnapshotReads.add(read);
        const done = () => { abandonedSnapshotReads.delete(read); };
        read.then(done, done);
        reject(new Error('snapshot_build_timeout'));
      }, SNAPSHOT_BUILD_TIMEOUT_MS);
      timer.unref?.();
    });
    return await Promise.race([read, timeout]);
  } catch (err) {
    recordSnapshotFailure('build_failed');
    throw err;
  } finally {
    clearTimeout(timer);
    recordSnapshotBuild(startMs);
  }
}

let lastIconBudgetWarning = '';

/**
 * The snapshot's icons, as thumbnails, up to SNAPSHOT_ICONS_MAX_BYTES. Past that
 * an icon is left out and a phone uses the icon routes or initials. The Dispatcher
 * comes first, then projects, then agents, in a set order, so the same icons stay
 * from one snapshot to the next.
 */
async function buildSnapshotIcons(
  projects: Project[],
  durablesByProject: Record<string, DurableConfigs>,
  dispatcher?: DurableConfigs[number],
): Promise<{ projectIcons: Record<string, string>; agentIcons: Record<string, string>; stats: SnapshotIconStats; iconRefs?: IconRefs }> {
  const projectIcons: Record<string, string> = {};
  const agentIcons: Record<string, string> = {};
  const iconRefs: IconRefs = { agents: {}, projects: {} };
  const agentIcon = (d: DurableConfigs[number]) => ({ into: agentIcons, refs: iconRefs.agents, id: d.id, locate: () => agentConfig.agentIconFilePath(d.icon!) });
  const wanted = [
    ...(dispatcher?.icon ? [agentIcon(dispatcher)] : []),
    ...projects.filter((p) => p.icon).map((p) => ({ into: projectIcons, refs: iconRefs.projects, id: p.id, locate: () => projectStore.iconFilePath(p.icon!) })),
    ...projects.flatMap((p) => durablesByProject[p.id] ?? []).filter((d) => d.icon).map(agentIcon),
  ];
  const images = await Promise.all(wanted.map(async ({ locate }) => {
    const filePath = await locate();
    return filePath ? readIconImage(filePath) : null;
  }));

  let includedBytes = 0;
  let leftOutCount = 0;
  let leftOutBytes = 0;
  images.forEach((image, i) => {
    if (!image || image === ICON_TEMPORARILY_UNAVAILABLE) return;
    const { dataUrl, ...ref } = image;
    // A ref has no budget: it's a few fields, and the phone decides when to fetch.
    wanted[i].refs[wanted[i].id] = ref;
    if (includedBytes + dataUrl.length > SNAPSHOT_ICONS_MAX_BYTES) {
      leftOutCount++;
      leftOutBytes += dataUrl.length;
      return;
    }
    includedBytes += dataUrl.length;
    wanted[i].into[wanted[i].id] = dataUrl;
  });

  // Snapshots rebuild often: say it once, and again only when it changes.
  const warning = leftOutCount > 0 ? `${leftOutCount}:${leftOutBytes}:${includedBytes}` : '';
  if (warning && warning !== lastIconBudgetWarning) {
    appLog('core:annex', 'warn', 'Snapshot left out icons to stay within its budget', {
      meta: { leftOutCount, leftOutBytes, includedBytes, budgetBytes: SNAPSHOT_ICONS_MAX_BYTES },
    });
  }
  lastIconBudgetWarning = warning;
  const iconsUnknown = images.includes(ICON_TEMPORARILY_UNAVAILABLE);
  noteSnapshotIconsUnknown(iconsUnknown);
  return {
    projectIcons,
    agentIcons,
    // Present means complete, and no entry means removed. So with an icon whose answer isn't known, say nothing.
    ...(iconsUnknown ? {} : { iconRefs }),
    stats: { iconCount: Object.keys(projectIcons).length + Object.keys(agentIcons).length, iconBytes: includedBytes, iconsLeftOut: leftOutCount },
  };
}

type CanvasStateWire = { canvases: unknown[]; activeCanvasId: string; wireDefinitions?: unknown[] };

/** A project's canvases and wires, or the app's with no path. Null when there are none or they can't be read. */
async function readCanvasState(projectPath?: string): Promise<CanvasStateWire | null> {
  const where = projectPath ? { scope: 'project-local' as const, projectPath } : { scope: 'global' as const };
  try {
    const [canvases, activeId, wires] = await Promise.all(['canvas-instances', 'canvas-active-id', 'canvas-wires'].map((key) => (
      readPluginStorageKey({ pluginId: 'canvas', key, ...where })
    )));
    if (!canvases || !Array.isArray(canvases) || canvases.length === 0) return null;
    return {
      canvases,
      activeCanvasId: (activeId as string) || (canvases[0] as any)?.id || '',
      ...(wires && Array.isArray(wires) && wires.length > 0 ? { wireDefinitions: wires } : {}),
    };
  } catch {
    // Canvas data not available — skip
    return null;
  }
}

type SnapshotSources = Awaited<ReturnType<typeof readSnapshotSourcesData>>;

/** Everything that needs awaiting. Live state comes after, in assembleSnapshot. */
async function readSnapshotSourcesData() {
  const projects = await projectStore.list();
  const durablesByProject: Record<string, DurableConfigs> = {};
  const policiesByProject: Record<string, Awaited<ReturnType<typeof catalogOrchestration>>> = {};

  // Fetch agents per project in parallel
  await Promise.all(projects.map(async (proj) => {
    // Disposed helpers (#2224) keep a config row but are not agents to show.
    const durables = (await agentConfig.listDurable(proj.path)).filter((d) => !isDisposedAgent(d));
    durablesByProject[proj.id] = durables;
    policiesByProject[proj.id] = await catalogOrchestration(proj.path, durables);
  }));

  const iconSet = await buildSnapshotIcons(projects, durablesByProject, dispatcherRecord() ?? undefined);

  // Read per-project canvas state in parallel (including wires)
  const canvasState: Record<string, CanvasStateWire> = {};
  await Promise.all(projects.map(async (proj) => {
    const state = await readCanvasState(proj.path);
    if (state) canvasState[proj.id] = state;
  }));

  // Read app-level (global scope) canvas state (including wires)
  const appCanvasState = await readCanvasState();

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

  return { projects, durablesByProject, policiesByProject, iconSet, canvasState, appCanvasState, groupProjects, bulletinDigests };
}

/**
 * The snapshot, from its disk reads and today's live state. All in one tick, and a
 * caller sends it in that tick too, so `lastSeq` and every live field describe the
 * same moment. An agent that starts during the reads shows as running, rather than
 * a refresh overwriting that with a newer cursor. What came from disk can lag, but
 * what changes it asks for another refresh, which follows this one.
 */
function assembleSnapshot(sources: SnapshotSources): BuiltSnapshot {
  const { projects, durablesByProject, policiesByProject, iconSet, canvasState, appCanvasState, groupProjects, bulletinDigests } = sources;
  const { projectIcons, agentIcons, stats: icons, iconRefs } = iconSet;
  const agents: Record<string, unknown[]> = {};
  const quickAgents: Record<string, unknown[]> = {};
  for (const proj of projects) {
    agents[proj.id] = durablesByProject[proj.id].map((d) => mapDurableAgent(d, proj.id, policiesByProject[proj.id]));
    quickAgents[proj.id] = [];
  }

  // Add tracked quick agents to their project buckets
  for (const qa of trackedQuickAgents.values()) {
    if (!quickAgents[qa.projectId]) {
      quickAgents[qa.projectId] = [];
    }
    quickAgents[qa.projectId].push({
      ...quickAgentWireFields(qa),
      color: QUICK_AGENT_COLOR,
      detailedStatus: getDetailedStatus(qa.id),
      lastActivityAt: lastActivityAt(qa.id, qa.spawnedAt),
    });
  }

  // The Dispatcher (#2533): in no project, so on its own. Its record stays listed while it is off, so history isn't lost.
  const record = dispatcherRecord();
  const dispatcherAgent = record ? dispatcherAgentView(record) : null;

  // Build agents metadata (execution modes, detailed statuses)
  const agentsMeta: Record<string, { executionMode: string | null; detailedStatus: AgentDetailedStatus | null }> = {};
  for (const projectAgents of [...Object.values(agents), ...(dispatcherAgent ? [[dispatcherAgent]] : [])]) {
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
          status: isAgentRunning(b.agentId) ? 'connected' : 'sleeping',
        }));
      if (members.length > 0) {
        groupProjectMembers[gp.id] = members;
      }
    }
  } catch {
    // Binding manager not available — skip
  }

  return { icons, iconRefs, payload: {
    protocolVersion: ANNEX_PROTOCOL_VERSION,
    projects,
    agents,
    quickAgents,
    agentsMeta,
    theme: getThemeColors(),
    terminalColors: getTerminalColors(),
    orchestrators: getOrchestratorsMap(),
    pendingPermissions: permissionQueue.listPending().map((pending) => ({ ...pending, ...boundToolInput(pending.toolInput) })),
    // Helper starts and disposes waiting on the user (#159); gated by capabilities.helperRequests.
    helperRequests: buildMobileHelperRequests(projects, durablesByProject),
    // Moves when presets or a cell's state change, so an open or cached page knows to refetch (#2671).
    helperRoutingRevision: helperRoutingRevision(),
    lastSeq: eventReplay.getLastSeq(),
    plugins,
    projectIcons,
    ...projectStateSnapshot(projects.map((p) => p.id), agents, quickAgents),
    ...finishedQuickAgentsSnapshot(projects.map((p) => p.id)),
    agentIcons,
    canvasState,
    appCanvasState,
    sessionPaused,
    groupProjects,
    bulletinDigests,
    groupProjectMembers,
    ptyHost: annexPtyHost(process.platform, detectWindowsPty()),
    // Null until the Dispatcher exists; its agent is the agents[projectId][] shape plus isDispatcher.
    dispatcher: dispatcherAgent
      ? { ...dispatcherSnapshotFlags(), projectId: DISPATCHER_PROJECT_ID, ...dispatcherOffFields(getDispatcherState(), dispatcherAgentView), agent: dispatcherAgent }
      : null,
  } };
}

// ---------------------------------------------------------------------------
// WebSocket broadcast with replay buffer (Issue 8)
// ---------------------------------------------------------------------------

/** Telemetry: open clients by kind (mTLS controllers are desktop, bearer clients mobile). */
function reportClientCounts(): void {
  const counts = { desktop: 0, mobile: 0, unknown: 0 };
  for (const client of wss?.clients ?? []) {
    if (client.readyState === WebSocket.OPEN) counts[clientKindOf(client)]++;
  }
  recordClients(counts.desktop, counts.mobile, counts.unknown);
}

/** What a socket said it was at connect, for metrics only. It's unverified, so nothing else may read it. */
const wsClientKinds = new WeakMap<WebSocket, 'desktop' | 'mobile'>();

/**
 * Metrics only: its `client` param, or else its telemetry hello. Auth can't say, because a
 * phone and a desktop controller both use pinned mTLS, so anything else is counted as unknown.
 */
function clientKindOf(ws: WebSocket): 'desktop' | 'mobile' | 'unknown' {
  const said = wsClientKinds.get(ws);
  if (said) return said;
  const service = wsTelemetryPeerServices.get(ws);
  if (service === 'clubhouse-go') return 'mobile';
  return service === 'clubhouse' ? 'desktop' : 'unknown';
}

/** A frame this size is worth knowing about: a phone can't take one over MOBILE_WS_FRAME_MAX_BYTES. */
const LARGE_FRAME_LOG_BYTES = 4 * 1024 * 1024;
/** Writes to the project list come in bursts, as saving an image takes more than one. */
const PROJECTS_CHANGED_DEBOUNCE_MS = 150;
const LARGE_FRAME_LOG_INTERVAL_MS = 60_000;
const lastLargeFrameLog = new Map<string, number>();

/** Logs a large frame's type and size, never its contents, at most once a minute for each type. */
function noteFrameSize(data: string, type?: string): void {
  // A character is at most three UTF-8 bytes, so most frames skip the count.
  if (data.length * 3 < LARGE_FRAME_LOG_BYTES) return;
  const bytes = Buffer.byteLength(data);
  if (bytes < LARGE_FRAME_LOG_BYTES) return;
  const frameType = type ?? data.match(/^\{"type":"([^"]+)"/)?.[1] ?? 'other';
  const now = Date.now();
  if (now - (lastLargeFrameLog.get(frameType) ?? -Infinity) < LARGE_FRAME_LOG_INTERVAL_MS) return;
  lastLargeFrameLog.set(frameType, now);
  appLog('core:annex', bytes > MOBILE_WS_FRAME_MAX_BYTES ? 'error' : 'warn', 'Sending a large WebSocket frame', {
    meta: { type: frameType, bytes, mobileLimitBytes: MOBILE_WS_FRAME_MAX_BYTES },
  });
}

/**
 * What a frame of each type becomes when it's over the limit, keeping what it means.
 * Types not here go as they are and are counted: each either has its own bound before this
 * or holds facts that can't be left out. A snapshot isn't here because it has its own
 * limits, in snapshotFrame.
 */
const FRAME_FALLBACKS: Readonly<Record<string, (message: { payload: Record<string, unknown> }) => object>> = {
  // Replay and anything else sending one that didn't start in broadcastAndBuffer.
  'chat:event': (message) => {
    const { event } = message.payload as { event: ChatEvent };
    return { ...message, payload: { ...message.payload, event: boundChatEvent(event, Buffer.byteLength(JSON.stringify(event))) } };
  },
  // A marker naming what changed, with no state. Its reader fetches it through the route a truncated snapshot uses.
  'canvas:state': (message) => {
    const { projectId, scope, state } = message.payload as { projectId?: string | null; scope?: string; state?: unknown };
    return { type: 'canvas:state', payload: { projectId: projectId ?? null, ...(scope && { scope }), stateOmitted: { version: 1, reason: 'frame_limit', bytes: Buffer.byteLength(JSON.stringify(state) ?? '') } } };
  },
  // readBoundedPtyBuffer stops this first. An empty ack would read as a real, blank terminal.
  'pty:attach:ack': (message) => ({ type: 'error', payload: { message: TERMINAL_UNAVAILABLE, op: 'pty:attach', agentId: message.payload.agentId } }),
};

const lastFrameLimitLog = new Map<string, number>();

/**
 * The one check every outgoing frame passes, direct, broadcast or replayed: over
 * ANNEX_FRAME_MAX_BYTES of encoded bytes, it takes its type's fallback. Logs the
 * type and sizes, never the contents.
 */
function enforceFrameLimit(data: string, type?: string): string {
  // A character is at most three UTF-8 bytes, so most frames skip the count.
  if (data.length * 3 < ANNEX_FRAME_MAX_BYTES) return data;
  const bytes = Buffer.byteLength(data);
  if (bytes <= ANNEX_FRAME_MAX_BYTES) return data;
  const frameType = type ?? data.match(/^\{"type":"([^"]+)"/)?.[1] ?? 'other';
  if (frameType === 'snapshot') return data;
  const fallback = FRAME_FALLBACKS[frameType];
  const bounded = fallback ? JSON.stringify(fallback(JSON.parse(data))) : data;
  const boundedBytes = Buffer.byteLength(bounded);
  // A fallback can leave what it can't shorten, and that's still a frame over the limit.
  reportFrameOverLimit(frameType, boundedBytes <= ANNEX_FRAME_MAX_BYTES ? 'fallback' : 'sent_over_limit', bytes, boundedBytes);
  return bounded;
}

function reportFrameOverLimit(type: string, action: 'fallback' | 'sent_over_limit', bytes: number, boundedBytes: number): void {
  recordFrameOverLimit(type, action);
  const now = Date.now();
  if (now - (lastFrameLimitLog.get(type) ?? -Infinity) < LARGE_FRAME_LOG_INTERVAL_MS) return;
  lastFrameLimitLog.set(type, now);
  appLog('core:annex', 'warn', 'A frame was over its limit', {
    meta: { type, action, bytes, boundedBytes, limitBytes: ANNEX_FRAME_MAX_BYTES },
  });
}

const TERMINAL_UNAVAILABLE = 'terminal_unavailable';

/** A terminal's buffer in a frame, leaving room for the rest of it. */
const PTY_BUFFER_MAX_ENCODED_BYTES = ANNEX_FRAME_MAX_BYTES - 1024;

/**
 * A terminal's buffer for a phone, for the attach ack and the buffer route alike. The
 * mirror and raw output both fit themselves by leaving out scrollback, down to the
 * screen alone. This is the final check, for when that's still over. Null means
 * there's no faithful terminal to send, and the caller says so rather than sending an
 * empty one: Clubhouse Go showed 147 draws that as a blank screen with the wrong cursor.
 */
async function readBoundedPtyBuffer(agentId: string, frameType: string) {
  const snapshot = await ptyManager.getSerializedBufferSnapshot(agentId, { maxEncodedBytes: PTY_BUFFER_MAX_ENCODED_BYTES });
  // JSON at most sextuples a character, so most buffers skip the encoding.
  if (snapshot.data.length * 6 + 2 <= PTY_BUFFER_MAX_ENCODED_BYTES) return snapshot;
  const bytes = Buffer.byteLength(JSON.stringify(snapshot.data));
  if (bytes <= PTY_BUFFER_MAX_ENCODED_BYTES) return snapshot;
  reportFrameOverLimit(frameType, 'fallback', bytes, 0);
  return null;
}

/** How a socket gets icons: `refs` if it opted in with `?iconRefs=1` at connect, else inline thumbnails. */
type SnapshotForm = 'inline' | 'refs';
const wsIconRefs = new WeakSet<WebSocket>();
const snapshotFormOf = (ws: WebSocket): SnapshotForm => (wsIconRefs.has(ws) ? 'refs' : 'inline');

const SNAPSHOT_LOG_INTERVAL_MS = 60_000;
let lastSnapshotLog: { result: string; atMs: number } | null = null;

/** Sizes and counts of a snapshot being sent, never its contents. At most once a minute unless the result changes. */
function reportSnapshot(result: SnapshotResult, trigger: SnapshotTrigger, bytes: number, items: number, icons: SnapshotIconStats): void {
  recordSnapshot(result, trigger, { bytes, items, ...icons });
  const now = Date.now();
  if (lastSnapshotLog?.result === result && now - lastSnapshotLog.atMs < SNAPSHOT_LOG_INTERVAL_MS) return;
  lastSnapshotLog = { result, atMs: now };
  appLog('core:annex', result === 'ok' ? 'info' : 'warn', 'Sending a snapshot', {
    meta: { result, trigger, bytes, items, ...icons },
  });
}

/**
 * What a snapshot can do without, in the order it's given up. Canvases go first: they
 * have a route of their own, and phones don't draw them from here. Absent rather than
 * empty, because a client reads an empty field as nothing being there. The icon maps
 * are the exception: a phone keeps old icons only when both are absent, so both are
 * sent empty, and its routes still serve them.
 */
const SNAPSHOT_TRUNCATION_STEPS: ReadonlyArray<{ result: SnapshotResult; omitted: string[]; apply: (payload: Record<string, unknown>) => void }> = [
  {
    result: 'canvas_omitted',
    omitted: ['canvasState', 'appCanvasState'],
    apply: (payload) => { delete payload.canvasState; delete payload.appCanvasState; },
  },
  {
    result: 'icons_dropped',
    omitted: ['agentIcons', 'projectIcons'],
    apply: (payload) => { payload.agentIcons = {}; payload.projectIcons = {}; },
  },
];

/**
 * The same for a socket that fetches its images. Refs go absent, not empty: absent
 * means unknown, so a phone keeps what it has, where `{}` would mean every image was removed.
 */
const SNAPSHOT_REFS_TRUNCATION_STEPS: typeof SNAPSHOT_TRUNCATION_STEPS = [
  SNAPSHOT_TRUNCATION_STEPS[0],
  { result: 'icons_dropped', omitted: ['iconRefs'], apply: (payload) => { delete payload.iconRefs; } },
];

/**
 * A snapshot as one frame, at most SNAPSHOT_FRAME_MAX_BYTES if what can be given up
 * gets it there. `snapshotTruncated` says what was, and that the absence doesn't
 * mean it's gone. The fields left can't be given up, so past that it's reported.
 */
function snapshotFrame({ payload, icons, iconRefs }: BuiltSnapshot, trigger: SnapshotTrigger, form: SnapshotForm = 'inline'): string {
  const items = payload.projects.length + Object.values(payload.agents).reduce((sum, list) => sum + list.length, 0);
  // A phone that fetches images has both legacy maps empty, because it clears its inline icons on seeing either.
  const formPayload: Record<string, unknown> = form === 'refs' ? { ...payload, projectIcons: {}, agentIcons: {}, ...(iconRefs && { iconRefs }) } : payload;
  const refCount = iconRefs ? Object.keys(iconRefs.agents).length + Object.keys(iconRefs.projects).length : 0;
  const sentIcons = form === 'refs' ? { iconCount: refCount, iconBytes: 0, iconsLeftOut: 0 } : icons;
  let frame = JSON.stringify({ type: 'snapshot', payload: formPayload });
  let bytes = Buffer.byteLength(frame);
  if (bytes <= SNAPSHOT_FRAME_MAX_BYTES) {
    reportSnapshot(sentIcons.iconsLeftOut > 0 ? 'icons_left_out' : 'ok', trigger, bytes, items, sentIcons);
    return frame;
  }
  const fullBytes = bytes;
  const reduced: Record<string, unknown> = { ...formPayload };
  const omitted: string[] = [];
  let result: SnapshotResult = 'ok';
  for (const step of form === 'refs' ? SNAPSHOT_REFS_TRUNCATION_STEPS : SNAPSHOT_TRUNCATION_STEPS) {
    step.apply(reduced);
    omitted.push(...step.omitted);
    result = step.result;
    frame = JSON.stringify({ type: 'snapshot', payload: { ...reduced, snapshotTruncated: { version: 1, reason: 'frame_limit', omitted, bytes: fullBytes } } });
    bytes = Buffer.byteLength(frame);
    if (bytes <= SNAPSHOT_FRAME_MAX_BYTES) break;
  }
  const iconsGone = omitted.includes('agentIcons') || omitted.includes('iconRefs');
  reportSnapshot(bytes > MOBILE_WS_FRAME_MAX_BYTES ? 'over_mobile_limit' : result, trigger, bytes, items, iconsGone
    ? { iconCount: 0, iconBytes: 0, iconsLeftOut: sentIcons.iconCount + sentIcons.iconsLeftOut }
    : sentIcons);
  return frame;
}

/** Most frames held for one socket: as many as the replay buffer keeps. */
const HELD_FRAMES_MAX = 10_000;
const HELD_BYTES_MAX = 32 * 1024 * 1024;

interface HeldFrames {
  frames: string[];
  bytes: number;
  /** A try at the snapshot failed and another is due: replies go out so commands work, events stay back. */
  retrying: boolean;
  /** The snapshot's `lastSeq`: every event after it is held. */
  cursor: number;
}

/**
 * Frames for a socket still waiting on its first snapshot. It's in `wss.clients`
 * from the start and the build awaits disk, so without this it gets live events
 * before it has a cursor to read them against. The strings are shared with every
 * other socket, so holding them costs little.
 */
const heldFrames = new WeakMap<WebSocket, HeldFrames>();
/** Every socket with frames held: what the next build serves. */
const firstSnapshotWaiters = new Set<WebSocket>();

/**
 * Hold a frame for later. Past the limits, what's held is dropped, and the cursor
 * stays where it was. The phone then sees a jump in seq after its snapshot, and
 * replay fills that in, or says it can't. Moving the cursor would lose those events
 * for good: a phone doesn't replay what's behind its cursor. Closing would not help
 * either. iOS can't see a close code, and a phone reconnects within a second into
 * another build.
 */
function holdFrame(held: HeldFrames, data: string): void {
  held.frames.push(data);
  held.bytes += Buffer.byteLength(data);
  if (held.frames.length <= HELD_FRAMES_MAX && held.bytes <= HELD_BYTES_MAX) return;
  appLog('core:annex', 'warn', 'Dropping held frames for a socket with no snapshot yet', {
    meta: { frames: held.frames.length, bytes: held.bytes },
  });
  held.frames = [];
  held.bytes = 0;
}

/** Send what was held, in order and in one tick, so nothing live can land between them. */
function releaseFrames(ws: WebSocket): void {
  const held = heldFrames.get(ws);
  heldFrames.delete(ws);
  firstSnapshotWaiters.delete(ws);
  if (!held || ws.readyState !== WebSocket.OPEN) return;
  for (const data of held.frames) ws.send(data);
}

/** After a failed build, how long until the next. Past the end, the last one repeats. */
const SNAPSHOT_RETRY_DELAYS_MS = [2000, 8000, 30_000, 60_000];
/**
 * How long a snapshot too large to send is taken at its word. It stays too large
 * until something changes, so this is only a backstop.
 */
const SNAPSHOT_OVERSIZE_RETRY_MS = 5 * 60_000;
/** A change is worth a look, but only this often: a busy host could otherwise rebuild a huge snapshot nonstop. */
const SNAPSHOT_OVERSIZE_RECHECK_MS = 30_000;

/**
 * Snapshots can't be sent right now, and when to try again. This covers the whole
 * host rather than each socket: phones reconnect every few seconds, and each new
 * socket wanting its own build is how a failure turns into constant work. Inside the
 * window nothing builds, and a phone hears `snapshot_failed` at once. When it ends,
 * one refresh runs and serves everyone waiting.
 */
let snapshotBlock: { kind: 'failed' | 'oversize'; until: number; startedAt: number } | null = null;
let snapshotFailures = 0;
let snapshotOversizeRecheck: ReturnType<typeof setTimeout> | null = null;
let snapshotBlockTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A snapshot built while an icon couldn't be read for a reason that can pass has no
 * `iconRefs`, and nothing else may change for a long time. So once the icon's retry is
 * due, one refresh tries again. Bounded: an icon that keeps failing counts as no image
 * after a few tries (icon-images.ts), and these refreshes stop after a few in a row.
 */
const ICON_RETRY_REFRESH_MAX = 3;
/** Past the icon's retry time, so the refresh reads the file again rather than its cached failure. */
const ICON_RETRY_REFRESH_DELAY_MS = ICON_RETRY_MS + 1_000;
let iconRetryRefresh: ReturnType<typeof setTimeout> | null = null;
let iconRetryRefreshes = 0;

function noteSnapshotIconsUnknown(unknown: boolean): void {
  if (!unknown) { iconRetryRefreshes = 0; return; }
  if (iconRetryRefresh || iconRetryRefreshes >= ICON_RETRY_REFRESH_MAX) return;
  iconRetryRefreshes++;
  iconRetryRefresh = setTimeout(() => {
    iconRetryRefresh = null;
    // No one to tell: the next socket's own build reads the icons again.
    if (!wss || wss.clients.size === 0) { iconRetryRefreshes = 0; return; }
    broadcastSnapshotRefresh();
  }, ICON_RETRY_REFRESH_DELAY_MS);
  iconRetryRefresh.unref?.();
}

function setSnapshotBlock(kind: 'failed' | 'oversize'): void {
  // Several builds can fail together: that's one failure, not several steps of backoff.
  if (kind === 'failed' && snapshotBlock && Date.now() < snapshotBlock.until) return;
  const delay = kind === 'oversize'
    ? SNAPSHOT_OVERSIZE_RETRY_MS
    : SNAPSHOT_RETRY_DELAYS_MS[Math.min(snapshotFailures++, SNAPSHOT_RETRY_DELAYS_MS.length - 1)];
  snapshotBlock = { kind, until: Date.now() + delay, startedAt: Date.now() };
  if (snapshotBlockTimer) clearTimeout(snapshotBlockTimer);
  snapshotBlockTimer = setTimeout(() => {
    snapshotBlockTimer = null;
    // A timer can fire just before the clock reaches `until`, and this retry must not hit its own gate.
    if (snapshotBlock) snapshotBlock.until = 0;
    // With no one connected there's no one to build for. The next to connect tries.
    if (firstSnapshotWaiters.size > 0 || (wss && wss.clients.size > 0)) broadcastSnapshotRefresh();
  }, delay);
  snapshotBlockTimer.unref?.();
}

function clearSnapshotBlock(): void {
  snapshotBlock = null;
  snapshotFailures = 0;
  if (snapshotBlockTimer) clearTimeout(snapshotBlockTimer);
  snapshotBlockTimer = null;
}

/** Tell the phone once, and keep the socket and its commands. Events stay back until a snapshot goes out. */
function firstSnapshotFailed(ws: WebSocket): void {
  const held = heldFrames.get(ws);
  if (!held || ws.readyState !== WebSocket.OPEN) return;
  try {
    if (!held.retrying) ws.send(JSON.stringify({ type: 'error', payload: { message: 'snapshot_failed' } }));
  } catch (sendErr) {
    appLog('core:annex', 'debug', 'Failed to send error to client (client likely disconnected)', {
      meta: { error: sendErr instanceof Error ? sendErr.message : String(sendErr) },
    });
  }
  held.retrying = true;
}

/** Send a built snapshot as this socket's first, and what was held after it. False if it's too large to send. */
function deliverFirstSnapshot(ws: WebSocket, held: HeldFrames, built: BuiltSnapshot, trigger: SnapshotTrigger): boolean {
  const frame = snapshotFrame({ ...built, payload: { ...built.payload, lastSeq: held.cursor } }, trigger, snapshotFormOf(ws));
  if (Buffer.byteLength(frame) > MOBILE_WS_FRAME_MAX_BYTES) return false;
  noteFrameSize(frame, 'snapshot');
  ws.send(frame);
  releaseFrames(ws);
  return true;
}

/**
 * A socket's first snapshot, then what was held for it. Until one is sent the
 * phone has no baseline for events, so they stay back, within the limits in
 * holdFrame, while WebSocket replies still go out. HTTP isn't involved at all.
 * The socket waits on the host's one build, joining it if one is running.
 * If none can be sent it hears `snapshot_failed` once, and the socket stays open: a
 * phone has its own grace period, and closing would only bring it back sooner.
 */
function sendFirstSnapshot(ws: WebSocket): void {
  if (snapshotBlock && Date.now() < snapshotBlock.until) firstSnapshotFailed(ws);
  // The window is over but nothing has worked since, so connected phones are owed one too.
  else if (snapshotBlock && !refreshInFlight) broadcastSnapshotRefresh();
  else startSnapshotBuild();
}

function broadcastWs(message: object): void {
  broadcastFrame((message as { type?: string }).type ?? 'other', JSON.stringify(message));
}

function broadcastFrame(type: string, frame: string, form?: SnapshotForm): number {
  if (!wss) return 0;
  const data = enforceFrameLimit(frame, type);
  noteFrameSize(data, type);
  let sendFailures = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && (!form || snapshotFormOf(client) === form)) {
      try {
        const held = heldFrames.get(client);
        // A socket waiting on its first snapshot gets it from the same build, with its own cursor.
        if (held && type === 'snapshot') continue;
        if (held) holdFrame(held, data);
        else client.send(data);
      } catch (err) {
        sendFailures++;
        appLog('core:annex', 'warn', 'broadcastWs: failed to send to client', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
  recordBroadcast(type, Buffer.byteLength(data), sendFailures);
  return sendFailures;
}

/** Broadcast a message and push it to the replay buffer. */
function broadcastAndBuffer(type: string, payload: unknown, context?: string): void {
  const tc = validatedTraceparent(type === 'chat:event' ? context : context ?? currentRequestTraceparent());
  // Serialized once, here, because a frame's size decides what's kept for replay as well as what's sent.
  const { payload: bounded, json: boundedJson } = boundEventPayload(type, payload);
  const omitted = omittedFrame(type, bounded, boundedJson);
  const frameType = omitted ? 'frame:omitted' : type;
  const kept = omitted ?? bounded;
  const json = omitted ? JSON.stringify(omitted) : boundedJson;
  const seq = eventReplay.pushEvent(frameType, kept, tc, Buffer.byteLength(json));
  broadcastFrame(frameType, `{"type":${JSON.stringify(frameType)},"payload":${json},"seq":${seq}${tc ? `,"tc":${JSON.stringify(tc)}` : ''}}`);
}

/**
 * What can be left out of the stream as the last resort: an event carrying no state.
 * An allowlist, so a new type isn't one until someone decides that. Anything with an
 * approval, a question, a queue or a status has its own path, or goes as it is and
 * is reported. A phone advances its cursor past this and doesn't fetch, so the text
 * shows on the next read of `/chat`, and stays on the desktop.
 */
const OMITTABLE_CHAT_EVENT_TYPES: ReadonlySet<string> = new Set(['agent_message', 'agent_message_chunk', 'agent_thought', 'agent_thought_chunk']);

/** Room in a frame for its type, seq and trace context around the payload. */
const FRAME_ENVELOPE_BYTES = 1024;

/**
 * An event no phone can receive: the transport closes the socket on it. Sent once live,
 * that costs a reconnect, and the new connection's first snapshot is past it. Sent on replay
 * it would be every time, for as long as the buffer keeps it, so replay across it answers
 * `replay:gap`. Clubhouse Go measured that phones ignore that frame's `lastSeq`, so what ends
 * this is the fresh cursor each connection takes below, not the gap's.
 */
function cannotBeReplayed(event: { payload: unknown }): boolean {
  const json = JSON.stringify(event.payload) ?? '';
  return json.length * 3 + FRAME_ENVELOPE_BYTES > MOBILE_WS_FRAME_MAX_BYTES && Buffer.byteLength(json) + FRAME_ENVELOPE_BYTES > MOBILE_WS_FRAME_MAX_BYTES;
}

/** The frame:omitted payload for an event over the limit, in place of it, or null if it stays as it is. */
function omittedFrame(type: string, payload: unknown, json: string): Record<string, unknown> | null {
  if (type !== 'chat:event' || (json.length * 3 + FRAME_ENVELOPE_BYTES) < ANNEX_FRAME_MAX_BYTES) return null;
  const bytes = Buffer.byteLength(json);
  if (bytes + FRAME_ENVELOPE_BYTES <= ANNEX_FRAME_MAX_BYTES) return null;
  const { agentId, event } = payload as { agentId: string; event: ChatEvent };
  if (!OMITTABLE_CHAT_EVENT_TYPES.has(event.type)) return null;
  const omitted = { version: 1, originalType: type, eventType: event.type, agentId, sessionId: event.sessionId, eventSeq: event.seq, bytes };
  reportFrameOverLimit(type, 'fallback', bytes, Buffer.byteLength(JSON.stringify(omitted)));
  return omitted;
}

/** An event's payload as Annex keeps and sends it, and that as JSON. Most pass through unchanged. */
function boundEventPayload(type: string, payload: unknown): { payload: unknown; json: string } {
  const json = JSON.stringify(payload) ?? 'null';
  if (type === 'chat:event' && (payload as { event?: ChatEvent }).event?.type === 'permission_request') {
    recordToolInputSize(toolInputSizeBucket(Buffer.byteLength(json)));
  }
  // A character is at most three UTF-8 bytes, so most events skip the count.
  if (json.length * 3 <= OUTER_TOOL_INPUT_MAX_BYTES) return { payload, json };
  if (type === 'hook:event') {
    const hook = payload as { event: AgentHookEvent };
    const input = boundToolInput(hook.event.toolInput);
    if (!input.toolInputTruncated) return { payload, json };
    recordFrameOverLimit(type, 'fallback');
    const next = { ...hook, event: { ...hook.event, ...input } };
    return { payload: next, json: JSON.stringify(next) };
  }
  if (type === 'permission:request') {
    const request = payload as { toolInput?: Record<string, unknown> };
    const input = boundToolInput(request.toolInput);
    if (!input.toolInputTruncated) return { payload, json };
    recordFrameOverLimit(type, 'fallback');
    const next = { ...request, ...input };
    return { payload: next, json: JSON.stringify(next) };
  }
  if (type !== 'chat:event' || json.length * 3 <= PERMISSION_INPUT_MAX_BYTES) return { payload, json };
  const bytes = Buffer.byteLength(json);
  const { agentId, event } = payload as { agentId: string; event: ChatEvent };
  const bounded = boundChatEvent(event, bytes);
  if (bounded === event) return { payload, json };
  recordFrameOverLimit(type, 'fallback');
  const next = { agentId, event: bounded };
  return { payload: next, json: JSON.stringify(next) };
}

// ---------------------------------------------------------------------------
// Icon endpoints (Issue 2)
// ---------------------------------------------------------------------------

/**
 * An icon's bounded image, the same one a snapshot describes: a phone decodes all
 * of it. No such image is a 404, and the phone draws initials. One that can't be read
 * right now is a 503, and the phone keeps what it has. The ETag is the
 * current version, whichever was asked for: `?v=` only decides how long it can be
 * kept, so a stale request gets the new image and a short answer on caching.
 */
async function sendIconImage(req: http.IncomingMessage, res: http.ServerResponse, filePath: string | null | undefined, requested: string | null): Promise<void> {
  const image = filePath ? await readIconImage(filePath) : null;
  if (image === ICON_TEMPORARILY_UNAVAILABLE) {
    res.setHeader('Retry-After', '30');
    sendJson(res, 503, { error: 'icon_unavailable' });
    return;
  }
  if (!image) {
    sendJson(res, 404, { error: 'icon_not_found' });
    return;
  }
  const etag = `"${image.version}"`;
  const cacheControl = requested === null ? 'private, max-age=3600'
    : requested === image.version ? 'private, max-age=31536000, immutable' : 'private, no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }
  const buf = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
  res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': buf.length, ETag: etag, 'Cache-Control': cacheControl });
  res.end(buf);
}

async function handleIconRequest(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
  const { pathname, searchParams } = new URL(url, 'http://icons');
  const requested = searchParams.get('v');

  // GET /api/v1/icons/agent/:agentId
  const agentIconMatch = pathname.match(/^\/api\/v1\/icons\/agent\/([^/]+)$/);
  if (agentIconMatch) {
    const agentId = decodeURIComponent(agentIconMatch[1]);
    // The Dispatcher is in no project (#2533); anyone else, find across all projects
    let iconFilename = activeDispatcher(agentId)?.config.icon;
    const projects = iconFilename ? [] : await projectStore.list();
    for (const proj of projects) {
      const durables = await agentConfig.listDurable(proj.path);
      const agent = durables.find((d) => d.id === agentId);
      if (agent?.icon) {
        iconFilename = agent.icon;
        break;
      }
    }
    await sendIconImage(req, res, iconFilename ? await agentConfig.agentIconFilePath(iconFilename) : null, requested);
    return true;
  }

  // GET /api/v1/icons/project/:projectId
  const projectIconMatch = pathname.match(/^\/api\/v1\/icons\/project\/([^/]+)$/);
  if (projectIconMatch) {
    const projectId = decodeURIComponent(projectIconMatch[1]);
    const projects = await projectStore.list();
    const project = projects.find((p) => p.id === projectId);
    await sendIconImage(req, res, project?.icon ? await projectStore.iconFilePath(project.icon) : null, requested);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Agent readiness helper
// ---------------------------------------------------------------------------

/**
 * Poll until the agent is registered as running (PTY or headless).
 * spawnAgent() resolves after the process is launched but before runtime
 * registration completes, so a brief poll avoids the race where
 * broadcastSnapshotRefresh() builds a snapshot showing 'sleeping'.
 */
async function waitForAgentRunning(agentId: string, maxAttempts = 10, intervalMs = 100): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (isAgentRunning(agentId)) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // If the agent never registered, continue anyway — the snapshot will show
  // 'sleeping' which is better than blocking indefinitely.
  appLog('core:annex', 'warn', 'Agent did not register as running within timeout', {
    meta: { agentId, maxAttempts, intervalMs },
  });
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

/**
 * findAgentAcrossProjects for phone routes and commands: the Dispatcher too
 * while it is on (#2533), with its folder as the project `__dispatcher__`.
 */
async function findMobileAgent(agentId: string): ReturnType<typeof findAgentAcrossProjects> {
  return activeDispatcher(agentId) ?? findAgentAcrossProjects(agentId);
}

/** The Dispatcher's folder is no git repo: git routes for `__dispatcher__` say so instead of project_not_found. */
function refuseDispatcherGit(ctx: AnnexRouteContext, projectId: string): boolean {
  if (!isDispatcherProjectId(projectId)) return false;
  sendJson(ctx.res, 409, { error: 'not_git_repo' });
  return true;
}

// ---------------------------------------------------------------------------
// Controller terminals (#2476)
// ---------------------------------------------------------------------------

/**
 * Where a controller's shell opens, scoped like the desktop's Terminal tab
 * (resolveChromeScope): the project root, or an agent's worktree when it has
 * one. A quick agent opens in the folder it runs in. Null for an agent that
 * is not in `project`.
 */
async function resolveShellCwd(project: { path: string }, agentId?: string): Promise<string | null> {
  if (!agentId) return project.path;
  const durable = (await agentConfig.listDurable(project.path)).find((d) => d.id === agentId);
  if (durable) return durable.worktreePath || project.path;
  const registration = agentRegistry.get(agentId);
  if (registration && registration.projectPath === project.path) return registration.cwd || project.path;
  return null;
}

function sendPtyError(ws: WebSocket, op: string, message: string, target: { sessionId?: string; agentId?: string }): void {
  safeSend(ws, JSON.stringify({ type: 'error', payload: { message, op, ...target } }));
}

/** A shell another controller spawned: private to it, like its output. */
function isOtherControllersShell(ws: WebSocket, id: string): boolean {
  const owner = shellOwners.get(id);
  return owner !== undefined && owner !== ws;
}

function shellCountFor(ws: WebSocket): number {
  let count = 0;
  for (const owner of shellOwners.values()) if (owner === ws) count++;
  return count;
}

/** End every shell `ws` spawned; on disconnect nobody is left to read them. */
function closeShellsFor(ws: WebSocket): void {
  for (const [sessionId, owner] of [...shellOwners]) {
    if (owner !== ws) continue;
    shellOwners.delete(sessionId);
    ptyManager.killShell(sessionId);
  }
}

async function handleSpawnShellWs(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
  const op = 'pty:spawn-shell';
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SHELL_SESSION_ID_LENGTH) {
    sendPtyError(ws, op, 'invalid_session_id', {});
    return;
  }
  const projectId = payload.projectId;
  const agentId = typeof payload.agentId === 'string' && payload.agentId ? payload.agentId : undefined;
  const owner = shellOwners.get(sessionId);
  // Spawning over a live session kills it, so only a controller's own shell may be replaced.
  if (owner ? owner !== ws : ptyManager.isRunning(sessionId)) {
    sendPtyError(ws, op, 'session_in_use', { sessionId });
    return;
  }
  if (!owner && shellCountFor(ws) >= MAX_SHELLS_PER_CONNECTION) {
    sendPtyError(ws, op, 'too_many_shells', { sessionId });
    return;
  }
  // The Dispatcher's folder too while it is on (#2533): a shell there, as for any agent's folder.
  const project = dispatcherShellProject(projectId) ?? (typeof projectId === 'string' ? await findProjectById(projectId) : undefined);
  if (!project) {
    sendPtyError(ws, op, 'project_not_found', { sessionId });
    return;
  }
  const cwd = await resolveShellCwd(project, agentId);
  if (!cwd) {
    sendPtyError(ws, op, 'agent_not_found', { sessionId });
    return;
  }
  // The checks above awaited: a second spawn for the same id may have taken it.
  const current = shellOwners.get(sessionId);
  if (current ? current !== ws : ptyManager.isRunning(sessionId)) {
    sendPtyError(ws, op, 'session_in_use', { sessionId });
    return;
  }
  // Owned before it starts, so its first output already goes to this controller only.
  shellOwners.set(sessionId, ws);
  try {
    await ptyManager.spawnShell(sessionId, cwd);
  } catch (err) {
    if (shellOwners.get(sessionId) === ws && !ptyManager.isRunning(sessionId)) shellOwners.delete(sessionId);
    sendPtyError(ws, op, err instanceof Error ? err.message : 'spawn_failed', { sessionId });
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) {
    // The controller left while the shell started; its close handler ran too early to end it.
    const current = shellOwners.get(sessionId);
    if (current === undefined || current === ws) {
      shellOwners.delete(sessionId);
      ptyManager.killShell(sessionId);
    }
    return;
  }
  safeSend(ws, JSON.stringify({ type: 'pty:spawn-shell:ack', payload: { sessionId, cwd } }));
}

function handleCloseShellWs(ws: WebSocket, payload: Record<string, unknown>): void {
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string' || shellOwners.get(sessionId) !== ws) {
    sendPtyError(ws, 'pty:close', 'session_not_found', typeof sessionId === 'string' ? { sessionId } : {});
    return;
  }
  shellOwners.delete(sessionId);
  ptyManager.killShell(sessionId);
  safeSend(ws, JSON.stringify({ type: 'pty:close:ack', payload: { sessionId } }));
}

/** A terminal-mode agent's own PTY: its screen now; live `pty:data` follows by broadcast. */
async function handleAttachWs(ws: WebSocket, payload: Record<string, unknown>): Promise<void> {
  const op = 'pty:attach';
  const agentId = payload.agentId;
  if (typeof agentId !== 'string' || !agentId) {
    sendPtyError(ws, op, 'agent_not_found', {});
    return;
  }
  if (getAgentExecutionMode(agentId) !== 'pty') {
    sendPtyError(ws, op, 'agent_not_terminal', { agentId });
    return;
  }
  // Shells are not agents: a desktop terminal or another controller's shell stays private.
  if (!ptyManager.isRunning(agentId) || ptyManager.getShellCwd(agentId) !== undefined) {
    sendPtyError(ws, op, 'agent_not_running', { agentId });
    return;
  }
  const snapshot = await readBoundedPtyBuffer(agentId, 'pty:attach:ack');
  if (!snapshot) {
    sendPtyError(ws, op, TERMINAL_UNAVAILABLE, { agentId });
    return;
  }
  const { data, seq, cols, rows, scrollbackLines } = snapshot;
  safeSend(ws, JSON.stringify({ type: 'pty:attach:ack', payload: {
    agentId, buffer: data, outputSeq: seq, ...(cols !== undefined && rows !== undefined && { cols, rows }),
    ...(scrollbackLines !== undefined && { scrollbackLines }),
  } }));
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

  const model = (body.model as string | undefined) || defaultModel;
  const orchestrator = (body.orchestrator as string | undefined) || defaultOrchestrator;
  const freeAgentMode = (body.freeAgentMode as boolean | undefined) ?? defaultFreeAgentMode;

  // Tracked and announced to phones by the quick agent observer (see observeQuickAgents below).
  try {
    const entry = await startQuickAgent({
      project: { id: projectId, path: project.path },
      cwd,
      prompt,
      model,
      orchestrator,
      freeAgentMode,
      systemPrompt,
      parentAgentId,
    });
    sendJson(res, 201, { ...quickAgentWireFields(entry), status: 'starting' });
  } catch (err) {
    appLog('core:annex', 'error', 'Failed to spawn quick agent', {
      meta: { error: err instanceof Error ? err.message : String(err) },
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

  const agentInfo = await findAgentAcrossProjects(agentId);
  if (!agentInfo) {
    sendJson(res, 404, { error: 'agent_not_found' });
    return;
  }

  // Check if already running (process-level check)
  if (isAgentRunning(agentId)) {
    sendJson(res, 409, { error: 'agent_already_running' });
    return;
  }

  // Guard: check if already registered in agent registry (stale registration from crashed spawn)
  const existingRegistration = agentRegistry.get(agentId);
  if (existingRegistration) {
    appLog('core:annex', 'warn', 'Stale agent registration found during wake — cleaning up before respawn', {
      meta: { agentId, existingRegistration: { projectPath: existingRegistration.projectPath, runtime: existingRegistration.runtime } },
    });
    agentRegistry.untrack(agentId);
  }

  const { config, project } = agentInfo;
  // Resume only an agent with a session to resume: a never-run agent would
  // get the CLI's resume-latest form and exit at once.
  const resume = !!body.resume && !!config.lastSessionId;
  const model = (body.model as string | undefined) || config.model;
  const cwd = config.worktreePath || project.path;

  // Validate agent config before spawn
  if (!config.name || config.name === config.id) {
    appLog('core:annex', 'warn', 'Agent config has missing or ghost name — using disk config name as-is', {
      meta: { agentId, configName: config.name, configId: config.id },
    });
  }

  appLog('core:annex', 'info', 'Waking durable agent', {
    meta: {
      agentId,
      agentName: config.name,
      projectId: project.id,
      projectPath: project.path,
      cwd,
      model: model || 'default',
      orchestrator: config.orchestrator || 'default',
      resume,
      hasWorktree: !!config.worktreePath,
    },
  });

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

    appLog('core:annex', 'info', 'Agent spawn completed successfully', {
      meta: { agentId, agentName: config.name },
    });

    // Broadcast agent:woken event immediately
    noteAgentActivity(config.id);
    broadcastAndBuffer('agent:woken', {
      agentId: config.id,
      message,
      source: 'annex',
    });

    // Wait for the agent to be registered as running before refreshing the
    // snapshot.  spawnAgent() resolves after the process is launched, but the
    // PTY / headless session may not yet be registered, causing
    // mapDurableAgent() to report 'sleeping' instead of 'running'.
    await waitForAgentRunning(config.id);
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
      meta: { agentId, agentName: config.name, error: err instanceof Error ? err.message : String(err) },
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

  // A frame this came from left out most of a large input, so it can't be approved from here.
  const queued = permissionQueue.listPending().find((p) => p.requestId === requestId);
  if (decision === 'allow' && queued && boundToolInput(queued.toolInput).toolInputTruncated) {
    sendJson(res, 409, { error: 'incomplete_representation' });
    return;
  }

  // The agentId comes from the request path — bind the resolution to it so a
  // client can't resolve another agent's pending request by requestId alone.
  const result = permissionQueue.resolvePermissionDetailed(requestId, decision, {
    expectedAgentId: agentId,
    source: 'annex',
  });
  if (result.status === 'rejected') {
    const httpStatus = result.reason === 'agent_mismatch' ? 403 : 404;
    sendJson(res, httpStatus, {
      error: result.reason === 'agent_mismatch' ? 'agent_mismatch' : 'request_not_found',
    });
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
// Pairing-port request handler (plain HTTP, unauthenticated)
// ---------------------------------------------------------------------------

async function handlePairingRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  const origin = req.headers.origin || '';
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
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
    const pairStartMs = Date.now();
    const pairReply = (status: number, body: Record<string, unknown>): void => {
      recordPairServed(pairStartMs, status === 200 ? 'ok' : pairResultFor(body.error as string | undefined));
      sendJson(res, status, body);
    };
    const source = req.socket.remoteAddress || 'unknown';
    const bruteCheck = annexPeers.checkBruteForce(source);

    if (!bruteCheck.allowed) {
      if (bruteCheck.locked) {
        pairReply(429, { error: 'pairing_locked', message: 'Too many failed attempts. Pairing is locked.' });
      } else {
        pairReply(429, { error: 'rate_limited', retryAfterMs: bruteCheck.delayMs });
      }
      return;
    }

    readBody(req).then((raw) => {
      const body = parseJsonBody(raw);
      if (!body) { pairReply(400, { error: 'invalid_json' }); return; }
      const pin = body.pin;
      if (typeof pin !== 'string') { pairReply(400, { error: 'invalid_json' }); return; }

      if (!comparePins(pin, currentPin)) {
        annexPeers.recordFailedAttempt(source);
        pairReply(401, { error: 'invalid_pin' });
        return;
      }

      const securePair = (req.socket as tls.TLSSocket).encrypted === true;
      let clientCertificateFingerprint: string | undefined;
      const sessionOnly = securePair && body.pairingMode === 'session';
      if (securePair && body.pairingMode !== undefined && body.pairingMode !== 'session' && body.pairingMode !== 'persistent') {
        pairReply(400, { error: 'invalid_pairing_mode' }); return;
      }
      if (securePair) {
        clientCertificateFingerprint = annexTls.extractPeerCertificateFingerprint(req.socket as tls.TLSSocket);
        if (typeof body.publicKey !== 'string' || !clientCertificateFingerprint
          || annexTls.extractPeerFingerprint(req.socket as tls.TLSSocket) !== annexIdentity.computeFingerprint(body.publicKey)) {
          pairReply(400, { error: 'client_certificate_required' });
          return;
        }
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
            pairReply(400, { error: 'invalid_public_key' });
            return;
          }
        } catch {
          pairReply(400, { error: 'invalid_public_key' });
          return;
        }
        const pairedPeer: AnnexPeer = {
          fingerprint: annexIdentity.computeFingerprint(clientPublicKey),
          publicKey: clientPublicKey,
          alias: (body.alias as string) || 'Unknown',
          icon: (body.icon as string) || 'computer',
          color: (body.color as string) || 'indigo',
          pairedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          ...(clientCertificateFingerprint ? { tlsCertificateFingerprint: clientCertificateFingerprint } : {}),
          role: 'controller', // This peer initiated pairing → they control us
        };
        const previous = findPairedPeer(pairedPeer.fingerprint);
        if (previous?.tlsCertificateFingerprint && previous.tlsCertificateFingerprint !== pairedPeer.tlsCertificateFingerprint) disconnectPeer(pairedPeer.fingerprint);
        if (sessionOnly) mobileSessionPeers.set(pairedPeer.fingerprint, pairedPeer);
        else { mobileSessionPeers.delete(pairedPeer.fingerprint); annexPeers.addPeer(pairedPeer); }
      }

      if (clientCertificateFingerprint && typeof clientPublicKey === 'string') {
        sessionTokens.set(token, { issuedAt: Date.now(), peerFingerprint: annexIdentity.computeFingerprint(clientPublicKey) });
      }
      pairReply(200, {
        token,
        ...(clientCertificateFingerprint ? { tlsCertificateFingerprint: annexTls.getCertificateFingerprint(), mobileProtocolVersion: 1, pairingMode: sessionOnly ? 'session' : 'persistent' } : {}),
        publicKey: identity.publicKey,
        alias: settings.alias,
        icon: settings.icon,
        color: settings.color,
        fingerprint: identity.fingerprint,
      });
    }).catch((err) => {
      recordPairServed(pairStartMs, 'invalid_request');
      if (isBodyTooLarge(err) && !res.headersSent) { refuseOversizedBody(req, res); return; }
      appLog('core:annex', 'error', 'readBody failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
      res.writeHead(400);
      res.end();
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
}

type AnnexRouteContext = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: string;
  method: string;
  requireMtls: () => boolean;
  mobilePrincipal?: string;
};

type AnnexHttpRoute = {
  method: string;
  pattern: RegExp;
  handler: (ctx: AnnexRouteContext, match: RegExpMatchArray) => Promise<void>;
};

async function handleStatusRoute(ctx: AnnexRouteContext): Promise<void> {
  const { res } = ctx;
  const settings = annexSettings.getSettings();
  const projects = await projectStore.list();
  let agentCount = 0;
  for (const p of projects) {
    const durables = await agentConfig.listDurable(p.path);
    agentCount += durables.filter((d) => !isDisposedAgent(d)).length;
  }
  sendJson(res, 200, {
    version: '1',
    deviceName: settings.deviceName,
    agentCount,
    orchestratorCount: getAvailableOrchestrators().length,
  });
}

async function handleProjectsRoute(ctx: AnnexRouteContext): Promise<void> {
  sendJson(ctx.res, 200, await projectStore.list());
}

async function handleProjectAgentsRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  const project = await findProjectById(projectId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'project_not_found' });
    return;
  }
  const durables = (await agentConfig.listDurable(project.path)).filter((d) => !isDisposedAgent(d));
  const policies = await catalogOrchestration(project.path, durables);
  sendJson(ctx.res, 200, durables.map((d) => mapDurableAgent(d, projectId, policies)));
}

async function handleAgentBufferRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const agentId = decodeURIComponent(match[1]);
  const snapshot = await readBoundedPtyBuffer(agentId, 'pty:buffer');
  if (!snapshot) {
    sendJson(ctx.res, 503, { error: TERMINAL_UNAVAILABLE });
    return;
  }
  const { data: buffer, seq, cols, rows, scrollbackLines } = snapshot;
  ctx.res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(buffer),
    // Headers rather than a JSON body, so older controllers still read the buffer.
    [ANNEX_BUFFER_HEADERS.seq]: String(seq),
    ...(cols !== undefined && rows !== undefined && {
      [ANNEX_BUFFER_HEADERS.cols]: String(cols),
      [ANNEX_BUFFER_HEADERS.rows]: String(rows),
    }),
    ...(scrollbackLines !== undefined && { [ANNEX_BUFFER_HEADERS.scrollbackLines]: String(scrollbackLines) }),
  });
  ctx.res.end(buffer);
}

async function handleGroupProjectPatchRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.url.includes('/bulletin/')) return;
  if (ctx.method !== 'PATCH') return;
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
    return;
  }
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = body.name;
    if (body.description !== undefined) fields.description = body.description;
    if (body.instructions !== undefined) fields.instructions = body.instructions;
    if (body.metadata !== undefined) fields.metadata = body.metadata;
    if (Object.keys(fields).length === 0) {
      sendJson(ctx.res, 400, { error: 'no_fields_to_update' });
      return;
    }
    try {
      const updated = await groupProjectRegistry.update(gpId, fields as any);
      if (!updated) {
        sendJson(ctx.res, 404, { error: 'group_project_not_found' });
        return;
      }
      annexEventBus.emitGroupProjectChanged('updated', updated);
      sendJson(ctx.res, 200, updated);
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'update_failed' });
    }
  });
}

async function handleGroupProjectBulletinProtectionRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  const topic = decodeURIComponent(match[2]);
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const isProtected = body.isProtected as boolean;
    if (typeof isProtected !== 'boolean') {
      sendJson(ctx.res, 400, { error: 'isProtected (boolean) is required' });
      return;
    }
    const board = getBulletinBoard(gpId);
    board.setTopicProtected(topic, isProtected);
    sendJson(ctx.res, 200, { ok: true });
  });
}

async function handleIdentityRoute(ctx: AnnexRouteContext): Promise<void> {
  const identity = annexIdentity.getPublicIdentity();
  if (!identity) {
    sendJson(ctx.res, 503, { error: 'identity_not_ready' });
    return;
  }
  const settings = annexSettings.getSettings();
  sendJson(ctx.res, 200, {
    alias: settings.alias,
    icon: settings.icon,
    color: settings.color,
    fingerprint: identity.fingerprint,
    publicKey: identity.publicKey,
  });
}

async function handleProjectFilesTreeRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  const project = await findProjectById(projectId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'project_not_found' });
    return;
  }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const relPath = url.searchParams.get('path') || '.';
  const depth = parseInt(url.searchParams.get('depth') || '2', 10);
  const includeHidden = url.searchParams.get('includeHidden') === 'true';
  const resolvedProject = path.resolve(project.path);
  const fullPath = relPath === '.' ? resolvedProject : path.resolve(resolvedProject, relPath);
  if (fullPath !== resolvedProject && !fullPath.startsWith(resolvedProject + path.sep)) {
    sendJson(ctx.res, 403, { error: 'path_traversal' });
    return;
  }
  try {
    const tree = await fileService.readTree(fullPath, { depth, includeHidden });
    sendJson(ctx.res, 200, tree);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'read_tree_failed' });
  }
}

async function handleProjectFilesReadRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  const project = await findProjectById(projectId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'project_not_found' });
    return;
  }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const relPath = url.searchParams.get('path');
  if (!relPath) {
    sendJson(ctx.res, 400, { error: 'path_required' });
    return;
  }
  const resolvedProject = path.resolve(project.path);
  const fullPath = path.resolve(resolvedProject, relPath);
  if (fullPath !== resolvedProject && !fullPath.startsWith(resolvedProject + path.sep)) {
    sendJson(ctx.res, 403, { error: 'path_traversal' });
    return;
  }
  try {
    const content = await fileService.readFile(fullPath);
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(content),
    });
    ctx.res.end(content);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      sendJson(ctx.res, 404, { error: 'file_not_found' });
    } else {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'read_failed' });
    }
  }
}

async function handleGitInfoRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  if (refuseDispatcherGit(ctx, projectId)) return;
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  try {
    const info = await gitService.getGitInfo(project.path);
    sendJson(ctx.res, 200, info);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'git_info_failed' });
  }
}

async function handleGitLogRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  if (refuseDispatcherGit(ctx, projectId)) return;
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  try {
    const log = await gitService.getLog(project.path, limit, offset);
    sendJson(ctx.res, 200, log);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'git_log_failed' });
  }
}

async function handleGitDiffRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  if (refuseDispatcherGit(ctx, projectId)) return;
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const filePath = url.searchParams.get('file');
  if (!filePath) { sendJson(ctx.res, 400, { error: 'file_required' }); return; }
  const staged = url.searchParams.get('staged') === 'true';
  try {
    const diff = await gitService.getFileDiff(project.path, filePath, staged);
    sendJson(ctx.res, 200, diff);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'git_diff_failed' });
  }
}

async function handleGitShowCommitRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  if (refuseDispatcherGit(ctx, projectId)) return;
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const hash = url.searchParams.get('hash');
  if (!hash) { sendJson(ctx.res, 400, { error: 'hash_required' }); return; }
  try {
    const detail = await gitService.showCommit(project.path, hash);
    sendJson(ctx.res, 200, detail);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'git_show_commit_failed' });
  }
}

async function handleGitCommitDiffRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  if (refuseDispatcherGit(ctx, projectId)) return;
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const hash = url.searchParams.get('hash');
  const filePath = url.searchParams.get('file');
  if (!hash || !filePath) { sendJson(ctx.res, 400, { error: 'hash_and_file_required' }); return; }
  try {
    const diff = await gitService.getCommitFileDiff(project.path, hash, filePath);
    sendJson(ctx.res, 200, diff);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'git_commit_diff_failed' });
  }
}

async function handleGitOperationRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const projectId = decodeURIComponent(match[1]);
  if (refuseDispatcherGit(ctx, projectId)) return;
  const operation = match[2];
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  readJsonBody(ctx.req, ctx.res, async (body) => {
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
        default: sendJson(ctx.res, 400, { error: 'unknown_operation' }); return;
      }
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'git_operation_failed' });
    }
  });
}

async function handleSessionListRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const agentId = decodeURIComponent(match[1]);
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  const orchestrator = url.searchParams.get('orchestrator') || undefined;
  if (!projectId) { sendJson(ctx.res, 400, { error: 'projectId_required' }); return; }
  const project = dispatcherFolderProject(projectId) ?? await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  try {
    const config = await agentConfig.getDurableConfig(project.path, agentId);
    const provider = await resolveOrchestrator(project.path, orchestrator || config?.orchestrator);
    const sessions = isSessionCapable(provider) ? await provider.listSessions(config?.worktreePath || project.path) : [];
    sendJson(ctx.res, 200, sessions);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'list_sessions_failed' });
  }
}

async function handleSessionTranscriptRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const agentId = decodeURIComponent(match[1]);
  const sessionId = decodeURIComponent(match[2]);
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  const orchestrator = url.searchParams.get('orchestrator') || undefined;
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  if (!projectId) { sendJson(ctx.res, 400, { error: 'projectId_required' }); return; }
  const project = dispatcherFolderProject(projectId) ?? await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  try {
    const config = await agentConfig.getDurableConfig(project.path, agentId);
    const provider = await resolveOrchestrator(project.path, orchestrator || config?.orchestrator);
    if (!isSessionCapable(provider)) { sendJson(ctx.res, 200, null); return; }
    const cwd = config?.worktreePath || project.path;
    const rawEvents = await provider.readSessionTranscript(sessionId, cwd);
    if (!rawEvents) { sendJson(ctx.res, 200, null); return; }
    const events = normalizeSessionEvents(rawEvents);
    sendJson(ctx.res, 200, paginateEvents(events, offset, limit));
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'read_transcript_failed' });
  }
}

async function handleSessionSummaryRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const agentId = decodeURIComponent(match[1]);
  const sessionId = decodeURIComponent(match[2]);
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  const orchestrator = url.searchParams.get('orchestrator') || undefined;
  if (!projectId) { sendJson(ctx.res, 400, { error: 'projectId_required' }); return; }
  const project = dispatcherFolderProject(projectId) ?? await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  try {
    const config = await agentConfig.getDurableConfig(project.path, agentId);
    const provider = await resolveOrchestrator(project.path, orchestrator || config?.orchestrator);
    if (!isSessionCapable(provider)) { sendJson(ctx.res, 200, null); return; }
    const cwd = config?.worktreePath || project.path;
    const rawEvents = await provider.readSessionTranscript(sessionId, cwd, { maxBytes: SUMMARY_TRANSCRIPT_MAX_BYTES });
    if (!rawEvents) { sendJson(ctx.res, 200, null); return; }
    const events = normalizeSessionEvents(rawEvents);
    sendJson(ctx.res, 200, buildSessionSummary(events, provider.id));
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'get_summary_failed' });
  }
}

async function handleQuickProjectAgentRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const projectId = decodeURIComponent(match[1]);
  readJsonBody(ctx.req, ctx.res, (body) => handleSpawnQuickAgent(ctx.res, projectId, null, body));
}

async function handleQuickChildAgentRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const parentAgentId = decodeURIComponent(match[1]);
  const parentInfo = await findAgentAcrossProjects(parentAgentId);
  if (!parentInfo) {
    sendJson(ctx.res, 404, { error: 'agent_not_found' });
    return;
  }
  readJsonBody(ctx.req, ctx.res, (body) => handleSpawnQuickAgent(ctx.res, parentInfo.project.id, parentAgentId, body));
}

async function handleWakeAgentRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const agentId = decodeURIComponent(match[1]);
  readJsonBody(ctx.req, ctx.res, (body) => handleWakeAgent(ctx.res, agentId, body));
}

async function handlePermissionResponseRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const agentId = decodeURIComponent(match[1]);
  readJsonBody(ctx.req, ctx.res, (body) => handlePermissionResponse(ctx.res, agentId, body));
}

async function handleAgentMessageRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const agentId = decodeURIComponent(match[1]);
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const message = body.message as string | undefined;
    if (!message || typeof message !== 'string') {
      sendJson(ctx.res, 400, { error: 'message is required' });
      return;
    }
    if (message.length > MAX_PTY_INPUT_SIZE) {
      sendJson(ctx.res, 400, { error: 'message exceeds 64KB limit' });
      return;
    }
    const mode = getAgentExecutionMode(agentId);
    try {
      const runtime = getAgentRuntime(agentId);
      if (runtime?.kind === 'chat') {
        await runtime.sendMessage(message, { source: 'annex' });
      } else if (mode === 'pty' && ptyManager.isStopping(agentId)) {
        // The process is exiting and would swallow the text.
        sendJson(ctx.res, 409, { error: 'agent_stopping', message: new AgentStoppingError(agentId).message });
        return;
      } else if (mode === 'pty' && ptyManager.isRunning(agentId)) {
        ptyManager.write(agentId, message);
      } else {
        sendJson(ctx.res, 400, { error: `cannot send message to agent in '${mode}' mode` });
        return;
      }
      sendJson(ctx.res, 200, { ok: true, agentId, mode });
    } catch (err) {
      appLog('core:annex', 'error', 'Failed to send message to agent', {
        meta: { agentId, mode, error: err instanceof Error ? err.message : String(err) },
      });
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'send_failed' });
    }
  });
}

async function handleDurableCreationRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const projectId = decodeURIComponent(match[1]);
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const name = body.name as string;
    const color = body.color as string;
    if (!name || !color) {
      sendJson(ctx.res, 400, { error: 'name and color are required' });
      return;
    }
    // The name becomes a folder and a git branch on this machine (#2221).
    const nameProblem = body.useWorktree !== false ? validateAgentGitName(name, 'folder') : null;
    if (nameProblem) {
      sendJson(ctx.res, 400, { error: 'invalid_name', message: nameProblem });
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
      broadcastSnapshotRefresh();
      sendJson(ctx.res, 201, config);
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'create_failed' });
    }
  });
}

async function handleDurableDeleteRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const projectId = decodeURIComponent(match[1]);
  const agentId = decodeURIComponent(match[2]);
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const mode = (body.mode as string) || 'force';
    try {
      if (isAgentRunning(agentId)) {
        const config = (await agentConfig.listDurable(project.path)).find(agent => agent.id === agentId);
        await stopAgentForAnnex(agentId, project.path, config?.orchestrator);
      }
      let result: { ok: boolean; message: string };
      switch (mode) {
        case 'commit-push': result = await agentConfig.deleteCommitAndPush(project.path, agentId); break;
        case 'cleanup-branch': result = await agentConfig.deleteWithCleanupBranch(project.path, agentId); break;
        case 'force': result = await agentConfig.deleteForce(project.path, agentId); break;
        case 'unregister': result = await agentConfig.deleteUnregister(project.path, agentId); break;
        default: result = await agentConfig.deleteForce(project.path, agentId);
      }
      broadcastSnapshotRefresh();
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'delete_failed' });
    }
  });
}

async function handleWorktreeStatusRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const projectId = decodeURIComponent(match[1]);
  const agentId = decodeURIComponent(match[2]);
  const project = await findProjectById(projectId);
  if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
  try {
    const status = await agentConfig.getWorktreeStatus(project.path, agentId);
    sendJson(ctx.res, 200, status);
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'status_failed' });
  }
}

async function handleGroupProjectsListRoute(ctx: AnnexRouteContext): Promise<void> {
  const projects = await groupProjectRegistry.list();
  sendJson(ctx.res, 200, projects);
}

async function handleGroupProjectGetRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.url.includes('/bulletin/')) return;
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
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
        status: isAgentRunning(b.agentId) ? 'connected' : 'sleeping',
      }));
  } catch { /* ignore */ }
  sendJson(ctx.res, 200, { ...project, members });
}

async function handleGroupProjectDigestRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
    return;
  }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  let since: DigestSince | undefined;
  try {
    since = decodeDigestSince(url.searchParams.get('since'), url.searchParams.get(SINCE_CHANNELS_PARAM));
  } catch (err) {
    appLog('core:annex-server', 'warn', 'Rejected bulletin digest request with invalid since', {
      meta: { gpId, error: err instanceof Error ? err.message : String(err) },
    });
    sendJson(ctx.res, 400, { error: 'invalid_since' });
    return;
  }
  const board = getBulletinBoard(gpId);
  const digest = await board.getDigest(since);
  sendJson(ctx.res, 200, digest);
}

async function handleGroupProjectTopicRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const gpId = decodeURIComponent(match[1]);
  const topic = decodeURIComponent(match[2]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
    return;
  }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const since = url.searchParams.get('since') || undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
  const board = getBulletinBoard(gpId);
  const messages = await board.getTopicMessages(topic, since, limit);
  sendJson(ctx.res, 200, messages);
}

async function handleGroupProjectAllMessagesRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
    return;
  }
  const url = new URL(ctx.req.url || '/', 'http://localhost');
  const since = url.searchParams.get('since') || undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
  const board = getBulletinBoard(gpId);
  const messages = await board.getAllMessages(since, limit);
  sendJson(ctx.res, 200, messages);
}

async function handleGroupProjectPostMessageRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
    return;
  }
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const sender = body.sender as string;
    const topic = body.topic as string;
    const msgBody = body.body as string;
    if (!sender || !topic || !msgBody) {
      sendJson(ctx.res, 400, { error: 'sender, topic, and body are required' });
      return;
    }
    if (topic === 'system') {
      sendJson(ctx.res, 400, { error: 'system topic is reserved' });
      return;
    }
    try {
      const board = getBulletinBoard(gpId);
      const message = await board.postMessage(sender, topic, msgBody);
      annexEventBus.emitBulletinMessage(gpId, message);
      sendJson(ctx.res, 201, message);
    } catch (err) {
      sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : 'post_failed' });
    }
  });
}

async function handleGroupProjectShoulderTapRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
    return;
  }
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const sender = (body.sender as string) || 'remote';
    const targetAgentId = (body.targetAgentId as string) || null;
    const message = body.message as string;
    if (!message) {
      sendJson(ctx.res, 400, { error: 'message is required' });
      return;
    }
    try {
      const result = await executeShoulderTap({ projectId: gpId, senderLabel: sender, targetAgentId, message });
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'shoulder_tap_failed' });
    }
  });
}

async function handleGroupProjectPollingRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const enabled = body.enabled;
    if (typeof enabled !== 'boolean') {
      sendJson(ctx.res, 400, { error: 'enabled (boolean) is required' });
      return;
    }
    try {
      const result = await setProjectPolling(gpId, enabled);
      if (!result) {
        sendJson(ctx.res, 404, { error: 'group_project_not_found' });
        return;
      }
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'set_polling_failed' });
    }
  });
}

async function handleGroupProjectInjectRoute(ctx: AnnexRouteContext): Promise<void> {
  if (ctx.requireMtls()) return;
  readJsonBody(ctx.req, ctx.res, async (body) => {
    const agentId = body.agentId as string;
    const message = body.message as string;
    if (!agentId || !message) {
      sendJson(ctx.res, 400, { error: 'agentId and message are required' });
      return;
    }
    const reg = agentRegistry.get(agentId);
    if (!reg) {
      sendJson(ctx.res, 404, { error: 'agent_not_found' });
      return;
    }
    try {
      const runtime = getAgentRuntime(agentId);
      if (runtime?.kind === 'pty') {
        const timing = getProvider(reg.orchestrator)?.getPasteSubmitTiming() ?? { initialDelayMs: 350, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 30 };
        await injectPtyText(agentId, message, timing);
      } else if (runtime) {
        await runtime.sendMessage(message, { source: 'annex' });
      }
      sendJson(ctx.res, 200, { ok: true });
    } catch (err) {
      sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'inject_failed' });
    }
  });
}

async function handleGroupProjectMembersRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const gpId = decodeURIComponent(match[1]);
  const project = await groupProjectRegistry.get(gpId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'group_project_not_found' });
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
        status: isAgentRunning(b.agentId) ? 'connected' : 'sleeping',
      }));
  } catch { /* ignore */ }
  sendJson(ctx.res, 200, members);
}

async function handleGroupProjectDeleteMessageRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  const topic = decodeURIComponent(match[2]);
  const msgId = decodeURIComponent(match[3]);
  try {
    const board = getBulletinBoard(gpId);
    const deleted = await board.deleteMessage(topic, msgId);
    sendJson(ctx.res, 200, { deleted });
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'delete_failed' });
  }
}

async function handleGroupProjectDeleteTopicRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (ctx.requireMtls()) return;
  const gpId = decodeURIComponent(match[1]);
  const topic = decodeURIComponent(match[2]);
  try {
    const board = getBulletinBoard(gpId);
    const deleted = await board.deleteTopic(topic);
    sendJson(ctx.res, 200, { deleted });
  } catch (err) {
    sendJson(ctx.res, 500, { error: err instanceof Error ? err.message : 'delete_failed' });
  }
}

async function handleAgentIconRoute(ctx: AnnexRouteContext): Promise<void> {
  const handled = await handleIconRequest(ctx.req, ctx.res, ctx.req.url || '/');
  if (handled) return;
  sendJson(ctx.res, 404, { error: 'icon_not_found' });
}

async function handleProjectIconRoute(ctx: AnnexRouteContext): Promise<void> {
  const handled = await handleIconRequest(ctx.req, ctx.res, ctx.req.url || '/');
  if (handled) return;
  sendJson(ctx.res, 404, { error: 'icon_not_found' });
}

/** What a snapshot left out for size: one project's canvases, or the app's. Sent one at a time, so each stays small. */
async function handleMobileCanvasRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  if (!match[1]) {
    sendJson(ctx.res, 200, { state: await readCanvasState() });
    return;
  }
  const projectId = decodeURIComponent(match[1]);
  const project = (await projectStore.list()).find((p) => p.id === projectId);
  if (!project) {
    sendJson(ctx.res, 404, { error: 'project_not_found' });
    return;
  }
  sendJson(ctx.res, 200, { projectId, state: await readCanvasState(project.path) });
}

async function handleMobileCapabilitiesRoute(ctx: AnnexRouteContext): Promise<void> {
  sendJson(ctx.res, 200, {
    version: 1, epoch: mobileCommands.epoch, controlAuth: 'mtls-pinned-client',
    controlAvailable: !!ctx.mobilePrincipal, commands: MOBILE_COMMAND_TYPES,
    pairing: { sessionRevokePath: '/api/v1/mobile/pairing' },
    richContent: { version: 1, enabled: isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG), maximumBytes: 8 * 1024 * 1024 },
    attachments: MOBILE_ATTACHMENTS_CAPABILITY,
    events: { transport: 'annex-websocket', replayRequest: 'mobile:replay', queueState: 'queue_state' },
    createOptions: { version: 1, path: '/api/v1/mobile/projects/{projectId}/create-options' },
    agentSettings: { version: 1, path: '/api/v1/mobile/agents/{agentId}/settings' },
    contextWindow: { version: 1 },
    providerControl: { version: 1, preview: 'agent.providerPreview', change: 'agent.providerChange', stoppedAcknowledgment: true, strictStart: true },
    // Every agent's live state in one read, for catching up after a reconnect.
    agentState: { version: 1, path: '/api/v1/mobile/agents/state' },
    helperRequests: { version: 1, snapshotField: 'helperRequests', commands: ['helper.approve', 'helper.decline'] },
    chatControls: { version: 1 },
    // The composer's / menu: a live chat snapshot's `slashCommands`, updated by `commands_available` events.
    slashCommands: { version: 1, snapshotField: 'slashCommands', event: 'commands_available', maxCommands: MOBILE_SLASH_COMMANDS_MAX },
    // A paired phone has full control (#2462): persistent approvals and Free Agent Mode, as on the desktop.
    permissions: { version: 1, persistentApprovals: MOBILE_PERSISTENT_APPROVALS, freeAgentMode: true },
    // Durable agents' `orchestration` in the catalog and settings; agent.create and agent.update take it (#2228).
    orchestration: { version: 1 },
    idempotency: { scope: 'peer-and-epoch', maxEntries: MOBILE_COMMAND_MAX_ENTRIES, ttlMs: MOBILE_COMMAND_TTL_MS },
    projectState: { version: 1 },
    finishedQuickAgents: { version: 1 },
    // A snapshot over its limit says what it left out in `snapshotTruncated`; these fetch canvases.
    snapshotTruncation: { version: 1, canvasPaths: { project: '/api/v1/mobile/canvas/{projectId}', app: '/api/v1/mobile/canvas' } },
    // Connect with `?iconRefs=1` and a snapshot carries `iconRefs` in place of image bytes.
    iconRefs: { version: 1, connectParam: 'iconRefs=1', clientParam: 'client=mobile', paths: { agent: '/api/v1/icons/agent/{agentId}?v={version}', project: '/api/v1/icons/project/{projectId}?v={version}' } },
    // Shells at the project root or an agent's worktree, and an agent's own PTY (#2476).
    terminal: { version: 1, projectShell: true, agentShell: true, agentAttach: true,
      maxShellsPerConnection: MAX_SHELLS_PER_CONNECTION, maxInputLength: MAX_PTY_INPUT_SIZE },
    // The app-wide Dispatcher (#2533): the snapshot's `dispatcher`, dispatcher:changed and dispatcher.setEnabled.
    dispatcher: dispatcherCapability(dispatcherAgentView),
    // App-wide helper presets (#2671). It lists only what works now.
    helperRouting: helperRoutingCapability(),
    ...phoneRoutes(),
  });
}

/**
 * Every address this desktop answers on (LAN first, then Tailscale), so a
 * paired phone can move between home Wi-Fi and Tailscale, and one paired before
 * Tailscale was set up learns it. Phones only connect over TLS and check the
 * pinned certificate at each address, so this is a hint, never trust.
 */
function phoneRoutes(): { routes?: { hosts: string[]; port: number } } {
  if (!tlsServer || !serverPort) return {};
  const hosts = pairingHosts(os.networkInterfaces(), boundHost);
  return hosts.length > 0 ? { routes: { hosts, port: serverPort } } : {};
}

async function handleMobilePairingDeleteRoute(ctx: AnnexRouteContext): Promise<void> {
  const fingerprint = ctx.mobilePrincipal;
  if (!fingerprint) { sendJson(ctx.res, 403, { error: 'client_certificate_required' }); return; }
  // Never let a session-only action silently remove persistent desktop trust.
  if (!mobileSessionPeers.has(fingerprint) || annexPeers.getPeer(fingerprint)) {
    sendJson(ctx.res, 409, { error: 'persistent_pairing_requires_desktop' }); return;
  }
  disconnectPeer(fingerprint);
  sendJson(ctx.res, 200, { version: 1, epoch: mobileCommands.epoch, revoked: true, pairingMode: 'session' });
}

/**
 * Every agent's live state in one read, for a phone catching up after a reconnect: what it missed
 * while away (a sleep, a turn's end, an answered request) never reaches it as events. Cheap: in-memory
 * runtime state and agent configs only, no transcripts.
 */
async function handleMobileAgentStateRoute(ctx: AnnexRouteContext): Promise<void> {
  try {
    const state = (agentId: string) => {
      const runtime = getAgentRuntime(agentId);
      const chat = runtime?.kind === 'chat' && runtime.isRunning() ? runtime : null;
      const sessionState = chat ? chat.getState() : null;
      return {
        sessionId: chat ? chat.getSessionId?.() ?? null : null,
        sessionState,
        detailedStatus: isAgentRunning(agentId) ? getDetailedStatus(agentId) : null,
        pendingPermission: permissionQueue.listPendingForAgent(agentId).length > 0 || sessionState === 'waiting_permission',
        pendingQuestion: sessionState === 'waiting_input',
      };
    };
    const agents: object[] = [];
    for (const project of await projectStore.list()) {
      for (const d of (await agentConfig.listDurable(project.path)).filter((a) => !isDisposedAgent(a))) {
        agents.push({
          agentId: d.id, projectId: project.id, kind: 'durable',
          status: isAgentRunning(d.id) ? 'running' : 'sleeping',
          hasSession: !!d.lastSessionId, lastActivityAt: lastActivityAt(d.id, d.createdAt),
          ...state(d.id),
        });
      }
    }
    const dispatcher = activeDispatcher();
    if (dispatcher) {
      const d = dispatcher.config;
      agents.push({
        agentId: d.id, projectId: DISPATCHER_PROJECT_ID, kind: 'durable', isDispatcher: true,
        status: isAgentRunning(d.id) ? 'running' : 'sleeping',
        hasSession: !!d.lastSessionId, lastActivityAt: lastActivityAt(d.id, d.createdAt),
        ...state(d.id),
      });
    }
    for (const quick of trackedQuickAgents.values()) {
      agents.push({
        agentId: quick.id, projectId: quick.projectId, kind: 'quick', status: quick.status,
        hasSession: false, lastActivityAt: lastActivityAt(quick.id, quick.spawnedAt),
        ...state(quick.id),
      });
    }
    sendJson(ctx.res, 200, { version: 1, epoch: mobileCommands.epoch, agents });
  } catch {
    // telemetry-exempt: the phone keeps its catalog status and retries on the next reconnect.
    sendJson(ctx.res, 500, { error: 'agent_state_failed' });
  }
}

async function handleMobileChatRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  try {
    const agentId = decodeURIComponent(match[1]);
    const durable = await findMobileAgent(agentId);
    if ((!durable || isDisposedAgent(durable.config)) && !trackedQuickAgents.has(agentId)) {
      sendJson(ctx.res, 404, { error: 'agent_not_found' }); return;
    }
    const query = new URL(ctx.url, 'http://localhost').searchParams;
    const requestedSession = query.get('sessionId') ?? undefined;
    const beforeSeq = query.has('beforeSeq') ? Number(query.get('beforeSeq')) : undefined;
    const limit = query.has('limit') ? Number(query.get('limit')) : 2000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000
      || (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1))
      || (requestedSession !== undefined && (requestedSession.length === 0 || requestedSession.length > 256))) {
      sendJson(ctx.res, 400, { error: 'invalid_query' }); return;
    }
    const runtime = getAgentRuntime(agentId);
    const liveSessionId = runtime?.kind === 'chat' ? runtime.getSessionId?.() : undefined;
    let live = runtime?.kind === 'chat' && runtime.isRunning() && (requestedSession === undefined || liveSessionId === requestedSession);
    const events = live ? (await runtime.readTranscript()).events ?? [] : await readChatTranscript(agentId, { sessionId: requestedSession });
    const sessionId = requestedSession ?? (live ? liveSessionId : events[events.length - 1]?.sessionId);
    live = live && getAgentRuntime(agentId) === runtime && runtime.isRunning() && runtime.getSessionId?.() === sessionId;
    const current = events.filter((e) => e.sessionId === sessionId);
    const eligible = beforeSeq === undefined ? current : current.filter((e) => e.seq < beforeSeq);
    // The agent's folders (#2457): relative paths resolve against the first. Older phones
    // link only absolute paths under them; `contentAnyPath` says any readable path is served (#2478).
    const richContent = isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG);
    const contentRoots = richContent ? await agentFolders(agentId).catch((): string[] => []) : [];
    const pending = live ? pendingInteractions(current) : { pendingPermissions: [], pendingQuestions: [] };
    const page = buildChatPage({
      eligible,
      limit,
      pendingPermissions: pending.pendingPermissions,
      pendingQuestions: pending.pendingQuestions,
      metadata: {
        version: 1, epoch: mobileCommands.epoch, agentId, sessionId: sessionId ?? null,
        canStart: !!durable && !isAgentRunning(agentId) && !mobileStartingAgents.has(agentId) && !(isDispatcherOffForStart(agentId)),
        currentSessionId: runtime?.kind === 'chat' ? runtime.getSessionId?.() ?? null : null, readOnly: !live,
        state: live ? runtime.getState() : 'sleeping', capabilities: live ? runtime.getCapabilities?.() ?? null : null,
        lastSeq: current[current.length - 1]?.seq ?? 0,
        contentRoots,
        contentAnyPath: richContent,
        ...(live ? runtime.getQueueState?.() ?? { queuedMessageIds: [], queueStateSeq: 0, queueRemovalSupported: false }
          : { queuedMessageIds: [], queueStateSeq: 0, queueRemovalSupported: false }),
        // The composer's level, model and effort pills, for chat.setLevel / chat.setModel (#2462).
        chatControls: live ? chatControls(current, runtime.getCapabilities?.()) : null,
        // The composer's / menu; a page may not reach back to the session's commands_available.
        slashCommands: live ? latestSlashCommands(current) : null,
      },
    });
    if (page.stage !== 'whole') recordChatPageOverflow(page.stage);
    if (page.ok === false) {
      sendJson(ctx.res, 503, page.failure);
      return;
    }
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(page.body) });
    ctx.res.end(page.body);
  } catch {
    // telemetry-exempt: do not export transcript content; caller receives a bounded error.
    sendJson(ctx.res, 500, { error: 'chat_snapshot_failed' });
  }
}

/** Rich content stays behind the desktop setting (on unless saved off or unreadable) and pinned mobile mTLS.
 * Recheck authorization after filesystem IO; revocation may race a preview read. */
async function handleMobileContentRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const principal = ctx.mobilePrincipal;
  if (!principal) { sendJson(ctx.res, 403, { error: 'client_certificate_required' }); return; }
  const epoch = mobileCommands.epoch;
  const pin = findPairedPeer(principal)?.tlsCertificateFingerprint;
  const authorized = () => {
    const peer = findPairedPeer(principal);
    return mobileCommands.epoch === epoch && !!peer && peer.tlsCertificateFingerprint === pin
      && (!peer.role || peer.role === 'controller');
  };
  try {
    const agentId = decodeURIComponent(match[1]);
    const info = await findMobileAgent(agentId);
    if ((!info || isDisposedAgent(info.config)) && !trackedQuickAgents.has(agentId)) {
      sendJson(ctx.res, 404, { error: 'agent_not_found' }); return;
    }
    const query = new URL(ctx.url, 'http://localhost').searchParams;
    const result = await readMobileChatContent(query, agentId, () => isGraduatedFeatureOn(RICH_CHAT_CONTENT_FLAG));
    if (!authorized()) { sendJson(ctx.res, 403, { error: 'authorization_revoked' }); return; }
    ctx.res.setHeader('Cache-Control', 'no-store');
    sendJson(ctx.res, 200, result);
  } catch {
    // telemetry-exempt: paths, bytes and credentials must never enter telemetry.
    sendJson(ctx.res, 404, { error: 'content_unavailable' });
  }
}

async function handleMobileChatSessionsRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  try {
    const agentId = decodeURIComponent(match[1]);
    if (!await findMobileAgent(agentId) && !trackedQuickAgents.has(agentId)) {
      sendJson(ctx.res, 404, { error: 'agent_not_found' }); return;
    }
    sendJson(ctx.res, 200, { version: 1, epoch: mobileCommands.epoch, agentId, sessions: await listChatSessions(agentId) });
  } catch {
    // telemetry-exempt: session storage errors are bounded in the API response.
    sendJson(ctx.res, 500, { error: 'chat_sessions_failed' });
  }
}

/** A durable agent awake, or being woken from a phone; undefined while it sleeps. */
function mobileLiveState(agentId: string): 'running' | 'starting' | undefined {
  if (mobileStartingAgents.has(agentId)) return 'starting';
  return isAgentRunning(agentId) ? 'running' : undefined;
}

/** The New agent page's options for one project (#2451). */
async function handleMobileCreateOptionsRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  try {
    const project = await findProjectById(decodeURIComponent(match[1]));
    if (!project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
    sendJson(ctx.res, 200, { version: 1, epoch: mobileCommands.epoch, ...await buildCreateOptions({ id: project.id, path: project.path }) });
  } catch {
    // telemetry-exempt: settings and catalog read errors are bounded in the API response.
    sendJson(ctx.res, 500, { error: 'create_options_failed' });
  }
}

/** A durable agent's editable settings and what each can be set to (#2452). */
async function handleMobileAgentSettingsRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  try {
    const info = await findMobileAgent(decodeURIComponent(match[1]));
    if (!info || isDisposedAgent(info.config)) { sendJson(ctx.res, 404, { error: 'agent_not_found' }); return; }
    const project = { id: info.project.id, path: info.project.path };
    const dispatcher = project.id === DISPATCHER_PROJECT_ID;
    const [settings, options, details] = await Promise.all([
      buildAgentSettings(project, info.config, mobileLiveState(info.config.id), { dispatcher }),
      buildAgentSettingsOptions(project.path),
      buildAgentDetails(project, info.config, { dispatcher }),
    ]);
    sendJson(ctx.res, 200, { version: 1, epoch: mobileCommands.epoch, ...settings, options, details });
  } catch {
    // telemetry-exempt: config read errors are bounded in the API response.
    sendJson(ctx.res, 500, { error: 'agent_settings_failed' });
  }
}

/** Helper presets, app-wide or for an agent's or project's Auto setting (#2671). No filter returns every label family too. */
async function handleMobileHelperRoutingRoute(ctx: AnnexRouteContext): Promise<void> {
  try {
    const query = new URL(ctx.req.url ?? '', 'http://annex').searchParams;
    const agentId = query.get('agentId') ?? undefined;
    const projectId = query.get('projectId') ?? undefined;
    const agent = agentId ? await findMobileAgent(agentId) : undefined;
    if (agentId && !agent && !isDisabledDispatcherId(agentId)) { sendJson(ctx.res, 404, { error: 'agent_not_found' }); return; }
    const project = projectId && !isDispatcherProjectId(projectId) ? await findProjectById(projectId) : undefined;
    if (projectId && !project) { sendJson(ctx.res, 404, { error: 'project_not_found' }); return; }
    // The Dispatcher's folder has no project of its own, and it can't use presets.
    const routingProject = project ?? (agentId && activeDispatcher(agentId) ? undefined : agent?.project);
    const settings = await mobileHelperRouting({ projectPath: routingProject?.path, agentId, agent });
    sendJson(ctx.res, 200, { version: 1, epoch: mobileCommands.epoch, ...settings });
  } catch (err) {
    // telemetry-exempt: read errors are bounded in the API response, and logged here.
    appLog('core:annex', 'warn', 'Helper presets read failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
    sendJson(ctx.res, 500, { error: 'helper_routing_failed' });
  }
}

async function runMobileCommand(command: MobileCommand, assertAuthorized: () => void, principal: string): Promise<unknown> {
  assertAuthorized();
  if (command.type === 'helperRouting.update') return runHelperRoutingUpdate(command, assertAuthorized, findProjectById);
  if (command.type === 'dispatcher.setEnabled') {
    // onDispatcherChanged broadcasts dispatcher:changed and refreshes the snapshot.
    return setDispatcherEnabledFromPhone(command.enabled, assertAuthorized);
  }
  // The Dispatcher is in no project (#2533): nothing is created, pinned or listed under its id.
  if ('projectId' in command && isDispatcherProjectId(command.projectId)) {
    throw new MobileControlError('dispatcher_locked', 409, 'rejected', 'The Dispatcher is in no project.');
  }
  if ('agentId' in command) assertDispatcherCommand(command.type, command.agentId);
  if ('sessionId' in command) {
    const info = await findMobileAgent(command.agentId);
    if ((!info || isDisposedAgent(info.config)) && !trackedQuickAgents.has(command.agentId)) throw new MobileControlError('agent_not_found', 404);
    const runtime = getAgentRuntime(command.agentId);
    return executeChatCommand(command, runtime, async () => !await isRevertRunning(command.agentId), () => {
      assertAuthorized();
      if (getAgentRuntime(command.agentId) !== runtime) throw new MobileControlError('session_mismatch');
    }, (ids, caps) => mobileAttachments.resolveFor(principal, command.agentId, ids, caps));
  }
  if (command.type === 'project.setPinned' || command.type === 'project.setInactive') {
    const project = await findProjectById(command.projectId);
    if (!project) throw new MobileControlError('project_not_found', 404);
    // Until a desktop window has moved its saved pins into main, a change here would replace them.
    if (!isProjectStateReady()) throw new MobileControlError('project_state_unavailable');
    assertAuthorized();
    // The desktop's rules: a pinned project can't be marked inactive (unpin first); marking active is activity now.
    if (command.type === 'project.setInactive' && command.inactive && getProjectState().pinnedProjectIds.includes(project.id)) {
      throw new MobileControlError('project_pinned');
    }
    const changed = applyProjectStateChange(command.type === 'project.setPinned'
      ? { type: 'setPinned', projectId: project.id, pinned: command.pinned }
      : { type: 'setInactive', projectId: project.id, inactive: command.inactive, at: Date.now() });
    // A change refreshes the snapshot through onProjectStateChange; a no-op still confirms the state.
    if (!changed) broadcastSnapshotRefresh();
    const durables = (await agentConfig.listDurable(project.path)).filter((d) => !isDisposedAgent(d));
    const running = durables.some((d) => isAgentRunning(d.id))
      || [...trackedQuickAgents.values()].some((qa) => qa.projectId === project.id && qa.status === 'running');
    return { projectId: project.id, ...projectStateEntry(project.id, running ? new Set([project.id]) : new Set()) };
  }
  if (command.type === 'quick.dismiss' || command.type === 'quick.clear') {
    const project = await findProjectById(command.projectId);
    if (!project) throw new MobileControlError('project_not_found', 404);
    // Until a desktop window has moved its saved list into main, a change here would replace it.
    if (!isFinishedQuickAgentsReady()) throw new MobileControlError('finished_quick_agents_unavailable');
    assertAuthorized();
    const changed = applyFinishedQuickAgentChange(command.type === 'quick.dismiss'
      ? { type: 'dismiss', projectId: project.id, agentId: command.agentId }
      : { type: 'clear', projectId: project.id });
    // A change refreshes the snapshot through onFinishedQuickAgentsChange; a no-op still confirms the list.
    if (!changed) broadcastSnapshotRefresh();
    return { projectId: project.id, finishedQuickAgents: finishedQuickAgentList(project.id) };
  }
  if (command.type === 'agent.spawn') {
    const project = await findProjectById(command.projectId);
    if (!project) throw new MobileControlError('project_not_found', 404);
    assertAuthorized();
    const id = generateQuickAgentId();
    const name = generateQuickName();
    const orchestrator = command.orchestrator ?? project.orchestrator ?? 'claude-code';
    // All paths come from the registered project. A quick agent from a phone asks first.
    const tracked: TrackedQuickAgent = { id, name, kind: 'quick', status: 'starting', prompt: command.prompt,
      model: command.model ?? null, orchestrator, freeAgentMode: false, parentAgentId: null, projectId: project.id, spawnedAt: Date.now() };
    setTrackedQuickAgent(id, tracked);
    // A copy: the replay buffer keeps this payload, and the entry goes on changing.
    broadcastAndBuffer('agent:spawned', quickAgentWireFields(tracked));
    const starting = { cancelled: false };
    mobileStartingAgents.set(id, starting);
    try {
      await spawnAgent({ agentId: id, projectPath: project.path, cwd: project.path, kind: 'quick',
        // A phone starts an agent to follow and talk to: chat or terminal per the
        // provider setting, never a headless one-shot it couldn't see.
        mission: command.prompt, model: command.model, orchestrator, freeAgentMode: false, interactive: true });
      if (starting.cancelled) {
        await killAgent(id, project.path, orchestrator);
        throw new MobileControlError('start_cancelled', 409, 'failed');
      }
      tracked.status = isAgentRunning(id) ? 'running' : 'sleeping';
      broadcastToAllWindows(IPC.ANNEX.AGENT_SPAWNED, { ...quickAgentWireFields(tracked), headless: getAgentExecutionMode(id) === 'headless' });
      broadcastSnapshotRefresh();
      return { agentId: id, name, state: tracked.status, executionMode: getAgentExecutionMode(id) };
    } catch (err) {
      untrackQuickAgent(id);
      broadcastSnapshotRefresh();
      throw err;
    } finally { finishMobileStart(id, starting); }
  }
  if (command.type === 'agent.create') {
    const project = await findProjectById(command.projectId);
    if (!project) throw new MobileControlError('project_not_found', 404);
    assertAuthorized();
    const created = await createMobileAgent({ id: project.id, path: project.path }, command, assertAuthorized);
    broadcastSnapshotRefresh();
    return created;
  }
  if (command.type === 'agent.providerPreview' || command.type === 'agent.providerChange') {
    const durable = await findMobileAgent(command.agentId);
    if (!durable || isDisposedAgent(durable.config)) throw new MobileControlError('agent_not_found', 404);
    const actor = { key: `phone:${principal}`, assertAuthorized };
    const result = command.type === 'agent.providerPreview'
      ? await previewAgentProvider(durable.project.path, command.agentId, command.provider, actor)
      : await changeAgentProvider(durable.project.path, command.agentId, command.provider, command.expectedState, actor);
    if (command.type === 'agent.providerChange') {
      broadcastToAllWindows(IPC.WINDOW.REQUEST_DURABLE_RELOAD, durable.project.id);
      broadcastSnapshotRefresh();
    }
    return result;
  }
  if (command.type === 'agent.update') {
    const durable = await findMobileAgent(command.agentId);
    if (!durable || isDisposedAgent(durable.config)) throw new MobileControlError('agent_not_found', 404);
    assertAuthorized();
    // Settings > Dispatcher's rules for the Dispatcher, the Settings card's for every other agent.
    const updateAgent = durable.project.id === DISPATCHER_PROJECT_ID ? updateMobileDispatcher : updateMobileAgent;
    const updated = await updateAgent({ id: durable.project.id, path: durable.project.path }, durable.config, command,
      { live: mobileLiveState(command.agentId), assertAuthorized });
    // The desktop's agent list reads names and colours once; tell it what the phone changed.
    const { settings } = updated;
    const update: AnnexAgentUpdate = { agentId: updated.agentId, name: settings.name.value, color: settings.color.value, emoji: settings.emoji.value,
      model: settings.model.value === 'default' ? null : settings.model.value, orchestrator: settings.orchestrator.value,
      freeAgentMode: settings.freeAgentMode.value };
    broadcastToAllWindows(IPC.ANNEX.AGENT_UPDATED, update);
    broadcastSnapshotRefresh();
    return updated;
  }
  if (command.type === 'helper.approve' || command.type === 'helper.decline') {
    const result = await runHelperCommand(command, { assertAuthorized, reloadProject: (projectPath) => {
      // The desktop's rail drops the disposed helper, as after its own dispose dialog.
      void Promise.resolve(projectStore.list()).then((projects) => {
        const project = projects.find((p) => path.resolve(p.path) === path.resolve(projectPath));
        if (project) broadcastToAllWindows(IPC.WINDOW.REQUEST_DURABLE_RELOAD, project.id);
      }).catch(() => { /* telemetry-exempt: the rail catches up on its next load */ });
    } });
    broadcastSnapshotRefresh();
    return result;
  }
  const info = await findMobileAgent(command.agentId);
  const quick = trackedQuickAgents.get(command.agentId);
  const project = info?.project ?? (quick ? await findProjectById(quick.projectId) : undefined);
  if (!project || (info && isDisposedAgent(info.config))) throw new MobileControlError('agent_not_found', 404);
  assertAuthorized();
  if (command.type === 'agent.stop') {
    const starting = mobileStartingAgents.get(command.agentId);
    if (starting) starting.cancelled = true;
    if (command.waitForStopped) {
      return withAgentTransition(command.agentId, async () => {
        assertAuthorized();
        await stopAgentForAnnex(command.agentId, project.path, info?.config.orchestrator);
        if (!(await waitForAgentStopped(command.agentId))) throw new MobileControlError('agent_stopping');
        await persistGuidedSessionCapture(project.path, command.agentId);
        assertAuthorized();
        broadcastSnapshotRefresh();
        return { agentId: command.agentId, stopRequested: true, state: 'sleeping', stopped: true };
      });
    }
    await killAgent(command.agentId, project.path, info?.config.orchestrator);
    broadcastSnapshotRefresh();
    return { agentId: command.agentId, stopRequested: true };
  }
  if (!info) throw new MobileControlError('agent_not_found', 404);
  if (isAgentRunning(command.agentId) || mobileStartingAgents.has(command.agentId)) throw new MobileControlError('agent_already_running');
  const start = async () => {
  const starting = { cancelled: false };
  mobileStartingAgents.set(command.agentId, starting);
  try {
    const config = command.expectedProvider !== undefined ? await agentConfig.getDurableConfig(project.path, command.agentId) : info.config;
    if (!config || isDisposedAgent(config)) throw new MobileControlError('agent_not_found', 404);
    if (command.expectedProvider !== undefined) {
      if (command.resume && hasSessionCaptureFailure(command.agentId)) throw new MobileControlError('session_capture_failed');
      const provider = await resolveOrchestrator(project.path, config.orchestrator);
      if (provider.id !== command.expectedProvider) throw new MobileControlError('stale_state');
      if (command.resume && (!command.expectedSessionId || command.expectedSessionId !== config.lastSessionId
        || config.sessionHistory?.find((entry) => entry.sessionId === command.expectedSessionId)?.orchestrator !== provider.id)) {
        throw new MobileControlError('resume_unverified');
      }
      assertAuthorized();
    }
    const resume = command.resume === true && !!config.lastSessionId;
    await spawnAgent({ agentId: config.id, projectPath: project.path, cwd: config.worktreePath || project.path,
      kind: 'durable', mission: command.message, model: config.model, orchestrator: config.orchestrator,
      freeAgentMode: config.freeAgentMode, resume, strictResume: command.expectedProvider !== undefined && resume, sessionId: resume ? config.lastSessionId : undefined });
    if (starting.cancelled) {
      await killAgent(command.agentId, project.path, config.orchestrator);
      throw new MobileControlError('start_cancelled', 409, 'failed');
    }
    noteAgentActivity(config.id);
    broadcastAndBuffer('agent:woken', { agentId: config.id, source: 'annex-mobile' });
    broadcastSnapshotRefresh();
    return { agentId: config.id, executionMode: getAgentExecutionMode(config.id) };
  } finally { finishMobileStart(command.agentId, starting); }
  };
  return command.expectedProvider !== undefined ? withAgentTransition(command.agentId, start) : start();
}

/**
 * Refuses a command body over the limit. It can't be parsed, so the answer has
 * no commandId and no receipt is kept.
 */
function refuseOversizedMobileCommand(req: http.IncomingMessage, res: http.ServerResponse): void {
  const response = mobileCommands.reject('too_large', 413);
  logRefusedMobileCommand(response);
  sendJsonAndDrain(req, res, response.statusCode, response.body);
}

async function handleMobileCommandRoute(ctx: AnnexRouteContext): Promise<void> {
  // Mobile requires pinned mTLS even on the legacy HTTP fallback listener.
  if (!ctx.mobilePrincipal) {
    const response = mobileCommands.reject('client_certificate_required', 403);
    sendJson(ctx.res, response.statusCode, response.body); return;
  }
  try {
    const input: unknown = JSON.parse((await readCappedBody(ctx.req, MAX_BODY_SIZE)).toString());
    // A peer can be revoked while its body is streaming; recheck before execution.
    const peer = findPairedPeer(ctx.mobilePrincipal);
    const principal = peer && (peer.role === 'controller' || !peer.role)
      && peer.tlsCertificateFingerprint === annexTls.extractPeerCertificateFingerprint(ctx.req.socket as tls.TLSSocket)
      ? ctx.mobilePrincipal : undefined;
    const epoch = mobileCommands.epoch;
    const pin = peer?.tlsCertificateFingerprint;
    const assertAuthorized = () => {
      const current = principal ? findPairedPeer(principal) : undefined;
      if (mobileCommands.epoch !== epoch || !current || current.tlsCertificateFingerprint !== pin
        || (current.role && current.role !== 'controller')) throw new MobileControlError('authorization_revoked', 403);
    };
    const response = await mobileCommands.execute(principal, input, (command) => runMobileCommand(command, assertAuthorized, principal!));
    logRefusedMobileCommand(response, input);
    sendJson(ctx.res, response.statusCode, response.body);
  } catch (err) {
    if (isBodyTooLarge(err)) { refuseOversizedMobileCommand(ctx.req, ctx.res); return; }
    // telemetry-exempt: invalid JSON/body is reported to the caller and logged by code, without its content.
    const response = mobileCommands.reject('invalid_command', 400);
    logRefusedMobileCommand(response);
    sendJson(ctx.res, response.statusCode, response.body);
  }
}

/** A refusal's code, status and known command type, so a phone's failure can be told apart afterwards. Never the command's contents. */
function logRefusedMobileCommand(response: MobileResponse, input?: unknown): void {
  if (response.statusCode < 400) return;
  const type = (input as { type?: unknown } | null | undefined)?.type;
  appLog('core:annex', 'warn', 'Mobile command refused', {
    meta: { code: response.body.error?.code, status: response.statusCode, type: (MOBILE_COMMAND_TYPES as readonly unknown[]).includes(type) ? type : 'unknown' },
  });
}

/**
 * A phone uploads one image (raw bytes, image/* or application/octet-stream)
 * for a chat agent that takes images; chat.send then names it in
 * `attachmentIds` (#2453). Pinned mTLS like /mobile/commands, its own body
 * cap (the 1 MB readBody cap stays for everything else), and per-peer limits.
 */
async function handleMobileAttachmentRoute(ctx: AnnexRouteContext, match: RegExpMatchArray): Promise<void> {
  const principal = ctx.mobilePrincipal;
  if (!principal) { sendJson(ctx.res, 403, { error: 'client_certificate_required' }); return; }
  const epoch = mobileCommands.epoch;
  const pin = findPairedPeer(principal)?.tlsCertificateFingerprint;
  const authorized = () => {
    const peer = findPairedPeer(principal);
    return mobileCommands.epoch === epoch && !!peer && peer.tlsCertificateFingerprint === pin
      && (!peer.role || peer.role === 'controller');
  };
  let bodyRead = false;
  const refuse = (status: number, error: string, retryAfterMs?: number) => {
    if (retryAfterMs !== undefined) ctx.res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    if (!bodyRead) {
      // Discard a body within the cap so the client reads this answer. A bigger one is
      // drained up to a bound while the answer goes out, then the connection closes.
      const declared = Number(ctx.req.headers['content-length']);
      if (Number.isFinite(declared) && declared <= CHAT_IMAGE_MAX_BYTES && status !== 413) ctx.req.resume();
      else { sendJsonAndDrain(ctx.req, ctx.res, status, { version: 1, error }); return; }
    }
    sendJson(ctx.res, status, { version: 1, error });
  };
  try {
    const agentId = decodeURIComponent(match[1]);
    if (!isUploadContentType(ctx.req.headers['content-type'])) { refuse(415, 'unsupported_media_type'); return; }
    mobileAttachments.checkLimits(principal, Math.min(Number(ctx.req.headers['content-length']) || 0, CHAT_IMAGE_MAX_BYTES));
    const info = await findMobileAgent(agentId);
    if ((!info || isDisposedAgent(info.config)) && !trackedQuickAgents.has(agentId)) { refuse(404, 'agent_not_found'); return; }
    const runtime = getAgentRuntime(agentId);
    if (!runtime || runtime.kind !== 'chat' || !runtime.isRunning()) { refuse(409, 'not_chat'); return; }
    if (runtime.getCapabilities?.()?.images !== true) { refuse(409, 'images_not_supported'); return; }
    const body = await readCappedBody(ctx.req, CHAT_IMAGE_MAX_BYTES);
    bodyRead = true;
    // A peer can be revoked while its body is streaming.
    if (!authorized()) { refuse(403, 'authorization_revoked'); return; }
    const result = await mobileAttachments.upload(principal, agentId, body);
    sendJson(ctx.res, 200, result);
  } catch (err) {
    // telemetry-exempt: bounded upload errors go to the caller; image bytes are never logged.
    if (err instanceof MobileUploadError) refuse(err.statusCode, err.code, err.retryAfterMs);
    else refuse(400, 'upload_failed');
  }
}

const ANNEX_HTTP_ROUTE_TABLE: AnnexHttpRoute[] = [
  { method: 'POST', pattern: /^\/api\/v1\/mobile\/agents\/([^/]+)\/attachments$/, handler: handleMobileAttachmentRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/agents\/([^/]+)\/content(\?.*)?$/, handler: handleMobileContentRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/capabilities$/, handler: handleMobileCapabilitiesRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/canvas$/, handler: handleMobileCanvasRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/canvas\/([^/]+)$/, handler: handleMobileCanvasRoute },
  { method: 'DELETE', pattern: /^\/api\/v1\/mobile\/pairing$/, handler: handleMobilePairingDeleteRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/agents\/state$/, handler: handleMobileAgentStateRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/agents\/([^/]+)\/chat(\?.*)?$/, handler: handleMobileChatRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/agents\/([^/]+)\/chat\/sessions$/, handler: handleMobileChatSessionsRoute },
  { method: 'POST', pattern: /^\/api\/v1\/mobile\/commands$/, handler: handleMobileCommandRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/projects\/([^/]+)\/create-options$/, handler: handleMobileCreateOptionsRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/agents\/([^/]+)\/settings$/, handler: handleMobileAgentSettingsRoute },
  { method: 'GET', pattern: /^\/api\/v1\/mobile\/helper-routing(\?.*)?$/, handler: handleMobileHelperRoutingRoute },
  { method: 'GET', pattern: /^\/api\/v1\/identity$/, handler: handleIdentityRoute },
  { method: 'GET', pattern: /^\/api\/v1\/status$/, handler: handleStatusRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects$/, handler: handleProjectsRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/agents$/, handler: handleProjectAgentsRoute },
  { method: 'GET', pattern: /^\/api\/v1\/agents\/([^/]+)\/buffer$/, handler: handleAgentBufferRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/files\/tree(\?.*)?$/, handler: handleProjectFilesTreeRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/files\/read(\?.*)?$/, handler: handleProjectFilesReadRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/git\/info$/, handler: handleGitInfoRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/git\/log(\?.*)?$/, handler: handleGitLogRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/git\/diff(\?.*)?$/, handler: handleGitDiffRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/git\/show-commit(\?.*)?$/, handler: handleGitShowCommitRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/git\/commit-diff(\?.*)?$/, handler: handleGitCommitDiffRoute },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/([^/]+)\/git\/(stage|unstage|stage-all|unstage-all|commit|push|pull|checkout|stash|stash-pop)$/, handler: handleGitOperationRoute },
  { method: 'GET', pattern: /^\/api\/v1\/agents\/([^/]+)\/sessions(\?.*)?$/, handler: handleSessionListRoute },
  { method: 'GET', pattern: /^\/api\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/transcript(\?.*)?$/, handler: handleSessionTranscriptRoute },
  { method: 'GET', pattern: /^\/api\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/summary(\?.*)?$/, handler: handleSessionSummaryRoute },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/([^/]+)\/agents\/quick$/, handler: handleQuickProjectAgentRoute },
  { method: 'POST', pattern: /^\/api\/v1\/agents\/([^/]+)\/agents\/quick$/, handler: handleQuickChildAgentRoute },
  { method: 'POST', pattern: /^\/api\/v1\/agents\/([^/]+)\/wake$/, handler: handleWakeAgentRoute },
  { method: 'POST', pattern: /^\/api\/v1\/agents\/([^/]+)\/permission-response$/, handler: handlePermissionResponseRoute },
  { method: 'POST', pattern: /^\/api\/v1\/agents\/([^/]+)\/message$/, handler: handleAgentMessageRoute },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/([^/]+)\/agents\/durable$/, handler: handleDurableCreationRoute },
  { method: 'POST', pattern: /^\/api\/v1\/projects\/([^/]+)\/agents\/([^/]+)\/delete$/, handler: handleDurableDeleteRoute },
  { method: 'GET', pattern: /^\/api\/v1\/projects\/([^/]+)\/agents\/([^/]+)\/worktree-status$/, handler: handleWorktreeStatusRoute },
  { method: 'GET', pattern: /^\/api\/v1\/group-projects$/, handler: handleGroupProjectsListRoute },
  { method: 'GET', pattern: /^\/api\/v1\/group-projects\/([^/]+?)(\?.*)?$/, handler: handleGroupProjectGetRoute },
  { method: 'GET', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/digest(\?.*)?$/, handler: handleGroupProjectDigestRoute },
  { method: 'GET', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/topics\/([^/?]+)(\?.*)?$/, handler: handleGroupProjectTopicRoute },
  { method: 'GET', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/messages(\?.*)?$/, handler: handleGroupProjectAllMessagesRoute },
  { method: 'POST', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/messages$/, handler: handleGroupProjectPostMessageRoute },
  { method: 'POST', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/shoulder-tap$/, handler: handleGroupProjectShoulderTapRoute },
  { method: 'POST', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/polling$/, handler: handleGroupProjectPollingRoute },
  { method: 'DELETE', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/topics\/([^/]+)\/messages\/([^/]+)$/, handler: handleGroupProjectDeleteMessageRoute },
  { method: 'DELETE', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/topics\/([^/?]+)$/, handler: handleGroupProjectDeleteTopicRoute },
  { method: 'PATCH', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/bulletin\/topics\/([^/]+)\/protection$/, handler: handleGroupProjectBulletinProtectionRoute },
  { method: 'POST', pattern: /^\/api\/v1\/inject-message$/, handler: handleGroupProjectInjectRoute },
  { method: 'GET', pattern: /^\/api\/v1\/group-projects\/([^/]+)\/members$/, handler: handleGroupProjectMembersRoute },
  { method: 'PATCH', pattern: /^\/api\/v1\/group-projects\/([^/]+?)$/, handler: handleGroupProjectPatchRoute },
  { method: 'GET', pattern: /^\/api\/v1\/icons\/agent\/([^/?]+)(\?.*)?$/, handler: handleAgentIconRoute },
  { method: 'GET', pattern: /^\/api\/v1\/icons\/project\/([^/?]+)(\?.*)?$/, handler: handleProjectIconRoute },
];

/** The REST route table's methods and patterns (telemetry route templates are checked against it). */
export function annexHttpRoutes(): ReadonlyArray<{ method: string; pattern: RegExp }> {
  return ANNEX_HTTP_ROUTE_TABLE.map(({ method, pattern }) => ({ method, pattern }));
}

export function resolveAnnexHttpRoute(method: string, url: string): AnnexHttpRoute | undefined {
  return ANNEX_HTTP_ROUTE_TABLE.find((route) => route.method === method && route.pattern.test(url));
}

// ---------------------------------------------------------------------------
// Main-port request handler (serves authenticated endpoints)
// ---------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // CORS headers — restrict to local origins only
  const origin = req.headers.origin || '';
  if (isAllowedCorsOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Mobile bootstrap: only PIN pairing, only over TLS. All control remains authenticated.
  if (method === 'POST' && url === '/pair' && (req.socket as tls.TLSSocket).encrypted) {
    await handlePairingRequest(req, res);
    return;
  }

  // All endpoints on the main server require auth (mTLS or bearer token).
  // Check mTLS first (matching the WebSocket upgrade handler), then fall back
  // to bearer token. Without this, REST calls from the controller using only
  // mTLS certs (e.g. buffer fetch) would be rejected with 401.
  let authenticated = false;
  let isMtlsAuthenticated = false;
  let mobilePrincipal: string | undefined;
  if (req.socket && 'getPeerCertificate' in req.socket) {
    const peerFingerprint = annexTls.extractPeerFingerprint(req.socket as tls.TLSSocket);
    if (peerFingerprint) {
      const peer = findPairedPeer(peerFingerprint);
      if (peer && (peer.role === 'controller' || !peer.role)
        && (!peer.tlsCertificateFingerprint || peer.tlsCertificateFingerprint === annexTls.extractPeerCertificateFingerprint(req.socket as tls.TLSSocket))) {
        authenticated = true;
        isMtlsAuthenticated = true;
        if (peer.tlsCertificateFingerprint && peer.tlsCertificateFingerprint === annexTls.extractPeerCertificateFingerprint(req.socket as tls.TLSSocket)) mobilePrincipal = peerFingerprint;
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
      recordControlDenied('rest');
      sendJson(res, 403, { error: 'mtls_required', message: 'Destructive operations require mTLS authentication' });
      return true;
    }
    return false;
  }

  const route = resolveAnnexHttpRoute(method, url);
  if (route) {
    const match = url.match(route.pattern);
    if (match) {
      await withRemoteParent(restTraceparent(req.headers.traceparent, isMtlsAuthenticated), () =>
        annexRestFlow(method, route.pattern, () => res.statusCode, () =>
          traceHttpResponse(res, () => route.handler({ req, res, url, method, requireMtls, mobilePrincipal }, match))),
        true,
      );
      return;
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// WebSocket message handler (Issue 8 — bidirectional)
// ---------------------------------------------------------------------------

const MAX_PTY_INPUT_SIZE = 64 * 1024; // 64KB
/**
 * Largest WebSocket frame accepted (the ws default is 100 MiB). The biggest
 * legitimate message is a legacy clipboard:image: 10 MB of base64 plus its envelope.
 */
export const WS_MAX_PAYLOAD = 11 * 1024 * 1024;

function isReplayFrame(data: string): boolean {
  const { type, seq } = JSON.parse(data) as { type?: string; seq?: unknown };
  return seq !== undefined || type === 'replay:start' || type === 'replay:end';
}

/** Send data over a WebSocket only if the connection is still open. */
function safeSend(ws: WebSocket, data: string): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    const tc = currentRequestTraceparent();
    if (tc) {
      const message = JSON.parse(data);
      // Replay carries the original event context, never this request's context.
      if (!message.replayed) data = JSON.stringify({ ...message, tc });
    }
    data = enforceFrameLimit(data);
    noteFrameSize(data);
    const held = heldFrames.get(ws);
    // A reply can go ahead of the snapshot: a phone has no cursor yet, and takes the snapshot after it.
    // Replay can't, because it carries seqs: it waits with the events it might repeat.
    if (held && !held.retrying && isReplayFrame(data)) holdFrame(held, data);
    else ws.send(data);
    return true;
  }
  return false;
}

const wsTelemetryHandshakes = new WeakMap<WebSocket, ReturnType<typeof telemetryHelloAck>>();
const wsTelemetryPeerServices = new WeakMap<WebSocket, string>();

function handleWsMessage(ws: WebSocket, data: string): void {
  // `tc`: optional W3C traceparent from a controller with telemetry on (spec §7).
  let msg: { type?: string; payload?: Record<string, unknown>; since?: number; epoch?: unknown; tc?: unknown };
  try {
    msg = JSON.parse(data);
  } catch {
    appLog('core:annex', 'warn', 'Malformed JSON in WebSocket message', {
      meta: { bytes: Buffer.byteLength(data) },
    });
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const type = msg.type;
  // Optional, authenticated capability handshake. One identity per socket; no resource mutation.
  if (type === 'telemetry:hello') {
    if (wsAuthTypes.get(ws) !== 'mtls') return;
    const peer = parseTelemetryHello(msg.payload);
    if (!peer) return;
    const prior = wsTelemetryHandshakes.get(ws);
    if (prior && (wsTelemetryPeerServices.get(ws) !== peer.serviceName || prior.peerServiceInstanceId !== peer.serviceInstanceId
      || prior.connectionAttemptId !== peer.connectionAttemptId)) return;
    const ack = prior ?? telemetryHelloAck(peer);
    wsTelemetryHandshakes.set(ws, ack);
    wsTelemetryPeerServices.set(ws, peer.serviceName);
    reportClientCounts();
    withRemoteParent(validatedTraceparent(msg.tc), () => tel.flow('clubhouse.annex.command', {
      attrs: handshakeAttributes(ack),
    }, () => {
      rememberAnnexIncidentPhone(peer.serviceName, peer.serviceInstanceId, ack.connectionId);
      rememberAnnexIncidentTrace();
      return safeSend(ws, JSON.stringify({ type: 'telemetry:hello:ack', payload: ack }));
    }), true);
    return;
  }

  if (type === 'mobile:replay') {
    const epoch = mobileCommands.epoch;
    const since = msg.since;
    const events = msg.epoch === epoch && Number.isSafeInteger(since) && since! >= 0 && since! <= eventReplay.getLastSeq()
      ? eventReplay.getEventsSince(since!) : null;
    // Agent cleanup can remove interior events; never claim a partial replay is complete.
    if (events === null || events.length !== eventReplay.getLastSeq() - since!
      || events.some((event, index) => event.seq !== since! + index + 1) || events.some(cannotBeReplayed)) {
      safeSend(ws, JSON.stringify({ type: 'replay:gap', epoch, oldestAvailable: eventReplay.getOldestSeq(), lastSeq: eventReplay.getLastSeq() }));
      return;
    }
    safeSend(ws, JSON.stringify({ type: 'replay:start', epoch, fromSeq: events[0]?.seq ?? since, toSeq: eventReplay.getLastSeq(), count: events.length }));
    for (const event of events) safeSend(ws, JSON.stringify({ type: event.type, payload: event.payload, seq: event.seq, ...(event.tc && { tc: event.tc }), replayed: true }));
    safeSend(ws, JSON.stringify({ type: 'replay:end', epoch }));
    return;
  }

  // --- Replay (available to all authenticated connections) ---
  if (type === 'replay' && typeof msg.since === 'number') {
    const events = eventReplay.getEventsSince(msg.since);

    if (events === null || events.some(cannotBeReplayed)) {
      recordReplay('gap');
      safeSend(ws, JSON.stringify({
        type: 'replay:gap',
        oldestAvailable: eventReplay.getOldestSeq(),
        lastSeq: eventReplay.getLastSeq(),
      }));
      return;
    }

    safeSend(ws, JSON.stringify({
      type: 'replay:start',
      fromSeq: events.length > 0 ? events[0].seq : msg.since,
      toSeq: eventReplay.getLastSeq(),
      count: events.length,
    }));

    let replayed = true;
    for (const event of events) {
      if (!safeSend(ws, JSON.stringify({
        type: event.type,
        payload: event.payload,
        seq: event.seq,
        ...(event.tc && { tc: event.tc }),
        replayed: true,
      }))) {
        replayed = false;
        break;
      }
    }
    recordReplay(replayed ? 'ok' : 'send_failed');

    safeSend(ws, JSON.stringify({ type: 'replay:end' }));
    return;
  }

  // --- Control messages (mTLS-only) ---
  const authType = wsAuthTypes.get(ws);
  const isMtls = authType === 'mtls';

  if (!isMtls && (type === 'pty:input' || type === 'pty:resize' || type === 'pty:spawn-shell' || type === 'pty:close' || type === 'pty:attach' || type === 'agent:spawn' || type === 'agent:wake' || type === 'agent:kill' || type === 'agent:reorder' || type === 'clipboard:image')) {
    recordControlDenied('ws');
    safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'Control messages require mTLS authentication' } }));
    return;
  }

  const payload = msg.payload || {};
  const traceparent = wsTraceparent(type, msg.tc);
  const handshake = isMtls ? wsTelemetryHandshakes.get(ws) : undefined;
  if (handshake && traceparent) rememberAnnexIncidentPhone(wsTelemetryPeerServices.get(ws) ?? '', handshake.peerServiceInstanceId, handshake.connectionId);

  switch (type) {
    case 'pty:input': {
      const agentId = payload.agentId as string;
      const inputData = payload.data as string;
      if (!agentId || typeof inputData !== 'string') break;
      if (inputData.length > MAX_PTY_INPUT_SIZE) {
        sendPtyError(ws, 'pty:input', 'pty:input data exceeds 64KB limit', { agentId });
        break;
      }
      if (isOtherControllersShell(ws, agentId)) {
        sendPtyError(ws, 'pty:input', 'session_not_found', { agentId });
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
      if (isOtherControllersShell(ws, agentId)) {
        sendPtyError(ws, 'pty:resize', 'session_not_found', { agentId });
        break;
      }
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
        safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'clipboard:image data exceeds 10MB limit' } }));
        break;
      }
      const refused = handleClipboardImage(agentId, base64, mimeType);
      if (refused) safeSend(ws, JSON.stringify({ type: 'error', payload: refused }));
      break;
    }

    case 'pty:spawn-shell': {
      handleSpawnShellWs(ws, payload).catch((err) => {
        appLog('core:annex', 'error', 'pty:spawn-shell failed', {
          meta: { projectId: payload.projectId, error: err instanceof Error ? err.message : String(err) },
        });
        sendPtyError(ws, 'pty:spawn-shell', 'internal_error', typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {});
      });
      break;
    }

    case 'pty:close': {
      handleCloseShellWs(ws, payload);
      break;
    }

    case 'pty:attach': {
      handleAttachWs(ws, payload).catch((err) => {
        appLog('core:annex', 'error', 'pty:attach failed', {
          meta: { agentId: payload.agentId, error: err instanceof Error ? err.message : String(err) },
        });
        sendPtyError(ws, 'pty:attach', 'internal_error', typeof payload.agentId === 'string' ? { agentId: payload.agentId } : {});
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
          safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'project_not_found' } }));
          return;
        }
        return annexCommandFlow(traceparent, () => handleSpawnQuickAgentWs(ws, project, payload));
      }).catch((err) => {
        appLog('core:annex', 'error', 'agent:spawn lookup failed', {
          meta: { projectId, error: err instanceof Error ? err.message : String(err) },
        });
        safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'internal_error' } }));
      });
      break;
    }

    case 'agent:wake': {
      const agentId = payload.agentId as string;
      if (!agentId) break;
      annexCommandFlow(traceparent, () => handleWakeAgentWs(ws, agentId, {
        resume: !!payload.resume,
        mission: payload.mission as string | undefined,
        model: payload.model as string | undefined,
      }));
      break;
    }

    case 'agent:kill': {
      const agentId = payload.agentId as string;
      if (!agentId) break;
      void annexCommandFlow(traceparent, () => handleKillAgentWs(ws, agentId));
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
      applyCanvasMutationServerSide(projectId, canvasId, mutation).then(() => {
        broadcastSnapshotRefresh();
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'canvas_mutation_failed';
        appLog('core:annex', 'error', 'Canvas mutation failed server-side', {
          meta: { projectId, canvasId, mutationType: mutation.type, error: message },
        });
        safeSend(ws, JSON.stringify({
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
          safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'project_not_found' } }));
          return;
        }
        agentConfig.reorderDurable(project.path, orderedIds).then(() => {
          broadcastSnapshotRefresh();
          safeSend(ws, JSON.stringify({ type: 'agent:reorder:ack', payload: { projectId } }));
        }).catch(() => {
          safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'reorder_failed' } }));
        });
      }).catch((err) => {
        appLog('core:annex', 'error', 'agent:reorder lookup failed', {
          meta: { projectId, error: err instanceof Error ? err.message : String(err) },
        });
        safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'internal_error' } }));
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
  try {
    const entry = await startQuickAgent({
      project: { id: project.id, path: project.path },
      prompt,
      model: payload.model as string | undefined,
      orchestrator: (payload.orchestrator as string) || project.orchestrator || 'claude-code',
      freeAgentMode: (payload.freeAgentMode as boolean) ?? false,
      parentAgentId,
    });
    safeSend(ws, JSON.stringify({ type: 'agent:spawn:ack', payload: { id: entry.id, name: entry.name, status: 'starting' } }));
  } catch {
    // telemetry-exempt: the controller is told the start failed
    safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'spawn_failed' } }));
  }
}

async function stopAgentForAnnex(agentId: string, projectPath: string, orchestrator?: string, plainShell = false): Promise<void> {
  await killAgent(agentId, projectPath, orchestrator, 'user', {
    waitForExit: true, throwOnFailure: true, ...(plainShell ? { exitCommand: 'exit\r' } : {}),
  });
  if (isAgentRunning(agentId)) throw new Error('agent_still_running');
}

async function handleKillAgentWs(ws: WebSocket, agentId: string): Promise<void> {
  try {
    const info = await findAgentAcrossProjects(agentId);
    // Quick agents have no durable config; their running registration carries
    // the same project/provider identity used by the main-process stop path.
    const registration = agentRegistry.get(agentId);
    const shellCwd = ptyManager.getShellCwd(agentId);
    const projectPath = info?.project.path || registration?.projectPath || shellCwd;
    if (!projectPath) {
      safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'agent_not_found' } }));
      return;
    }
    await stopAgentForAnnex(agentId, projectPath, registration?.orchestrator || info?.config.orchestrator, shellCwd !== undefined);
    safeSend(ws, JSON.stringify({ type: 'agent:kill:ack', payload: { agentId } }));
  } catch (err) {
    appLog('core:annex', 'warn', 'Failed to stop remote agent', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    safeSend(ws, JSON.stringify({ type: 'error', payload: { message: err instanceof Error ? err.message : 'stop_failed' } }));
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
    safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'agent_not_found' } }));
    return;
  }
  if (isAgentRunning(agentId)) {
    safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'agent_already_running' } }));
    return;
  }

  // Guard: clean up stale registry entry from crashed spawn
  const existingRegistration = agentRegistry.get(agentId);
  if (existingRegistration) {
    appLog('core:annex', 'warn', 'Stale agent registration found during WS wake — cleaning up before respawn', {
      meta: { agentId, existingRegistration: { projectPath: existingRegistration.projectPath, runtime: existingRegistration.runtime } },
    });
    agentRegistry.untrack(agentId);
  }

  const { config, project } = agentInfo;
  const agentModel = options.model || config.model;
  const cwd = config.worktreePath || project.path;

  appLog('core:annex', 'info', 'Waking durable agent (WS)', {
    meta: {
      agentId,
      agentName: config.name,
      projectId: project.id,
      cwd,
      model: agentModel || 'default',
      orchestrator: config.orchestrator || 'default',
      resume: options.resume,
    },
  });

  try {
    await spawnAgent({
      agentId: config.id, projectPath: project.path, cwd,
      kind: 'durable', model: agentModel, mission: options.mission,
      orchestrator: config.orchestrator, freeAgentMode: config.freeAgentMode,
      resume: !!options.resume && !!config.lastSessionId,
      sessionId: options.resume ? config.lastSessionId : undefined,
    });

    appLog('core:annex', 'info', 'Agent spawn completed successfully (WS)', {
      meta: { agentId, agentName: config.name },
    });

    noteAgentActivity(config.id);
    broadcastAndBuffer('agent:woken', { agentId: config.id, source: 'annex-v2' });

    // Wait for the agent to be registered as running before refreshing the
    // snapshot.  Matches the HTTP handler pattern — without this, the snapshot
    // arrives before the agent is registered, causing controllers to see
    // agents stuck in "sleeping" state.
    await waitForAgentRunning(config.id);
    broadcastSnapshotRefresh();
    safeSend(ws, JSON.stringify({ type: 'agent:wake:ack', payload: { agentId: config.id, status: 'starting' } }));
  } catch (err) {
    appLog('core:annex', 'error', 'Failed to wake agent (WS)', {
      meta: { agentId, agentName: config.name, error: err instanceof Error ? err.message : String(err) },
    });
    safeSend(ws, JSON.stringify({ type: 'error', payload: { message: 'wake_failed' } }));
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
  const serverStartMs = Date.now();
  const networkProfile = annexNetworkProfile();
  boundHost = networkProfile.host;

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
    recordTlsFallback();
  }

  // If TLS failed, fall back to HTTP for the main server
  const mainServer = tlsServer || http.createServer(handleRequest);
  if (!tlsServer) {
    httpServer = mainServer as http.Server;
  }

  wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // WebSocket upgrade handler for the main server
  mainServer.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host}`);

    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Defense-in-depth: reject WebSocket upgrades from unexpected origins
    // (DNS rebinding mitigation — complements mTLS + token auth)
    const origin = req.headers.origin || '';
    if (origin && !/^(file:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(origin)) {
      appLog('core:annex', 'warn', 'WebSocket upgrade rejected — invalid origin', {
        meta: { origin, remoteAddress: req.socket.remoteAddress },
      });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Check auth: mTLS peer cert OR bearer token
    let authType: WsAuthType = 'bearer';

    let peerFingerprintForWs: string | undefined;
    if (tlsServer && socket instanceof tls.TLSSocket) {
      const peerFingerprint = annexTls.extractPeerFingerprint(socket);
      if (peerFingerprint) {
        const peer = findPairedPeer(peerFingerprint);
        // Only grant mTLS auth to peers with role 'controller' (or legacy peers without a role)
        if (peer && (peer.role === 'controller' || !peer.role)
        && (!peer.tlsCertificateFingerprint || peer.tlsCertificateFingerprint === annexTls.extractPeerCertificateFingerprint(req.socket as tls.TLSSocket))) {
          authType = 'mtls';
          peerFingerprintForWs = peerFingerprint;
          annexPeers.updateLastSeen(peerFingerprint);
        }
      }
    }

    if (authType !== 'mtls') {
      // Accept token from Authorization header (preferred) or query param (legacy
      // fallback kept until Clubhouse-Go#76 ships on the mobile client).
      const token = extractBearerToken(req) ?? urlObj.searchParams.get('token');
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
      if (urlObj.searchParams.get('iconRefs') === '1') wsIconRefs.add(ws);
      const clientKind = urlObj.searchParams.get('client');
      if (clientKind === 'mobile' || clientKind === 'desktop') wsClientKinds.set(ws, clientKind);
      if (peerFingerprintForWs) {
        wsPeerFingerprints.set(ws, peerFingerprintForWs);
      }
      if (authType === 'bearer') {
        const token = extractBearerToken(req) ?? urlObj.searchParams.get('token');
        if (token) wsBearerTokens.set(ws, token);
      }
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws) => {
    // Mark connection alive for heartbeat
    wsAlive.set(ws, true);
    ws.on('pong', () => { wsAlive.set(ws, true); });

    // Nothing reaches this socket until its snapshot has. Events from here on come after it,
    // so its cursor is this seq: the build reads state later, and an event it already
    // reflects arriving again is safe, where one lost between the read and the cursor isn't.
    // Taken fresh for every connection, whichever build serves it: that's also how a phone gets
    // past a frame it can't receive, so it must never come from an earlier connection or build.
    heldFrames.set(ws, { frames: [], bytes: 0, retrying: false, cursor: eventReplay.getLastSeq() });
    firstSnapshotWaiters.add(ws);

    // wsAuthTypes is set synchronously in handleUpgrade before 'connection' fires — safe to read here.
    const authType = wsAuthTypes.get(ws);
    reportClientCounts();

    // Broadcast lock state immediately when mTLS controller connects — before the async
    // buildSnapshot() so the satellite UI locks without waiting for snapshot I/O to complete.
    if (authType === 'mtls') {
      const fingerprint = wsPeerFingerprints.get(ws);
      const peer = fingerprint ? findPairedPeer(fingerprint) : null;
      // Track the latest connecting controller as lock owner.
      sessionPauseOwner = fingerprint || null;
      broadcastToAllWindows(IPC.ANNEX.LOCK_STATE_CHANGED, {
        locked: true,
        controllerAlias: peer?.alias || 'Remote Controller',
        controllerIcon: peer?.icon || '',
        controllerColor: peer?.color || 'indigo',
        controllerFingerprint: fingerprint || '',
        remainingMs: 0,
      });
    }

    // Register close handler before any await so a disconnect during buildSnapshot
    // is handled correctly and never leaves the satellite stuck in locked state.
    ws.on('close', (code, reason) => {
      heldFrames.delete(ws);
      firstSnapshotWaiters.delete(ws);
      appLog('core:annex', 'info', 'WebSocket client disconnected', {
        meta: { authType, code, reason: reason?.toString() || '' },
      });
      reportClientCounts();
      closeShellsFor(ws);
      if (authType === 'mtls') {
        // Check if any other mTLS connections are still open
        const hasMtlsClient = Array.from(wss?.clients || []).some(
          (client) => client !== ws && client.readyState === WebSocket.OPEN && wsAuthTypes.get(client) === 'mtls',
        );
        // Only release the lock when no mTLS clients remain — a disconnecting
        // controller that "owned" the lock must not unlock while others are
        // still connected (LB-OA-2026-05-01).
        if (releaseMtlsLockIfLastClient(hasMtlsClient)) {
          broadcastToAllWindows(IPC.ANNEX.LOCK_STATE_CHANGED, {
            locked: false,
            remainingMs: 0,
          });
        }
      }
    });

    // Listen for client messages (replay requests)
    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString());
    });

    // Send snapshot on connect — async I/O after all event handlers are registered
    sendFirstSnapshot(ws);
  });

  // Subscribe to event bus (clean up any stale listeners first)
  unsubscribeEventBus();
  annexEventBus.setActive(true);

  unsubPtyData = annexEventBus.onPtyData((agentId, data, outputSeq) => {
    // A controller's shell is private: only it reads the output, and replay keeps none (#2476).
    const shellOwner = shellOwners.get(agentId);
    if (shellOwner) {
      safeSend(shellOwner, JSON.stringify({ type: 'pty:data', payload: { agentId, data, ...(outputSeq !== undefined && { outputSeq }) } }));
      return;
    }
    // `outputSeq` lets a controller stitch this onto a /buffer snapshot (#2324).
    broadcastAndBuffer('pty:data', { agentId, data, ...(outputSeq !== undefined && { outputSeq }) });
  });

  unsubChatEvent = onChatEvent((event) => {
    noteAgentActivity(event.agentId, event.ts);
    if (event.type === 'session_ended') forgetAppendedNotes(event.agentId, event.sessionId);
    // Remote clients never get desktop paths or inline image bytes (#2453).
    broadcastAndBuffer('chat:event', { agentId: event.agentId, event: remoteChatEvent(event) }, chatEventTraceparent(event));
    pushChatStatus(event);
  });

  unsubHookEvent = annexEventBus.onHookEvent((agentId, event) => {
    const detailedStatus = hookEventToDetailedStatus(event);
    detailedStatusCache.set(agentId, detailedStatus);
    noteAgentActivity(agentId);
    broadcastAndBuffer('hook:event', { agentId, event, detailedStatus });
  });

  unsubPtyExit = annexEventBus.onPtyExit((agentId, exitCode) => {
    const shellOwner = shellOwners.get(agentId);
    if (shellOwner) {
      shellOwners.delete(agentId);
      safeSend(shellOwner, JSON.stringify({ type: 'pty:exit', payload: { agentId, exitCode } }));
      return;
    }
    detailedStatusCache.delete(agentId);
    permissionQueue.clearForAgent(agentId);
    eventReplay.clearForAgent(agentId);
    const lastActivityAt = noteAgentActivity(agentId);

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
      cancelQuickAgentCleanup(agentId);
      quickAgentCleanupTimers.set(agentId, setTimeout(() => {
        untrackQuickAgent(agentId);
        agentLastActivity.delete(agentId);
      }, 60_000));
    } else {
      // A durable agent asleep: stopped, idle-slept or exited, terminal or chat. The iOS app takes pty:* frames
      // only into its terminal, and the chat events that said so were just dropped from replay, so without this
      // a phone kept showing it awake until the next catalog read.
      lastChatStatusPush.delete(agentId);
      broadcastAndBuffer('agent:status', {
        id: agentId,
        agentId,
        kind: 'durable',
        status: 'sleeping',
        detailedStatus: null,
        lastActivityAt,
      });
    }
  });

  unsubAgentSpawned = annexEventBus.onAgentSpawned((agentId, kind, projectId, meta) => {
    noteAgentActivity(agentId);
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

  // Helper starts and disposes waiting on the user (#159) are in the snapshot.
  const offStarts = onStartRequestsChanged(() => broadcastSnapshotRefresh());
  const offDisposes = onDisposeRequestsChanged(() => broadcastSnapshotRefresh());
  // A project's name, color or image, wherever it changed, or one added or removed. A burst is one snapshot.
  let projectsChangedTimer: ReturnType<typeof setTimeout> | null = null;
  const offProjects = projectStore.onProjectsChanged(() => {
    if (projectsChangedTimer) return;
    projectsChangedTimer = setTimeout(() => {
      projectsChangedTimer = null;
      if (wss && wss.clients.size > 0) broadcastSnapshotRefresh();
    }, PROJECTS_CHANGED_DEBOUNCE_MS);
    projectsChangedTimer.unref?.();
  });
  unsubHelperRequests = () => {
    offStarts();
    offDisposes();
    offProjects();
    if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
    projectsChangedTimer = null;
  };

  // Presets or a cell's state changed (#2671): a phone refetches. Never for a quota sample, and no snapshot is built.
  unsubHelperRouting = onHelperRoutingChanged((revision) => broadcastAndBuffer(HELPER_ROUTING_CHANGED_EVENT, { revision }));

  // The Dispatcher turned on or off, or its config changed (#2533): phones add, drop or update it live.
  const dispatcherChangedPayload = (state: ReturnType<typeof getDispatcherState>) => ({ ...dispatcherChange(state), ...dispatcherOffFields(state, dispatcherAgentView) });
  let lastDispatcherChange = JSON.stringify(dispatcherChangedPayload(getDispatcherState()));
  unsubDispatcher = onDispatcherChanged((state) => {
    const change = dispatcherChangedPayload(state);
    const key = JSON.stringify(change);
    if (key !== lastDispatcherChange) {
      lastDispatcherChange = key;
      broadcastAndBuffer(DISPATCHER_CHANGED_EVENT, change);
    }
    broadcastSnapshotRefresh();
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
        revokedTokens.delete(token); // clean up expired revocations
      }
    }
  }, 60_000);

  // Server-side heartbeat: ping all WS clients and terminate unresponsive ones.
  // This catches dead controller connections (e.g. mobile app killed, network lost)
  // that would otherwise leave the "connected (paused)" badge stuck forever.
  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (wsAlive.get(client) === false) {
        appLog('core:annex', 'info', 'Heartbeat: terminating unresponsive WebSocket client');
        client.terminate();
        continue;
      }
      wsAlive.set(client, false);
      try { client.ping(); } catch { client.terminate(); }
    }
  }, SERVER_HEARTBEAT_INTERVAL_MS);

  // Start both servers
  let mainReady = false;
  let pairingReady = false;

  function publishBonjour() {
    if (!mainReady || !pairingReady) return;
    rememberBoundPorts();
    if (!networkProfile.advertise) {
      broadcastToAllWindows(IPC.ANNEX.STATUS_CHANGED, getStatus());
      return;
    }
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

  // Reuse last launch's ports so a paired phone can reconnect without re-pairing.
  const lastPorts = annexSettings.getLastPorts();
  const pairing = pairingServer;

  listenPreferringPort(listenServer(mainServer, networkProfile.host), lastPorts.mainPort).then((port) => {
    if (mainServer !== (tlsServer || httpServer)) return; // stopped while binding
    serverPort = port;
    appLog('core:annex', 'info', `Annex main server listening on ${networkProfile.host}:${serverPort} (${tlsServer ? 'TLS' : 'HTTP'})`);
    mainReady = true;
    if (pairingReady) recordServerStarted(serverStartMs, !!tlsServer);
    publishBonjour();
  }).catch((err) => {
    appLog('core:annex', 'error', 'Annex main server failed to listen', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });

  listenPreferringPort(listenServer(pairing, networkProfile.host), lastPorts.pairingPort).then((port) => {
    if (pairing !== pairingServer) return; // stopped while binding
    pairingPort = port;
    appLog('core:annex', 'info', `Annex pairing server listening on ${networkProfile.host}:${pairingPort} (HTTP)`);
    pairingReady = true;
    if (mainReady) recordServerStarted(serverStartMs, !!tlsServer);
    publishBonjour();
  }).catch((err) => {
    appLog('core:annex', 'error', 'Annex pairing server failed to listen', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

/** A ListenFn for `server`. On error the server is closed, so it can listen again. */
function listenServer(server: http.Server | https.Server, host: string): ListenFn {
  return (port) => new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.close();
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('Annex server has no address after listen'));
    });
  });
}

/** Persist the bound ports for the next launch's listenPreferringPort. */
function rememberBoundPorts(): void {
  const ports = { mainPort: serverPort, pairingPort };
  const last = annexSettings.getLastPorts();
  if (last.mainPort === ports.mainPort && last.pairingPort === ports.pairingPort) return;
  Promise.resolve().then(() => annexSettings.saveLastPorts(ports)).catch((err) => {
    appLog('core:annex', 'warn', 'Failed to remember Annex ports', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

export function stop(): void {
  // Unsubscribe from event bus
  unsubscribeEventBus();
  if (refreshFollowUp) clearTimeout(refreshFollowUp);
  refreshFollowUp = null;
  refreshAgain = false;
  refreshWanted = false;
  refreshInFlight = false;
  firstSnapshotWaiters.clear();
  refreshGeneration++;
  abandonedSnapshotReads.clear();
  clearSnapshotBlock();
  if (snapshotOversizeRecheck) clearTimeout(snapshotOversizeRecheck);
  snapshotOversizeRecheck = null;
  if (iconRetryRefresh) clearTimeout(iconRetryRefresh);
  iconRetryRefresh = null;
  iconRetryRefreshes = 0;
  lastLargeFrameLog.clear();
  lastFrameLimitLog.clear();
  lastSnapshotLog = null;
  lastIconBudgetWarning = '';

  if (staleEvictionInterval) {
    clearInterval(staleEvictionInterval);
    staleEvictionInterval = null;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  annexEventBus.setActive(false);

  // Controllers' shells end with their connections, which end here.
  for (const sessionId of [...shellOwners.keys()]) {
    shellOwners.delete(sessionId);
    ptyManager.killShell(sessionId);
  }

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
  boundHost = '';
  currentPin = '';
  sessionTokens.clear();
  revokedTokens.clear();
  detailedStatusCache.clear();
  lastChatStatusPush.clear();
  for (const agentId of quickAgentCleanupTimers.keys()) cancelQuickAgentCleanup(agentId);
  trackedQuickAgents.clear();
  agentLastActivity.clear();
  eventReplay.reset();
  permissionQueue.reset();
  mobileCommands.reset();
  mobileAttachments.reset();
  mobileSessionPeers.clear();
  // Starts already accepted may still be awaiting a driver; stop them on completion.
  for (const starting of mobileStartingAgents.values()) starting.cancelled = true;

  appLog('core:annex', 'info', 'Annex server stopped');
}

export function getStatus(): AnnexStatus & { pairingPort: number; tlsEnabled: boolean } {
  const settings = annexSettings.getSettings();
  const identity = annexIdentity.getPublicIdentity();
  const certFingerprint = tlsServer ? annexTls.getCertificateFingerprint() : undefined;
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
    ...(certFingerprint ? { tlsCertificateFingerprint: certFingerprint } : {}),
    ...pairingLink(identity?.fingerprint || '', certFingerprint, settings.alias || settings.deviceName),
  };
}

/**
 * The QR pairing link for Annex settings. Phones only pair over TLS, so it is
 * left out until the TLS server is listening; the PIN and ports are read
 * fresh, so each status broadcast carries the current link.
 */
function pairingLink(fingerprint: string, certFingerprint: string | undefined, name: string): Pick<AnnexStatus, 'pairingUrl' | 'pairingHosts'> {
  if (!tlsServer || !certFingerprint || !serverPort) return {};
  const hosts = pairingHosts(os.networkInterfaces(), boundHost);
  const url = buildPairingUrl({ hosts, port: serverPort, fingerprint, certFingerprint, pin: currentPin, name });
  return url ? { pairingUrl: url, pairingHosts: hosts } : {};
}

/**
 * Broadcast a fresh snapshot to all connected WS clients.
 * Call after durable agent config changes (create, delete, rename) so
 * controllers see the update without needing to reconnect.
 */
let refreshInFlight = false;
let refreshAgain = false;
let refreshWanted = false;
let refreshFollowUp: ReturnType<typeof setTimeout> | null = null;
/** Bumped by stop(), so a build still running then can't start another afterwards. */
let refreshGeneration = 0;

/** After a refresh that raced a change, the next waits this long, so a storm of changes can't mean building nonstop. */
const RACED_REFRESH_DELAY_MS = 250;

/** Frames that never change a snapshot's fields. They can come many times a build, so they can't count as a race. */
const OUTPUT_EVENT_TYPES = new Set(['pty:data', 'chat:event', 'frame:omitted']);

/** Did anything a snapshot shows change since this seq? If the buffer can't say, assume so. */
function snapshotStateChangedSince(seq: number): boolean {
  const events = eventReplay.getEventsSince(seq);
  return events === null || events.some((event) => !OUTPUT_EVENT_TYPES.has(event.type));
}

/**
 * A new snapshot for every socket. One build at a time: changes during it get one
 * more, so a burst costs two builds and an older build can't arrive after a newer
 * one.
 *
 * A phone trusts a snapshot's state up to its `lastSeq`, and replay won't repair
 * what it has already seen. So if something it shows changed during the reads, the
 * snapshot says the seq from before them. A phone that has seen that change drops
 * it as a duplicate, and a follow-up carries everything. With only output in
 * between, nothing is stale, and an older cursor would have every refresh dropped
 * while an agent streams. A refresh changes no state, so it can't cause another
 * on its own: a follow-up needs a real change during the build.
 */
export function broadcastSnapshotRefresh(): void {
  if (snapshotBlock && Date.now() < snapshotBlock.until) {
    // A failure's retry covers any change. A snapshot too large might fit now, so look, but not often.
    if (snapshotBlock.kind === 'failed') return;
    const wait = snapshotBlock.startedAt + SNAPSHOT_OVERSIZE_RECHECK_MS - Date.now();
    if (wait > 0) {
      snapshotOversizeRecheck ??= setTimeout(() => {
        snapshotOversizeRecheck = null;
        broadcastSnapshotRefresh();
      }, wait);
      snapshotOversizeRecheck.unref?.();
      return;
    }
  }
  refreshWanted = true;
  if (refreshInFlight) {
    refreshAgain = true;
    return;
  }
  startSnapshotBuild();
}

/**
 * The host's one snapshot build: reads never run side by side, however many sockets
 * connect, so what a host does is bounded by itself and not by its phones. It serves
 * every socket waiting on a first snapshot, joined at any point, each with its own
 * cursor, and connected phones too if a refresh asked. A socket that joined partway
 * may have missed a change made before it connected and after these reads, as an
 * event it won't be sent. That counts as a race, and the follow-up covers it.
 */
function startSnapshotBuild(): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const broadcast = refreshWanted;
  refreshWanted = false;
  const cursor = eventReplay.getLastSeq();
  const generation = refreshGeneration;
  let raced = false;
  readSnapshotSources().then((sources) => {
    if (generation !== refreshGeneration) return;
    const built = assembleSnapshot(sources);
    raced = snapshotStateChangedSince(cursor);
    if (raced) built.payload.lastSeq = cursor;
    // Built once and encoded per form, so a phone that fetches images never gets one here.
    let oversize = false;
    if (broadcast) {
      const forms = new Set<SnapshotForm>();
      for (const client of wss?.clients ?? []) forms.add(snapshotFormOf(client));
      for (const form of forms) {
        const frame = snapshotFrame(built, 'refresh', form);
        // Never send a phone a frame it would close on. It keeps what it has, and the next change tries again.
        if (Buffer.byteLength(frame) > MOBILE_WS_FRAME_MAX_BYTES) oversize = true;
        else if (broadcastFrame('snapshot', frame, form) > 0) recordSnapshotFailure('send_failed');
      }
    }
    for (const ws of [...firstSnapshotWaiters]) {
      const held = heldFrames.get(ws);
      if (!held || ws.readyState !== WebSocket.OPEN) continue;
      try {
        if (!deliverFirstSnapshot(ws, held, built, 'connect')) oversize = true;
      } catch (err) {
        recordSnapshotFailure('send_failed');
        appLog('core:annex', 'error', 'Failed to send snapshot on connect', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    if (oversize) {
      setSnapshotBlock('oversize');
      for (const ws of firstSnapshotWaiters) firstSnapshotFailed(ws);
    } else {
      clearSnapshotBlock();
    }
  }).catch((err) => {
    if (generation !== refreshGeneration) return;
    const meta = { error: err instanceof Error ? err.message : String(err) };
    if (broadcast) appLog('core:annex', 'error', 'broadcastSnapshotRefresh failed', { meta });
    if (firstSnapshotWaiters.size > 0) appLog('core:annex', 'error', 'Failed to send snapshot on connect', { meta });
    setSnapshotBlock('failed');
    for (const ws of firstSnapshotWaiters) firstSnapshotFailed(ws);
  }).finally(() => {
    // The server stopped during the build: nothing left to tell, even if it has started again.
    if (generation !== refreshGeneration) return;
    refreshInFlight = false;
    if (refreshAgain) {
      refreshAgain = false;
      broadcastSnapshotRefresh();
    } else if (raced) {
      refreshFollowUp = setTimeout(broadcastSnapshotRefresh, RACED_REFRESH_DELAY_MS);
      refreshFollowUp.unref?.();
    }
  });
}

/**
 * Run a recovery audit for all projects — compares running agents (in the
 * agent registry) against disk configs. Logs discrepancies as warnings.
 *
 * Call after server start or after a batch of agents are woken to validate
 * that the in-memory state matches persistent storage.
 */
export async function runRecoveryAudit(): Promise<void> {
  const projects = await projectStore.list();
  const runningRegistrations = agentRegistry.getAllRegistrations();
  const runningIds = new Set(runningRegistrations.keys());

  appLog('core:annex', 'info', 'Running post-recovery audit', {
    meta: { projectCount: projects.length, runningAgentCount: runningIds.size },
  });

  for (const proj of projects) {
    await agentConfig.auditRecovery(proj.path, runningIds);
  }
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

/** Broadcast app-level (global scope) canvas state to all connected controller clients. */
export function broadcastAppCanvasStateToClients(state: unknown): void {
  broadcastWs({ type: 'canvas:state', payload: { projectId: null, state, scope: 'global' } });
}

/** Broadcast session pause/resume to all connected WS clients. */
export function notifySessionPause(paused: boolean): void {
  sessionPaused = paused;
  if (!paused) sessionPauseOwner = null;
  broadcastWs({ type: paused ? 'session:paused' : 'session:resumed', payload: { paused } });
}

export function regeneratePin(): void {
  currentPin = generatePin();
  sessionTokens.clear();
  revokedTokens.clear();
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

/** Disconnect a specific peer's WebSocket connection by fingerprint and revoke their tokens. */
export function disconnectPeer(fingerprint: string): void {
  mobileSessionPeers.delete(fingerprint);
  const peerTokens = new Set<string>();
  appLog('core:annex', 'info', `disconnectPeer called`, { meta: { fingerprint } });
  for (const [token, session] of sessionTokens) {
    if (session.peerFingerprint === fingerprint) { peerTokens.add(token); revokedTokens.add(token); sessionTokens.delete(token); }
  }
  if (!wss) return;
  for (const client of wss.clients) {
    if (wsPeerFingerprints.get(client) === fingerprint || peerTokens.has(wsBearerTokens.get(client) ?? '')) {
      // Revoke the bearer token used by this connection
      const token = wsBearerTokens.get(client);
      if (token) {
        revokedTokens.add(token);
        sessionTokens.delete(token);
      }
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
  mobileEpoch: () => mobileCommands.epoch,
  PROJECTS_CHANGED_DEBOUNCE_MS,
  HELD_FRAMES_MAX,
  wsIconRefs,
  SNAPSHOT_RETRY_DELAYS_MS,
  SNAPSHOT_BUILD_TIMEOUT_MS,
  SNAPSHOT_OVERSIZE_RETRY_MS,
  SNAPSHOT_OVERSIZE_RECHECK_MS,
  ICON_RETRY_REFRESH_MAX,
  ICON_RETRY_REFRESH_DELAY_MS,
  heldBytes: (ws: WebSocket) => heldFrames.get(ws)?.bytes,
  holdForTest(ws: WebSocket, data: string) {
    const held = heldFrames.get(ws);
    if (held) holdFrame(held, data);
  },
  safeSendForTest: (ws: WebSocket, data: string) => safeSend(ws, data),
  broadcastForTest: (message: object) => broadcastWs(message),
  resetFrameLogs: () => lastFrameLimitLog.clear(),
  runMobileCommand,
  get sessionTokens() { return sessionTokens; },
  isValidToken,
  readBody,
  TOKEN_TTL_MS,
  SERVER_HEARTBEAT_INTERVAL_MS,
  wsAlive,
  wsAuthTypes,
  wsPeerFingerprints,
  wsBearerTokens,
  shellOwners,
  get wss() { return wss; },
  get heartbeatInterval() { return heartbeatInterval; },
  get trackedQuickAgents() { return trackedQuickAgents; },
  quickAgentCleanupTimers,
  releaseMtlsLockIfLastClient,
  get sessionPauseOwner() { return sessionPauseOwner; },
  setSessionPauseOwner(fp: string | null) { sessionPauseOwner = fp; },
  resetSessionPauseOwner() { sessionPauseOwner = null; sessionPaused = false; },
  detailedStatusCache,
  getDetailedStatus,
  pushChatStatus,
  lastChatStatusPush,
  buildSnapshot: async () => assembleSnapshot(await readSnapshotSources()).payload,
  agentLastActivity,
  noteAgentActivity,
};
