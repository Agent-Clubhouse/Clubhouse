/** Selected saved group policies/membership, never the operational membership resolver. */
import * as path from 'path';
import { app } from 'electron';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import { isMachineFingerprint, parseAgentAddress } from '../../shared/agent-address';
import { GROUP_PROJECT_TOOL_SUFFIXES } from '../../shared/group-project-permissions';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import type { ConnectionEndpointFields } from './connection-endpoint-fields-display';
import { readRegisteredProjectRootsForDisplay } from './registered-project-roots-display';
import { createReadOnlyMetadataBudget, readReadOnlyConnectionSourceMetadata, ReadOnlyMetadataLimitError, type ReadOnlyConnectionSourceMetadata } from './read-only-agent-target-witness';
import { matchLoadedIdentityForDisplay } from './annex-identity';
import { display } from './remote-details-presentation';
export interface SavedGroupConnection {
  groupId: string; name: string; membership: 'explicit' | 'auto' | 'excluded'; applicability: 'configured' | 'disposed' | 'excluded' | 'out-of-scope' | 'unknown';
  scope: 'app' | 'project' | 'unknown'; reach: 'local' | 'network' | 'unknown';
  host: 'local-contract' | 'loaded-local' | 'loaded-other' | 'unknown';
  disabledTools?: string[]; unrecognizedTools: number; switchSource: 'member' | 'group' | 'absent' | 'invalid';
}
export interface SavedGroupConnectionPage {
  rows: SavedGroupConnection[]; complete: boolean; unknownRows: number; unavailableGroups: number; knownMatches: number;
  offset: number; next: { offset: number; projectOffset: number } | null;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const groupId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
function combine(rs: readonly DisplayReceipt[]): DisplayReceipt { const captured = [...new Set(rs)]; return { current: () => captured.every(current) }; }
/** At most8 registry groups/page,4096 registry/tombstone entries and4096 total
 * member/exclusion visits;4MiB/file +8MiB membership-body budget. Addresses are
 * host-relative; exact selected project/primary and loaded local-machine
 * association must bind a record before its name/tools are returned. No raw
 * addresses/fingerprints, other members, prompts, descriptions/config or grants. */
export function readSavedGroupConnectionsForDisplay(selected: { agentId: string; projectId: string; projectPath: string; fields: ConnectionEndpointFields; receipt: DisplayReceipt }, options: {
  authorized(): boolean; receipts: DisplayReceipt[]; offset?: number; projectOffset?: number;
}): DisplayValue<SavedGroupConnectionPage> {
  const inputs = [{ field: 'Selected saved group relationships', source: 'primary' as const, observedAt: Date.now() }];
  const unknown = (reason: 'invalid' | 'changed' | 'unreadable' | 'limit'): DisplayValue<SavedGroupConnectionPage> => ({ state: 'unavailable', reason, inputs });
  const offset = options.offset ?? 0;
  if (!selected || !id(selected.agentId) || selected.fields?.id !== selected.agentId || !Array.isArray(options.receipts) || !Number.isInteger(offset) || offset < 0 || offset > 4096 || (options.projectOffset ?? 0) !== 0) return unknown('invalid');
  const target = selected.receipt, authorized = options.authorized, receipts = options.receipts, start = receipts.length;
  const admitted = () => { try { return authorized() && current(target); } catch { return false; } }; if (!admitted()) return unknown('changed');
  const roots = readRegisteredProjectRootsForDisplay(selected, { authorized, receipts }); if (roots.state !== 'ok') return roots;
  const home = app.getPath('home'), packaged = !!app.isPackaged, directory = `${packaged ? '.clubhouse' : '.clubhouse-dev'}/group-projects/`;
  receipts.push({ current: () => app.getPath('home') === home && !!app.isPackaged === packaged });
  const page: SavedGroupConnectionPage = { rows: [], complete: true, unknownRows: 0, unavailableGroups: 0, knownMatches: 0, offset, next: null };
  const matches = new Map<string, DisplayValue<boolean>>();
  const localMachine = (value: unknown): boolean | undefined => {
    if (typeof value !== 'string' || value.length > 95) return undefined;
    const candidate = value.toLowerCase(); let result = matches.get(candidate);
    if (!result) { if (matches.size >= 16) return undefined; result = matchLoadedIdentityForDisplay(candidate, { receipts }); matches.set(candidate, result); }
    return result.state === 'ok' ? result.value : undefined;
  };
  try {
    const registry = readReadOnlyConnectionSourceMetadata(home, (directory + 'registry.json') as ReadOnlyConnectionSourceMetadata, { budget: createReadOnlyMetadataBudget() }); receipts.push(registry.receipt);
    const tombstones = readReadOnlyConnectionSourceMetadata(home, (directory + 'tombstones.json') as ReadOnlyConnectionSourceMetadata, { budget: createReadOnlyMetadataBudget() }); receipts.push(tombstones.receipt);
    const hidden = new Set<string>();
    if (!tombstones.missing) {
      if (!Array.isArray(tombstones.raw) || tombstones.raw.length > 4096) return unknown('unreadable');
      for (const t of tombstones.raw) { if (!record(t) || !groupId(t.groupProjectId)) return unknown('unreadable'); hidden.add(t.groupProjectId); }
    }
    if (registry.missing) return finish();
    if (!Array.isArray(registry.raw) || registry.raw.length > 4096) return unknown('limit');
    const ids = new Set<string>(); for (const g of registry.raw) { if (!record(g) || !groupId(g.id) || ids.has(g.id) || typeof g.name !== 'string' || !g.name || g.name.length > 1024 || typeof g.createdAt !== 'string' || g.createdAt.length > 128 || !record(g.metadata) || g.description !== undefined && typeof g.description !== 'string' || g.instructions !== undefined && typeof g.instructions !== 'string') return unknown('unreadable'); ids.add(g.id); }
    if (offset > 0 && offset >= registry.raw.length) return unknown('changed');
    const budget = createReadOnlyMetadataBudget(); let rowsLeft = 4096, consumed = 0;
    for (const g of registry.raw.slice(offset, offset + 8)) {
      if (!admitted() || !roots.value.receipt.current() || !registry.receipt.current() || !tombstones.receipt.current()) return unknown('changed');
      consumed++; if (!record(g) || !groupId(g.id) || hidden.has(g.id)) continue;
      try {
        const read = readReadOnlyConnectionSourceMetadata(path.join(home, directory, g.id), 'membership.json', { budget }); receipts.push(read.receipt);
        // Missing membership means unmanaged: Canvas/source records are separate,
        // not an inferred default empty membership or automatic migration.
        if (read.missing) continue;
        const m = read.raw;
        if (!record(m) || m.version !== 1 || typeof m.autoJoin !== 'boolean' || !Array.isArray(m.explicit) || !Array.isArray(m.excluded)) throw new Error('Invalid saved membership.');
        if (m.explicit.length + m.excluded.length > rowsLeft) { if (m.explicit.length + m.excluded.length <= 4096 && consumed > 1) { consumed--; break; } page.complete = false; page.unavailableGroups++; continue; }
        rowsLeft -= m.explicit.length + m.excluded.length;
        const scope = record(g.scope) && ['app', 'project'].includes(String(g.scope.level)) && ['local', 'network'].includes(String(g.scope.reach)) ? g.scope : undefined;
        const inScope = scope?.level === 'app' || scope?.level === 'project' && scope.projectId === selected.projectId;
        const hostMachine = g.host === undefined || record(g.host) && g.host.machine === null ? null : record(g.host) && typeof g.host.machine === 'string' && g.host.machine.length <= 95 && isMachineFingerprint(g.host.machine) ? g.host.machine.toLowerCase() : undefined;
        const localHost = hostMachine === null ? true : localMachine(hostMachine);
        const addresses = new Set<string>(); let explicit: Record<string, unknown> | undefined, excluded = false, ambiguous = false, policyAddress: string | undefined;
        const relevant = (entry: unknown, exclusion = false): entry is Record<string, unknown> & { address: string } => {
          if (!record(entry) || typeof entry.address !== 'string' || entry.address.length > 512) throw new Error('Invalid membership address.');
          const address = parseAgentAddress(entry.address); if (!id(address.agentId)) throw new Error('Invalid member ID.');
          const normalized = JSON.stringify([address.agentId, address.machine ?? hostMachine]); if (addresses.has(normalized)) throw new Error('Duplicate membership address.'); addresses.add(normalized);
          if (address.agentId !== selected.agentId) return false;
          const machine = address.machine ? localMachine(address.machine) : localHost;
          if (machine === false) return false;
          const project = entry.projectId === selected.projectId || entry.projectId === undefined && scope?.level === 'project' && scope.projectId === selected.projectId
            || exclusion && entry.projectId === undefined && explicit !== undefined
            || record(entry.autoProject) && entry.autoProject.projectId === selected.projectId && localMachine(entry.autoProject.machine) === true;
          if (machine !== true || !project) { ambiguous = true; return false; }
          policyAddress = entry.address; return true;
        };
        for (const e of m.explicit) { if (!record(e) || typeof e.addedAt !== 'string' || e.addedAt.length > 128 || !['durable', 'helper', 'quick'].includes(String(e.kind))) throw new Error('Invalid explicit member.'); if (relevant(e)) { if (explicit || !['durable', 'helper', 'quick'].includes(String(e.kind))) throw new Error('Ambiguous selected membership.'); explicit = e; } }
        addresses.clear(); for (const e of m.excluded) { if (!record(e) || typeof e.excludedAt !== 'string' || e.excludedAt.length > 128) throw new Error('Invalid exclusion.'); if (relevant(e, true)) excluded = true; }
        const helper = selected.fields.helper.state === 'ok' ? selected.fields.helper.value : undefined, disposed = selected.fields.disposed.state === 'ok' ? selected.fields.disposed.value : undefined;
        const automatic = selected.projectId !== DISPATCHER_PROJECT_ID && m.autoJoin && inScope && localHost === true && helper === false && disposed === false;
        if (ambiguous) { page.complete = false; page.unknownRows++; }
        if (!explicit && !excluded && !automatic) continue;
        if (typeof g.name !== 'string' || !g.name || g.name.length > 1024) throw new Error('Invalid selected group name.');
        let disabled: unknown, switchSource: SavedGroupConnection['switchSource'] = 'absent';
        const key = policyAddress ?? selected.agentId;
        if (record(m.disabledTools) && Object.prototype.hasOwnProperty.call(m.disabledTools, key)) { disabled = m.disabledTools[key]; switchSource = 'member'; }
        else if (record(g.metadata) && Object.prototype.hasOwnProperty.call(g.metadata, 'defaultDisabledTools')) { disabled = g.metadata.defaultDisabledTools; switchSource = 'group'; }
        const validTools = Array.isArray(disabled) && disabled.length <= 64 && disabled.every(id), toolList = validTools ? disabled as string[] : [], knownTools = toolList.filter((t) => (GROUP_PROJECT_TOOL_SUFFIXES as readonly string[]).includes(t));
        if (disabled !== undefined && !validTools) switchSource = 'invalid';
        page.rows.push({ groupId: g.id, name: display(g.name, 240), membership: excluded ? 'excluded' : explicit ? 'explicit' : 'auto', applicability: excluded ? 'excluded' : disposed === true ? 'disposed' : ambiguous || localHost === undefined || selected.projectId === DISPATCHER_PROJECT_ID || !scope || disposed !== false || explicit?.kind === 'quick' ? 'unknown' : !inScope ? 'out-of-scope' : 'configured',
          scope: scope?.level as SavedGroupConnection['scope'] ?? 'unknown', reach: scope?.reach as SavedGroupConnection['reach'] ?? 'unknown', host: hostMachine === null ? 'local-contract' : localHost === true ? 'loaded-local' : localHost === false ? 'loaded-other' : 'unknown',
          ...(validTools && { disabledTools: knownTools }), unrecognizedTools: validTools ? toolList.length - knownTools.length : 0, switchSource }); page.knownMatches++;
      } catch (error) {
        if (error instanceof ReadOnlyMetadataLimitError && error.reason === 'aggregate' && consumed > 1) { consumed--; break; }
        page.complete = false; page.unavailableGroups++;
      }
    }
    if (offset + consumed < registry.raw.length) page.next = { offset: offset + consumed, projectOffset: 0 };
    return finish();
  } catch (error) { return unknown(error instanceof ReadOnlyMetadataLimitError ? 'limit' : 'unreadable'); }
  function finish(): DisplayValue<SavedGroupConnectionPage> {
    const final = combine([target, ...receipts.slice(start)]); receipts.push(final); if (!admitted() || !final.current()) return unknown('changed');
    return { state: 'ok', value: page, inputs };
  }
}
