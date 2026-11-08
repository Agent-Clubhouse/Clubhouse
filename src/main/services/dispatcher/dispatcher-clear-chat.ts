/**
 * Clear chat (#3043): the Dispatcher's conversation starts over. One long
 * conversation is the rule, compacted by the CLI as it grows; clearing is the
 * person's choice.
 *
 * Only the conversation goes. Memory, the Dispatcher's work, its agents,
 * connections and Actions, and news held for the next check-in all stay. A
 * running chat starts a new conversation at once, with its instructions and
 * memory index written fresh; a sleeping one starts fresh at its next wake.
 */
import * as agentConfig from '../agent-config';
import * as agentSystem from '../agent-system';
import { getAgentRuntime } from '../agent-runtime';
import { appLog } from '../log-service';
import { getDispatcherChatPath } from './dispatcher-paths';
import { getDispatcherChatAgentId, prepareDispatcherSessionStart } from './dispatcher-service';

export type ClearChatResult =
  /** The running chat started a new conversation. */
  | { cleared: 'now' }
  /** The chat was asleep: its next start is a new conversation. */
  | { cleared: 'next_start' };

export interface ClearChatDeps {
  chatAgentId?: () => string | null;
  isRunning?: (agentId: string) => boolean;
  clearContext?: (agentId: string) => Promise<void>;
  forgetSession?: (dir: string, agentId: string) => Promise<void>;
  prepareStart?: (dir: string, agentId: string) => Promise<void>;
}

async function clearRunning(agentId: string): Promise<void> {
  const runtime = getAgentRuntime(agentId);
  if (!runtime) throw new Error('The Dispatcher\'s conversation can\'t be cleared right now.');
  await runtime.clearContext();
}

export async function clearDispatcherChat(deps: ClearChatDeps = {}): Promise<ClearChatResult> {
  const chatId = (deps.chatAgentId ?? getDispatcherChatAgentId)();
  if (!chatId) throw new Error('The Dispatcher is not set up yet.');
  const dir = getDispatcherChatPath();
  if ((deps.isRunning ?? agentSystem.isAgentRunning)(chatId)) {
    // The new conversation reads its instructions and memory index as a fresh start does.
    await (deps.prepareStart ?? prepareDispatcherSessionStart)(dir, chatId);
    await (deps.clearContext ?? clearRunning)(chatId);
    appLog('core:dispatcher', 'info', 'Dispatcher chat cleared', { meta: { running: true } });
    return { cleared: 'now' };
  }
  await (deps.forgetSession ?? ((d, id) => agentConfig.updateSessionId(d, id, null)))(dir, chatId);
  appLog('core:dispatcher', 'info', 'Dispatcher chat cleared', { meta: { running: false } });
  return { cleared: 'next_start' };
}
