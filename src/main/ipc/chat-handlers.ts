/**
 * IPC for the chat runtime. Every action resolves the agent's runtime through
 * the registry, so a request for an agent that isn't running in chat fails
 * cleanly instead of reaching a PTY.
 */
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ChatAgentRuntimeInfo, ChatDriverId, ChatQuestionAnswers, ChatRuntimeSettings, ContentBlock, MessageDelivery, PermissionLevel, PermissionResponseExtras } from '../../shared/chat';
import { PERMISSION_LEVELS } from '../../shared/chat';
import { getAgentRuntime, isChatAgent, readChatTranscript, onChatEvent, resolveChatDriver } from '../services/agent-runtime';
import { createStatusBridge } from '../services/agent-runtime/chat-status-bridge';
import { handleChatEventForCheckpoints, listTurns, getChanges, revertTurn, type ChangesScope } from '../services/agent-runtime/checkpoint-tracker';
import * as chatRuntimeSettings from '../services/chat-runtime-settings';
import * as annexEventBus from '../services/annex-event-bus';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, numberArg, objectArg, booleanArg } from './validation';

function requireChatRuntime(agentId: string) {
  const runtime = getAgentRuntime(agentId);
  if (!runtime || runtime.kind !== 'chat') throw new Error(`Agent ${agentId} is not running in chat`);
  return runtime;
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
    [stringArg(), numberArg({ integer: true, min: 1, optional: true })],
    async (_event, agentId, tail) => readChatTranscript(agentId, tail ? { tail } : {}),
  ));

  ipcMain.handle(IPC.CHAT.SEND_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg({ minLength: 1 }), stringArg({ optional: true })],
    async (_event, agentId, text, delivery) => {
      const requested = delivery && DELIVERIES.has(delivery) ? (delivery as 'auto' | MessageDelivery) : 'auto';
      const content: ContentBlock[] = [{ type: 'text', text }];
      return requireChatRuntime(agentId).sendMessage(content, { source: 'user', delivery: requested });
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
    [stringArg(), stringArg(), stringArg({ optional: true })],
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
    async (_event, agentId, turnId, force) => revertTurn(agentId, turnId, force === true),
  ));

}
