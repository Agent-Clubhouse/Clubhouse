/** Safe selected-parent helper display, independent of runtime/grant authority. */
export const REMOTE_HELPER_PAGE_SIZE = 8;
export const REMOTE_HELPER_STATUSES = ['disposed', 'handed-off', 'creating', 'failed', 'running', 'needs-you', 'waking', 'not-running', 'unknown'] as const;
export interface RemoteHelperRow {
  key: string;
  name: string;
  projectName: string | null;
  status: typeof REMOTE_HELPER_STATUSES[number];
  statusSource: 'saved' | 'current-run' | 'unknown';
  branch: string | null;
  failure: 'creation' | 'runtime' | 'unknown' | null;
  disposedAt: string | null;
  work: { state: 'recorded'; text: string } | { state: 'unavailable'; reason: 'identity' | 'read-failed' | 'admission-limit' | 'not-applicable' };
  /** Only a strictly bound live helper/project; never a path or lookup reference. */
  target?: { agentId: string; projectId: string };
}
export interface RemoteHelperPage {
  version: 1;
  source: 'selected-direct-helpers';
  state: 'ok' | 'unavailable';
  offset: number;
  next: number | null;
  total: number | null;
  liveCount: number | null;
  disposedCount: number | null;
  pendingCount: number | null;
  rows: RemoteHelperRow[];
  pending: Array<{ key: string; name: string; task: string; warning: string | null; createdAt: string; expiresAt: string }>;
  notes: string[];
}
const text = (v: unknown, max = 240): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const count = (v: unknown) => v === null || Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 4096;
const id = (v: unknown) => text(v, 200) && !v.includes('@') && !v.includes('||') && Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const keys = (v: object, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
export function isRemoteHelperPage(value: unknown): value is RemoteHelperPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteHelperPage;
  return keys(v, ['version', 'source', 'state', 'offset', 'next', 'total', 'liveCount', 'disposedCount', 'pendingCount', 'rows', 'pending', 'notes'])
    && v.version === 1 && v.source === 'selected-direct-helpers' && ['ok', 'unavailable'].includes(v.state)
    && Number.isSafeInteger(v.offset) && v.offset >= 0 && v.offset <= 4096 && v.offset % REMOTE_HELPER_PAGE_SIZE === 0
    && [v.total, v.liveCount, v.disposedCount, v.pendingCount].every(count)
    && (v.total === null ? v.state === 'unavailable' && v.liveCount === null && v.disposedCount === null && v.next === null && v.rows?.length === 0
      : v.state === 'ok' && v.liveCount !== null && v.disposedCount !== null && v.total === v.liveCount + v.disposedCount
        && (v.offset === 0 || v.offset < v.total) && v.rows?.length === Math.min(REMOTE_HELPER_PAGE_SIZE, Math.max(0, v.total - v.offset))
        && (v.next === null ? v.offset + v.rows?.length >= v.total : v.next === v.offset + REMOTE_HELPER_PAGE_SIZE && v.next < v.total))
    && Array.isArray(v.rows) && v.rows.length <= REMOTE_HELPER_PAGE_SIZE && new Set(v.rows.map((r) => r?.key)).size === v.rows.length
    && v.rows.every((r) => !!r && typeof r === 'object' && keys(r, ['key', 'name', 'projectName', 'status', 'statusSource', 'branch', 'failure', 'disposedAt', 'work', 'target'])
      && text(r.key, 64) && text(r.name) && (r.projectName === null || text(r.projectName)) && REMOTE_HELPER_STATUSES.includes(r.status)
      && ['saved', 'current-run', 'unknown'].includes(r.statusSource) && (r.branch === null || text(r.branch))
      && [null, 'creation', 'runtime', 'unknown'].includes(r.failure) && (r.disposedAt === null || text(r.disposedAt, 64) && Number.isFinite(Date.parse(r.disposedAt)))
      && !!r.work && typeof r.work === 'object' && (r.work.state === 'recorded' ? keys(r.work, ['state', 'text']) && text(r.work.text)
        : r.work.state === 'unavailable' && keys(r.work, ['state', 'reason']) && ['identity', 'read-failed', 'admission-limit', 'not-applicable'].includes(r.work.reason))
      && (r.target === undefined || r.status !== 'disposed' && !!r.target && typeof r.target === 'object' && keys(r.target, ['agentId', 'projectId']) && id(r.target.agentId) && id(r.target.projectId)))
    && Array.isArray(v.pending) && v.pending.length <= 3 && new Set(v.pending.map((r) => r?.key)).size === v.pending.length && (v.pendingCount === null ? v.pending.length === 0 : v.pendingCount === v.pending.length)
    && v.pending.every((r) => !!r && typeof r === 'object' && keys(r, ['key', 'name', 'task', 'warning', 'createdAt', 'expiresAt'])
      && text(r.key, 64) && text(r.name) && text(r.task, 2048) && (r.warning === null || text(r.warning, 1024))
      && text(r.createdAt, 64) && Number.isFinite(Date.parse(r.createdAt)) && text(r.expiresAt, 64) && Date.parse(r.expiresAt) > Date.parse(r.createdAt))
    && Array.isArray(v.notes) && v.notes.length <= 10 && v.notes.every((n) => text(n, 2048));
}
