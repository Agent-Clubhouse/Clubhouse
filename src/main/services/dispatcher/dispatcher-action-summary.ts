import { describeSteps, describeTrigger, type ActionNames, type ActionView } from '../../../shared/actions';
import type { ChatEventDataMap } from '../../../shared/chat';
import { getAgentRuntime } from '../agent-runtime';
import { noteNextStartNotice } from '../agent-runtime/stale-session';
import { appLog } from '../log-service';
import { getDispatcherChatAgentId } from './dispatcher-service';

/** Coordinator tool results do not reach the conversation agent. Write a UI-only receipt there. */
export async function showDispatcherActionSummary(action: ActionView, names: ActionNames): Promise<void> {
  const chatId = getDispatcherChatAgentId();
  if (!chatId) {
    appLog('core:dispatcher', 'warn', 'Could not show an Action summary because the conversation is not set up');
    return;
  }
  const trigger = describeTrigger(action.trigger, names);
  const steps = describeSteps(action.steps, names);
  const notice: ChatEventDataMap['notice'] = {
    level: 'info',
    code: 'action_changed',
    message: `${action.name}. ${trigger}. ${steps}. ${action.enabled ? 'On' : 'Off'}.`,
    actionSummary: { id: action.id, name: action.name, trigger, steps, enabled: action.enabled },
  };
  const runtime = getAgentRuntime(chatId);
  if (runtime?.isRunning() && runtime.addNotice) await runtime.addNotice(notice);
  else noteNextStartNotice(chatId, notice);
}
