// ── KanBoss data models ─────────────────────────────────────────────────

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type HistoryAction =
  | 'created'
  | 'moved'
  | 'edited'
  | 'priority-changed'
  | 'automation-started'
  | 'automation-succeeded'
  | 'automation-failed'
  | 'automation-stuck';

export interface HistoryEntry {
  action: HistoryAction;
  timestamp: number;
  detail: string;
  agentId?: string;
}

export interface Card {
  id: string;
  boardId: string;
  title: string;
  body: string;
  priority: Priority;
  stateId: string;
  swimlaneId: string;
  history: HistoryEntry[];
  automationAttempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardState {
  id: string;
  name: string;
  order: number;
  isAutomatic: boolean;
  automationPrompt: string;
}

export interface Swimlane {
  id: string;
  name: string;
  order: number;
  managerAgentId: string | null;
  evaluationAgentId: string | null; // null = same as manager agent
}

export interface BoardConfig {
  maxRetries: number;
  zoomLevel: number;
  gitHistory: boolean;
}

export interface Board {
  id: string;
  name: string;
  states: BoardState[];
  swimlanes: Swimlane[];
  config: BoardConfig;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRun {
  cardId: string;
  boardId: string;
  stateId: string;
  swimlaneId: string;
  executionAgentId: string;
  evaluationAgentId: string | null;
  configuredEvaluationAgentId: string | null; // from swimlane config; null = same as manager
  phase: 'executing' | 'evaluating';
  attempt: number;
  startedAt: number;
}

// ── Storage keys ────────────────────────────────────────────────────────

export const BOARDS_KEY = 'boards';
export const cardsKey = (boardId: string): string => `cards:${boardId}`;
export const AUTOMATION_RUNS_KEY = 'automation-runs';

// ── Priority display config ─────────────────────────────────────────────

export const PRIORITY_CONFIG: Record<Priority, { label: string; color: string; hidden?: boolean }> = {
  none:     { label: 'None',     color: '', hidden: true },
  low:      { label: 'Low',      color: '#3b82f6' },
  medium:   { label: 'Medium',   color: '#eab308' },
  high:     { label: 'High',     color: '#f97316' },
  critical: { label: 'Critical', color: '#ef4444' },
};

// ── Helpers ─────────────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
