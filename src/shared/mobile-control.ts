/** Additive mobile control contract. Annex's existing protocol remains v2. */
import type { ChatQuestionAnswers } from './chat';
export const MOBILE_PROTOCOL_VERSION = 1;
export const MOBILE_COMMAND_TYPES = ['chat.send', 'chat.interrupt', 'chat.permission', 'chat.question', 'chat.queue.remove', 'agent.start', 'agent.stop', 'agent.spawn'] as const;
interface CommandBase { version: 1; commandId: string; epoch: string }
interface ChatTarget { agentId: string; sessionId: string }
export type MobileCommand = CommandBase & (
  | (ChatTarget & { type: 'chat.send'; text: string; delivery?: 'auto' | 'prompt' | 'steer' | 'queued' })
  | (ChatTarget & { type: 'chat.interrupt' })
  | (ChatTarget & { type: 'chat.queue.remove'; messageIds: string[] })
  | (ChatTarget & { type: 'chat.permission'; requestId: string; optionId: string })
  | (ChatTarget & { type: 'chat.question'; requestId: string; answers: ChatQuestionAnswers })
  | { type: 'agent.start'; agentId: string; message?: string; resume?: boolean }
  | { type: 'agent.stop'; agentId: string }
  | { type: 'agent.spawn'; projectId: string; prompt: string; model?: string; orchestrator?: string }
);
export interface MobileReceipt {
  version: 1;
  commandId?: string;
  epoch: string;
  status: 'completed' | 'rejected' | 'failed';
  result?: unknown;
  error?: { code: string; message: string };
}
export interface MobileResponse { statusCode: number; body: MobileReceipt }
