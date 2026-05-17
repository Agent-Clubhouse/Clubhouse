import { describe, it, expect, vi } from 'vitest';
import {
  serializeBlueprint,
  deserializeBlueprint,
  generateBlueprintId,
  BLUEPRINT_SCHEMA_VERSION,
} from './blueprint-serialization';
import type { BlueprintManifest } from './blueprint-types';

/** Minimal valid blueprint for testing. */
function validBlueprint(): BlueprintManifest {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test Blueprint',
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: '2026-04-05T00:00:00.000Z',
    canvas: {
      views: [
        {
          refId: 'view-1',
          type: 'agent',
          displayName: 'Agent A',
          position: { x: 0, y: 0 },
        },
      ],
      wires: [],
    },
  };
}

describe('serializeBlueprint', () => {
  it('produces valid JSON', () => {
    const json = serializeBlueprint(validBlueprint());
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('produces deterministic output with sorted keys', () => {
    const bp = validBlueprint();
    const json1 = serializeBlueprint(bp);
    const json2 = serializeBlueprint(bp);
    expect(json1).toBe(json2);

    // Verify keys are sorted — "canvas" should come before "createdAt" before "id"
    const parsed = JSON.parse(json1);
    const topKeys = Object.keys(parsed);
    const sortedKeys = [...topKeys].sort();
    expect(topKeys).toEqual(sortedKeys);
  });

  it('sorts nested object keys', () => {
    const bp = validBlueprint();
    // position has {x, y} — after sorting, keys should be [x, y] (already sorted)
    bp.canvas.views[0].position = { x: 10, y: 20 };
    const json = serializeBlueprint(bp);

    // Parse and check a nested object key order
    const parsed = JSON.parse(json);
    const viewKeys = Object.keys(parsed.canvas.views[0]);
    const sortedViewKeys = [...viewKeys].sort();
    expect(viewKeys).toEqual(sortedViewKeys);
  });

  it('preserves array order (does not sort arrays)', () => {
    const bp = validBlueprint();
    bp.canvas.views = [
      { refId: 'z-view', type: 'agent', displayName: 'Z', position: { x: 0, y: 0 } },
      { refId: 'a-view', type: 'agent', displayName: 'A', position: { x: 1, y: 1 } },
    ];
    const json = serializeBlueprint(bp);
    const parsed = JSON.parse(json);
    expect(parsed.canvas.views[0].refId).toBe('z-view');
    expect(parsed.canvas.views[1].refId).toBe('a-view');
  });
});

describe('deserializeBlueprint', () => {
  it('round-trips through serialize → deserialize', () => {
    const original = validBlueprint();
    const json = serializeBlueprint(original);
    const restored = deserializeBlueprint(json);

    expect(restored.id).toBe(original.id);
    expect(restored.name).toBe(original.name);
    expect(restored.version).toBe(original.version);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.canvas.views).toHaveLength(1);
    expect(restored.canvas.views[0].refId).toBe('view-1');
  });

  it('preserves optional fields through round-trip', () => {
    const bp = validBlueprint();
    bp.description = 'A description';
    bp.createdBy = 'test-agent';
    bp.exportedFrom = '0.39.0';
    bp.requiredPlugins = ['plugin-a'];
    bp.agents = [{ refId: 'a1', name: 'Agent', orchestrator: 'claude-code', freeAgent: true }];
    bp.projects = [{ refId: 'p1', name: 'Proj', relativePath: './src' }];

    const json = serializeBlueprint(bp);
    const restored = deserializeBlueprint(json);

    expect(restored.description).toBe('A description');
    expect(restored.createdBy).toBe('test-agent');
    expect(restored.exportedFrom).toBe('0.39.0');
    expect(restored.requiredPlugins).toEqual(['plugin-a']);
    expect(restored.agents).toHaveLength(1);
    expect(restored.agents![0].orchestrator).toBe('claude-code');
    expect(restored.agents![0].freeAgent).toBe(true);
    expect(restored.projects).toHaveLength(1);
    expect(restored.projects![0].relativePath).toBe('./src');
  });

  it('throws on invalid JSON', () => {
    expect(() => deserializeBlueprint('not json')).toThrow('Invalid blueprint JSON');
  });

  it('throws on valid JSON that is not a valid blueprint', () => {
    expect(() => deserializeBlueprint('{}')).toThrow('Invalid blueprint');
  });

  it('warns on future schemaVersion instead of throwing (LB-PS-2026-05-03)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bp = validBlueprint() as Record<string, unknown>;
    bp.schemaVersion = 9999;
    expect(() => deserializeBlueprint(JSON.stringify(bp))).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('9999'));
    warnSpy.mockRestore();
  });

  it('treats missing schemaVersion as version 1 (LB-PS-2026-05-03)', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    delete bp.schemaVersion;
    expect(() => deserializeBlueprint(JSON.stringify(bp))).not.toThrow();
    const result = deserializeBlueprint(JSON.stringify(bp));
    expect(result.schemaVersion).toBe(BLUEPRINT_SCHEMA_VERSION);
  });

  it('throws on blueprint with dangling wire refs', () => {
    const bp = validBlueprint();
    bp.canvas.wires = [{ sourceRef: 'view-1', targetRef: 'nonexistent' }];
    const json = JSON.stringify(bp);
    expect(() => deserializeBlueprint(json)).toThrow('nonexistent');
  });

  it('throws on blueprint with duplicate refIds', () => {
    const bp = validBlueprint();
    bp.canvas.views.push({
      refId: 'view-1', // duplicate
      type: 'anchor',
      displayName: 'Dup',
      position: { x: 1, y: 1 },
    });
    const json = JSON.stringify(bp);
    expect(() => deserializeBlueprint(json)).toThrow('duplicate');
  });
});

describe('generateBlueprintId', () => {
  it('returns a string', () => {
    const id = generateBlueprintId();
    expect(typeof id).toBe('string');
  });

  it('returns a valid UUID v4 format', () => {
    const id = generateBlueprintId();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRegex);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateBlueprintId()));
    expect(ids.size).toBe(100);
  });
});
