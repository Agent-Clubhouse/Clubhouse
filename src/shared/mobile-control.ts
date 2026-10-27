/** Additive mobile control contract. Annex's existing protocol remains v2. */
import type { ChatQuestionAnswers } from './chat';
import type { AgentIdleSleep } from './idle-sleep';
export const MOBILE_PROTOCOL_VERSION = 1;
export const MOBILE_COMMAND_TYPES = ['chat.send', 'chat.interrupt', 'chat.permission', 'chat.question', 'chat.queue.remove', 'agent.start', 'agent.stop', 'agent.spawn', 'agent.create', 'agent.update'] as const;
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
  | ({ type: 'agent.create' } & MobileAgentCreate)
  | ({ type: 'agent.update' } & MobileAgentUpdate)
);
/** A durable agent, as the New agent page makes one. Free Agent Mode is never accepted from a phone. */
export interface MobileAgentCreate {
  projectId: string; name: string; color: string; orchestrator?: string; model?: string; persona?: string;
  useWorktree?: boolean; mcpIds?: string[]; branchName?: string; branchFrom?: string; folderName?: string;
}
/** Settings a phone may change; null clears. Free Agent Mode is never accepted from a phone. */
export interface MobileAgentUpdate {
  agentId: string; name?: string; color?: string; emoji?: string | null; orchestrator?: string; model?: string;
  runtime?: 'default' | 'chat' | 'terminal'; persona?: string | null; clubhouseMode?: boolean; idleSleep?: AgentIdleSleep;
}
/** What the desktop windows patch into their agent list after a phone's agent.update. */
export interface AnnexAgentUpdate {
  agentId: string; name: string; color: string; emoji: string | null; model: string | null; orchestrator: string | null;
}
/** When a setting can change: at any time, only while the agent sleeps, or not from a phone. */
export type MobileSettingEditable = 'always' | 'sleeping' | 'never';
export interface MobileReceipt {
  version: 1;
  commandId?: string;
  epoch: string;
  status: 'completed' | 'rejected' | 'failed';
  result?: unknown;
  error?: { code: string; message: string };
}
export interface MobileResponse { statusCode: number; body: MobileReceipt }
