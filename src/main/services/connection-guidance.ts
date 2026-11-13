import { createHash, randomUUID } from 'crypto';
import type { ConnectionGuidanceSnapshot, SaveConnectionGuidance } from '../../shared/connection-guidance';
import { directionKey } from '../../shared/connection-grants';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import type { BindingTargetKind, McpBinding } from './clubhouse-mcp/types';
import { connectionEnd } from './connection-grants';
import { connectionGuidanceOwnership, getConnectionGuidanceSourceVersion, inspectConnectionGuidance, isBindingRemovedByUser, setConnectionGuidanceRestore } from './persisted-bindings';
import { createSettingsStore, peekStoredSettingsSync } from './settings-store';
import { getConnectionToolCatalog, keepsFirstToolList, sanitizeWireInstruction } from './clubhouse-mcp/tool-registry';
import { appLog } from './log-service';
import { agentRegistry } from './agent-registry';

interface GuidanceEntry {
  key: string;
  instructions: Record<string, string>;
  revision: string;
  sourceRevision: string;
}

interface GuidanceFile {
  version: number;
  entries: unknown[];
}

const VERSION = 1;
const FILENAME = 'connection-instructions.json';
const store = createSettingsStore<GuidanceFile>(
  FILENAME,
  { version: VERSION, entries: [] },
  undefined,
  { atomic: true, rollBackFailedSaves: true, audit: { key: 'connection_instructions' } },
);
let writeQueue: Promise<unknown> = Promise.resolve();
const bindingRevisions = new WeakMap<McpBinding, string>();
let reportedReadError = false;

function instructionsOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Connection instructions must be a tool-to-text object.');
  const entries: Array<[string, unknown]> = Object.entries(raw);
  if (entries.length > 256) throw new Error('Connection instructions must contain at most 256 tool names.');
  const cleaned = entries.flatMap(([key, value]): Array<[string, string]> => {
    if (!key || key.length > 200 || typeof value !== 'string' || value.length > 64_000) {
      throw new Error('Connection instructions must have tool names and text values of at most 64,000 characters.');
    }
    return value.trim() ? [[key, value]] : [];
  });
  return Object.fromEntries(cleaned.sort(([a], [b]) => a.localeCompare(b)));
}

function guidanceKey(agentId: string, targetId: string, kind: BindingTargetKind): string {
  return `${kind}:${directionKey(connectionEnd(agentId), connectionEnd(targetId))}`;
}

function parsedEntry(raw: unknown): GuidanceEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !('key' in raw) || typeof raw.key !== 'string' || !raw.key || raw.key.length > 2000
    || !('revision' in raw) || typeof raw.revision !== 'string' || !raw.revision || raw.revision.length > 256
    || !('sourceRevision' in raw) || typeof raw.sourceRevision !== 'string' || !raw.sourceRevision || raw.sourceRevision.length > 256
    || !('instructions' in raw)) {
    throw new Error('Saved connection guidance could not be read. Repair connection-instructions.json before editing it.');
  }
  return { key: raw.key, revision: raw.revision, sourceRevision: raw.sourceRevision, instructions: instructionsOf(raw.instructions) };
}

/** Never read the settings store's optimistic cache, including during an atomic rename. */
function committedFile(): GuidanceFile {
  const raw = peekStoredSettingsSync(FILENAME);
  if (raw === 'missing') return { version: VERSION, entries: [] };
  if (raw === 'unreadable' || typeof raw.version !== 'number' || !Number.isInteger(raw.version)
    || raw.version < 1 || !Array.isArray(raw.entries)) {
    throw new Error('Saved connection guidance could not be read. Repair connection-instructions.json before editing it.');
  }
  const keys = new Set<string>();
  for (const value of raw.entries) {
    const entry = parsedEntry(value);
    if (keys.has(entry.key)) throw new Error('Saved connection guidance has duplicate directions. Repair connection-instructions.json before editing it.');
    keys.add(entry.key);
  }
  return { ...raw, version: raw.version, entries: raw.entries };
}

function entryOf(file: GuidanceFile, key: string): GuidanceEntry | undefined {
  return file.entries.map(parsedEntry).find((entry) => entry.key === key);
}

function bindingRevision(binding: McpBinding): string {
  let revision = bindingRevisions.get(binding);
  if (!revision) { revision = randomUUID(); bindingRevisions.set(binding, revision); }
  return revision;
}

function sameBinding(binding: McpBinding, kind: BindingTargetKind): boolean {
  return binding.targetKind === kind && bindingManager.getAllBindings().includes(binding);
}

function findBinding(agentId: string, targetId: string): McpBinding | undefined {
  const key = directionKey(connectionEnd(agentId), connectionEnd(targetId));
  return bindingManager.getAllBindings().find((b) => directionKey(connectionEnd(b.agentId), connectionEnd(b.targetId)) === key);
}

function requireBinding(agentId: string, targetId: string): McpBinding {
  const binding = findBinding(agentId, targetId);
  if (!binding) throw new Error('This direction is no longer connected. Reload Connections before editing it.');
  return binding;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function snapshotOf(binding: McpBinding): Promise<{ snapshot: ConnectionGuidanceSnapshot; sourceRevision: string; sourceVersion: string }> {
  const kind = binding.targetKind;
  const sourceVersion = getConnectionGuidanceSourceVersion(binding.agentId, binding.targetId);
  const { sources, unreadable } = await inspectConnectionGuidance(binding.agentId, binding.targetId);
  if (!sameBinding(binding, kind) || sourceVersion !== getConnectionGuidanceSourceVersion(binding.agentId, binding.targetId)) {
    throw new Error('Connection guidance ownership changed. Reload before editing; your draft has not been applied.');
  }
  const originals = sources.map((source) => ({ ...source, instructions: instructionsOf(source.instructions) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const file = committedFile();
  const saved = entryOf(file, guidanceKey(binding.agentId, binding.targetId, binding.targetKind));
  const sourceRevision = hash({ sources: originals, unreadable });
  const ownership = connectionGuidanceOwnership(binding.agentId, binding.targetId);
  const managed = ownership.managed;
  const ownershipReason = ownership.instructions === undefined
    ? 'Connection ownership could not be checked. Reload sources before editing.'
    : 'This connection is managed by Annex Network membership and cannot be edited here.';
  const readOnlyReason = file.version > VERSION
    ? 'Guidance was saved by a newer Clubhouse. Update Clubhouse before editing it.'
    : binding.targetKind === 'plugin'
      ? 'Plugin connection guidance cannot be changed from this window.'
      : managed ? ownershipReason : undefined;
  const instructions = managed ? binding.instructions : saved?.instructions ?? binding.instructions;
  return {
    sourceRevision,
    sourceVersion,
    snapshot: {
      agentId: binding.agentId, targetId: binding.targetId,
      instructions: instructionsOf(instructions ?? {}),
      hasOverride: saved !== undefined,
      sources: originals, unreadable,
      conflictingSources: new Set(originals.filter((s) => Object.keys(s.instructions).length > 0).map((s) => JSON.stringify(s.instructions))).size > 1,
      needsSourceConfirmation: originals.some((s) => Object.keys(s.instructions).length > 0) && saved?.sourceRevision !== sourceRevision,
      readOnly: readOnlyReason !== undefined,
      ...(readOnlyReason && { readOnlyReason }),
      revision: hash([saved?.revision, sourceRevision, bindingRevision(binding), sourceVersion]),
    },
  };
}

export async function getConnectionGuidance(agentId: string, targetId: string): Promise<ConnectionGuidanceSnapshot> {
  const binding = findBinding(agentId, targetId);
  if (binding) return (await snapshotOf(binding)).snapshot;
  const sourceVersion = getConnectionGuidanceSourceVersion(agentId, targetId);
  const { sources, unreadable, offlineKinds } = await inspectConnectionGuidance(agentId, targetId);
  if (findBinding(agentId, targetId) || sourceVersion !== getConnectionGuidanceSourceVersion(agentId, targetId)
    || isBindingRemovedByUser(agentId, targetId)) {
    throw new Error('Saved connection ownership changed. Reload before inspecting guidance.');
  }
  if (unreadable.length > 0) throw new Error(`Saved connection sources could not be checked: ${unreadable.join(', ')}. Reload before inspecting guidance.`);
  if (offlineKinds.length !== 1 || sources.length === 0) {
    throw new Error('A unique saved connection source and endpoint kind could not be proved. Reload Connections before inspecting guidance.');
  }
  const originals = sources.map((source) => ({ ...source, instructions: instructionsOf(source.instructions) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const sourceRevision = hash({ sources: originals, unreadable });
  const file = committedFile();
  const saved = entryOf(file, guidanceKey(agentId, targetId, offlineKinds[0]));
  const ownership = connectionGuidanceOwnership(agentId, targetId);
  if (ownership.managed && ownership.instructions === undefined) throw new Error('Saved connection ownership could not be checked. Reload sources before inspecting guidance.');
  const conflictingSources = new Set(originals.map((source) => JSON.stringify(source.instructions))).size > 1;
  const instructions = ownership.managed ? ownership.instructions
    : saved?.instructions ?? (conflictingSources ? {} : originals[0].instructions);
  const notice = 'Saved guidance only: this direction is not connected. Editing and tool-description previews are unavailable until it reconnects. No session or tool client was started.'
    + (!ownership.managed && !saved && conflictingSources ? ' Original source guidance conflicts; no combined guidance is selected. Inspect each retained original.' : '');
  return {
    agentId, targetId, instructions: instructionsOf(instructions ?? {}), hasOverride: saved !== undefined,
    sources: originals, unreadable, conflictingSources, needsSourceConfirmation: false,
    readOnly: true, offline: true, readOnlyReason: notice, notice,
    revision: hash(['offline', saved?.revision, sourceRevision, sourceVersion]),
  };
}

export function getConnectionGuidanceCatalog(agentId: string, targetId: string) {
  const binding = requireBinding(agentId, targetId);
  return getConnectionToolCatalog(binding.agentId, binding.targetId, binding.targetKind);
}

export function previewConnectionGuidance(agentId: string, targetId: string, raw: unknown): Record<string, string> {
  const binding = requireBinding(agentId, targetId);
  const instructions = instructionsOf(raw);
  const catalog = getConnectionToolCatalog(binding.agentId, binding.targetId, binding.targetKind);
  return Object.fromEntries(catalog.tools.map((tool) => {
    const text = instructions[tool.suffix] || instructions['*'];
    return [tool.suffix, tool.description + (text ? `\n\n[WIRE INSTRUCTIONS — user-supplied]\n${sanitizeWireInstruction(text)}\n[END WIRE INSTRUCTIONS]` : '')];
  }));
}

export function saveConnectionGuidance(agentId: string, targetId: string, request: SaveConnectionGuidance): Promise<ConnectionGuidanceSnapshot> {
  const save = () => saveLocked(agentId, targetId, request);
  const result = writeQueue.then(save, save);
  writeQueue = result;
  return result;
}

/** Remove saved overrides targeting a deleted group project, serialized with edits. */
export function purgeGroupProjectGuidance(groupProjectId: string): Promise<void> {
  const purge = async () => {
    const file = committedFile();
    if (file.version > VERSION) throw new Error('Guidance was saved by a newer Clubhouse. Update before deleting a group project.');
    const entries = file.entries.filter((value) => {
      const key = parsedEntry(value).key;
      return !key.startsWith('group-project:') || !key.endsWith(`/${groupProjectId}`);
    });
    if (entries.length !== file.entries.length) await store.save({ ...file, entries });
  };
  const result = writeQueue.then(purge, purge);
  writeQueue = result;
  return result;
}

function runtimeNotice(agentId: string): string {
  const sender = agentRegistry.get(agentId);
  const refresh = sender && sender.runtime !== 'chat' && keepsFirstToolList(agentId)
    ? "The sender's CLI keeps its first tool list; restart its session to load these descriptions."
    : "Live tool-description refresh in the sender's client is not confirmed. Reload tools or restart the sender's session to ensure the new descriptions are loaded.";
  return `Guidance saved. Server tool descriptions are updated. ${refresh} Sessions were not restarted.`;
}

async function saveLocked(agentId: string, targetId: string, request: SaveConnectionGuidance): Promise<ConnectionGuidanceSnapshot> {
  const instructions = instructionsOf(request.instructions);
  if (typeof request.revision !== 'string' || !request.revision) throw new Error('Reload connection guidance before saving it.');
  if (request.replaceAcrossSources !== undefined && typeof request.replaceAcrossSources !== 'boolean') throw new Error('Source replacement confirmation must be true or false.');
  const binding = requireBinding(agentId, targetId);
  const kind = binding.targetKind;
  const { snapshot, sourceRevision, sourceVersion } = await snapshotOf(binding);
  if (snapshot.readOnly) throw new Error(snapshot.readOnlyReason);
  if (snapshot.unreadable.length > 0) throw new Error('Some connection sources could not be checked. Reload the sources before saving guidance.');
  if (request.revision !== snapshot.revision) throw new Error('Connection guidance or its sources changed. Reload before saving; your draft has not been applied.');
  if (snapshot.needsSourceConfirmation && request.replaceAcrossSources !== true) {
    throw new Error("Confirm replacement of guidance across this direction's sources. Their original text will be kept.");
  }
  const key = guidanceKey(binding.agentId, binding.targetId, binding.targetKind);
  const revision = randomUUID();
  const file = committedFile();
  if (file.version > VERSION) throw new Error('Guidance was saved by a newer Clubhouse. Update before editing it.');
  if (!sameBinding(binding, kind) || sourceVersion !== getConnectionGuidanceSourceVersion(binding.agentId, binding.targetId)
    || connectionGuidanceOwnership(binding.agentId, binding.targetId).managed) {
    throw new Error('Connection guidance ownership changed. Reload before editing; your draft has not been applied.');
  }
  if (hash([entryOf(file, key)?.revision, sourceRevision, bindingRevision(binding), sourceVersion]) !== request.revision) {
    throw new Error('Another editor saved this direction. Reload before saving; your draft has not been applied.');
  }
  const entry: GuidanceEntry = { key, instructions, revision, sourceRevision };
  await store.save({
    ...file, version: VERSION,
    entries: [...file.entries.filter((value) => parsedEntry(value).key !== key), entry],
  });
  let stillOwned = sameBinding(binding, kind) && sourceVersion === getConnectionGuidanceSourceVersion(binding.agentId, binding.targetId);
  let applicationError = 'Its live ownership changed.';
  if (stillOwned) {
    try {
      const current = await snapshotOf(binding);
      const committed = committedFile();
      stillOwned = sameBinding(binding, kind) && sourceVersion === getConnectionGuidanceSourceVersion(binding.agentId, binding.targetId)
        && !connectionGuidanceOwnership(binding.agentId, binding.targetId).managed
        && committed.version <= VERSION && entryOf(committed, key)?.revision === revision
        && !current.snapshot.readOnly && current.snapshot.unreadable.length === 0
        && current.sourceVersion === sourceVersion && current.sourceRevision === sourceRevision
        && current.snapshot.revision === hash([revision, sourceRevision, bindingRevision(binding), sourceVersion]);
      applicationError = 'Its sources or live ownership changed, or could not be checked.';
    } catch (error) {
      // telemetry-exempt: logged below and returned in the committed-but-not-applied notice
      applicationError = error instanceof Error ? error.message : String(error);
      stillOwned = false;
    }
  }
  if (stillOwned) {
    bindingManager.setInstructions(binding.agentId, binding.targetId, instructions);
    stillOwned = sameBinding(binding, kind) && sourceVersion === getConnectionGuidanceSourceVersion(binding.agentId, binding.targetId)
      && !connectionGuidanceOwnership(binding.agentId, binding.targetId).managed;
  }
  const notice = `Guidance was saved, but it was not applied to this live direction. ${applicationError} Reload Connections before editing.`;
  if (!stillOwned) appLog('core:mcp', 'warn', 'Committed connection guidance was not applied to changed live ownership or sources', {
    meta: { agentId: binding.agentId, targetId: binding.targetId, reason: applicationError },
  });
  return {
    ...snapshot, instructions, hasOverride: true, needsSourceConfirmation: false,
    revision: hash([revision, sourceRevision, bindingRevision(binding), sourceVersion]),
    notice: stillOwned ? runtimeNotice(binding.agentId) : notice,
    ...(!stillOwned && { readOnly: true, readOnlyReason: notice }),
  };
}

/** Install before restoring sources, so even their first binding sees saved guidance. */
export function startConnectionGuidance(): void {
  const resolve = (agentId: string, targetId: string, kind: BindingTargetKind) => {
    try {
      const file = committedFile();
      reportedReadError = false;
      return kind === 'plugin' || connectionGuidanceOwnership(agentId, targetId).managed
        ? undefined : entryOf(file, guidanceKey(agentId, targetId, kind))?.instructions;
    } catch (error) {
      // telemetry-exempt: read failures are logged once until a successful read
      if (!reportedReadError) appLog('core:mcp', 'warn', 'Saved connection guidance could not be read; overrides will not be applied', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      });
      reportedReadError = true;
      return undefined;
    }
  };
  bindingManager.setConnectionInstructionsSource(resolve);
  setConnectionGuidanceRestore(() => {
    for (const binding of bindingManager.getAllBindings()) {
      const kind = binding.targetKind;
      if (kind === 'plugin') continue;
      const ownership = connectionGuidanceOwnership(binding.agentId, binding.targetId);
      const instructions = ownership.managed ? ownership.instructions : resolve(binding.agentId, binding.targetId, binding.targetKind);
      if (instructions !== undefined && sameBinding(binding, kind)
        && hash(instructionsOf(instructions)) !== hash(instructionsOf(binding.instructions ?? {}))) {
        bindingManager.setInstructions(binding.agentId, binding.targetId, instructions);
      }
    }
  });
}
