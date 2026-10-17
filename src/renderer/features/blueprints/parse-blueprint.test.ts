import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../shared/types';
import {
  detectBlueprintFormat,
  parseAnyBlueprint,
  parseAnyBlueprintText,
  applyParsedBlueprint,
} from './parse-blueprint';

// ── Fixtures ─────────────────────────────────────────────────────────

const LEGACY_BLUEPRINT = {
  version: 1,
  name: 'Legacy BP',
  views: [
    { type: 'agent', title: 'A', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, metadata: {} },
    { type: 'anchor', title: 'Anchor', position: { x: 500, y: 0 }, size: { width: 240, height: 50 }, metadata: {}, label: 'Notes' },
  ],
};

const MANIFEST_BLUEPRINT = {
  id: 'bp-1',
  name: 'Manifest BP',
  version: '1.0.0',
  schemaVersion: 1,
  createdAt: '2026-04-25T12:00:00.000Z',
  canvas: {
    views: [
      { refId: 'v1', type: 'agent', displayName: 'Alpha', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, agentRef: 'a1' },
      { refId: 'v2', type: 'anchor', displayName: 'Hub', position: { x: 600, y: 0 }, size: { width: 240, height: 50 } },
    ],
    wires: [{ sourceRef: 'v1', targetRef: 'v2' }],
  },
  agents: [{ refId: 'a1', name: 'Alpha', matchBy: { name: 'Alpha' } }],
};

// ── detectBlueprintFormat ────────────────────────────────────────────

describe('detectBlueprintFormat', () => {
  it('detects manifest format by schemaVersion + canvas object', () => {
    expect(detectBlueprintFormat(MANIFEST_BLUEPRINT)).toBe('manifest');
  });

  it('detects legacy format by numeric version + views array', () => {
    expect(detectBlueprintFormat(LEGACY_BLUEPRINT)).toBe('legacy');
  });

  it('throws on null', () => {
    expect(() => detectBlueprintFormat(null)).toThrow('expected a JSON object');
  });

  it('throws on non-object', () => {
    expect(() => detectBlueprintFormat('hello')).toThrow('expected a JSON object');
    expect(() => detectBlueprintFormat(42)).toThrow('expected a JSON object');
  });

  it('throws with schemaVersion-specific message when schemaVersion is wrong', () => {
    expect(() => detectBlueprintFormat({ schemaVersion: 99, canvas: { views: [] } })).toThrow(
      'Unsupported blueprint schemaVersion: 99',
    );
  });

  it('throws on shape that matches neither format', () => {
    expect(() => detectBlueprintFormat({ name: 'whatever' })).toThrow('Not a recognisable blueprint');
  });

  it('does not mistake string version for legacy', () => {
    // String version with no schemaVersion or canvas → not recognisable
    expect(() => detectBlueprintFormat({ version: '1.0.0', views: [] })).toThrow('Not a recognisable blueprint');
  });
});

// ── parseAnyBlueprint ────────────────────────────────────────────────

describe('parseAnyBlueprint', () => {
  it('imports a legacy blueprint to a CanvasInstance', () => {
    const result = parseAnyBlueprint(LEGACY_BLUEPRINT);
    expect(result.format).toBe('legacy');
    expect(result.canvas.name).toBe('Legacy BP');
    expect(result.canvas.views).toHaveLength(2);
    expect(result.pendingWires).toEqual([]);
    expect(result.stubs).toEqual([]);
    expect(result.refIdToViewId.size).toBe(0);
  });

  it('imports a manifest blueprint to a CanvasInstance with stubs and pending wires', () => {
    const result = parseAnyBlueprint(MANIFEST_BLUEPRINT, { agents: [], projects: [] });
    expect(result.format).toBe('manifest');
    expect(result.canvas.name).toBe('Manifest BP');
    expect(result.canvas.views).toHaveLength(2);
    // Wire from the manifest is preserved as a pending wire awaiting resolution
    expect(result.pendingWires).toHaveLength(1);
    expect(result.pendingWires[0]).toEqual({ sourceRef: 'v1', targetRef: 'v2' });
    // Agent stub recorded for v1 (no agents on this machine → not_found)
    expect(result.stubs).toHaveLength(1);
    expect(result.stubs[0].badge).toBe('not_found');
    // refIdToViewId populated for both views
    expect(result.refIdToViewId.size).toBe(2);
  });

  it('imports a manifest blueprint without ctx (defaults to no agents/projects)', () => {
    const result = parseAnyBlueprint(MANIFEST_BLUEPRINT);
    expect(result.format).toBe('manifest');
    expect(result.canvas.views).toHaveLength(2);
    // No agents to match against → stub stays unbound
    expect(result.stubs[0].badge).toBe('not_found');
  });

  it('throws on invalid legacy blueprint (missing version)', () => {
    expect(() => parseAnyBlueprint({ name: 'X', views: [] })).toThrow('Not a recognisable blueprint');
  });

  it('throws on legacy blueprint with future numeric version', () => {
    expect(() => parseAnyBlueprint({ version: 999, name: 'Future', views: [] })).toThrow('Unsupported blueprint version');
  });

  it('throws on manifest with bad schemaVersion', () => {
    expect(() => parseAnyBlueprint({ schemaVersion: 2, canvas: { views: [] } })).toThrow('Unsupported blueprint schemaVersion: 2');
  });
});

// ── parseAnyBlueprintText ────────────────────────────────────────────

describe('parseAnyBlueprintText', () => {
  it('parses valid JSON text', () => {
    const result = parseAnyBlueprintText(JSON.stringify(LEGACY_BLUEPRINT));
    expect(result.format).toBe('legacy');
    expect(result.canvas.views).toHaveLength(2);
  });

  it('parses a serialised manifest blueprint (semver string version is OK)', () => {
    const result = parseAnyBlueprintText(JSON.stringify(MANIFEST_BLUEPRINT), { agents: [], projects: [] });
    expect(result.format).toBe('manifest');
  });

  it('throws on invalid JSON with a clear message', () => {
    expect(() => parseAnyBlueprintText('{not json')).toThrow('Not a valid JSON file');
  });
});

// ── buildWireDefinitionsFromResult ───────────────────────────────────

describe('wire plan in the parse result', () => {
  it('has no wires for a legacy blueprint', () => {
    const result = parseAnyBlueprint(LEGACY_BLUEPRINT);
    expect(result.wires).toEqual({ create: [], deferred: [], skipped: [] });
  });

  it('skips a wire to an anchor: it is not a wire target (it used to become a browser wire)', () => {
    const matchedAgent = { id: 'agent-real-id', name: 'Alpha', orchestrator: null, model: null, status: 'sleeping' } as unknown as Agent;
    const result = parseAnyBlueprint(MANIFEST_BLUEPRINT, { agents: [matchedAgent], projects: [] });
    expect(result.wires.create).toEqual([]);
    expect(result.wires.skipped).toEqual([expect.objectContaining({ reason: 'unsupported_target' })]);
  });

  it('applyParsedBlueprint inserts the canvas, then adds the planned wires', async () => {
    const matchedAgent = { id: 'agent-real-id', name: 'Alpha', orchestrator: null, model: null, status: 'sleeping' } as unknown as Agent;
    const result = parseAnyBlueprint(MANIFEST_BLUEPRINT, { agents: [matchedAgent], projects: [] });
    result.wires.create.push({ agentId: 'agent-real-id', targetId: 'x', targetKind: 'browser', label: 'x' });
    const calls: string[] = [];
    await applyParsedBlueprint(result, {
      insertCanvas: async (canvas) => { calls.push(`canvas:${canvas.id === result.canvas.id}`); },
      addWireDefinition: (wire) => { calls.push(`wire:${wire.targetId}`); },
    });
    expect(calls).toEqual(['canvas:true', 'wire:x']);
  });
});
