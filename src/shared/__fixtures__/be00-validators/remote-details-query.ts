// FROZEN test fixture: src/shared/remote-details-query.ts at be0091d1676764b0e3300898ab0ad1f135f88a46 (blob sha256 0eb92b4302fa8f0bfdf99222d183033e48c77816e2dd2905d54571758af65fff).
// Old-client validators for mixed-version tests. Only relative imports are rewritten. Do not edit.
/** Selected Connections and helper pages over the existing paired-desktop Details GET. */
import { isRemoteInventoryQuery, type RemoteInventoryQuery } from './remote-inventory-page';
export const REMOTE_CONNECTION_PAGE_SOURCES = ['outgoing', 'incoming', 'directions', 'sources', 'manual-dispatcher', 'helpers', 'dispatcher-auto', 'tool-records', 'canvas-records', 'zone-records', 'helper-parent', 'group-records'] as const;
export type RemoteConnectionPageSource = typeof REMOTE_CONNECTION_PAGE_SOURCES[number];
export interface RemoteConnectionDetailsQuery { card: 'connections' | 'orchestrate'; source: RemoteConnectionPageSource; offset?: number; projectOffset?: number }
export type RemoteDetailsQuery = RemoteConnectionDetailsQuery | RemoteInventoryQuery;
export interface RemoteConnectionPage {
  source: RemoteConnectionPageSource;
  offset: number;
  projectOffset: number;
  next: { offset: number; projectOffset: number } | null;
  /** Number of known matching records in THIS root page, not a global total. */
  known: number;
  complete: boolean;
}
const offset = (v: unknown) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 4096;
export function isRemoteDetailsQuery(value: unknown): value is RemoteDetailsQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (['skills-mcp', 'actions', 'canvases'].includes((value as { card?: string }).card)) return isRemoteInventoryQuery(value);
  const v = value as RemoteConnectionDetailsQuery;
  return Object.keys(v).every((key) => ['card', 'source', 'offset', 'projectOffset'].includes(key)) && (v.card === 'connections' || v.card === 'orchestrate' && v.source === 'helpers' && !v.projectOffset && (v.offset ?? 0) % 8 === 0)
    && REMOTE_CONNECTION_PAGE_SOURCES.includes(v.source) && (v.offset === undefined || offset(v.offset))
    && (v.projectOffset === undefined || offset(v.projectOffset))
    && (!v.projectOffset || v.source === 'helpers' || v.source === 'dispatcher-auto' || v.source === 'tool-records' || v.source === 'canvas-records' || v.source === 'zone-records');
}
export function isRemoteConnectionPage(value: unknown): value is RemoteConnectionPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteConnectionPage;
  return Object.keys(v).every((key) => ['source', 'offset', 'projectOffset', 'next', 'known', 'complete'].includes(key))
    && isRemoteDetailsQuery({ card: 'connections', source: v.source, offset: v.offset, projectOffset: v.projectOffset })
    && offset(v.offset) && offset(v.projectOffset) && Number.isSafeInteger(v.known) && v.known >= 0 && typeof v.complete === 'boolean'
    && (v.next === null || !!v.next && typeof v.next === 'object' && !Array.isArray(v.next)
      && Object.keys(v.next).every((key) => ['offset', 'projectOffset'].includes(key)) && offset(v.next.offset) && offset(v.next.projectOffset)
      && (v.next.projectOffset > v.projectOffset || v.next.projectOffset === v.projectOffset && v.next.offset > v.offset)
      && (v.next.projectOffset === 0 || v.source === 'helpers' || v.source === 'dispatcher-auto' || v.source === 'tool-records' || v.source === 'canvas-records' || v.source === 'zone-records'));
}
