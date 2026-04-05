import { describe, it, expect, beforeEach } from 'vitest';
import {
  exportProjectBundle,
  serializeBundle,
  validateBundle,
  importBundle,
  type BundleExportContext,
} from './blueprint-bundle';
import type { CanvasInstance, AgentCanvasView } from '../../plugins/builtin/canvas/canvas-types';
import type { Agent, Project } from '../../../shared/types';
import { resetRefCounter } from './blueprint-export';

// ── Test helpers ──────────────────────────────────────────────────────

function makeCanvas(name: string, views: any[] = [], overrides: Partial<CanvasInstance> = {}): CanvasInstance {
  return {
    id: `canvas_${name}`,
    name,
    views,
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: views.length,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
    ...overrides,
  };
}

function makeAgentView(id: string, agentId: string): AgentCanvasView {
  return {
    id,
    type: 'agent',
    position: { x: 100, y: 200 },
    size: { width: 480, height: 480 },
    title: 'Agent',
    displayName: 'Agent',
    zIndex: 0,
    metadata: { agentId, agentName: 'Agent' },
    agentId,
    projectId: 'proj_1',
  };
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    projectId: 'proj_1',
    name,
    kind: 'durable',
    status: 'running',
    color: 'emerald',
    orchestrator: 'claude-code',
    model: 'opus',
  } as Agent;
}

function makeProject(): Project {
  return { id: 'proj_1', name: 'test-project', path: '/Users/test/source/test-project' };
}

function makeContext(overrides: Partial<BundleExportContext> = {}): BundleExportContext {
  return {
    agents: {},
    projects: { proj_1: makeProject() },
    wireDefinitions: [],
    projectId: 'proj_1',
    exportProjectPath: '/Users/test/source/test-project',
    projectName: 'test-project',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  resetRefCounter();
});

describe('exportProjectBundle', () => {
  it('exports empty project as bundle with no blueprints', () => {
    const bundle = exportProjectBundle([], makeContext());

    expect(bundle.name).toBe('test-project');
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.blueprints).toEqual([]);
    expect(bundle.metadata?.canvasCount).toBe(0);
    expect(bundle.metadata?.totalViews).toBe(0);
  });

  it('exports multiple canvases as separate blueprints', () => {
    const canvases = [
      makeCanvas('Board A', [makeAgentView('cv_1', 'durable_a')]),
      makeCanvas('Board B', [makeAgentView('cv_2', 'durable_b')]),
      makeCanvas('Board C'),
    ];
    const ctx = makeContext({
      agents: {
        durable_a: makeAgent('durable_a', 'Agent A'),
        durable_b: makeAgent('durable_b', 'Agent B'),
      },
    });

    const bundle = exportProjectBundle(canvases, ctx);

    expect(bundle.blueprints).toHaveLength(3);
    expect(bundle.blueprints[0].name).toBe('Board A');
    expect(bundle.blueprints[1].name).toBe('Board B');
    expect(bundle.blueprints[2].name).toBe('Board C');
    expect(bundle.metadata?.canvasCount).toBe(3);
    expect(bundle.metadata?.totalViews).toBe(2);
    expect(bundle.metadata?.totalAgents).toBe(2);
  });

  it('includes project metadata', () => {
    const bundle = exportProjectBundle([makeCanvas('Test')], makeContext());

    expect(bundle.metadata?.projectName).toBe('test-project');
    expect(bundle.id).toBeTruthy();
    expect(bundle.createdAt).toBeTruthy();
    expect(bundle.version).toBe('1.0.0');
  });

  it('passes appVersion through to bundle', () => {
    const bundle = exportProjectBundle([], makeContext({ appVersion: '0.39.0' }));
    expect(bundle.exportedFrom).toBe('0.39.0');
  });
});

describe('serializeBundle', () => {
  it('produces valid JSON with nested data preserved', () => {
    const canvases = [
      makeCanvas('Board A', [makeAgentView('cv_1', 'durable_a')]),
    ];
    const ctx = makeContext({
      agents: { durable_a: makeAgent('durable_a', 'Agent A') },
    });
    const bundle = exportProjectBundle(canvases, ctx);
    const json = serializeBundle(bundle);
    const parsed = JSON.parse(json);

    expect(parsed.name).toBe('test-project');
    expect(parsed.blueprints).toHaveLength(1);
    expect(parsed.blueprints[0].canvas.views).toHaveLength(1);
    expect(parsed.blueprints[0].canvas.views[0].position).toBeDefined();
    expect(parsed.metadata.canvasCount).toBe(1);
  });
});

describe('validateBundle', () => {
  it('accepts a valid bundle', () => {
    const bundle = exportProjectBundle([makeCanvas('Test')], makeContext());
    const result = validateBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    const result = validateBundle('not an object');
    expect(result.valid).toBe(false);
  });

  it('rejects missing schemaVersion', () => {
    const result = validateBundle({ blueprints: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('schemaVersion');
  });

  it('rejects missing blueprints array', () => {
    const result = validateBundle({ schemaVersion: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('blueprints');
  });

  it('rejects empty blueprints array', () => {
    const result = validateBundle({ schemaVersion: 1, blueprints: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('no blueprints');
  });

  it('rejects blueprints without canvas property', () => {
    const result = validateBundle({ schemaVersion: 1, blueprints: [{ name: 'test' }] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('canvas');
  });
});

describe('importBundle', () => {
  it('imports a bundle creating multiple canvases', () => {
    const canvases = [
      makeCanvas('Board A', [makeAgentView('cv_1', 'durable_a')]),
      makeCanvas('Board B'),
    ];
    const ctx = makeContext({
      agents: { durable_a: makeAgent('durable_a', 'Agent A') },
    });
    const bundle = exportProjectBundle(canvases, ctx);
    const result = importBundle(bundle);

    expect(result.canvases).toHaveLength(2);
    expect(result.canvases[0].name).toBe('Board A');
    expect(result.canvases[1].name).toBe('Board B');
    expect(result.errors).toHaveLength(0);
  });

  it('handles empty bundle gracefully', () => {
    const bundle = exportProjectBundle([], makeContext());
    // Override to bypass validation (empty bundles still importable at code level)
    bundle.blueprints = [];
    const result = importBundle(bundle);
    expect(result.canvases).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('collects errors for failed imports without stopping', () => {
    const bundle = exportProjectBundle([makeCanvas('Good')], makeContext());
    // Inject a bad blueprint
    bundle.blueprints.push({
      id: 'bad',
      name: 'Bad Blueprint',
      version: '1.0.0',
      schemaVersion: 1,
      createdAt: '',
      canvas: { views: [{ refId: 'v1', type: 'INVALID_TYPE' as any, displayName: 'Bad', position: { x: 0, y: 0 } }], wires: [] },
    });
    const result = importBundle(bundle);

    // Good canvas imported, bad one produces error
    expect(result.canvases.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('tracks agent stub count from manifests', () => {
    const canvases = [makeCanvas('Board', [makeAgentView('cv_1', 'durable_a')])];
    const ctx = makeContext({
      agents: { durable_a: makeAgent('durable_a', 'Agent A') },
    });
    const bundle = exportProjectBundle(canvases, ctx);
    const result = importBundle(bundle);

    expect(result.totalAgentStubs).toBe(1);
  });
});
