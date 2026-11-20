import { isRemoteHelperPage, type RemoteHelperPage } from './remote-helper-page';
import { isRemoteInventoryPage, REMOTE_INVENTORY_SOURCES, type RemoteInventoryPage, type RemoteInventorySource } from './remote-inventory-page';
import { isRemoteConnectionPage, REMOTE_CONNECTION_PAGE_SOURCES, type RemoteConnectionPage, type RemoteConnectionPageSource } from './remote-details-query';
import { ACTION_OUTCOMES, ACTION_RELATIONSHIPS, isActionRunTime, type RemoteActionRow } from './agent-action-groups';
import { isRemoteAgentSettings, type RemoteAgentSettings } from './remote-agent-settings';
import type { AgentStatus } from './types';
import { isChatDetailsEvidence, type ChatDetailsEvidence } from './chat/details-evidence';

/** Display evidence for one selected agent, never configuration objects or authority. */
export const REMOTE_DETAILS_MAX_BYTES = 256 * 1024;
export const REMOTE_DETAILS_MAX_ROWS = 100;
export const REMOTE_DETAILS_CARD_IDS = ['settings', 'dispatcher', 'orchestrate', 'connections', 'actions', 'skills-mcp', 'session', 'canvases', 'changes'] as const;
export type RemoteDetailsCardId = typeof REMOTE_DETAILS_CARD_IDS[number];
export const REMOTE_OUTGOING_WIRE_KINDS = ['agent', 'browser', 'terminal', 'group-project', 'plugin'] as const;
/** Selected host-memory binding records; never a handshake, reachability or effective grant. */
export type RemoteOutgoingWires = { source: 'selected-outgoing-binding-records'; state: 'recorded';
  rows: Array<{ name: string | null; kind: typeof REMOTE_OUTGOING_WIRE_KINDS[number] }>; total: number; omitted: number }
  | { source: 'selected-outgoing-binding-records'; state: 'unavailable'; reason: 'unreadable' | 'invalid' | 'limit' | 'changed' };
export function isRemoteOutgoingWires(value: unknown): value is RemoteOutgoingWires {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteOutgoingWires;
  if (v.source !== 'selected-outgoing-binding-records') return false;
  if (v.state === 'unavailable') return Object.keys(v).every((key) => ['source', 'state', 'reason'].includes(key))
    && ['unreadable', 'invalid', 'limit', 'changed'].includes(v.reason);
  return v.state === 'recorded' && Object.keys(v).every((key) => ['source', 'state', 'rows', 'total', 'omitted'].includes(key))
    && Array.isArray(v.rows) && v.rows.length <= 50 && Number.isSafeInteger(v.total) && v.total >= v.rows.length && v.total <= 4096
    && Number.isSafeInteger(v.omitted) && v.omitted === v.total - v.rows.length
    && v.rows.every((r) => !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).every((key) => ['name', 'kind'].includes(key))
      && (r.name === null || typeof r.name === 'string' && !!r.name && r.name.length <= 240) && REMOTE_OUTGOING_WIRE_KINDS.includes(r.kind));
}
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
  /** Explicitly omitted from a selected-source response, never a verified empty card. */
  requested?: false;
  /** Optional bounded selected-source page. Older hosts omit it. */
  connectionPage?: RemoteConnectionPage;
}
export interface RemoteAgentDetails {
  inventoryPages?: 1;
  inventorySources?: RemoteInventorySource[];
  inventoryPageOnly?: true;
  inventoryPage?: RemoteInventoryPage;
  version: 1;
  helperPages?: 1;
  helperPageOnly?: true;
  helperPage?: RemoteHelperPage;
  /** Additive selected-source continuation support, independent of older Details hosts. */
  connectionPages?: 1;
  /** Explicit selected-source-only envelope support; absent on older paged hosts. */
  connectionPageEnvelope?: 1;
  /** Other card bodies are not included, rather than empty/unsupported. */
  connectionPageOnly?: true;
  /** Additive supported origin list; absent on the first paged-host version. */
  connectionPageSources?: RemoteConnectionPageSource[];
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
  /** Absent on older hosts, unsupported selected roles, or source-page-only responses. */
  outgoingWires?: RemoteOutgoingWires;
}

export function isRemoteAgentDetails(value: unknown, agentId: string): value is RemoteAgentDetails {
  if (!value || typeof value !== 'object') return false;
  const v = value as RemoteAgentDetails;
  const text = (s: unknown) => typeof s === 'string' && s.length <= 2048;
  return v.version === 1 && (v.inventoryPages === undefined || v.inventoryPages === 1)
    && (v.inventorySources === undefined || v.inventoryPages === 1 && Array.isArray(v.inventorySources) && v.inventorySources.length <= 16 && new Set(v.inventorySources).size === v.inventorySources.length && v.inventorySources.every((source) => REMOTE_INVENTORY_SOURCES.includes(source)))
    && (v.inventoryPage === undefined || v.inventoryPages === 1 && v.inventoryPageOnly === true && v.connectionPageOnly !== true && v.helperPageOnly !== true && isRemoteInventoryPage(v.inventoryPage) && !!v.inventorySources?.includes(v.inventoryPage.source))
    && (v.inventoryPageOnly === undefined || v.inventoryPageOnly === true && v.inventoryPage !== undefined && Object.keys(v).every((key) => ['version', 'agentId', 'readOnly', 'readAt', 'providerId', 'providerLabel', 'running', 'status', 'spawnedAt', 'sessionId', 'nativeSessionId', 'settings', 'cards', 'inventoryPages', 'inventorySources', 'inventoryPageOnly', 'inventoryPage'].includes(key)) && v.settings === null && v.providerEvidence === undefined && v.providerEvidenceState === undefined && v.outgoingWires === undefined && v.helperPage === undefined && Array.isArray(v.cards) && v.cards.every((c) => !!c && typeof c === 'object' && (c.id === (v.inventoryPage?.source === 'selected-action-relationships' ? 'actions' : 'skills-mcp') ? c.requested === undefined : c.requested === false) && c.connectionPage === undefined && c.omitted === 0 && Array.isArray(c.rows) && !c.rows.length && Array.isArray(c.notes) && !c.notes.length))
    && (v.helperPages === undefined || v.helperPages === 1)
    && (v.helperPage === undefined || v.helperPages === 1 && v.connectionPageOnly !== true && isRemoteHelperPage(v.helperPage))
    && (v.helperPageOnly === undefined || v.helperPageOnly === true && v.helperPage !== undefined && v.connectionPageOnly !== true && v.settings === null && v.providerEvidence === undefined && v.outgoingWires === undefined && Array.isArray(v.cards) && v.cards.every((c) => !!c && typeof c === 'object' && (c.id === 'orchestrate' ? c.requested === undefined : c.requested === false && c.connectionPage === undefined && c.omitted === 0 && Array.isArray(c.rows) && !c.rows.length && Array.isArray(c.notes) && !c.notes.length)))
    && (v.connectionPages === undefined || v.connectionPages === 1)
    && (v.outgoingWires === undefined || v.connectionPageOnly !== true && isRemoteOutgoingWires(v.outgoingWires))
    && (v.connectionPageEnvelope === undefined || v.connectionPages === 1 && v.connectionPageEnvelope === 1)
    && (v.connectionPageOnly === undefined || v.connectionPageOnly === true && v.connectionPageEnvelope === 1 && v.settings === null && v.providerEvidence === undefined && Array.isArray(v.cards) && v.cards.every((c) => !!c && typeof c === 'object') && v.cards.some((c) => c.id === 'connections' && c.connectionPage !== undefined) && v.cards.every((c) => c.id === 'connections' ? c.requested === undefined : c.requested === false && Array.isArray(c.rows) && !c.rows.length && Array.isArray(c.notes) && !c.notes.length))
    && (v.connectionPageSources === undefined || v.connectionPages === 1 && Array.isArray(v.connectionPageSources) && v.connectionPageSources.length <= 16
      && new Set(v.connectionPageSources).size === v.connectionPageSources.length && v.connectionPageSources.every((source) => REMOTE_CONNECTION_PAGE_SOURCES.includes(source))) && v.agentId === agentId && v.readOnly === true
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
      && (c.requested === undefined || (v.connectionPageOnly === true && c.id !== 'connections' || v.helperPageOnly === true && c.id !== 'orchestrate' || v.inventoryPageOnly === true && c.id !== (v.inventoryPage?.source === 'selected-action-relationships' ? 'actions' : 'skills-mcp')) && c.requested === false)
      && Number.isSafeInteger(c.omitted) && c.omitted >= 0
      && Number.isFinite(c.observedAt) && c.observedAt > 0
      && (c.connectionPage === undefined || c.id === 'connections' && isRemoteConnectionPage(c.connectionPage))
      && Array.isArray(c.notes) && c.notes.length <= 20 && c.notes.every(text)
      && Array.isArray(c.rows) && c.rows.length <= REMOTE_DETAILS_MAX_ROWS
      && c.rows.every((r) => !!r && typeof r === 'object' && text(r.label) && text(r.value)
        && (r.action === undefined || c.id === 'actions' && !!r.action && typeof r.action === 'object' && !Array.isArray(r.action)
          && Object.keys(r.action).every((key) => ['group', 'enabled', 'description', 'lastRun'].includes(key))
          && ACTION_RELATIONSHIPS.includes(r.action.group) && typeof r.action.enabled === 'boolean' && text(r.action.description)
          && (r.action.lastRun === undefined || !!r.action.lastRun && typeof r.action.lastRun === 'object' && !Array.isArray(r.action.lastRun)
            && Object.keys(r.action.lastRun).every((key) => ['outcome', 'startedAt'].includes(key))
            && ACTION_OUTCOMES.includes(r.action.lastRun.outcome)
            && (r.action.lastRun.startedAt === undefined || isActionRunTime(r.action.lastRun.startedAt))))
        && (r.canvas === undefined || c.id === 'canvases' && !!r.canvas && typeof r.canvas === 'object'
          && ['app', 'project'].includes(r.canvas.scope) && text(r.canvas.canvasId) && !!r.canvas.canvasId
          && text(r.canvas.viewId) && !!r.canvas.viewId)));
}
