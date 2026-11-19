import { isRemoteAgentSettings, type RemoteAgentSettings } from './remote-agent-settings';
import type { AgentStatus } from './types';

/** Display evidence for one selected agent, never configuration objects or authority. */
export const REMOTE_DETAILS_MAX_BYTES = 256 * 1024;
export const REMOTE_DETAILS_MAX_ROWS = 100;
export const REMOTE_DETAILS_CARD_IDS = ['settings', 'dispatcher', 'orchestrate', 'connections', 'actions', 'skills-mcp', 'session', 'canvases', 'changes'] as const;
export type RemoteDetailsCardId = typeof REMOTE_DETAILS_CARD_IDS[number];
export interface RemoteDetailsRow { label: string; value: string }
export interface RemoteDetailsCard {
  id: RemoteDetailsCardId;
  title: string;
  state: 'ok' | 'error' | 'unsupported' | 'not-applicable';
  summary: string;
  rows: RemoteDetailsRow[];
  notes: string[];
  /** Rows outside the bounded result are counted, never silently hidden. */
  omitted: number;
  observedAt: number;
}
export interface RemoteAgentDetails {
  version: 1;
  agentId: string;
  readOnly: true;
  readAt: number;
  providerId: string;
  running: boolean;
  status: AgentStatus;
  spawnedAt: number | null;
  sessionId: string | null;
  nativeSessionId: string | null;
  settings: RemoteAgentSettings | null;
  cards: RemoteDetailsCard[];
}

export function isRemoteAgentDetails(value: unknown, agentId: string): value is RemoteAgentDetails {
  if (!value || typeof value !== 'object') return false;
  const v = value as RemoteAgentDetails;
  const text = (s: unknown) => typeof s === 'string' && s.length <= 2048;
  return v.version === 1 && v.agentId === agentId && v.readOnly === true
    && Number.isFinite(v.readAt) && v.readAt > 0 && text(v.providerId) && typeof v.running === 'boolean'
    && ['running', 'sleeping', 'waking', 'creating', 'spawning', 'error'].includes(v.status)
    && (v.spawnedAt === null || Number.isFinite(v.spawnedAt) && v.spawnedAt > 0)
    && (v.sessionId === null || text(v.sessionId)) && (v.nativeSessionId === null || text(v.nativeSessionId))
    && (v.settings === null || isRemoteAgentSettings(v.settings, agentId))
    && Array.isArray(v.cards) && v.cards.length === REMOTE_DETAILS_CARD_IDS.length
    && v.cards.every((c) => !!c && typeof c === 'object')
    && new Set(v.cards.map((c) => c.id)).size === REMOTE_DETAILS_CARD_IDS.length
    && v.cards.every((c) => REMOTE_DETAILS_CARD_IDS.includes(c.id) && text(c.title) && text(c.summary)
      && ['ok', 'error', 'unsupported', 'not-applicable'].includes(c.state)
      && Number.isSafeInteger(c.omitted) && c.omitted >= 0
      && Number.isFinite(c.observedAt) && c.observedAt > 0
      && Array.isArray(c.notes) && c.notes.length <= 20 && c.notes.every(text)
      && Array.isArray(c.rows) && c.rows.length <= REMOTE_DETAILS_MAX_ROWS
      && c.rows.every((r) => !!r && typeof r === 'object' && text(r.label) && text(r.value)));
}
