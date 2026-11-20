/** Selected saved membership metadata only; never a board-content/navigation grant. */
export const REMOTE_CANVAS_MEMBERSHIP_SOURCE = 'selected-canvas-memberships' as const;
export const REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE = 25;
export const REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS = 4096;
export interface RemoteCanvasMembershipQuery { card: 'canvases'; source: typeof REMOTE_CANVAS_MEMBERSHIP_SOURCE; offset?: number; selection?: string }
export interface RemoteCanvasMembershipRow { key: string; name: string; scope: 'app' | 'project'; canvasId: string; viewId: string }
export type RemoteCanvasMembershipPage = { version: 1; source: typeof REMOTE_CANVAS_MEMBERSHIP_SOURCE; agentId: string; projectId: string; offset: number; observedAt: number; notes: string[] } & (
  { state: 'recorded'; selection: string; rows: RemoteCanvasMembershipRow[]; total: number; next: number | null }
  | { state: 'unavailable'; reason: 'invalid' | 'unreadable' | 'limit' | 'changed' | 'unsupported' }
);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const text = (v: unknown, max = 240): v is string => typeof v === 'string' && !!v && v.length <= max && Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const selection = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const offset = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS && Number(v) % REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE === 0;
export function isRemoteCanvasMembershipQuery(value: unknown): value is RemoteCanvasMembershipQuery {
  return record(value) && keys(value, ['card', 'source', 'offset', 'selection']) && value.card === 'canvases' && value.source === REMOTE_CANVAS_MEMBERSHIP_SOURCE
    && (value.offset === undefined || offset(value.offset)) && (value.selection === undefined || selection(value.selection)) && (!value.offset || selection(value.selection));
}
export function isRemoteCanvasMembershipPage(value: unknown): value is RemoteCanvasMembershipPage {
  if (!record(value) || value.version !== 1 || value.source !== REMOTE_CANVAS_MEMBERSHIP_SOURCE || !text(value.agentId) || !text(value.projectId)
    || !offset(value.offset) || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt) || value.observedAt <= 0
    || !Array.isArray(value.notes) || value.notes.length > 10 || !value.notes.every((note) => text(note))) return false;
  const common = ['version', 'source', 'agentId', 'projectId', 'offset', 'observedAt', 'notes', 'state'];
  if (value.state === 'unavailable') return keys(value, [...common, 'reason']) && ['invalid', 'unreadable', 'limit', 'changed', 'unsupported'].includes(String(value.reason));
  if (value.state !== 'recorded' || !keys(value, [...common, 'selection', 'rows', 'total', 'next']) || !selection(value.selection)
    || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || Number(value.total) > REMOTE_CANVAS_MEMBERSHIP_MAX_ITEMS
    || value.offset > 0 && value.offset >= Number(value.total) || !Array.isArray(value.rows)
    || value.rows.length !== Math.min(REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE, Math.max(0, Number(value.total) - value.offset))
    || (value.next === null ? value.offset + value.rows.length < Number(value.total) : value.next !== value.offset + REMOTE_CANVAS_MEMBERSHIP_PAGE_SIZE || Number(value.next) >= Number(value.total))) return false;
  return value.rows.every((r) => record(r) && keys(r, ['key', 'name', 'scope', 'canvasId', 'viewId']) && selection(r.key) && text(r.name)
      && ['app', 'project'].includes(String(r.scope)) && text(r.canvasId, 200) && text(r.viewId, 200))
    && new Set(value.rows.map((r) => (r as RemoteCanvasMembershipRow).key)).size === value.rows.length
    && new Set(value.rows.map((r) => JSON.stringify([(r as RemoteCanvasMembershipRow).scope, (r as RemoteCanvasMembershipRow).canvasId, (r as RemoteCanvasMembershipRow).viewId]))).size === value.rows.length;
}
