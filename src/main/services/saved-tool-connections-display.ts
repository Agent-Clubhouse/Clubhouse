/** Selected recorded tool-created links from registered project primaries.
 * Does not call the operational source collector or infer its current scope/grants.
 */
import * as path from 'path';
import { AUTOMATIC_CONNECTION_SWITCHES } from '../../shared/connection-grants';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import { readRegisteredProjectRootsForDisplay } from './registered-project-roots-display';
import { readReadOnlyConnectionSourceMetadata, createReadOnlyMetadataBudget, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
import { readConnectionEndpointMetadataForDisplay, type AdmittedConnectionEndpoint, type ConnectionEndpointMetadata } from './connection-endpoint-metadata-display';
import { hasAsciiControl } from '../../shared/ascii-control';

export interface SavedToolConnectionDisplay {
  agentId: string;
  targetId: string;
  targetKind: 'agent' | 'group-project';
  direction: 'outgoing' | 'incoming';
  sourceProjectId: string;
  sourceProjectName: DisplayValue<string>;
  createdAt?: string;
  /** Saved declarations only; not the operational scope/grant evaluation. */
  declaredScope: 'granted' | 'helper-family' | 'unknown';
  disabledTools: string[];
  enabledTools: string[];
  endpoint?: DisplayValue<ConnectionEndpointMetadata>;
}
export interface SavedToolConnectionPage {
  rows: SavedToolConnectionDisplay[];
  knownMatches: number;
  complete: boolean;
  unknownRows: number;
  unavailableProjects: number;
  projectOffset: number;
  offset: number;
  next: { projectOffset: number; offset: number } | null;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !hasAsciiControl(v) && !v.includes('@') && !v.includes('||');
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const current = (r: DisplayReceipt) => { try { return r.current(); } catch { return false; } };
function combine(rs: readonly DisplayReceipt[]): DisplayReceipt { const captured = [...new Set(rs)]; return { current: () => captured.every(current) }; }
const date = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 128 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;

/** Strict selected target/role admission is caller-owned. No paths come from
 * route params. At most16 source roots,4096 total source-row visits,8 related
 * rows plus8 direct endpoint queries; registry and endpoint readers have their
 * own explicit bounded budgets. Keep ALL returned private receipts through
 * final response serialization; separate run/pin/revocation authority remains.
 * Recorded links are useful even when current eligibility cannot be proven,
 * but must NEVER be called live/connected/authorized on this evidence alone. */
export function readSavedToolConnectionsForDisplay(selected: { agentId: string; projectId: string; projectPath: string; receipt: DisplayReceipt }, options: {
  authorized(): boolean; receipts: DisplayReceipt[]; projectOffset?: number; offset?: number;
}): DisplayValue<SavedToolConnectionPage> {
  const inputs = [{ field: 'Selected saved tool-created connection records', source: 'primary' as const, observedAt: Date.now() }];
  const unknown = (reason: 'invalid' | 'changed' | 'limit' | 'unreadable'): DisplayValue<SavedToolConnectionPage> => ({ state: 'unavailable', reason, inputs });
  const projectOffset = options.projectOffset ?? 0, offset = options.offset ?? 0;
  if (!selected || !id(selected.agentId) || !folder(selected.projectPath) || typeof selected.receipt?.current !== 'function'
    || !Array.isArray(options.receipts) || !Number.isInteger(offset) || offset < 0 || offset > 4096) return unknown('invalid');
  const selectedId = selected.agentId, selectedProject = selected.projectId, selectedPath = selected.projectPath, target = selected.receipt, authorized = options.authorized, receipts = options.receipts;
  const admitted = () => { try { return authorized() && current(target); } catch { return false; } };
  if (!admitted()) return unknown('changed');
  const start = receipts.length, roots = readRegisteredProjectRootsForDisplay({ projectId: selectedProject, projectPath: selectedPath, receipt: target }, { authorized, receipts, offset: projectOffset });
  if (roots.state !== 'ok') return roots;
  const rows: SavedToolConnectionDisplay[] = [], queries: AdmittedConnectionEndpoint[] = [], queryPositions: number[] = [], budget = createReadOnlyMetadataBudget();
  let complete = true, unknownRows = 0, unavailableProjects = 0, knownMatches = 0, visitsLeft = 4096, deferredProject: number | undefined;
  for (const [index, project] of roots.value.roots.entries()) {
    if (!admitted() || !current(roots.value.receipt)) return unknown('changed');
    try {
      const data = readReadOnlyConnectionSourceMetadata(project.path, '.clubhouse/.local/orchestrator-connections.json', { budget });
      const association = combine([target, roots.value.receipt, data.receipt]); receipts.push(association);
      if (data.missing) continue;
      if (!record(data.raw) || data.raw.version !== 1 || !Array.isArray(data.raw.connections)) { unavailableProjects++; complete = false; continue; }
      if (data.raw.connections.length > visitsLeft) {
        if (data.raw.connections.length <= 4096 && index > 0) { deferredProject = projectOffset + index; break; }
        unavailableProjects++; complete = false; continue;
      }
      visitsLeft -= data.raw.connections.length;
      for (const raw of data.raw.connections) {
        if (!record(raw) || !id(raw.agentId) || !id(raw.targetId)) { unknownRows++; complete = false; continue; }
        const outgoing = raw.agentId === selectedId;
        if (!outgoing && (raw.targetId !== selectedId || raw.targetKind !== 'agent')) continue;
        const fromProject = raw.agentProjectPath === undefined ? project.path : raw.agentProjectPath;
        const toProject = raw.targetProjectPath === undefined ? project.path : raw.targetProjectPath;
        const selectedEnd = outgoing ? fromProject : toProject;
        if (folder(selectedEnd) && selectedEnd !== selectedPath) continue;
        if (!folder(selectedEnd) || !id(raw.ownerId) || typeof raw.targetKind !== 'string' || !['agent', 'group-project'].includes(raw.targetKind)) { unknownRows++; complete = false; continue; }
        knownMatches++;
        if (knownMatches <= offset || rows.length >= 8) continue;
        const row: SavedToolConnectionDisplay = { agentId: raw.agentId, targetId: raw.targetId, targetKind: raw.targetKind as SavedToolConnectionDisplay['targetKind'], direction: outgoing ? 'outgoing' : 'incoming',
          sourceProjectId: project.id, sourceProjectName: project.name, createdAt: date(raw.createdAt), declaredScope: raw.scope === 'granted' ? 'granted' : raw.scope === undefined ? 'helper-family' : 'unknown',
          disabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink.disabledTools], enabledTools: [...AUTOMATIC_CONNECTION_SWITCHES.orchestratorLink.enabledTools] };
        const position = rows.push(row) - 1;
        if (raw.targetKind === 'agent') {
          const otherProject = outgoing ? toProject : fromProject;
          if (folder(otherProject)) { queries.push({ agentId: outgoing ? raw.targetId : raw.agentId, projectPath: otherProject, association }); queryPositions.push(position); }
          else row.endpoint = { state: 'unavailable', reason: 'invalid', inputs };
        }
      }
    } catch (error) {
      if (error instanceof ReadOnlyMetadataLimitError && error.reason === 'aggregate' && index > 0) { deferredProject = projectOffset + index; break; }
      unavailableProjects++; complete = false;
    }
  }
  if (!admitted()) return unknown('changed');
  if (queries.length) {
    const metadata = readConnectionEndpointMetadataForDisplay(queries, { receipts });
    for (let i = 0; i < queryPositions.length; i++) rows[queryPositions[i]].endpoint = metadata.state === 'ok' ? metadata.value[i] : { state: 'unavailable', reason: metadata.reason, inputs: metadata.inputs };
  }
  const final = combine([target, ...receipts.slice(start)]); receipts.push(final);
  if (!admitted() || !final.current()) return unknown('changed');
  if (offset > 0 && offset >= knownMatches) return unknown('changed');
  const next = knownMatches > offset + rows.length ? { projectOffset, offset: offset + rows.length }
    : deferredProject !== undefined ? { projectOffset: deferredProject, offset: 0 }
      : roots.value.nextOffset !== null ? { projectOffset: roots.value.nextOffset, offset: 0 } : null;
  return { state: 'ok', inputs, value: { rows, knownMatches, complete, unknownRows, unavailableProjects, projectOffset, offset, next } };
}
