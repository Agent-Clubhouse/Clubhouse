/**
 * What the renderer needs to pick an agent's view: whether chat runs it now,
 * and which runtime it will use while it is still starting (#2206). A wake
 * resolves the provider, runs the preflight and reads config before the chat
 * start registers, so "is a chat runtime running" alone is false for the
 * first second or two of every chat wake and the pane flashes the terminal.
 */

import type { ChatAgentRuntimeInfo } from '../../../shared/chat';
import * as ptyManager from '../pty-manager';
import { getDurableConfig } from '../agent-config';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import { appLog } from '../log-service';
import { hasChatStartInFlight } from './chat-spawn';
import { resolveChatDriver } from './chat-drivers';
import { isChatAgent } from './index';

export interface AgentRuntimeQuery {
  /** The agent's project, so its durable config (runtime override) can be read. */
  projectPath?: string;
  /** The renderer shows the agent as starting (creating, spawning or waking). */
  starting?: boolean;
}

const DEFAULT_PROVIDER = 'claude-code';

export async function getAgentRuntimeInfo(agentId: string, provider: string | undefined, query: AgentRuntimeQuery = {}): Promise<ChatAgentRuntimeInfo> {
  const chatAvailable = !!resolveChatDriver(provider || DEFAULT_PROVIDER);
  const live = isChatAgent(agentId);
  if (live || hasChatStartInFlight(agentId)) return { chat: true, live, chatAvailable };
  // A running terminal answers it, including a chat start that fell back.
  if (!query.starting || !query.projectPath || ptyManager.isRunning(agentId)) return { chat: false, live, chatAvailable };
  return { chat: await willStartInChat(agentId, provider, query.projectPath), live, chatAvailable };
}

/** Same decision tryStartChatAgent makes before it registers a start. */
async function willStartInChat(agentId: string, provider: string | undefined, projectPath: string): Promise<boolean> {
  try {
    const config = await getDurableConfig(projectPath, agentId);
    if (!config) return false;
    const providerId = config.orchestrator || provider || DEFAULT_PROVIDER;
    const resolved = resolveRuntimeMode(providerId, config.runtimeMode);
    return resolved.mode === 'chat' && !!resolveChatDriver(providerId, resolved.driver);
  } catch (err) {
    // telemetry-exempt: a read-only view hint; the spawn reads the same config and reports its own failure.
    appLog('core:chat', 'warn', 'Could not read the agent config to pick its runtime', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}
