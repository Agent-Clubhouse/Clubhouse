import { describe, it, expect } from 'vitest';
import { validateBlueprint } from './blueprint-validation';
import type { BlueprintManifest } from './blueprint-types';

/** Minimal valid blueprint for use as a test base. */
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
          agentRef: 'agent-1',
        },
        {
          refId: 'view-2',
          type: 'anchor',
          displayName: 'Anchor',
          position: { x: 100, y: 100 },
        },
      ],
      wires: [
        { sourceRef: 'view-1', targetRef: 'view-2' },
      ],
    },
    agents: [
      { refId: 'agent-1', name: 'Coder' },
    ],
    projects: [
      { refId: 'proj-1', name: 'My Project', relativePath: './my-project' },
    ],
  };
}

describe('validateBlueprint', () => {
  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------
  it('accepts a fully valid blueprint', () => {
    const result = validateBlueprint(validBlueprint());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a minimal valid blueprint with no agents, projects, or wires', () => {
    const bp: BlueprintManifest = {
      id: 'abc',
      name: 'Minimal',
      version: '0.1.0',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00Z',
      canvas: { views: [], wires: [] },
    };
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts blueprint with optional string fields', () => {
    const bp = validBlueprint();
    bp.description = 'A test blueprint';
    bp.createdBy = 'mega-camel';
    bp.exportedFrom = '0.39.0';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Top-level structural errors
  // -----------------------------------------------------------------------
  it('rejects null', () => {
    const result = validateBlueprint(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Blueprint must be a non-null object');
  });

  it('rejects an array', () => {
    const result = validateBlueprint([]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Blueprint must be a non-null object');
  });

  it('rejects a primitive', () => {
    const result = validateBlueprint('not a blueprint');
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Required field validation
  // -----------------------------------------------------------------------
  it('reports missing id', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    delete bp.id;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('id must be a non-empty string');
  });

  it('reports empty name', () => {
    const bp = validBlueprint();
    (bp as Record<string, unknown>).name = '';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name must be a non-empty string');
  });

  it('reports missing version', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    delete bp.version;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('version must be a non-empty string');
  });

  it('reports missing createdAt', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    delete bp.createdAt;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('createdAt must be a non-empty string');
  });

  // -----------------------------------------------------------------------
  // schemaVersion
  // -----------------------------------------------------------------------
  it('rejects schemaVersion !== 1', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    bp.schemaVersion = 2;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('schemaVersion must be 1'))).toBe(true);
  });

  it('rejects schemaVersion of wrong type', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    bp.schemaVersion = '1';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Canvas validation
  // -----------------------------------------------------------------------
  it('rejects missing canvas', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    delete bp.canvas;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('canvas must be a non-null object');
  });

  it('rejects canvas without views array', () => {
    const bp = validBlueprint();
    (bp.canvas as Record<string, unknown>).views = 'not-array';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('canvas.views must be an array');
  });

  it('rejects canvas without wires array', () => {
    const bp = validBlueprint();
    (bp.canvas as Record<string, unknown>).wires = null;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('canvas.wires must be an array');
  });

  // -----------------------------------------------------------------------
  // View validation
  // -----------------------------------------------------------------------
  it('rejects view missing refId', () => {
    const bp = validBlueprint();
    (bp.canvas.views[0] as Record<string, unknown>).refId = '';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('refId must be a non-empty string'))).toBe(true);
  });

  it('rejects view missing type', () => {
    const bp = validBlueprint();
    delete (bp.canvas.views[0] as Record<string, unknown>).type;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('type must be a non-empty string'))).toBe(true);
  });

  it('rejects view missing displayName', () => {
    const bp = validBlueprint();
    (bp.canvas.views[0] as Record<string, unknown>).displayName = '';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('displayName must be a non-empty string'))).toBe(true);
  });

  it('rejects view with invalid position', () => {
    const bp = validBlueprint();
    (bp.canvas.views[0] as Record<string, unknown>).position = { x: 'bad', y: 0 };
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('position.x must be a number'))).toBe(true);
  });

  it('rejects view with invalid size', () => {
    const bp = validBlueprint();
    bp.canvas.views[0].size = { width: -1, height: 'bad' as unknown as number };
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('size.height must be a number'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Duplicate refId detection
  // -----------------------------------------------------------------------
  it('rejects duplicate view refIds', () => {
    const bp = validBlueprint();
    bp.canvas.views[1].refId = 'view-1'; // same as views[0]
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('duplicate'))).toBe(true);
  });

  it('rejects duplicate agent refIds', () => {
    const bp = validBlueprint();
    bp.agents = [
      { refId: 'agent-1', name: 'A' },
      { refId: 'agent-1', name: 'B' },
    ];
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('agent') && e.includes('duplicate'))).toBe(true);
  });

  it('rejects duplicate project refIds', () => {
    const bp = validBlueprint();
    bp.projects = [
      { refId: 'proj-1', name: 'A' },
      { refId: 'proj-1', name: 'B' },
    ];
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('project') && e.includes('duplicate'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Dangling wire references
  // -----------------------------------------------------------------------
  it('rejects wire with dangling sourceRef', () => {
    const bp = validBlueprint();
    bp.canvas.wires[0].sourceRef = 'nonexistent';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceRef') && e.includes('nonexistent'))).toBe(true);
  });

  it('rejects wire with dangling targetRef', () => {
    const bp = validBlueprint();
    bp.canvas.wires[0].targetRef = 'gone';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('targetRef') && e.includes('gone'))).toBe(true);
  });

  it('rejects wire with empty sourceRef', () => {
    const bp = validBlueprint();
    bp.canvas.wires[0].sourceRef = '';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('sourceRef must be a non-empty string'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Dangling agent / project references from views
  // -----------------------------------------------------------------------
  it('rejects view with dangling agentRef', () => {
    const bp = validBlueprint();
    bp.canvas.views[0].agentRef = 'no-such-agent';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('agentRef') && e.includes('no-such-agent'))).toBe(true);
  });

  it('rejects view with dangling projectRef', () => {
    const bp = validBlueprint();
    bp.canvas.views[0].projectRef = 'no-such-project';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('projectRef') && e.includes('no-such-project'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Layout validation
  // -----------------------------------------------------------------------
  it('accepts valid layout', () => {
    const bp = validBlueprint();
    bp.canvas.layout = { algorithm: 'elk', direction: 'RIGHT', centerViewRef: 'view-1' };
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(true);
  });

  it('rejects layout with empty algorithm', () => {
    const bp = validBlueprint();
    bp.canvas.layout = { algorithm: '' };
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('algorithm'))).toBe(true);
  });

  it('rejects layout with dangling centerViewRef', () => {
    const bp = validBlueprint();
    bp.canvas.layout = { algorithm: 'elk', centerViewRef: 'nonexistent' };
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('centerViewRef') && e.includes('nonexistent'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Agent validation
  // -----------------------------------------------------------------------
  it('rejects agent with empty name', () => {
    const bp = validBlueprint();
    bp.agents = [{ refId: 'a1', name: '' }];
    bp.canvas.views[0].agentRef = 'a1';
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('agents[0].name'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Project validation
  // -----------------------------------------------------------------------
  it('rejects project with empty name', () => {
    const bp = validBlueprint();
    bp.projects = [{ refId: 'p1', name: '' }];
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('projects[0].name'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // requiredPlugins validation
  // -----------------------------------------------------------------------
  it('accepts valid requiredPlugins', () => {
    const bp = validBlueprint();
    bp.requiredPlugins = ['plugin-a', 'plugin-b'];
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(true);
  });

  it('rejects requiredPlugins with non-string entry', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    bp.requiredPlugins = ['ok', 42];
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requiredPlugins[1]'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multiple errors in a single blueprint
  // -----------------------------------------------------------------------
  it('collects multiple errors at once', () => {
    const bp = validBlueprint() as Record<string, unknown>;
    delete bp.id;
    delete bp.name;
    bp.schemaVersion = 99;
    const result = validateBlueprint(bp);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
