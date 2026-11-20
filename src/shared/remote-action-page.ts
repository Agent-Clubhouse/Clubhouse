import { ACTION_OUTCOMES, ACTION_RELATIONSHIPS, isActionRunTime, type RemoteActionRow } from './agent-action-groups';
export const REMOTE_ACTION_PAGE_SIZE = 25;
export const REMOTE_ACTION_RELATIONSHIP_LIMIT = 4096;
export const REMOTE_ACTION_PAGE_SOURCE = 'selected-action-relationships' as const;
export interface RemoteActionRelationshipRow extends RemoteActionRow { key: string; name: string }
interface PageBase { version: 1; source: typeof REMOTE_ACTION_PAGE_SOURCE; offset: number; observedAt: number; notes: string[] }
export type RemoteActionRelationshipPage = PageBase & ({ state: 'recorded'; selection: string; next: number | null; totalRelationships: number; uniqueActions: number; rows: RemoteActionRelationshipRow[] }
  | { state: 'unavailable'; reason: 'invalid' | 'unreadable' | 'limit' | 'changed' | 'unsupported' });
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const ownKeys = (v: object, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
export function isRemoteActionRelationshipPage(value: unknown): value is RemoteActionRelationshipPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteActionRelationshipPage;
  if (v.version !== 1 || v.source !== REMOTE_ACTION_PAGE_SOURCE || !Number.isSafeInteger(v.offset) || v.offset < 0 || v.offset > REMOTE_ACTION_RELATIONSHIP_LIMIT || v.offset % REMOTE_ACTION_PAGE_SIZE
    || !Number.isFinite(v.observedAt) || v.observedAt <= 0 || !Array.isArray(v.notes) || v.notes.length > 10 || !v.notes.every((n) => text(n, 2048))) return false;
  if (v.state === 'unavailable') return ownKeys(v, ['version', 'source', 'state', 'offset', 'observedAt', 'notes', 'reason']) && ['invalid', 'unreadable', 'limit', 'changed', 'unsupported'].includes(v.reason);
  return v.state === 'recorded' && ownKeys(v, ['version', 'source', 'state', 'offset', 'observedAt', 'notes', 'selection', 'next', 'totalRelationships', 'uniqueActions', 'rows'])
    && hash(v.selection) && Number.isSafeInteger(v.totalRelationships) && v.totalRelationships >= 0 && v.totalRelationships <= REMOTE_ACTION_RELATIONSHIP_LIMIT
    && Number.isSafeInteger(v.uniqueActions) && v.uniqueActions >= 0 && v.uniqueActions <= v.totalRelationships
    && (v.totalRelationships === 0 ? v.uniqueActions === 0 : v.uniqueActions > 0)
    && (v.offset === 0 || v.offset < v.totalRelationships)
    && Array.isArray(v.rows) && v.rows.length === Math.min(REMOTE_ACTION_PAGE_SIZE, Math.max(0, v.totalRelationships - v.offset))
    && new Set(v.rows.map((r) => r?.key)).size === v.rows.length
    && (v.offset + v.rows.length < v.totalRelationships ? v.next === v.offset + REMOTE_ACTION_PAGE_SIZE : v.next === null)
    && v.rows.every((r) => !!r && typeof r === 'object' && !Array.isArray(r) && ownKeys(r, ['key', 'name', 'group', 'enabled', 'description', 'lastRun'])
      && hash(r.key) && text(r.name, 240) && ACTION_RELATIONSHIPS.includes(r.group) && typeof r.enabled === 'boolean' && text(r.description, 2048)
      && (r.lastRun === undefined || !!r.lastRun && typeof r.lastRun === 'object' && !Array.isArray(r.lastRun) && ownKeys(r.lastRun, ['outcome', 'startedAt'])
        && ACTION_OUTCOMES.includes(r.lastRun.outcome) && (r.lastRun.startedAt === undefined || isActionRunTime(r.lastRun.startedAt))));
}
