/**
 * IPC for the chat runtime. Every action resolves the agent's runtime through
 * the registry, so a request for an agent that isn't running in chat fails
 * cleanly instead of reaching a PTY.
 */
import * as fsp from 'fs/promises';
import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeImage, net, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ChatAgentRuntimeInfo, ChatDriverId, ChatQuestionAnswers, ChatRuntimeSettings, ContentBlock, MessageDelivery, PermissionLevel, PermissionResponseExtras } from '../../shared/chat';
import { CHAT_ATTACHMENTS_MAX, CHAT_IMAGE_MAX_BYTES, PERMISSION_LEVELS, RICH_CHAT_CONTENT_FLAG, isMediaRef } from '../../shared/chat';
import { getAgentRuntime, readChatTranscript, listChatSessions, onChatEvent } from '../services/agent-runtime';
import { getAgentRuntimeInfo, type AgentRuntimeQuery } from '../services/agent-runtime/runtime-info';
import { createStatusBridge } from '../services/agent-runtime/chat-status-bridge';
import { handleChatEventForCheckpoints, listTurns, getChanges, revertTurn, undoRevert, isRevertRunning, type ChangesScope } from '../services/agent-runtime/checkpoint-tracker';
import * as chatRuntimeSettings from '../services/chat-runtime-settings';
import * as annexEventBus from '../services/annex-event-bus';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, numberArg, objectArg, arrayArg, booleanArg, type ArgValidator } from './validation';
import { resolveAttachments, stageAttachmentData, stageAttachmentPath } from '../services/agent-runtime/chat-attachments';
import { fetchRemoteImage, mediaFilePath, readMedia } from '../services/agent-runtime/chat-media';
import { importChatImage, MAX_STAT_PATHS, readChatFilePreview, resolveChatFile, statChatPaths } from '../services/agent-runtime/chat-files';
import { getSettings as getExperimentalSettings } from '../services/experimental-settings';
import type { Project } from '../../shared/types';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';

/** An effort: a level, omitted to keep the current one, or null for the provider's default. */
const effortArg: ArgValidator<string | null | undefined> = (value, argName) => (value === null ? null : stringArg({ optional: true })(value, argName));

function requireChatRuntime(agentId: string) {
  const runtime = getAgentRuntime(agentId);
  if (!runtime || runtime.kind !== 'chat') throw new Error(`Agent ${agentId} is not running in chat`);
  return runtime;
}

/**
 * Staging must come from a Clubhouse window's own page (the main window or a
 * popout), not an iframe, webview or detached WebContents.
 */
function assertTopFrameOfAppWindow(event: IpcMainInvokeEvent, message = 'Attachments can only be added from a Clubhouse window'): void {
  if (!BrowserWindow.fromWebContents(event.sender) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error(message);
  }
}

/** Rich chat content channels: only with the flag on, and only from a Clubhouse window's own page. */
function assertRichMedia(event: IpcMainInvokeEvent): void {
  if (getExperimentalSettings()[RICH_CHAT_CONTENT_FLAG] !== true) throw new Error('Rich chat content is off');
  assertTopFrameOfAppWindow(event, 'Chat images can only be opened from a Clubhouse window');
}

/**
 * A fetch for click-to-load images over Electron's net (system proxy, no
 * cookies), with redirects handed back as 3xx responses so fetchRemoteImage
 * checks every hop before following it.
 */
function electronImageFetch(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    request.setHeader('Accept', 'image/*');
    const signal = init.signal;
    const onAbort = () => { request.abort(); reject(new Error('The image took too long to load')); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('redirect', (statusCode, _method, redirectUrl) => {
      request.abort();
      signal?.removeEventListener('abort', onAbort);
      resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } }));
    });
    request.on('response', (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          response.on('end', () => { signal?.removeEventListener('abort', onAbort); controller.close(); });
          response.on('error', (err: Error) => controller.error(err));
          response.on('aborted', () => controller.error(new Error('The image could not be loaded')));
        },
        cancel() { request.abort(); },
      });
      const status = response.statusCode >= 200 && response.statusCode <= 599 ? response.statusCode : 502;
      resolve(new Response(status === 204 || status === 304 ? null : body, { status, headers }));
    });
    request.on('error', (err) => { signal?.removeEventListener('abort', onAbort); reject(err); });
    request.end();
  });
}

const mediaRefArg: ArgValidator<string> = (value, argName) => {
  if (!isMediaRef(value)) throw new Error(`${argName} must be a media reference`);
  return value;
};

interface StageInput { path?: unknown; data?: unknown; name?: unknown; imagesAllowed?: unknown }

/** Bounds checked before anything is read or written. */
function validateStageInput(input: StageInput, argName: string): void {
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length > 4096)) throw new Error(`${argName}.path must be a path`);
  if (input.data !== undefined) {
    if (!(input.data instanceof Uint8Array)) throw new Error(`${argName}.data must be bytes`);
    if (input.data.byteLength > CHAT_IMAGE_MAX_BYTES) throw new Error('Images must be 3.75 MB or smaller');
  }
  if (input.imagesAllowed !== undefined && typeof input.imagesAllowed !== 'boolean') throw new Error(`${argName}.imagesAllowed must be a boolean`);
}

function validateRuntimeQuery(query: AgentRuntimeQuery, argName: string): void {
  const { projectPath, starting } = query as { projectPath?: unknown; starting?: unknown };
  if (projectPath !== undefined && (typeof projectPath !== 'string' || projectPath.length === 0 || projectPath.length > 4096)) {
    throw new Error(`${argName}.projectPath must be a path`);
  }
  if (starting !== undefined && typeof starting !== 'boolean') throw new Error(`${argName}.starting must be a boolean`);
}

const DELIVERIES: ReadonlySet<string> = new Set(['auto', 'prompt', 'steer', 'queued']);
const DRIVER_IDS: ReadonlySet<ChatDriverId> = new Set<ChatDriverId>([
  'claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_acp', 'copilot_sdk', 'acp',
]);

let unsubscribe: (() => void) | null = null;

/** The rich chat content channels: each is gated by the flag (assertRichMedia). */
export const RICH_CHAT_CHANNELS = [
  IPC.CHAT.READ_MEDIA, IPC.CHAT.MEDIA_ACTION, IPC.CHAT.FETCH_REMOTE_IMAGE, IPC.CHAT.STAT_PATHS,
  IPC.CHAT.READ_FILE_PREVIEW, IPC.CHAT.IMPORT_LOCAL_IMAGE, IPC.CHAT.FILE_ACTION,
] as const;

/**
 * Test seam, unpackaged builds only: calls per rich channel, counted before
 * validation or the flag check, so the flag-off E2E (#2491) can show the
 * renderer never asked. Read with `electronApp.evaluate`.
 */
export const RICH_CHAT_CALLS_GLOBAL = '__clubhouseRichChatCalls';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function richHandlerRegistrar(): (channel: typeof RICH_CHAT_CHANNELS[number], handler: InvokeHandler) => void {
  if (app.isPackaged) return (channel, handler) => ipcMain.handle(channel, handler);
  const calls = Object.fromEntries(RICH_CHAT_CHANNELS.map((c) => [c, 0])) as Record<string, number>;
  (globalThis as Record<string, unknown>)[RICH_CHAT_CALLS_GLOBAL] = calls;
  return (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    calls[channel]++;
    return handler(event, ...args);
  });
}

/** The Dispatcher's folder as a pseudo project, while it is on, so its files open from chat. */
async function dispatcherProjects(): Promise<Project[]> {
  const dispatcher = await import('../services/dispatcher/dispatcher-service');
  const state = dispatcher.getDispatcherState();
  if (!state.enabled || !state.path) return [];
  return [{ id: DISPATCHER_PROJECT_ID, name: 'Dispatcher', path: state.path }];
}

export function registerChatHandlers(): void {
  // Fan stamped chat events out to renderer windows and derive hook-shaped
  // status for the agent list, notifications and Annex.
  unsubscribe?.();
  const statusBridge = createStatusBridge((agentId, hookEvent) => {
    broadcastToAllWindows(IPC.AGENT.HOOK_EVENT, agentId, hookEvent);
    annexEventBus.emitHookEvent(agentId, hookEvent);
  });
  unsubscribe = onChatEvent((event) => {
    broadcastToAllWindows(IPC.CHAT.EVENT, event);
    statusBridge(event);
    handleChatEventForCheckpoints(event);
  });
  const handleRich = richHandlerRegistrar();

  ipcMain.handle(IPC.CHAT.READ_TRANSCRIPT, withValidatedArgs(
    [stringArg(), numberArg({ integer: true, min: 1, optional: true }), stringArg({ optional: true })],
    async (_event, agentId, tail, sessionId) => readChatTranscript(agentId, { tail, sessionId }),
  ));
  ipcMain.handle(IPC.CHAT.LIST_SESSIONS, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => listChatSessions(agentId),
  ));

  ipcMain.handle(IPC.CHAT.SEND_MESSAGE, withValidatedArgs(
    // Text may be empty when attachments carry the message.
    [stringArg(), stringArg({ minLength: 0 }), stringArg({ optional: true }), arrayArg(stringArg({ minLength: 1, maxLength: 64 }), { optional: true, maxLength: CHAT_ATTACHMENTS_MAX })],
    async (_event, agentId, text, delivery, attachmentIds) => {
      const requested = delivery && DELIVERIES.has(delivery) ? (delivery as 'auto' | MessageDelivery) : 'auto';
      const runtime = requireChatRuntime(agentId);
      // The agent would start editing files the revert is restoring.
      if (await isRevertRunning(agentId)) throw new Error('Wait for the revert to finish before sending');
      // Clearing intentionally stops the current turn and discards its queue.
      // /compact stays in sendMessage for driver guards, queue/steer and logging.
      if (!attachmentIds?.length && text.trim() === '/clear') {
        await runtime.clearContext();
        return { delivery: 'prompt' as const };
      }
      // Only ids staged through STAGE_ATTACHMENT: the renderer can't name a path here.
      const attached = attachmentIds?.length ? await resolveAttachments(agentId, attachmentIds, runtime.getCapabilities?.()) : [];
      const content: ContentBlock[] = [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...attached];
      if (!content.length) throw new Error('Nothing to send');
      return runtime.sendMessage(content, { source: 'user', delivery: requested });
    },
  ));

  // Trust model: page code has no raw ipcRenderer (contextIsolation, and the
  // preload exposes no generic invoke), so this channel is reached only
  // through the preload's stageAttachment(File). There the path comes from
  // webUtils.getPathForFile, which resolves only files the user dropped or
  // picked; page code can't stage an arbitrary path. Exposing a raw invoke
  // would break this.
  ipcMain.handle(IPC.CHAT.STAGE_ATTACHMENT, withValidatedArgs(
    [stringArg(), objectArg<StageInput>({ validate: validateStageInput })],
    async (event, agentId, input) => {
      assertTopFrameOfAppWindow(event);
      const name = typeof input.name === 'string' ? input.name.slice(0, 255) : undefined;
      if (typeof input.path === 'string') return stageAttachmentPath(agentId, input.path, name);
      if (input.data instanceof Uint8Array) {
        // Refuse before saving, so a paste the agent can't take leaves no file behind.
        if (input.imagesAllowed === false) throw new Error("This agent's chat can't take pasted images");
        return stageAttachmentData(agentId, input.data, name);
      }
      throw new Error('Attachment needs a file path or image data');
    },
  ));

  // Stored images are named by reference only; main maps it to the agent's media folder.
  handleRich(IPC.CHAT.READ_MEDIA, withValidatedArgs(
    [stringArg(), mediaRefArg],
    async (event, agentId, mediaRef) => {
      assertRichMedia(event);
      return readMedia(agentId, mediaRef);
    },
  ));

  handleRich(IPC.CHAT.MEDIA_ACTION, withValidatedArgs(
    [stringArg(), mediaRefArg, stringArg()],
    async (event, agentId, mediaRef, action) => {
      assertRichMedia(event);
      if (action === 'reveal') {
        shell.showItemInFolder(mediaFilePath(agentId, mediaRef));
        return;
      }
      if (action === 'copy') {
        const { data } = await readMedia(agentId, mediaRef);
        const image = nativeImage.createFromBuffer(Buffer.from(data));
        if (image.isEmpty()) throw new Error("This image can't be copied");
        await clipboard.write([new ClipboardItem({
          'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }),
        })]);
        return;
      }
      throw new Error(`Unknown media action: ${action}`);
    },
  ));

  handleRich(IPC.CHAT.FETCH_REMOTE_IMAGE, withValidatedArgs(
    [stringArg({ maxLength: 2048 })],
    async (event, url) => {
      assertRichMedia(event);
      return fetchRemoteImage(url, electronImageFetch);
    },
  ));

  // File chips: the renderer names paths it saw in the agent's text; main
  // answers for any regular file the user can read (#2478), or says why not.
  handleRich(IPC.CHAT.STAT_PATHS, withValidatedArgs(
    [stringArg(), arrayArg(stringArg({ maxLength: 1024 }), { maxLength: MAX_STAT_PATHS })],
    async (event, agentId, paths) => {
      assertRichMedia(event);
      return statChatPaths(agentId, paths);
    },
  ));

  handleRich(IPC.CHAT.READ_FILE_PREVIEW, withValidatedArgs(
    [stringArg(), stringArg({ maxLength: 1024 })],
    async (event, agentId, filePath) => {
      assertRichMedia(event);
      return readChatFilePreview(agentId, filePath);
    },
  ));

  // Local images in agent markdown (#2422): stored as media when they're images, so
  // the renderer shows them by reference and never loads the path itself.
  handleRich(IPC.CHAT.IMPORT_LOCAL_IMAGE, withValidatedArgs(
    [stringArg(), stringArg({ maxLength: 1024 })],
    async (event, agentId, src) => {
      assertRichMedia(event);
      return importChatImage(agentId, src);
    },
  ));

  handleRich(IPC.CHAT.FILE_ACTION, withValidatedArgs(
    [stringArg(), stringArg({ maxLength: 1024 }), stringArg()],
    async (event, agentId, filePath, action) => {
      assertRichMedia(event);
      const real = await resolveChatFile(agentId, filePath);
      if (action === 'reveal') { shell.showItemInFolder(real); return null; }
      // The renderer opens it the way a clubhouse:// link would.
      if (action === 'open') {
        const [{ resolveProtocolCommand }, projectStore] = await Promise.all([import('../protocol-handler'), import('../services/project-store')]);
        // Match against the projects' real paths too: `real` has symlinks resolved.
        // The Dispatcher's folder is in no project, so it opts in here (#2535).
        const projects = [...await projectStore.list(), ...await dispatcherProjects()];
        const realProjects = await Promise.all(projects.map(async (p) => ({ ...p, path: p.path ? await fsp.realpath(p.path).catch(() => p.path) : p.path })));
        const action = resolveProtocolCommand({ kind: 'open-file', filePath: real }, realProjects);
        return action.kind === 'open-file-not-found' ? resolveProtocolCommand({ kind: 'open-file', filePath: real }, projects) : action;
      }
      throw new Error(`Unknown file action: ${action}`);
    },
  ));

  ipcMain.handle(IPC.CHAT.INTERRUPT, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => requireChatRuntime(agentId).interrupt(),
  ));

  ipcMain.handle(IPC.CHAT.REMOVE_QUEUED, withValidatedArgs(
    [stringArg(), arrayArg(stringArg({ minLength: 1, maxLength: 128 }), { optional: true, maxLength: 1000 })],
    async (_event, agentId, messageIds): Promise<string[]> => {
      const runtime = requireChatRuntime(agentId);
      return runtime.removeQueued ? runtime.removeQueued(messageIds) : [];
    },
  ));

  ipcMain.handle(IPC.CHAT.RESPOND_PERMISSION, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), objectArg<PermissionResponseExtras>({ optional: true })],
    async (_event, agentId, requestId, optionId, extras) => requireChatRuntime(agentId).respondPermission(requestId, optionId, extras),
  ));

  ipcMain.handle(IPC.CHAT.ANSWER_QUESTION, withValidatedArgs(
    [stringArg(), stringArg(), objectArg<ChatQuestionAnswers>()],
    async (_event, agentId, requestId, answers) => requireChatRuntime(agentId).answerQuestion(requestId, answers),
  ));

  ipcMain.handle(IPC.CHAT.SET_LEVEL, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, agentId, level) => {
      if (!(PERMISSION_LEVELS as readonly string[]).includes(level)) throw new Error(`Unknown permission level: ${level}`);
      const runtime = requireChatRuntime(agentId);
      if (!runtime.setLevel) throw new Error('This agent cannot change permission level');
      await runtime.setLevel(level as PermissionLevel);
    },
  ));

  ipcMain.handle(IPC.CHAT.SET_MODEL, withValidatedArgs(
    [stringArg(), stringArg(), effortArg],
    async (_event, agentId, modelId, effort) => {
      const runtime = requireChatRuntime(agentId);
      if (!runtime.setModel) throw new Error('This agent cannot change model');
      await runtime.setModel(modelId, effort);
    },
  ));

  // Lets the agent pane pick ChatView or the terminal, and offer the
  // Chat / Terminal switch only when the provider has a chat driver. With the
  // project path and `starting`, a waking agent's answer is the runtime it is
  // starting into, so the pane doesn't flash the terminal first (#2206).
  ipcMain.handle(IPC.CHAT.GET_AGENT_RUNTIME, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), objectArg<AgentRuntimeQuery>({ optional: true, validate: validateRuntimeQuery })],
    async (_event, agentId, provider, query): Promise<ChatAgentRuntimeInfo> => getAgentRuntimeInfo(agentId, provider, query),
  ));

  ipcMain.handle(IPC.CHAT.GET_RUNTIME_SETTINGS, () => chatRuntimeSettings.getSettings());

  ipcMain.handle(IPC.CHAT.SAVE_RUNTIME_SETTINGS, withValidatedArgs(
    [objectArg<ChatRuntimeSettings>()],
    async (_event, settings) => {
      const clean: ChatRuntimeSettings = {};
      for (const [provider, value] of Object.entries(settings)) {
        if (!value || (value.mode !== 'chat' && value.mode !== 'terminal')) continue;
        const driver = value.driver && DRIVER_IDS.has(value.driver) ? value.driver : undefined;
        clean[provider] = { mode: value.mode, ...(driver ? { driver } : {}) };
      }
      await chatRuntimeSettings.saveSettings(clean);
    },
  ));

  // ── Checkpoints / Changes panel ──
  ipcMain.handle(IPC.CHAT.LIST_CHECKPOINTS, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => listTurns(agentId),
  ));

  ipcMain.handle(IPC.CHAT.GET_CHANGES, withValidatedArgs(
    [stringArg(), objectArg<ChangesScope>(), stringArg({ optional: true })],
    async (_event, agentId, scope, filePath) => {
      if (!scope || (typeof (scope as { turnId?: unknown }).turnId !== 'string' && typeof (scope as { sessionId?: unknown }).sessionId !== 'string')) {
        throw new Error('scope needs a turnId or a sessionId');
      }
      return getChanges(agentId, scope, filePath);
    },
  ));

  ipcMain.handle(IPC.CHAT.REVERT_TURN, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg({ optional: true })],
    // revertTurn refuses while this agent or another in its worktree is mid-turn.
    async (_event, agentId, turnId, force) => revertTurn(agentId, turnId, force === true),
  ));

  ipcMain.handle(IPC.CHAT.UNDO_REVERT, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, agentId, turnId) => undoRevert(agentId, turnId),
  ));

}
