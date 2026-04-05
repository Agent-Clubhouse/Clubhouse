import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../shared/types';
import type { BlueprintManifest, BlueprintAgentDef, BlueprintProjectRef } from '../../../shared/blueprint-types';
import {
  validateManifest,
  matchAgent,
  matchProject,
  importBlueprint,
  resolveAndCreateWires,
  bindAgentToStub,
} from './blueprint-import';
import type { ExistingProject } from './blueprint-import';

// ── Helpers ─────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    projectId: 'proj-1',
    name: 'test-agent',
    kind: 'durable',
    status: 'idle',
    color: 'blue',
    ...overrides,
  } as Agent;
}

function makeManifest(overrides: Partial<BlueprintManifest> = {}): BlueprintManifest {
  return {
    id: 'bp-001',
    name: 'Test Blueprint',
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: '2026-04-05T00:00:00Z',
    canvas: {
      views: [
        { refId: 'v1', type: 'agent', displayName: 'Agent Card', position: { x: 100, y: 100 }, agentRef: 'a1' },
        { refId: 'v2', type: 'agent', displayName: 'Second Agent', position: { x: 400, y: 100 }, agentRef: 'a2' },
      ],
      wires: [
        { sourceRef: 'v1', targetRef: 'v2' },
      ],
    },
    agents: [
      { refId: 'a1', name: 'scout', matchBy: { name: 'scout' } },
      { refId: 'a2', name: 'builder', matchBy: { name: 'builder' } },
    ],
    projects: [
      { refId: 'p1', name: 'my-app', relativePath: 'projects/my-app' },
    ],
    ...overrides,
  };
}

// ── validateManifest ────────────────────────────────────────────────

describe('validateManifest', () => {
  it('passes for a valid manifest', () => {
    const result = validateManifest(makeManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Expected an object');
  });

  it('rejects unsupported schemaVersion', () => {
    const result = validateManifest(makeManifest({ schemaVersion: 99 as any }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/schemaVersion/);
  });

  it('rejects missing name', () => {
    const result = validateManifest(makeManifest({ name: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('detects duplicate view refIds', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'dup', type: 'agent', displayName: 'A', position: { x: 0, y: 0 } },
          { refId: 'dup', type: 'agent', displayName: 'B', position: { x: 100, y: 0 } },
        ],
        wires: [],
      },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate view refId'))).toBe(true);
  });

  it('detects dangling wire sourceRef', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 } },
        ],
        wires: [
          { sourceRef: 'missing', targetRef: 'v1' },
        ],
      },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceRef "missing"'))).toBe(true);
  });

  it('detects dangling wire targetRef', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 } },
        ],
        wires: [
          { sourceRef: 'v1', targetRef: 'ghost' },
        ],
      },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('targetRef "ghost"'))).toBe(true);
  });

  it('detects dangling agentRef on views', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 }, agentRef: 'nonexistent' },
        ],
        wires: [],
      },
      agents: [],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('agentRef "nonexistent"'))).toBe(true);
  });

  it('detects dangling projectRef on views', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 }, projectRef: 'missing-proj' },
        ],
        wires: [],
      },
      projects: [],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('projectRef "missing-proj"'))).toBe(true);
  });

  it('detects duplicate agent refIds', () => {
    const manifest = makeManifest({
      agents: [
        { refId: 'dup-agent', name: 'A' },
        { refId: 'dup-agent', name: 'B' },
      ],
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate agent refId'))).toBe(true);
  });
});

// ── matchAgent ──────────────────────────────────────────────────────

describe('matchAgent', () => {
  const agents: Agent[] = [
    makeAgent({ id: 'a1', name: 'scout' }),
    makeAgent({ id: 'a2', name: 'builder' }),
    makeAgent({ id: 'a3', name: 'Scout' }),
  ];

  it('matches by exact name via matchBy.name', () => {
    const def: BlueprintAgentDef = { refId: 'x', name: 'scout', matchBy: { name: 'scout' } };
    const result = matchAgent(def, agents);
    expect(result.status).toBe('matched');
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe('a1');
  });

  it('returns ambiguous when multiple exact matches', () => {
    const dupeAgents = [
      makeAgent({ id: 'a1', name: 'scout' }),
      makeAgent({ id: 'a2', name: 'scout' }),
    ];
    const def: BlueprintAgentDef = { refId: 'x', name: 'scout', matchBy: { name: 'scout' } };
    const result = matchAgent(def, dupeAgents);
    expect(result.status).toBe('ambiguous');
    expect(result.agents).toHaveLength(2);
  });

  it('matches by name pattern glob', () => {
    const def: BlueprintAgentDef = { refId: 'x', name: 'build', matchBy: { namePattern: 'build*' } };
    const result = matchAgent(def, agents);
    expect(result.status).toBe('matched');
    expect(result.agents[0].id).toBe('a2');
  });

  it('falls back to case-insensitive name match', () => {
    const def: BlueprintAgentDef = { refId: 'x', name: 'BUILDER' };
    const result = matchAgent(def, agents);
    expect(result.status).toBe('matched');
    expect(result.agents[0].id).toBe('a2');
  });

  it('returns not_found when no match exists', () => {
    const def: BlueprintAgentDef = { refId: 'x', name: 'nonexistent' };
    const result = matchAgent(def, agents);
    expect(result.status).toBe('not_found');
    expect(result.agents).toHaveLength(0);
  });

  it('case-insensitive fallback returns ambiguous for multiple matches', () => {
    // agents has 'scout' and 'Scout' — both match case-insensitively
    const def: BlueprintAgentDef = { refId: 'x', name: 'scout' };
    // No matchBy, so falls back to case-insensitive
    const result = matchAgent(def, agents);
    expect(result.status).toBe('ambiguous');
    expect(result.agents).toHaveLength(2);
  });
});

// ── matchProject ────────────────────────────────────────────────────

describe('matchProject', () => {
  const projects: ExistingProject[] = [
    { id: 'p1', name: 'my-app', path: '/home/user/projects/my-app' },
    { id: 'p2', name: 'backend', path: '/home/user/projects/backend' },
  ];

  it('matches by path via matchBy.path', () => {
    const ref: BlueprintProjectRef = { refId: 'r1', name: 'app', matchBy: { path: 'projects/my-app' } };
    const result = matchProject(ref, projects);
    expect(result.matchedProjectId).toBe('p1');
  });

  it('matches by name via matchBy.name', () => {
    const ref: BlueprintProjectRef = { refId: 'r1', name: 'whatever', matchBy: { name: 'backend' } };
    const result = matchProject(ref, projects);
    expect(result.matchedProjectId).toBe('p2');
  });

  it('matches by ref.name as fallback', () => {
    const ref: BlueprintProjectRef = { refId: 'r1', name: 'my-app' };
    const result = matchProject(ref, projects);
    expect(result.matchedProjectId).toBe('p1');
  });

  it('matches by relativePath', () => {
    const ref: BlueprintProjectRef = { refId: 'r1', name: 'unknown', relativePath: 'projects/backend' };
    const result = matchProject(ref, projects);
    expect(result.matchedProjectId).toBe('p2');
  });

  it('returns no match when nothing found', () => {
    const ref: BlueprintProjectRef = { refId: 'r1', name: 'nonexistent' };
    const result = matchProject(ref, projects);
    expect(result.matchedProjectId).toBeUndefined();
  });
});

// ── importBlueprint ─────────────────────────────────────────────────

describe('importBlueprint', () => {
  const agents: Agent[] = [
    makeAgent({ id: 'agent-scout', name: 'scout' }),
    makeAgent({ id: 'agent-builder', name: 'builder' }),
  ];
  const projects: ExistingProject[] = [
    { id: 'proj-1', name: 'my-app', path: '/home/user/projects/my-app' },
  ];

  it('creates canvas with views positioned from manifest', () => {
    const manifest = makeManifest();
    const result = importBlueprint(manifest, agents, projects);

    expect(result.canvas.name).toBe('Test Blueprint');
    expect(result.canvas.views).toHaveLength(2);
    // Positions should be snapped to grid
    expect(result.canvas.views[0].position.x).toBe(100);
    expect(result.canvas.views[0].position.y).toBe(100);
  });

  it('maps refIds to new view IDs', () => {
    const manifest = makeManifest();
    const result = importBlueprint(manifest, agents, projects);

    expect(result.refIdToViewId.size).toBe(2);
    expect(result.refIdToViewId.has('v1')).toBe(true);
    expect(result.refIdToViewId.has('v2')).toBe(true);
    // View IDs should be different from refIds
    expect(result.refIdToViewId.get('v1')).not.toBe('v1');
  });

  it('matches agents and creates stubs with correct badges', () => {
    const manifest = makeManifest();
    const result = importBlueprint(manifest, agents, projects);

    expect(result.stubs).toHaveLength(2);

    const scoutStub = result.stubs.find((s) => s.def.name === 'scout')!;
    expect(scoutStub.badge).toBe('connected');
    expect(scoutStub.bound).toBe(true);
    expect(scoutStub.boundAgentId).toBe('agent-scout');

    const builderStub = result.stubs.find((s) => s.def.name === 'builder')!;
    expect(builderStub.badge).toBe('connected');
    expect(builderStub.bound).toBe(true);
    expect(builderStub.boundAgentId).toBe('agent-builder');
  });

  it('creates not_found stubs when agents are missing', () => {
    const manifest = makeManifest();
    const result = importBlueprint(manifest, [], projects); // no existing agents

    const scoutStub = result.stubs.find((s) => s.def.name === 'scout')!;
    expect(scoutStub.badge).toBe('not_found');
    expect(scoutStub.bound).toBe(false);
    expect(scoutStub.boundAgentId).toBeUndefined();
  });

  it('creates ambiguous stubs when multiple matches exist', () => {
    const dupeAgents = [
      makeAgent({ id: 'a1', name: 'scout' }),
      makeAgent({ id: 'a2', name: 'scout' }),
    ];
    const manifest = makeManifest();
    const result = importBlueprint(manifest, dupeAgents, projects);

    const scoutStub = result.stubs.find((s) => s.def.name === 'scout')!;
    expect(scoutStub.badge).toBe('multiple_matches');
    expect(scoutStub.bound).toBe(false);
  });

  it('passes through wires as pending', () => {
    const manifest = makeManifest();
    const result = importBlueprint(manifest, agents, projects);

    expect(result.pendingWires).toHaveLength(1);
    expect(result.pendingWires[0].sourceRef).toBe('v1');
    expect(result.pendingWires[0].targetRef).toBe('v2');
  });

  it('handles mixed view types', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'Agent', position: { x: 0, y: 0 }, agentRef: 'a1' },
          { refId: 'v2', type: 'sticky-note', displayName: 'Note', position: { x: 200, y: 0 } },
          { refId: 'v3', type: 'anchor', displayName: 'My Anchor', position: { x: 400, y: 0 } },
          { refId: 'v4', type: 'zone', displayName: 'Work Zone', position: { x: 0, y: 200 }, size: { width: 600, height: 400 } },
        ],
        wires: [],
      },
      agents: [{ refId: 'a1', name: 'scout', matchBy: { name: 'scout' } }],
    });

    const result = importBlueprint(manifest, agents, projects);

    expect(result.canvas.views).toHaveLength(4);
    expect(result.canvas.views[0].type).toBe('agent');
    expect(result.canvas.views[1].type).toBe('sticky-note');
    expect((result.canvas.views[1] as any).content).toBe('');
    expect(result.canvas.views[2].type).toBe('anchor');
    expect((result.canvas.views[2] as any).label).toBe('My Anchor');
    expect(result.canvas.views[3].type).toBe('zone');
    expect((result.canvas.views[3] as any).themeId).toBe('catppuccin-mocha');
  });

  it('applies layout settings from manifest', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 } },
        ],
        wires: [],
        layout: { algorithm: 'radial', direction: 'DOWN', centerViewRef: 'v1' },
      },
      agents: [],
    });

    const result = importBlueprint(manifest, [], []);
    expect(result.canvas.elkAlgorithm).toBe('radial');
    expect(result.canvas.elkDirection).toBe('DOWN');
    expect(result.canvas.layoutCenterId).toBe(result.refIdToViewId.get('v1'));
  });

  it('matches projects by name', () => {
    const manifest = makeManifest();
    const result = importBlueprint(manifest, agents, projects);

    const appMatch = result.projectMatches.find((p) => p.name === 'my-app')!;
    expect(appMatch.matchedProjectId).toBe('proj-1');
  });

  it('throws on invalid manifest', () => {
    expect(() => importBlueprint({ invalid: true } as any, [], [])).toThrow(/Invalid blueprint/);
  });
});

// ── resolveAndCreateWires ───────────────────────────────────────────

describe('resolveAndCreateWires', () => {
  it('creates wires when both endpoints are bound', () => {
    const manifest = makeManifest();
    const agents = [
      makeAgent({ id: 'agent-scout', name: 'scout' }),
      makeAgent({ id: 'agent-builder', name: 'builder' }),
    ];
    const projects: ExistingProject[] = [];

    const importResult = importBlueprint(manifest, agents, projects);

    const wireResult = resolveAndCreateWires(
      importResult.pendingWires,
      importResult.refIdToViewId,
      importResult.stubs,
      importResult.canvas.views,
    );

    expect(wireResult.created).toHaveLength(1);
    expect(wireResult.created[0].agentId).toBe('agent-scout');
    expect(wireResult.created[0].targetId).toBe('agent-builder');
    expect(wireResult.created[0].targetKind).toBe('agent');
    expect(wireResult.remaining).toHaveLength(0);
  });

  it('defers wires when source is not bound', () => {
    const manifest = makeManifest();
    // Only one agent exists
    const agents = [makeAgent({ id: 'agent-builder', name: 'builder' })];

    const importResult = importBlueprint(manifest, agents, []);

    const wireResult = resolveAndCreateWires(
      importResult.pendingWires,
      importResult.refIdToViewId,
      importResult.stubs,
      importResult.canvas.views,
    );

    // scout is not matched, so wire stays pending
    expect(wireResult.created).toHaveLength(0);
    expect(wireResult.remaining).toHaveLength(1);
  });

  it('defers wires when target is not bound', () => {
    const manifest = makeManifest();
    // Only one agent exists
    const agents = [makeAgent({ id: 'agent-scout', name: 'scout' })];

    const importResult = importBlueprint(manifest, agents, []);

    const wireResult = resolveAndCreateWires(
      importResult.pendingWires,
      importResult.refIdToViewId,
      importResult.stubs,
      importResult.canvas.views,
    );

    // builder is not matched, so wire stays pending
    expect(wireResult.created).toHaveLength(0);
    expect(wireResult.remaining).toHaveLength(1);
  });

  it('creates bidirectional wires as two entries', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 }, agentRef: 'a1' },
          { refId: 'v2', type: 'agent', displayName: 'B', position: { x: 200, y: 0 }, agentRef: 'a2' },
        ],
        wires: [
          { sourceRef: 'v1', targetRef: 'v2', bidirectional: true },
        ],
      },
      agents: [
        { refId: 'a1', name: 'scout', matchBy: { name: 'scout' } },
        { refId: 'a2', name: 'builder', matchBy: { name: 'builder' } },
      ],
    });

    const agents = [
      makeAgent({ id: 'agent-scout', name: 'scout' }),
      makeAgent({ id: 'agent-builder', name: 'builder' }),
    ];

    const importResult = importBlueprint(manifest, agents, []);
    const wireResult = resolveAndCreateWires(
      importResult.pendingWires,
      importResult.refIdToViewId,
      importResult.stubs,
      importResult.canvas.views,
    );

    expect(wireResult.created).toHaveLength(2);
    expect(wireResult.created[0].agentId).toBe('agent-scout');
    expect(wireResult.created[0].targetId).toBe('agent-builder');
    expect(wireResult.created[1].agentId).toBe('agent-builder');
    expect(wireResult.created[1].targetId).toBe('agent-scout');
  });

  it('preserves wire instructions and disabledTools', () => {
    const manifest = makeManifest({
      canvas: {
        views: [
          { refId: 'v1', type: 'agent', displayName: 'A', position: { x: 0, y: 0 }, agentRef: 'a1' },
          { refId: 'v2', type: 'agent', displayName: 'B', position: { x: 200, y: 0 }, agentRef: 'a2' },
        ],
        wires: [
          {
            sourceRef: 'v1',
            targetRef: 'v2',
            instructions: { '*': 'Be helpful', send_message: 'Be brief' },
            disabledTools: ['read_output'],
          },
        ],
      },
      agents: [
        { refId: 'a1', name: 'scout', matchBy: { name: 'scout' } },
        { refId: 'a2', name: 'builder', matchBy: { name: 'builder' } },
      ],
    });

    const agents = [
      makeAgent({ id: 'agent-scout', name: 'scout' }),
      makeAgent({ id: 'agent-builder', name: 'builder' }),
    ];

    const importResult = importBlueprint(manifest, agents, []);
    const wireResult = resolveAndCreateWires(
      importResult.pendingWires,
      importResult.refIdToViewId,
      importResult.stubs,
      importResult.canvas.views,
    );

    expect(wireResult.created[0].instructions).toEqual({
      '*': 'Be helpful',
      send_message: 'Be brief',
    });
    expect(wireResult.created[0].disabledTools).toEqual(['read_output']);
  });
});

// ── bindAgentToStub ─────────────────────────────────────────────────

describe('bindAgentToStub', () => {
  it('binds an agent to a stub and updates badge', () => {
    const manifest = makeManifest();
    const importResult = importBlueprint(manifest, [], []);

    const viewId = importResult.stubs[0].viewId;
    const updated = bindAgentToStub(importResult.stubs, viewId, 'new-agent-id');

    const boundStub = updated.find((s) => s.viewId === viewId)!;
    expect(boundStub.bound).toBe(true);
    expect(boundStub.boundAgentId).toBe('new-agent-id');
    expect(boundStub.badge).toBe('connected');
  });

  it('does not modify other stubs', () => {
    const manifest = makeManifest();
    const importResult = importBlueprint(manifest, [], []);

    const viewId = importResult.stubs[0].viewId;
    const otherViewId = importResult.stubs[1].viewId;
    const updated = bindAgentToStub(importResult.stubs, viewId, 'new-agent-id');

    const otherStub = updated.find((s) => s.viewId === otherViewId)!;
    expect(otherStub.bound).toBe(false);
    expect(otherStub.badge).toBe('not_found');
  });

  it('allows resolving wires after binding', () => {
    const manifest = makeManifest();
    const importResult = importBlueprint(manifest, [], []);

    // Bind both stubs
    let stubs = bindAgentToStub(importResult.stubs, importResult.stubs[0].viewId, 'agent-scout');
    stubs = bindAgentToStub(stubs, importResult.stubs[1].viewId, 'agent-builder');

    const wireResult = resolveAndCreateWires(
      importResult.pendingWires,
      importResult.refIdToViewId,
      stubs,
      importResult.canvas.views,
    );

    expect(wireResult.created).toHaveLength(1);
    expect(wireResult.created[0].agentId).toBe('agent-scout');
    expect(wireResult.created[0].targetId).toBe('agent-builder');
    expect(wireResult.remaining).toHaveLength(0);
  });
});
