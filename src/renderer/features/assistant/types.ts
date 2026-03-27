export type MessageRole = 'user' | 'assistant';

export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** Timestamp in ms */
  timestamp: number;
}

export type ActionCardStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ActionCardData {
  id: string;
  toolName: string;
  description: string;
  status: ActionCardStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface FeedItem {
  type: 'message' | 'action';
  message?: AssistantMessage;
  action?: ActionCardData;
}
