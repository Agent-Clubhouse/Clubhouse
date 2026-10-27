/** Additive mobile control contract. Annex's existing protocol remains v2. */
import type { ChatCapabilities, ChatModelOption, ChatQuestionAnswers, PermissionLevel } from './chat';
import type { AgentIdleSleep } from './idle-sleep';
export const MOBILE_PROTOCOL_VERSION = 1;
export const MOBILE_COMMAND_TYPES = ['chat.send', 'chat.interrupt', 'chat.permission', 'chat.question', 'chat.queue.remove', 'agent.start', 'agent.stop', 'agent.spawn', 'agent.create', 'agent.update', 'project.setPinned', 'project.setInactive', 'helper.approve', 'helper.decline', 'chat.setModel', 'chat.setLevel'] as const;
interface CommandBase { version: 1; commandId: string; epoch: string }
interface ChatTarget { agentId: string; sessionId: string }
export type MobileCommand = CommandBase & (
  // `text` may be empty when `attachmentIds` (from POST /mobile/agents/:id/attachments) carries images.
  | (ChatTarget & { type: 'chat.send'; text: string; delivery?: 'auto' | 'prompt' | 'steer' | 'queued'; attachmentIds?: string[] })
  | (ChatTarget & { type: 'chat.interrupt' })
  | (ChatTarget & { type: 'chat.queue.remove'; messageIds: string[] })
  | (ChatTarget & { type: 'chat.permission'; requestId: string; optionId: string })
  | (ChatTarget & { type: 'chat.question'; requestId: string; answers: ChatQuestionAnswers })
  // `effort` omitted keeps a chosen effort the new model offers; null is the provider's default (capabilities.effortDefault).
  | (ChatTarget & { type: 'chat.setModel'; model: string; effort?: string | null })
  | (ChatTarget & { type: 'chat.setLevel'; level: PermissionLevel })
  | { type: 'agent.start'; agentId: string; message?: string; resume?: boolean }
  | { type: 'agent.stop'; agentId: string }
  | { type: 'agent.spawn'; projectId: string; prompt: string; model?: string; orchestrator?: string }
  | ({ type: 'agent.create' } & MobileAgentCreate)
  | ({ type: 'agent.update' } & MobileAgentUpdate)
  | { type: 'project.setPinned'; projectId: string; pinned: boolean }
  | { type: 'project.setInactive'; projectId: string; inactive: boolean }
  // A helper start or dispose waiting on the user (#159). `force` approves a dispose that would lose work ("Dispose anyway").
  | { type: 'helper.approve'; requestId: string; force?: boolean }
  | { type: 'helper.decline'; requestId: string }
);
/** A durable agent, as the New agent page makes one. */
export interface MobileAgentCreate {
  projectId: string; name: string; color: string; orchestrator?: string; model?: string; persona?: string;
  freeAgentMode?: boolean; useWorktree?: boolean; mcpIds?: string[]; branchName?: string; branchFrom?: string; folderName?: string;
}
/** Settings a phone may change; null clears. */
export interface MobileAgentUpdate {
  agentId: string; name?: string; color?: string; emoji?: string | null; orchestrator?: string; model?: string;
  runtime?: 'default' | 'chat' | 'terminal'; persona?: string | null; clubhouseMode?: boolean; freeAgentMode?: boolean; idleSleep?: AgentIdleSleep;
}
/** What the desktop windows patch into their agent list after a phone's agent.update. */
export interface AnnexAgentUpdate {
  agentId: string; name: string; color: string; emoji: string | null; model: string | null; orchestrator: string | null;
  freeAgentMode: boolean;
}
/**
 * The chat snapshot's `chatControls`: what the composer's level, model and
 * effort pills show, for chat.setLevel and chat.setModel. `efforts` are the
 * current model's. `switchNote` is the pills' "Applies from the next message."
 */
export interface MobileChatControls {
  model: string | null;
  /** The session runs the provider's default model and hasn't named it yet ("Default model"). */
  modelUnknown: boolean;
  effort: string | null;
  effortIsDefault: boolean;
  /** False until the session reports its effort; hide the effort chip until then. */
  effortReported: boolean;
  level: PermissionLevel | null;
  models: ChatModelOption[];
  efforts: string[];
  levelNames: Partial<Record<PermissionLevel, string>>;
  liveLevels: PermissionLevel[];
  modelSwitch: ChatCapabilities['modelSwitch'];
  effortSwitch: ChatCapabilities['effortSwitch'];
  effortDefault: boolean;
  switchNote: string | null;
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

/**
 * A helper start or dispose an orchestrator asked the user to decide (#159),
 * as the Annex snapshot's `helperRequests` lists it. The desktop's Needs you
 * shows the same requests with `summary` as its line.
 */
export interface MobileHelperRequest {
  requestId: string;
  kind: 'start' | 'dispose';
  projectId: string;
  /** The orchestrator that asked. */
  requester: { agentId: string; name: string };
  /** The helper to start or dispose. A start's helper has no id until it is approved. */
  helper: { agentId: string | null; name: string };
  /** ISO times. A start expires; a dispose waits until it is answered. */
  requestedAt: string;
  expiresAt: string | null;
  /** The desktop's Needs you line. */
  summary: string;
  /** For a start: what the helper is asked to do and how. */
  start?: { task: string; persona: string | null; model: string | null; access: string | null; branchFrom: string | null };
  /**
   * For a dispose: what disposing would lose. `canDispose` is false when a
   * check couldn't run (only Decline then); `workAtRisk` means approving
   * needs `force: true`, the desktop's "Dispose anyway".
   */
  dispose?: { uncommittedFiles: number; unpushedCommits: number; unmergedCommits: number | null; checkError: string | null;
    forceRequested: boolean; workAtRisk: boolean; canDispose: boolean };
}
