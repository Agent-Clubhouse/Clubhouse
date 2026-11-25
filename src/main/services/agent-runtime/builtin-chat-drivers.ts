/**
 * Registers the chat drivers that ship with Clubhouse. Registering a driver
 * only makes chat available: an agent still runs in the terminal unless the
 * experimental Chat flag is on and its provider (or the agent) is set to Chat
 * (chat-spawn.ts).
 */

import { registerClaudeChatDrivers } from '../../chat/claude';
import { registerCopilotSdkChatDriver } from '../../chat/copilot/driver';
import { CodexChatDriver } from '../../orchestrators/adapters/codex-chat-driver';
import { app } from 'electron';
import { antigravityAcpDriver } from '../../chat/antigravity';
import { getLogDir } from '../../telemetry/local-control';
import { appLog } from '../log-service';
import { registerChatDriver } from './chat-drivers';

export interface BuiltinChatDriverOptions {
  /**
   * Register the Antigravity ACP driver. Pass the same value the Antigravity
   * provider was registered with (its experimental flag), so the driver never
   * exists without its provider.
   */
  antigravity?: boolean;
  /** Clubhouse's own log folder, for the driver's per-launch `--log-file`. Default: the local log folder. */
  logDir?: string;
  /** The app version, sent as the ACP client version. Default: the running app's. */
  clientVersion?: string;
}

/** Call once at startup, next to registerBuiltinProviders(). Returns an unregister for tests. */
export function registerBuiltinChatDrivers(options: BuiltinChatDriverOptions = {}): () => void {
  const unregister = [
    // Claude: Agent SDK first (the default for claude-code), then raw stream-json.
    registerClaudeChatDrivers(registerChatDriver, {
      log: (level, message, meta) => appLog('core:chat', level, message, { meta }),
    }),
    // Codex: app-server v2.
    registerChatDriver(new CodexChatDriver({
      onLog: (level, message, meta) => appLog('core:chat:codex', level, message, meta && { meta }),
    })),
    // Copilot: the SDK driver.
    registerCopilotSdkChatDriver(registerChatDriver, (level, message, meta) => appLog('core:chat:copilot', level, message, meta && { meta })),
    // Antigravity: agy acp, only alongside its experimental provider (#3797).
    ...(options.antigravity ? [registerChatDriver(antigravityAcpDriver({
      logDir: options.logDir ?? getLogDir(),
      clientVersion: options.clientVersion ?? app.getVersion(),
      log: (level, message, meta) => appLog('core:chat:antigravity', level, message, meta && { meta }),
    }))] : []),
  ];
  return () => unregister.forEach((u) => u());
}
