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
  accentColor: string;
}

export interface Swimlane {
  id: string;
  name: string;
  order: number;
  managerAgentId: string | null;
}

export interface BoardConfig {
  maxRetries: number;
  zoomLevel: number;
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
  phase: 'executing' | 'evaluating';
  attempt: number;
  startedAt: number;
}

// ── Storage keys ────────────────────────────────────────────────────────

export const BOARDS_KEY = 'boards';
export const cardsKey = (boardId: string): string => `cards:${boardId}`;
export const AUTOMATION_RUNS_KEY = 'automation-runs';

// ── Default accent colors ───────────────────────────────────────────────

export const ACCENT_COLORS = [
  'var(--ctp-blue)',
  'var(--ctp-yellow)',
  'var(--ctp-green)',
  'var(--ctp-mauve)',
  'var(--ctp-peach)',
  'var(--ctp-teal)',
] as const;

// ── Priority display config ─────────────────────────────────────────────

export const PRIORITY_CONFIG: Record<Priority, { label: string; className: string; hidden?: boolean }> = {
  none:     { label: 'None',     className: '', hidden: true },
  low:      { label: 'Low',      className: 'bg-ctp-blue/15 text-ctp-blue' },
  medium:   { label: 'Medium',   className: 'bg-ctp-yellow/15 text-ctp-yellow' },
  high:     { label: 'High',     className: 'bg-ctp-peach/15 text-ctp-peach' },
  critical: { label: 'Critical', className: 'bg-ctp-red/15 text-ctp-red' },
};

// ── Helpers ─────────────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
