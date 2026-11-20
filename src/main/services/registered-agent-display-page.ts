/** Internal selected relationship inventory for Connections. No ordinary loaders or raw config retention. */
import * as fs from 'fs';
import * as path from 'path';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import type { DisplayInput, DisplayReceipt, DisplayValue } from './display-settings';
import { getBaseDirPath } from './base-dir';
import { createReadOnlyMetadataBudget, readReadOnlyPrimaryMetadata, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
import { projectConnectionEndpointFieldsForDisplay, type ConnectionEndpointFields } from './connection-endpoint-fields-display';
import { display } from './remote-details-presentation';

export const REGISTERED_DISPLAY_PROJECTS = 16;
export const REGISTERED_DISPLAY_ROWS = 4096;
export const REGISTERED_DISPLAY_MATCHES = 50;
export const REGISTERED_DISPLAY_ALIAS_PROBES = 64;
interface Project { id: string; path: string; name: DisplayValue<string> }
export interface RegisteredDisplayAgent {
  agentId: string;
  projectId: string;
  projectName: DisplayValue<string>;
  fields: ConnectionEndpointFields;
  /** Included only after the selected parent/project relationship is established. */
  parentAgentId?: string;
}
export interface RegisteredDisplayRoot { projectPath: string; namespace?: string; receipt: DisplayReceipt }
export interface RegisteredAgentDisplayPage {
  entries: RegisteredDisplayAgent[];
  /** Completeness of this root page; next may still identify more registered roots. */
  complete: boolean;
  knownMatches: number;
  unknownRows: number;
  unavailableProjects: number;
  /** More registered roots, or more matching entries within the same root page. */
  next: { projectOffset: number; matchOffset: number } | null;
  projectOffset: number;
  matchOffset: number;
  observedAt: number;
}
export interface RegisteredDisplaySelection {
  agentId: string;
  projectId: string;
  projectPath: string;
  /** Strict selected target/role admission; caller separately retains transport/run authority. */
  receipt: DisplayReceipt;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const localId = (v: unknown): v is string => id(v) && !v.includes('@') && !v.includes('||');
const folder = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && path.isAbsolute(v) && !v.includes('\0');
const current = (receipt: DisplayReceipt) => { try { return receipt.current(); } catch { return false; } };
/** Keep receipts in a separate lexical scope; no parsed root/agent document is captured. */
function combine(receipts: readonly DisplayReceipt[]): DisplayReceipt {
  const captured = [...new Set(receipts)]; return { current: () => captured.every(current) };
}
function profile(base: string): DisplayReceipt { return { current: () => getBaseDirPath() === base }; }
function directoryKey(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.ino <= 0n) throw new Error('Directory association unavailable.');
  return `ino:${stat.dev}:${stat.ino}`;
}
function directoryReceipt(file: string, admitted: string): DisplayReceipt {
  return { current: () => { try { return directoryKey(file) === admitted; } catch { return false; } } };
}

/** The public view is allowlisted. Private observed-root data goes only into an empty host-owned Map.
 * The Map and receipt are not wire DTOs, cached registration, runtime or permission authority.
 * Pages are separate observations; caller must not infer a cross-page snapshot from offsets. */
export function readRegisteredAgentDisplayPage(selected: RegisteredDisplaySelection, purpose: 'helper-children' | 'dispatcher-auto', options: {
  authorized(): boolean;
  receipts: DisplayReceipt[];
  projectOffset?: number;
  matchOffset?: number;
  rootEvidence?: Map<string, RegisteredDisplayRoot>;
}): DisplayValue<RegisteredAgentDisplayPage> {
  const observedAt = Date.now(), inputs: DisplayInput[] = [{ field: 'Selected registered relationship inventory', source: 'primary', observedAt }];
  const unknown = (reason: 'invalid' | 'unreadable' | 'limit' | 'changed'): DisplayValue<RegisteredAgentDisplayPage> => ({ state: 'unavailable', reason, inputs });
  const projectOffset = options.projectOffset ?? 0, matchOffset = options.matchOffset ?? 0, rootsOut = options.rootEvidence;
  if (!selected || !localId(selected.agentId) || !id(selected.projectId) || !folder(selected.projectPath) || typeof selected.receipt?.current !== 'function'
    || !Array.isArray(options.receipts) || rootsOut !== undefined && (!(rootsOut instanceof Map) || rootsOut.size)
    || !Number.isInteger(projectOffset) || projectOffset < 0 || projectOffset > REGISTERED_DISPLAY_ROWS
    || !Number.isInteger(matchOffset) || matchOffset < 0 || matchOffset > REGISTERED_DISPLAY_ROWS
    || !['helper-children', 'dispatcher-auto'].includes(purpose)
    || (purpose === 'dispatcher-auto') !== (selected.projectId === DISPATCHER_PROJECT_ID)) return unknown('invalid');
  const selectedId = selected.agentId, selectedProjectId = selected.projectId, selectedPath = selected.projectPath, selectedReceipt = selected.receipt;
  const authorized = options.authorized, receipts = options.receipts;
  const admitted = () => { try { return authorized() && current(selectedReceipt); } catch { return false; } };
  if (!admitted()) return unknown('changed');
  const base = getBaseDirPath(), budget = createReadOnlyMetadataBudget(), evidence: DisplayReceipt[] = [selectedReceipt, profile(base)];
  const localRoots = new Map<string, RegisteredDisplayRoot>(), entries: RegisteredDisplayAgent[] = [];
  let knownMatches = 0, unknownRows = 0, unavailableProjects = 0, complete = true, rowsLeft = REGISTERED_DISPLAY_ROWS;
  try {
    const snapshot = readReadOnlyPrimaryMetadata(base, 'projects.json', { budget }); evidence.push(snapshot.receipt);
    const raw = Array.isArray(snapshot.raw) ? snapshot.raw : record(snapshot.raw) && snapshot.raw.version === 1 ? snapshot.raw.projects : undefined;
    if (!Array.isArray(raw)) return unknown('unreadable');
    if (raw.length > rowsLeft) return unknown('limit'); rowsLeft -= raw.length;
    const projects: Project[] = [], ids = new Set<string>(), paths = new Set<string>();
    let selectedRegistered = false;
    for (const value of raw) {
      if (!record(value) || !id(value.id) || !folder(value.path) || ids.has(value.id) || paths.has(value.path)) return unknown('unreadable');
      ids.add(value.id); paths.add(value.path);
      if (value.id === selectedProjectId && value.path === selectedPath) selectedRegistered = true;
      const label = typeof value.displayName === 'string' && value.displayName ? value.displayName : value.name;
      const name: DisplayValue<string> = typeof label === 'string' && label.length <= 1024 ? { state: 'ok', value: display(label, 240), inputs }
        : { state: 'unavailable', reason: typeof label === 'string' ? 'limit' : 'invalid', inputs };
      projects.push({ id: value.id, path: value.path, name });
    }
    if (purpose === 'helper-children' && !selectedRegistered) return unknown('changed');
    if (!admitted() || !snapshot.receipt.current()) return unknown('changed');
    if (projectOffset > 0 && projectOffset >= projects.length) return unknown('changed');
    let selectedDirectory: string | undefined, selectedDirectoryReceipt: DisplayReceipt | undefined;
    const aliases = new Map<string, { key: string | null; receipt?: DisplayReceipt }>();
    if (purpose === 'helper-children') {
      try { selectedDirectory = directoryKey(selectedPath); selectedDirectoryReceipt = directoryReceipt(selectedPath, selectedDirectory); evidence.push(selectedDirectoryReceipt); }
      catch { return unknown('unreadable'); }
    }
    const relatedParent = (parent: unknown, relevant: Set<DisplayReceipt>): boolean | undefined => {
      if (!folder(parent)) return undefined;
      if (parent === selectedPath) return true;
      // An unregistered UNC/network spelling is not an admitted alias probe.
      if ((parent.startsWith('\\\\') || parent.startsWith('//')) && !paths.has(parent)) return undefined;
      if (aliases.has(parent)) { const found = aliases.get(parent)!; if (found.receipt) relevant.add(found.receipt); return found.key === null ? undefined : found.key === selectedDirectory; }
      if (aliases.size >= REGISTERED_DISPLAY_ALIAS_PROBES || !admitted()) return undefined;
      try { const found = directoryKey(parent), receipt = directoryReceipt(parent, found); aliases.set(parent, { key: found, receipt }); evidence.push(receipt); relevant.add(receipt); return found === selectedDirectory; }
      catch { aliases.set(parent, { key: null }); return undefined; }
    };
    const rootPage = projects.slice(projectOffset, projectOffset + REGISTERED_DISPLAY_PROJECTS), namespaces = new Set<string>();
    for (const project of rootPage) {
      if (!admitted()) return unknown('changed');
      try {
        const data = readReadOnlyPrimaryMetadata(project.path, '.clubhouse/agents.json', { budget }); evidence.push(data.receipt);
        if (!Array.isArray(data.raw)) { unavailableProjects++; complete = false; continue; }
        // Both duplicate-ID admission and relationship projection visit every row.
        if (data.raw.length * 2 > rowsLeft) { unavailableProjects++; complete = false; continue; }
        rowsLeft -= data.raw.length * 2;
        if (data.rootNamespace && namespaces.has(data.rootNamespace)) return unknown('unreadable');
        if (data.rootNamespace) namespaces.add(data.rootNamespace);
        const counts = new Map<string, number>();
        for (const agent of data.raw) if (record(agent) && localId(agent.id)) counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
        const relevantAliases = new Set<DisplayReceipt>(), emittedBefore = entries.length;
        if (selectedDirectoryReceipt) relevantAliases.add(selectedDirectoryReceipt);
        for (const agent of data.raw) {
          if (!record(agent)) { unknownRows++; complete = false; continue; }
          if (purpose === 'helper-children') {
            if (agent.parentAgentId === undefined) continue;
            if (typeof agent.parentAgentId === 'string' && agent.parentAgentId !== selectedId) continue;
            if (agent.parentAgentId !== selectedId || agent.id === selectedId) { unknownRows++; complete = false; continue; }
            const related = agent.parentProjectPath === undefined && data.rootNamespace ? data.rootNamespace === selectedDirectory
              : relatedParent(agent.parentProjectPath === undefined ? project.path : agent.parentProjectPath, relevantAliases);
            if (related === false) continue;
            if (related === undefined) { unknownRows++; complete = false; continue; }
          }
          if (!localId(agent.id) || counts.get(agent.id) !== 1) { unknownRows++; complete = false; continue; }
          const projected = projectConnectionEndpointFieldsForDisplay(agent.id, agent);
          if (projected.state !== 'ok') { unknownRows++; complete = false; continue; }
          const fields = projected.value;
          if (purpose === 'dispatcher-auto') {
            if (agent.id === selectedId || fields.connectToDispatcher.state === 'ok' && !fields.connectToDispatcher.value
              || fields.disposed.state === 'ok' && fields.disposed.value || fields.helper.state === 'ok' && fields.helper.value) continue;
            if (fields.connectToDispatcher.state !== 'ok' || fields.disposed.state !== 'ok' || fields.helper.state !== 'ok') { unknownRows++; complete = false; continue; }
          }
          knownMatches++;
          if (knownMatches <= matchOffset || entries.length >= REGISTERED_DISPLAY_MATCHES) continue;
          const stamp = <T>(value: DisplayValue<T>): DisplayValue<T> => ({ ...value, inputs: value.inputs.map((input) => ({ ...input, source: 'primary', observedAt })) });
          entries.push({ agentId: agent.id, projectId: project.id, projectName: project.name,
            fields: { ...fields, name: fields.name.state === 'ok' ? { ...stamp(fields.name), state: 'ok', value: display(fields.name.value, 240) } : stamp(fields.name),
              helper: stamp(fields.helper), disposed: stamp(fields.disposed), connectToDispatcher: stamp(fields.connectToDispatcher) },
            ...(purpose === 'helper-children' && { parentAgentId: selectedId }) });
        }
        if (entries.length > emittedBefore) localRoots.set(project.id, { projectPath: project.path, namespace: data.rootNamespace,
          receipt: combine([selectedReceipt, profile(base), snapshot.receipt, data.receipt, ...relevantAliases]) });
      } catch (error) { unavailableProjects++; complete = false; if (!(error instanceof ReadOnlyMetadataLimitError)) continue; }
    }
    const receipt = combine(evidence); receipts.push(receipt);
    if (!admitted() || !receipt.current()) return unknown('changed');
    if (matchOffset > 0 && matchOffset >= knownMatches) return unknown('changed');
    if (rootsOut) for (const [key, value] of localRoots) rootsOut.set(key, value);
    const next = knownMatches > matchOffset + entries.length ? { projectOffset, matchOffset: matchOffset + entries.length }
      : projectOffset + rootPage.length < projects.length ? { projectOffset: projectOffset + rootPage.length, matchOffset: 0 } : null;
    return { state: 'ok', inputs, value: { entries, complete, knownMatches, unknownRows, unavailableProjects, next, projectOffset, matchOffset, observedAt } };
  } catch (error) { return unknown(error instanceof ReadOnlyMetadataLimitError ? 'limit' : 'unreadable'); }
}
