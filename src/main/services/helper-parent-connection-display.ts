/** Exact selected helper's saved parent reference. No global native-ID lookup or owner load. */
import * as path from 'path';
import { AUTOMATIC_CONNECTION_SWITCHES } from '../../shared/connection-grants';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import type { ConnectionEndpointFields } from './connection-endpoint-fields-display';
import type { ConfiguredRegisteredConnectionPage } from './configured-registered-connections-display';
import { readRegisteredProjectRootsForDisplay } from './registered-project-roots-display';
import { readConnectionEndpointMetadataForDisplay } from './connection-endpoint-metadata-display';
import { hasAsciiControl } from '../../shared/ascii-control';
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !hasAsciiControl(v) && !v.includes('||') && !v.includes('@');
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
function combine(rs: readonly DisplayReceipt[]): DisplayReceipt { const captured = [...new Set(rs)]; return { current: () => captured.every(current) }; }
/** Caller binds these exact parent fields to its selected primary and keeps the
 * strict target/run/role/auth fences. One registry<=4MiB/4096 rows, one related
 * primary<=4MiB/4096 rows and one selected reference. No cache warming.
 * Unregistered/alias-only parent project is explicit unknown, never name/global-ID fallback. */
export function readHelperParentConnectionForDisplay(selected: { agentId: string; projectId: string; projectPath: string; receipt: DisplayReceipt; fields: ConnectionEndpointFields; parentAgentId?: unknown; parentProjectPath?: unknown }, options: {
  authorized(): boolean; receipts: DisplayReceipt[]; offset?: number; projectOffset?: number;
}): DisplayValue<ConfiguredRegisteredConnectionPage> {
  const observedAt = Date.now(), inputs = [{ field: 'Selected helper saved parent reference', source: 'primary' as const, observedAt }];
  const unknown = (reason: 'invalid' | 'changed' | 'unreadable'): DisplayValue<ConfiguredRegisteredConnectionPage> => ({ state: 'unavailable', reason, inputs });
  if (!selected || !id(selected.agentId) || selected.fields?.id !== selected.agentId || !Array.isArray(options.receipts) || (options.offset ?? 0) !== 0 || (options.projectOffset ?? 0) !== 0) return unknown('invalid');
  const target = selected.receipt, authorized = options.authorized, receipts = options.receipts, parentId = selected.parentAgentId, parentPath = selected.parentProjectPath ?? selected.projectPath, start = receipts.length;
  const admitted = () => { try { return authorized() && current(target); } catch { return false; } }; if (!admitted()) return unknown('changed');
  const page: ConfiguredRegisteredConnectionPage = { entries: [], knownMatches: 0, complete: true, unknownRows: 0, unavailableProjects: 0, next: null, projectOffset: 0, matchOffset: 0, observedAt };
  if (parentId === undefined || parentId === '') { receipts.push(target); return { state: 'ok', value: page, inputs }; }
  if (!id(parentId) || parentId === selected.agentId || !folder(parentPath)) return unknown('invalid');
  const roots = readRegisteredProjectRootsForDisplay(selected, { authorized, receipts, relatedProjectPath: parentPath }); if (roots.state !== 'ok') return roots;
  const related = roots.value.relatedProject;
  page.parentReference = { agentId: parentId, ...(related && { projectName: related.name }) }; page.knownMatches = 1;
  if (!related) { page.complete = false; page.unavailableProjects = 1; return finish(); }
  const association = combine([target, roots.value.receipt]);
  const metadata = readConnectionEndpointMetadataForDisplay([{ agentId: parentId, projectPath: parentPath, association }], { receipts });
  const parent = metadata.state === 'ok' ? metadata.value[0] : metadata;
  if (parent.state !== 'ok' || parent.value.record !== 'registered-primary') { page.complete = false; page.unknownRows = 1; }
  else {
    const fields = parent.value.fields, disposed = fields.disposed.state === 'ok' ? fields.disposed.value : undefined, selectedDisposed = selected.fields.disposed.state === 'ok' ? selected.fields.disposed.value : undefined;
    const applicability = disposed || selectedDisposed ? 'disposed' : disposed === false && selectedDisposed === false ? 'configured' : 'unknown';
    page.entries.push({ endpoint: { agentId: parentId, projectId: related.id, projectName: related.name, fields }, source: 'helper-parent', applicability,
      directions: applicability === 'configured' ? [{ from: 'selected', disabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.helperToParent.disabledTools], enabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.helperToParent.enabledTools] },
        { from: 'endpoint', disabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.parentToHelper.disabledTools], enabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.parentToHelper.enabledTools] }] : [] });
    page.knownMatches = 1; if (applicability === 'unknown') { page.complete = false; page.unknownRows = 1; }
  }
  return finish();
  function finish(): DisplayValue<ConfiguredRegisteredConnectionPage> {
    const final = combine([target, ...receipts.slice(start)]); receipts.push(final); if (!admitted() || !final.current()) return unknown('changed');
    return { state: 'ok', value: page, inputs };
  }
}
