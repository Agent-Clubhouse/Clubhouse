/**
 * Registers the chat drivers that ship with Clubhouse. Registering a driver
 * only makes chat available: an agent still runs in the terminal unless the
 * experimental Chat flag is on and its provider (or the agent) is set to Chat
 * (chat-spawn.ts).
 */

import { registerClaudeChatDrivers } from '../../chat/claude';
import { CodexChatDriver } from '../../orchestrators/adapters/codex-chat-driver';
import { registerCopilotChatDrivers } from '../../orchestrators/adapters/acp-chat-driver';
import { createCopilotSdkChatDriver } from '../../chat/copilot/sdk-driver';
import { appLog } from '../log-service';
import { registerChatDriver } from './chat-drivers';

/** Call once at startup, next to registerBuiltinProviders(). Returns an unregister for tests. */
export function registerBuiltinChatDrivers(): () => void {
  const copilotLog = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) =>
    appLog('core:chat:copilot', level, message, meta && { meta });
  const unregister = [
    // Claude: Agent SDK first (the default for claude-code), then raw stream-json.
    registerClaudeChatDrivers(registerChatDriver, {
      log: (level, message, meta) => appLog('core:chat', level, message, { meta }),
    }),
    // Codex: app-server v2.
    registerChatDriver(new CodexChatDriver({
      onLog: (level, message, meta) => appLog('core:chat:codex', level, message, meta && { meta }),
    })),
    // Copilot: ACP (copilot_acp); the Copilot SDK driver will register after it.
    registerCopilotChatDrivers(registerChatDriver, copilotLog),
    // Copilot SDK: selectable with driver 'copilot_sdk'; falls back to ACP when it can't run.
    registerChatDriver(createCopilotSdkChatDriver(copilotLog)),
  ];
  return () => unregister.forEach((u) => u());
}
