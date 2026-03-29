export type MessageRole = 'user' | 'assistant';

export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Timestamp in ms */
  timestamp: number;
}

export type ActionCardStatus = 'pending_approval' | 'pending' | 'running' | 'completed' | 'error' | 'skipped';

export interface ActionCardData {
  id: string;
  toolName: string;
  description: string;
  status: ActionCardStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  durationMs?: number;
  /** Group ID to visually cluster related tool calls */
  groupId?: string;
  /** Human-readable summary for canvas/project/agent creation results */
  resultSummary?: string;
}

/** A logical group of related tool calls (e.g. "Creating canvas with 3 cards") */
export interface ActionGroup {
  id: string;
  label: string;
  actionIds: string[];
  status: 'pending_approval' | 'running' | 'completed' | 'error' | 'partial';
}

export interface FeedItem {
  type: 'message' | 'action' | 'action_group';
  message?: AssistantMessage;
  action?: ActionCardData;
  actionGroup?: ActionGroup;
}
