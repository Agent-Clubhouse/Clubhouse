/**
 * Registers the chat drivers that ship with Clubhouse. Registering a driver
 * only makes chat available: an agent still runs in the terminal unless the
 * experimental Chat flag is on and its provider (or the agent) is set to Chat
 * (chat-spawn.ts).
 */

import { registerClaudeChatDrivers } from '../../chat/claude';
import { appLog } from '../log-service';
import { registerChatDriver } from './chat-drivers';

/** Call once at startup, next to registerBuiltinProviders(). Returns an unregister for tests. */
export function registerBuiltinChatDrivers(): () => void {
  // Claude: Agent SDK first (the default for claude-code), then raw stream-json.
  return registerClaudeChatDrivers(registerChatDriver, {
    log: (level, message, meta) => appLog('core:chat', level, message, { meta }),
  });
}
