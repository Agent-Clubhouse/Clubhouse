import { ACTION_OUTCOMES, ACTION_RELATIONSHIPS, type RemoteActionRow } from './agent-action-groups';
import { isRemoteAgentSettings, type RemoteAgentSettings } from './remote-agent-settings';
import type { AgentStatus } from './types';
import { isChatDetailsEvidence, type ChatDetailsEvidence } from './chat/details-evidence';

/** Display evidence for one selected agent, never configuration objects or authority. */
export const REMOTE_DETAILS_MAX_BYTES = 256 * 1024;
export const REMOTE_DETAILS_MAX_ROWS = 100;
export const REMOTE_DETAILS_CARD_IDS = ['settings', 'dispatcher', 'orchestrate', 'connections', 'actions', 'skills-mcp', 'session', 'canvases', 'changes'] as const;
export type RemoteDetailsCardId = typeof REMOTE_DETAILS_CARD_IDS[number];
export interface RemoteDetailsRow {
  label: string;
  value: string;
  /** Safe selected-action display fields only, never definitions, steps or grants. */
  action?: RemoteActionRow;
  /** A verified membership of this selected agent, for host-aware navigation only. */
  canvas?: { scope: 'app' | 'project'; canvasId: string; viewId: string };
}
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
  /** Current registered/reported CLI label, separately from next-start settings. */
  providerLabel?: string;
  running: boolean;
  status: AgentStatus;
  spawnedAt: number | null;
  sessionId: string | null;
  nativeSessionId: string | null;
  settings: RemoteAgentSettings | null;
  cards: RemoteDetailsCard[];
  /** Optional on older hosts; one exact live runtime's passive provider facts. */
  providerEvidence?: ChatDetailsEvidence;
  providerEvidenceState?: 'current' | 'unavailable' | 'unsupported';
}

export function isRemoteAgentDetails(value: unknown, agentId: string): value is RemoteAgentDetails {
  if (!value || typeof value !== 'object') return false;
  const v = value as RemoteAgentDetails;
  const text = (s: unknown) => typeof s === 'string' && s.length <= 2048;
  return v.version === 1 && v.agentId === agentId && v.readOnly === true
    && Number.isFinite(v.readAt) && v.readAt > 0 && text(v.providerId) && !!v.providerId && (v.providerLabel === undefined || text(v.providerLabel) && !!v.providerLabel) && typeof v.running === 'boolean'
    && ['running', 'sleeping', 'waking', 'creating', 'spawning', 'error'].includes(v.status)
    && (v.spawnedAt === null || Number.isFinite(v.spawnedAt) && v.spawnedAt > 0)
    && (v.sessionId === null || text(v.sessionId)) && (v.nativeSessionId === null || text(v.nativeSessionId))
    && (v.settings === null || isRemoteAgentSettings(v.settings, agentId))
    && (v.providerEvidenceState === undefined || ['current', 'unavailable', 'unsupported'].includes(v.providerEvidenceState))
    && (v.providerEvidenceState !== 'current' || v.providerEvidence !== undefined)
    && (v.providerEvidence === undefined || (v.providerEvidenceState === undefined || v.providerEvidenceState === 'current') && isChatDetailsEvidence(v.providerEvidence)
      && v.running && v.providerEvidence.agentId === agentId && v.providerEvidence.providerId === v.providerId
      && v.providerEvidence.sessionId === v.sessionId && v.providerEvidence.nativeSessionId === v.nativeSessionId)
    && Array.isArray(v.cards) && v.cards.length === REMOTE_DETAILS_CARD_IDS.length
    && v.cards.every((c) => !!c && typeof c === 'object')
    && new Set(v.cards.map((c) => c.id)).size === REMOTE_DETAILS_CARD_IDS.length
    && v.cards.every((c) => REMOTE_DETAILS_CARD_IDS.includes(c.id) && text(c.title) && text(c.summary)
      && ['ok', 'error', 'unsupported', 'not-applicable'].includes(c.state)
      && Number.isSafeInteger(c.omitted) && c.omitted >= 0
      && Number.isFinite(c.observedAt) && c.observedAt > 0
      && Array.isArray(c.notes) && c.notes.length <= 20 && c.notes.every(text)
      && Array.isArray(c.rows) && c.rows.length <= REMOTE_DETAILS_MAX_ROWS
      && c.rows.every((r) => !!r && typeof r === 'object' && text(r.label) && text(r.value)
        && (r.action === undefined || c.id === 'actions' && !!r.action && typeof r.action === 'object' && !Array.isArray(r.action)
          && Object.keys(r.action).every((key) => ['group', 'enabled', 'description', 'lastRun'].includes(key))
          && ACTION_RELATIONSHIPS.includes(r.action.group) && typeof r.action.enabled === 'boolean' && text(r.action.description)
          && (r.action.lastRun === undefined || !!r.action.lastRun && typeof r.action.lastRun === 'object' && !Array.isArray(r.action.lastRun)
            && Object.keys(r.action.lastRun).every((key) => ['outcome', 'startedAt'].includes(key))
            && ACTION_OUTCOMES.includes(r.action.lastRun.outcome)
            && (r.action.lastRun.startedAt === undefined || Number.isSafeInteger(r.action.lastRun.startedAt) && r.action.lastRun.startedAt >= 0)))
        && (r.canvas === undefined || c.id === 'canvases' && !!r.canvas && typeof r.canvas === 'object'
          && ['app', 'project'].includes(r.canvas.scope) && text(r.canvas.canvasId) && !!r.canvas.canvasId
          && text(r.canvas.viewId) && !!r.canvas.viewId)));
}
