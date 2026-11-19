import type { ChangedFile } from './chat-checkpoints';

export const REMOTE_CHANGES_MAX_BYTES = 256 * 1024;
export const REMOTE_CHANGES_PAGE_SIZE = 50;
export type RemoteChangesScope = 'branch' | 'session' | 'turn';
export interface RemoteChangesQuery { scope: RemoteChangesScope; offset?: number; fileKey?: string }
export interface RemoteChangedFile extends Omit<ChangedFile, 'status'> {
  status: ChangedFile['status'] | 'unknown';
  fileKey: string;
  countsKnown: boolean;
  evidence: 'text' | 'binary' | 'unsafe' | 'too-large' | 'unreadable' | 'directory' | 'submodule' | 'budget' | 'filtered';
}
export interface RemoteAgentChanges {
  version: 1;
  readOnly: true;
  agentId: string;
  observedAt: number;
  scope: RemoteChangesScope;
  state: 'ok' | 'not-git' | 'no-base' | 'no-checkpoint' | 'unsupported';
  branch: string | null;
  base: string | null;
  sessionId: string | null;
  turnId: string | null;
  live: boolean;
  shared: boolean;
  files: RemoteChangedFile[];
  totalFiles: number;
  offset: number;
  nextOffset: number | null;
  /** Comparison bounds are not zero changes. */
  uncompared: number;
  skippedLarge: string[];
  skippedRepos: string[];
  skippedOmitted: number;
  patch?: { fileKey: string; state: RemoteChangedFile['evidence'] | 'unchanged' | 'stale'; text?: string; redacted?: boolean };
}
export function isRemoteChangesQuery(value: unknown): value is RemoteChangesQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const q = value as RemoteChangesQuery;
  return Object.keys(q).every((k) => ['scope', 'offset', 'fileKey'].includes(k)) && ['branch', 'session', 'turn'].includes(q.scope)
    && (q.offset === undefined || Number.isSafeInteger(q.offset) && q.offset >= 0 && q.offset <= 10_000)
    && (q.fileKey === undefined || typeof q.fileKey === 'string' && /^[a-f0-9]{64}$/.test(q.fileKey));
}
export function isRemoteAgentChanges(value: unknown, agentId: string, query: RemoteChangesQuery): value is RemoteAgentChanges {
  if (!value || typeof value !== 'object') return false;
  const r = value as RemoteAgentChanges;
  const text = (s: unknown) => typeof s === 'string' && s.length <= 2048;
  const nullable = (s: unknown) => s === null || text(s);
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const states = ['text', 'binary', 'unsafe', 'too-large', 'unreadable', 'directory', 'submodule', 'budget', 'filtered'];
  return r.version === 1 && r.readOnly === true && r.agentId === agentId && r.scope === query.scope
    && Number.isFinite(r.observedAt) && r.observedAt > 0 && ['ok', 'not-git', 'no-base', 'no-checkpoint', 'unsupported'].includes(r.state)
    && nullable(r.branch) && nullable(r.base) && nullable(r.sessionId) && nullable(r.turnId)
    && typeof r.live === 'boolean' && typeof r.shared === 'boolean'
    && count(r.totalFiles) && count(r.offset) && r.offset === (query.offset ?? 0)
    && (r.nextOffset === null || count(r.nextOffset) && r.nextOffset > r.offset && r.nextOffset < r.totalFiles)
    && count(r.uncompared) && count(r.skippedOmitted)
    && Array.isArray(r.skippedLarge) && r.skippedLarge.length <= 50 && r.skippedLarge.every(text)
    && Array.isArray(r.skippedRepos) && r.skippedRepos.length <= 50 && r.skippedRepos.every(text)
    && Array.isArray(r.files) && r.files.length <= REMOTE_CHANGES_PAGE_SIZE && r.files.length <= r.totalFiles
    && r.files.every((f) => !!f && typeof f === 'object' && text(f.path) && !!f.path && (f.oldPath === undefined || text(f.oldPath))
      && ['added', 'modified', 'deleted', 'renamed', 'unknown'].includes(f.status) && count(f.additions) && count(f.deletions)
      && typeof f.binary === 'boolean' && typeof f.countsKnown === 'boolean' && states.includes(f.evidence) && /^[a-f0-9]{64}$/.test(f.fileKey))
    && (r.patch === undefined || !!query.fileKey && !!r.patch && r.patch.fileKey === query.fileKey && [...states, 'unchanged', 'stale'].includes(r.patch.state) && (r.patch.redacted === undefined || typeof r.patch.redacted === 'boolean')
      && (r.patch.text === undefined || r.patch.state === 'text' && typeof r.patch.text === 'string' && r.patch.text.length <= 128 * 1024));
}
