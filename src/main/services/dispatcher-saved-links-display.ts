/** Committed selected manual Dispatcher links, not effective bindings or permissions. */
import { createHash } from 'crypto';
import * as path from 'path';
import { getBaseDirPath } from './base-dir';
import { peekMetadataFileForDisplaySync } from './settings-store';
import type { DisplayReceipt, DisplayValue } from './display-settings';

export const SAVED_LINK_DISPLAY_BYTES = 1024 * 1024;
export const SAVED_LINK_DISPLAY_SCAN = 4096;
export const SAVED_LINK_DISPLAY_PAGE = 50;
export interface SavedDispatcherLinkDisplay {
  agentId: string;
  targetId: string;
  createdBy: string;
  createdAt: string;
  /** Committed primary/pending-file evidence only; not the live removal queue. */
  removalRecorded: DisplayValue<boolean>;
}
export interface SavedDispatcherLinksPage {
  scope: 'committed-dispatcher-links';
  rows: SavedDispatcherLinkDisplay[];
  total: number;
  offset: number;
  omitted: number;
  nextOffset: number | null;
  /** Same native ID saved against another project is not this admitted agent. */
  excludedProjectRecords: number;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const date = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 128 && Number.isFinite(Date.parse(v));
const offsetValid = (offset: number) => Number.isSafeInteger(offset) && offset >= 0 && offset <= SAVED_LINK_DISPLAY_SCAN;
const key = (r: { agentId: string; targetId: string }) => `${r.agentId}\0${r.targetId}`;

function project(selected: string, projectPath: string, offset: number, baseDir: string): DisplayValue<SavedDispatcherLinksPage> {
  const inputs = [{ field: 'Selected saved Dispatcher links', source: 'primary' as const, observedAt: Date.now() }];
  const known = <T>(value: T): DisplayValue<T> => ({ state: 'ok', value, inputs });
  const unavailable = <T>(reason: 'invalid' | 'unreadable' | 'limit' = 'invalid'): DisplayValue<T> => ({ state: 'unavailable', reason, inputs });
  if (!id(selected) || !folder(projectPath) || !folder(baseDir) || !offsetValid(offset)) return unavailable();
  // Fixed host-owned metadata paths only. No store load/locks/recovery or census.
  const read = (name: string) => {
    const file = path.join(baseDir, name);
    const raw = peekMetadataFileForDisplaySync(file, SAVED_LINK_DISPLAY_BYTES);
    if (raw === 'missing' && peekMetadataFileForDisplaySync(file + '.bak', SAVED_LINK_DISPLAY_BYTES) !== 'missing') return 'unreadable' as const;
    return raw;
  };
  const raw = read('dispatcher-connections.json');
  if (raw === 'unreadable') return unavailable('unreadable');
  if (raw !== 'missing' && (raw.version !== 1 || !Array.isArray(raw.connections))) return unavailable();
  const entries: unknown[] = raw === 'missing' ? [] : raw.connections as unknown[];
  if (entries.length > SAVED_LINK_DISPLAY_SCAN) return unavailable('limit');
  const pending = read('dispatcher-connections.pending-removals.json');
  const removals = raw === 'missing' ? [] : raw.removedByUser;
  const pendingRows = pending === 'missing' ? [] : pending === 'unreadable' || pending.version !== 1 ? undefined : pending.removals;
  // Independent useful link fields survive unknown removal records. No false
  // active/default-Allowed inference may be made from removalRecorded alone.
  let removalsKnown = Array.isArray(removals) && Array.isArray(pendingRows);
  let removalReason: 'invalid' | 'unreadable' | 'limit' = pending === 'unreadable' ? 'unreadable' : 'invalid';
  const removed = new Set<string>();
  if (removalsKnown) {
    if (entries.length + (removals as unknown[]).length + (pendingRows as unknown[]).length > SAVED_LINK_DISPLAY_SCAN) { removalsKnown = false; removalReason = 'limit'; }
    else for (const removal of [...removals as unknown[], ...pendingRows as unknown[]]) {
      if (!record(removal) || !id(removal.agentId) || !id(removal.targetId)) { removalsKnown = false; break; }
      if (removal.agentId !== selected && removal.targetId !== selected) continue;
      if (!date(removal.removedAt)) { removalsKnown = false; break; }
      // Ordinary pending records may omit paths when their original store was
      // unavailable. They still apply to this native pair, as the owner does.
      removed.add(key({ agentId: removal.agentId, targetId: removal.targetId }));
    }
  }
  const rows: SavedDispatcherLinkDisplay[] = [], seen = new Set<string>();
  let excludedProjectRecords = 0;
  for (const entry of entries) {
    if (!record(entry) || !id(entry.agentId) || !id(entry.targetId)) return unavailable();
    if (entry.agentId !== selected && entry.targetId !== selected) continue;
    if (!folder(entry.agentProjectPath) || !folder(entry.targetProjectPath) || !id(entry.createdBy) || !date(entry.createdAt) || entry.agentId === entry.targetId) return unavailable();
    if ((entry.agentId === selected && entry.agentProjectPath !== projectPath) || (entry.targetId === selected && entry.targetProjectPath !== projectPath)) { excludedProjectRecords++; continue; }
    const k = key({ agentId: entry.agentId, targetId: entry.targetId });
    if (seen.has(k)) return unavailable();
    seen.add(k);
    rows.push({ agentId: entry.agentId, targetId: entry.targetId, createdBy: entry.createdBy, createdAt: entry.createdAt,
      removalRecorded: removalsKnown ? known(removed.has(k)) : unavailable(removalReason) });
  }
  const page = rows.slice(offset, offset + SAVED_LINK_DISPLAY_PAGE);
  return known({ scope: 'committed-dispatcher-links', rows: page, total: rows.length, offset, omitted: rows.length - page.length,
    nextOffset: offset + page.length < rows.length ? offset + page.length : null, excludedProjectRecords });
}
const signature = (value: DisplayValue<SavedDispatcherLinksPage>) => createHash('sha256').update(JSON.stringify(value, (k, v) => k === 'inputs' ? undefined : v)).digest('hex');
function receipt(selected: string, projectPath: string, offset: number, baseDir: string, admitted: string): DisplayReceipt {
  return { current: () => { try { return getBaseDirPath() === baseDir && signature(project(selected, projectPath, offset, baseDir)) === admitted; } catch { return false; } } };
}
/** Caller must supply a strictly admitted selected ID/project and retain its own final target/role/auth receipt. */
export function readSavedDispatcherLinksForDisplay(selected: string, projectPath: string, options: { offset?: number; receipts?: DisplayReceipt[] } = {}): DisplayValue<SavedDispatcherLinksPage> {
  const offset = options.offset ?? 0, baseDir = getBaseDirPath(), value = project(selected, projectPath, offset, baseDir);
  if (id(selected) && folder(projectPath) && folder(baseDir) && offsetValid(offset)) options.receipts?.push(receipt(selected, projectPath, offset, baseDir, signature(value)));
  return value;
}
