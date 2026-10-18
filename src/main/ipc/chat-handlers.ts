/**
 * IPC for the chat runtime. Every action resolves the agent's runtime through
 * the registry, so a request for an agent that isn't running in chat fails
 * cleanly instead of reaching a PTY.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ChatAgentRuntimeInfo, ChatDriverId, ChatQuestionAnswers, ChatRuntimeSettings, ContentBlock, MessageDelivery, PermissionLevel, PermissionResponseExtras } from '../../shared/chat';
import { CHAT_ATTACHMENTS_MAX, CHAT_IMAGE_MAX_BYTES, PERMISSION_LEVELS } from '../../shared/chat';
import { getAgentRuntime, isChatAgent, readChatTranscript, listChatSessions, onChatEvent, resolveChatDriver } from '../services/agent-runtime';
import { createStatusBridge } from '../services/agent-runtime/chat-status-bridge';
import { handleChatEventForCheckpoints, listTurns, getChanges, revertTurn, undoRevert, isRevertRunning, type ChangesScope } from '../services/agent-runtime/checkpoint-tracker';
import * as chatRuntimeSettings from '../services/chat-runtime-settings';
import * as annexEventBus from '../services/annex-event-bus';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, numberArg, objectArg, arrayArg, booleanArg, type ArgValidator } from './validation';
import { resolveAttachments, stageAttachmentData, stageAttachmentPath } from '../services/agent-runtime/chat-attachments';

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
function assertTopFrameOfAppWindow(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Attachments can only be added from a Clubhouse window');
  }
}

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

const DELIVERIES: ReadonlySet<string> = new Set(['auto', 'prompt', 'steer', 'queued']);
const DRIVER_IDS: ReadonlySet<ChatDriverId> = new Set<ChatDriverId>([
  'claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_acp', 'copilot_sdk', 'acp',
]);

let unsubscribe: (() => void) | null = null;

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

  ipcMain.handle(IPC.CHAT.INTERRUPT, withValidatedArgs(
    [stringArg()],
    async (_event, agentId) => requireChatRuntime(agentId).interrupt(),
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
  // Chat / Terminal switch only when the provider has a chat driver.
  ipcMain.handle(IPC.CHAT.GET_AGENT_RUNTIME, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, agentId, provider): Promise<ChatAgentRuntimeInfo> => ({
      chat: isChatAgent(agentId),
      chatAvailable: !!resolveChatDriver(provider || 'claude-code'),
    }),
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
