/** Metadata pages only. New sources require their own safe producer and validator. */
export const REMOTE_INVENTORY_PAGE_SIZE = 25;
export const REMOTE_INVENTORY_MAX_ITEMS = 4096;
export const REMOTE_MANAGED_INVENTORY_SOURCES = ['selected-managed-blocks', 'selected-managed-skills', 'selected-managed-mcps'] as const;
export type RemoteInventorySource = typeof REMOTE_MANAGED_INVENTORY_SOURCES[number];
export interface RemoteInventoryQuery { card: 'skills-mcp'; source: RemoteInventorySource; offset?: number; selection?: string }
export const isInventorySelection = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const isInventoryOffset = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < REMOTE_INVENTORY_MAX_ITEMS && Number(v) % REMOTE_INVENTORY_PAGE_SIZE === 0;
export type RemoteManagedPartRecord = { key: string; kind: 'block' | 'skill' | 'mcp' } & (
  { state: 'recorded'; name: string; revision: number; builtin: boolean } | { state: 'missing'; name: null }
);
export type RemoteInventoryPage = { version: 1; source: RemoteInventorySource; offset: number; observedAt: number; notes: string[] } & (
  { state: 'recorded'; selection: string; rows: RemoteManagedPartRecord[]; total: number; next: number | null }
  | { state: 'unavailable'; reason: 'invalid' | 'unreadable' | 'limit' | 'changed' | 'unsupported' }
);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const text = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 240 && Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
export function isRemoteInventoryQuery(value: unknown): value is RemoteInventoryQuery {
  if (!record(value)) return false;
  return keys(value, ['card', 'source', 'offset', 'selection']) && value.card === 'skills-mcp'
    && REMOTE_MANAGED_INVENTORY_SOURCES.includes(value.source as RemoteInventorySource)
    && (value.offset === undefined || isInventoryOffset(value.offset))
    && (value.selection === undefined || isInventorySelection(value.selection)) && (!value.offset || isInventorySelection(value.selection));
}
export function isRemoteInventoryPage(value: unknown): value is RemoteInventoryPage {
  if (!record(value) || value.version !== 1 || !REMOTE_MANAGED_INVENTORY_SOURCES.includes(value.source as RemoteInventorySource)
    || !isInventoryOffset(value.offset) || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt) || value.observedAt <= 0
    || !Array.isArray(value.notes) || value.notes.length > 10 || !value.notes.every(text)) return false;
  const common = ['version', 'source', 'offset', 'observedAt', 'notes', 'state'];
  if (value.state === 'unavailable') return keys(value, [...common, 'reason']) && ['invalid', 'unreadable', 'limit', 'changed', 'unsupported'].includes(String(value.reason));
  if (value.state !== 'recorded' || !keys(value, [...common, 'selection', 'rows', 'total', 'next']) || !isInventorySelection(value.selection)
    || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || Number(value.total) > REMOTE_INVENTORY_MAX_ITEMS
    || value.offset !== 0 && value.offset >= Number(value.total) || !Array.isArray(value.rows)
    || value.rows.length !== Math.min(REMOTE_INVENTORY_PAGE_SIZE, Math.max(0, Number(value.total) - value.offset))
    || (value.next === null ? value.offset + value.rows.length < Number(value.total) : value.next !== value.offset + REMOTE_INVENTORY_PAGE_SIZE || Number(value.next) >= Number(value.total))
    || new Set(value.rows.map((r) => record(r) ? r.key : null)).size !== value.rows.length) return false;
  const kind = value.source === 'selected-managed-blocks' ? 'block' : value.source === 'selected-managed-skills' ? 'skill' : 'mcp';
  return value.rows.every((r) => record(r) && isInventorySelection(r.key) && r.kind === kind && (r.state === 'missing'
    ? keys(r, ['key', 'kind', 'state', 'name']) && r.name === null
    : r.state === 'recorded' && keys(r, ['key', 'kind', 'state', 'name', 'revision', 'builtin']) && text(r.name)
      && Number.isSafeInteger(r.revision) && Number(r.revision) >= 1 && typeof r.builtin === 'boolean'));
}
