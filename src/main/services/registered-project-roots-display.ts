/** Private bounded registered roots for already admitted selected relationship readers.
 * Neither this result nor its paths/receipts are wire DTOs or discovery authority.
 */
import * as path from 'path';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { getBaseDirPath } from './base-dir';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { readReadOnlyPrimaryMetadata, createReadOnlyMetadataBudget, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
import { display } from './remote-details-presentation';
export const DISPLAY_REGISTERED_ROOT_PAGE = 16;
export const DISPLAY_REGISTERED_ROOT_ROWS = 4096;
export interface RegisteredProjectDisplayRoot { id: string; path: string; name: DisplayValue<string> }
export interface RegisteredProjectDisplayRoots {
  roots: RegisteredProjectDisplayRoot[];
  /** At most4096 validated paths, private alias admission only. */
  registeredPaths: ReadonlySet<string>;
  /** Private validated ID→path associations; never a DTO or live registration. */
  projectPaths: ReadonlyMap<string, string>;
  /** Only an explicitly requested related registered path; private caller input/output. */
  relatedProject?: RegisteredProjectDisplayRoot;
  total: number;
  offset: number;
  nextOffset: number | null;
  receipt: DisplayReceipt;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
function receipt(base: string, target: DisplayReceipt, primary: DisplayReceipt): DisplayReceipt {
  return { current: () => getBaseDirPath() === base && current(target) && current(primary) };
}
/** Caller provides a strict selected target/role receipt and retains separate
 * transport/pin/auth/run authority. Registry reads<=4MiB/4096 visits; max16
 * roots returned. All names are redacted/bounded; no ordinary owner loaded. */
export function readRegisteredProjectRootsForDisplay(selected: { projectId: string; projectPath: string; receipt: DisplayReceipt }, options: {
  authorized(): boolean; receipts: DisplayReceipt[]; offset?: number; relatedProjectPath?: string;
}): DisplayValue<RegisteredProjectDisplayRoots> {
  const inputs = [{ field: 'Selected registered project roots', source: 'primary' as const, observedAt: Date.now() }];
  const unknown = (reason: 'invalid' | 'changed' | 'unreadable' | 'limit'): DisplayValue<RegisteredProjectDisplayRoots> => ({ state: 'unavailable', reason, inputs });
  const offset = options.offset ?? 0;
  if (!selected || !id(selected.projectId) || !folder(selected.projectPath) || typeof selected.receipt?.current !== 'function'
    || options.relatedProjectPath !== undefined && !folder(options.relatedProjectPath)
    || !Array.isArray(options.receipts) || !Number.isInteger(offset) || offset < 0 || offset > DISPLAY_REGISTERED_ROOT_ROWS) return unknown('invalid');
  const relatedProjectPath = options.relatedProjectPath, projectId = selected.projectId, projectPath = selected.projectPath, target = selected.receipt, authorized = options.authorized, receipts = options.receipts;
  const admitted = () => { try { return authorized() && current(target); } catch { return false; } };
  if (!admitted()) return unknown('changed');
  const base = getBaseDirPath();
  try {
    const snapshot = readReadOnlyPrimaryMetadata(base, 'projects.json', { budget: createReadOnlyMetadataBudget() });
    const rows = Array.isArray(snapshot.raw) ? snapshot.raw : record(snapshot.raw) && snapshot.raw.version === 1 ? snapshot.raw.projects : undefined;
    if (!Array.isArray(rows)) return unknown('unreadable');
    if (rows.length > DISPLAY_REGISTERED_ROOT_ROWS) return unknown('limit');
    const ids = new Set<string>(), paths = new Set<string>(), projectPaths = new Map<string, string>(), page: RegisteredProjectDisplayRoot[] = [];
    let found = false, relatedProject: RegisteredProjectDisplayRoot | undefined;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!record(row) || !id(row.id) || !folder(row.path) || ids.has(row.id) || paths.has(row.path)) return unknown('unreadable');
      ids.add(row.id); paths.add(row.path); projectPaths.set(row.id, row.path); if (row.id === projectId && row.path === projectPath) found = true;
      const inPage = index >= offset && index < offset + DISPLAY_REGISTERED_ROOT_PAGE;
      if (!inPage && row.path !== relatedProjectPath) continue;
      const name = typeof row.displayName === 'string' && row.displayName ? row.displayName : row.name;
      const entry = { id: row.id, path: row.path, name: typeof name === 'string' && name.length <= 1024 ? { state: 'ok', value: display(name, 240), inputs }
        : { state: 'unavailable', reason: typeof name === 'string' ? 'limit' : 'invalid', inputs } } as RegisteredProjectDisplayRoot;
      if (inPage) page.push(entry); if (row.path === relatedProjectPath) relatedProject = entry;
    }
    if (projectId !== DISPATCHER_PROJECT_ID && !found || offset > 0 && offset >= rows.length) return unknown('changed');
    const evidence = receipt(base, target, snapshot.receipt); receipts.push(evidence);
    if (!admitted() || !evidence.current()) return unknown('changed');
    return { state: 'ok', inputs, value: { roots: page, registeredPaths: paths, projectPaths, ...(relatedProject && { relatedProject }), total: rows.length, offset,
      nextOffset: offset + page.length < rows.length ? offset + page.length : null, receipt: evidence } };
  } catch (error) { return unknown(error instanceof ReadOnlyMetadataLimitError ? 'limit' : 'unreadable'); }
}
