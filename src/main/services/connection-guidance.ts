import { createHash, randomUUID } from 'crypto';
import type { ConnectionGuidanceSnapshot, SaveConnectionGuidance } from '../../shared/connection-guidance';
import { directionKey } from '../../shared/connection-grants';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import type { BindingTargetKind, McpBinding } from './clubhouse-mcp/types';
import { connectionEnd } from './connection-grants';
import { inspectConnectionGuidance } from './persisted-bindings';
import { createSettingsStore } from './settings-store';
import { getConnectionToolCatalog, sanitizeWireInstruction } from './clubhouse-mcp/tool-registry';

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
const store = createSettingsStore<GuidanceFile>(
  'connection-instructions.json',
  { version: VERSION, entries: [] },
  undefined,
  { atomic: true, rollBackFailedSaves: true, audit: { key: 'connection_instructions' } },
);

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

function entriesOf(file: GuidanceFile): unknown[] {
  if (!Number.isInteger(file.version) || file.version < 1 || !Array.isArray(file.entries)) {
    throw new Error('Saved connection guidance could not be read. Repair connection-instructions.json before editing it.');
  }
  return file.entries;
}

function entryOf(file: GuidanceFile, key: string): GuidanceEntry | undefined {
  const raw = entriesOf(file).find((value) => value && typeof value === 'object' && 'key' in value && value.key === key);
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || !('revision' in raw) || typeof raw.revision !== 'string'
    || !('sourceRevision' in raw) || typeof raw.sourceRevision !== 'string' || !('instructions' in raw)) {
    throw new Error('Saved guidance for this direction is invalid. Repair connection-instructions.json before editing it.');
  }
  return { key, revision: raw.revision, sourceRevision: raw.sourceRevision, instructions: instructionsOf(raw.instructions) };
}

function requireBinding(agentId: string, targetId: string): McpBinding {
  const key = directionKey(connectionEnd(agentId), connectionEnd(targetId));
  const binding = bindingManager.getAllBindings().find((b) => directionKey(connectionEnd(b.agentId), connectionEnd(b.targetId)) === key);
  if (!binding) throw new Error('This direction is no longer connected. Reload Connections before editing it.');
  return binding;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function snapshotOf(binding: McpBinding): Promise<{ snapshot: ConnectionGuidanceSnapshot; sourceRevision: string; savedRevision?: string }> {
  const { sources, unreadable } = await inspectConnectionGuidance(binding.agentId, binding.targetId);
  const originals = sources.map((source) => ({ ...source, instructions: instructionsOf(source.instructions) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const file = store.get();
  const saved = entryOf(file, guidanceKey(binding.agentId, binding.targetId, binding.targetKind));
  const sourceRevision = hash({ sources: originals, unreadable });
  const readOnlyReason = file.version > VERSION
    ? 'Guidance was saved by a newer Clubhouse. Update Clubhouse before editing it.'
    : binding.targetKind === 'plugin'
      ? 'Plugin connection guidance cannot be changed from this window.'
      : originals.some((source) => source.sourceId === 'dispatcher-federation')
        ? 'This connection is managed by Annex Network membership and cannot be edited here.'
        : undefined;
  return {
    sourceRevision,
    savedRevision: saved?.revision,
    snapshot: {
      agentId: binding.agentId, targetId: binding.targetId,
      instructions: saved?.instructions ?? instructionsOf(binding.instructions ?? {}),
      hasOverride: saved !== undefined,
      sources: originals, unreadable,
      conflictingSources: new Set(originals.filter((s) => Object.keys(s.instructions).length > 0).map((s) => JSON.stringify(s.instructions))).size > 1,
      needsSourceConfirmation: originals.some((s) => Object.keys(s.instructions).length > 0) && saved?.sourceRevision !== sourceRevision,
      readOnly: readOnlyReason !== undefined,
      ...(readOnlyReason && { readOnlyReason }),
      revision: hash([saved?.revision, sourceRevision]),
    },
  };
}

export async function getConnectionGuidance(agentId: string, targetId: string): Promise<ConnectionGuidanceSnapshot> {
  return (await snapshotOf(requireBinding(agentId, targetId))).snapshot;
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

export async function saveConnectionGuidance(agentId: string, targetId: string, request: SaveConnectionGuidance): Promise<ConnectionGuidanceSnapshot> {
  const instructions = instructionsOf(request.instructions);
  if (typeof request.revision !== 'string' || !request.revision) throw new Error('Reload connection guidance before saving it.');
  if (request.replaceAcrossSources !== undefined && typeof request.replaceAcrossSources !== 'boolean') throw new Error('Source replacement confirmation must be true or false.');
  const binding = requireBinding(agentId, targetId);
  const { snapshot, sourceRevision, savedRevision } = await snapshotOf(binding);
  if (snapshot.readOnly) throw new Error(snapshot.readOnlyReason);
  if (snapshot.unreadable.length > 0) throw new Error('Some connection sources could not be checked. Reload the sources before saving guidance.');
  if (request.revision !== snapshot.revision) throw new Error('Connection guidance or its sources changed. Reload before saving; your draft has not been applied.');
  if (snapshot.needsSourceConfirmation && request.replaceAcrossSources !== true) {
    throw new Error("Confirm replacement of guidance across this direction's sources. Their original text will be kept.");
  }
  const key = guidanceKey(binding.agentId, binding.targetId, binding.targetKind);
  const revision = randomUUID();
  await store.update((file) => {
    if (file.version > VERSION) throw new Error('Guidance was saved by a newer Clubhouse. Update before editing it.');
    if (entryOf(file, key)?.revision !== savedRevision) throw new Error('Another editor saved this direction. Reload before saving; your draft has not been applied.');
    requireBinding(binding.agentId, binding.targetId);
    const entry: GuidanceEntry = { key, instructions, revision, sourceRevision };
    return {
      ...file, version: VERSION,
      entries: [...entriesOf(file).filter((value) => !(value && typeof value === 'object' && 'key' in value && value.key === key)), entry],
    };
  });
  bindingManager.setInstructions(binding.agentId, binding.targetId, instructions);
  return {
    ...snapshot, instructions, hasOverride: true, needsSourceConfirmation: false,
    revision: hash([revision, sourceRevision]),
  };
}

/** Install before restoring sources, so even their first binding sees saved guidance. */
export function startConnectionGuidance(): void {
  bindingManager.setConnectionInstructionsSource((agentId, targetId, kind) => entryOf(store.get(), guidanceKey(agentId, targetId, kind))?.instructions);
}
