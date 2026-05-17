import { describe, it, expect, beforeEach } from 'vitest';
import {
  exportCanvasToBlueprint,
  serializeManifest,
  slugify,
  resetRefCounter,
  type ExportContext,
} from './blueprint-export';
import type { CanvasInstance, AgentCanvasView, AnchorCanvasView, PluginCanvasView, StickyNoteCanvasView, ZoneCanvasView } from '../../plugins/builtin/canvas/canvas-types';
import type { McpBindingEntry } from '../../stores/mcpBindingStore';
import type { Agent, Project } from '../../../shared/types';

// ── Test helpers ──────────────────────────────────────────────────────

function makeCanvas(views: any[] = [], overrides: Partial<CanvasInstance> = {}): CanvasInstance {
  return {
    id: 'canvas_1',
    name: 'Test Canvas',
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

function makeAgentView(overrides: Partial<AgentCanvasView> = {}): AgentCanvasView {
  return {
    id: 'cv_agent1',
    type: 'agent',
    position: { x: 100, y: 200 },
    size: { width: 480, height: 480 },
    title: 'My Agent',
    displayName: 'My Agent',
    zIndex: 0,
    metadata: {
      agentId: 'durable_abc',
      agentName: 'My Agent',
      projectName: 'Test Project',
      orchestrator: 'claude-code',
      model: 'opus',
    },
    agentId: 'durable_abc',
    projectId: 'proj_1',
    ...overrides,
  };
}

function makeAnchorView(overrides: Partial<AnchorCanvasView> = {}): AnchorCanvasView {
  return {
    id: 'cv_anchor1',
    type: 'anchor',
    position: { x: 300, y: 100 },
    size: { width: 240, height: 50 },
    title: 'Notes',
    displayName: 'Notes',
    zIndex: 1,
    metadata: {},
    label: 'My Notes',
    autoCollapse: true,
    ...overrides,
  };
}

function makePluginView(overrides: Partial<PluginCanvasView> = {}): PluginCanvasView {
  return {
    id: 'cv_plugin1',
    type: 'plugin',
    position: { x: 600, y: 200 },
    size: { width: 560, height: 480 },
    title: 'Group Project',
    displayName: 'Group Project',
    zIndex: 2,
    metadata: { groupProjectId: 'gp_456' },
    pluginWidgetType: 'plugin:group-project:groupproject',
    pluginId: 'group-project',
    ...overrides,
  };
}

function makeStickyView(overrides: Partial<StickyNoteCanvasView> = {}): StickyNoteCanvasView {
  return {
    id: 'cv_sticky1',
    type: 'sticky-note',
    position: { x: 400, y: 400 },
    size: { width: 250, height: 250 },
    title: 'Note',
    displayName: 'Note',
    zIndex: 3,
    metadata: {},
    content: 'Hello world',
    color: 'yellow',
    ...overrides,
  };
}

function makeZoneView(overrides: Partial<ZoneCanvasView> = {}): ZoneCanvasView {
  return {
    id: 'cv_zone1',
    type: 'zone',
    position: { x: 0, y: 0 },
    size: { width: 600, height: 400 },
    title: 'Dev Zone',
    displayName: 'Dev Zone',
    zIndex: 4,
    metadata: {},
    themeId: 'catppuccin-mocha',
    containedViewIds: [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'durable_abc',
    projectId: 'proj_1',
    name: 'My Agent',
    kind: 'durable',
    status: 'running',
    color: 'emerald',
    orchestrator: 'claude-code',
    model: 'opus',
    ...overrides,
  } as Agent;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    name: 'test-project',
    path: '/Users/test/source/test-project',
    ...overrides,
  };
}

function makeWire(overrides: Partial<McpBindingEntry> = {}): McpBindingEntry {
  return {
    agentId: 'durable_abc',
    targetId: 'durable_def',
    targetKind: 'agent',
    label: 'wire-1',
    agentName: 'My Agent',
    targetName: 'Other Agent',
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    agents: {},
    projects: {},
    wireDefinitions: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  resetRefCounter();
});

describe('exportCanvasToBlueprint', () => {
  it('exports an empty canvas with correct manifest structure', () => {
    const canvas = makeCanvas();
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    expect(manifest.name).toBe('Test Canvas');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.id).toBeTruthy();
    expect(manifest.createdAt).toBeTruthy();
    expect(manifest.canvas.views).toEqual([]);
    expect(manifest.canvas.wires).toEqual([]);
    expect(manifest.canvas.layout?.algorithm).toBe('layered');
    expect(manifest.canvas.layout?.direction).toBe('RIGHT');
  });

  it('exports agent views with agentRef', () => {
    const agentView = makeAgentView();
    const agent = makeAgent();
    const canvas = makeCanvas([agentView]);
    const ctx = makeContext({
      agents: { [agent.id]: agent },
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.canvas.views).toHaveLength(1);
    const view = manifest.canvas.views[0];
    expect(view.type).toBe('agent');
    expect(view.displayName).toBe('My Agent');
    expect(view.position).toEqual({ x: 100, y: 200 });
    expect(view.agentRef).toBeTruthy();

    // Agent def should be created
    expect(manifest.agents).toHaveLength(1);
    expect(manifest.agents![0].name).toBe('My Agent');
    expect(manifest.agents![0].orchestrator).toBe('claude-code');
    expect(manifest.agents![0].model).toBe('opus');
    expect(manifest.agents![0].matchBy?.name).toBe('My Agent');

    // View agentRef should match agent def refId
    expect(view.agentRef).toBe(manifest.agents![0].refId);
  });

  it('strips ephemeral metadata from views', () => {
    const agentView = makeAgentView();
    const canvas = makeCanvas([agentView]);
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    const view = manifest.canvas.views[0];
    // Ephemeral keys should be stripped
    expect(view.metadata?.agentId).toBeUndefined();
    expect(view.metadata?.agentName).toBeUndefined();
    expect(view.metadata?.orchestrator).toBeUndefined();
    expect(view.metadata?.model).toBeUndefined();
    expect(view.metadata?.projectName).toBeUndefined();
  });

  it('exports anchor views with label and autoCollapse', () => {
    const anchorView = makeAnchorView();
    const canvas = makeCanvas([anchorView]);
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    expect(manifest.canvas.views).toHaveLength(1);
    const view = manifest.canvas.views[0];
    expect(view.type).toBe('anchor');
    expect(view.displayName).toBe('My Notes');
    expect(view.metadata?.autoCollapse).toBe(true);
  });

  it('exports plugin views with required plugins', () => {
    const pluginView = makePluginView();
    const canvas = makeCanvas([pluginView]);
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    expect(manifest.canvas.views).toHaveLength(1);
    const view = manifest.canvas.views[0];
    expect(view.type).toBe('plugin');
    expect(view.metadata?.pluginWidgetType).toBe('plugin:group-project:groupproject');
    expect(view.metadata?.pluginId).toBe('group-project');

    expect(manifest.requiredPlugins).toEqual(['group-project']);
  });

  it('exports sticky note views with content and color', () => {
    const stickyView = makeStickyView();
    const canvas = makeCanvas([stickyView]);
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    const view = manifest.canvas.views[0];
    expect(view.type).toBe('sticky-note');
    expect(view.content).toBe('Hello world');
    expect(view.color).toBe('yellow');
  });

  it('exports zone views with themeId in metadata', () => {
    const zoneView = makeZoneView();
    const canvas = makeCanvas([zoneView]);
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    const view = manifest.canvas.views[0];
    expect(view.type).toBe('zone');
    expect(view.metadata?.themeId).toBe('catppuccin-mocha');
  });

  it('remaps wires from agentIds to refIds', () => {
    const agent1 = makeAgent({ id: 'durable_abc', name: 'Agent A' });
    const agent2 = makeAgent({ id: 'durable_def', name: 'Agent B' });
    const view1 = makeAgentView({ id: 'cv_1', agentId: 'durable_abc' });
    const view2 = makeAgentView({
      id: 'cv_2',
      agentId: 'durable_def',
      title: 'Agent B',
      displayName: 'Agent B',
      metadata: { agentId: 'durable_def', agentName: 'Agent B' },
    });
    const wire = makeWire({
      agentId: 'durable_abc',
      targetId: 'durable_def',
      instructions: { '*': 'Be helpful' },
      disabledTools: ['read_output'],
    });
    const canvas = makeCanvas([view1, view2]);
    const ctx = makeContext({
      agents: { [agent1.id]: agent1, [agent2.id]: agent2 },
      wireDefinitions: [wire],
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.canvas.wires).toHaveLength(1);
    const bw = manifest.canvas.wires[0];
    // Source and target should be refIds, not agentIds
    expect(bw.sourceRef).not.toBe('durable_abc');
    expect(bw.targetRef).not.toBe('durable_def');
    expect(bw.sourceRef).toBeTruthy();
    expect(bw.targetRef).toBeTruthy();
    expect(bw.instructions).toEqual({ '*': 'Be helpful' });
    expect(bw.disabledTools).toEqual(['read_output']);
  });

  it('skips wires where endpoints are not on this canvas', () => {
    const view1 = makeAgentView({ id: 'cv_1', agentId: 'durable_abc' });
    const wire = makeWire({
      agentId: 'durable_abc',
      targetId: 'durable_xyz', // Not on canvas
    });
    const canvas = makeCanvas([view1]);
    const ctx = makeContext({
      agents: { durable_abc: makeAgent() },
      wireDefinitions: [wire],
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);
    expect(manifest.canvas.wires).toHaveLength(0);
  });

  it('exports project references with relative path', () => {
    const project = makeProject();
    const agentView = makeAgentView({ projectId: 'proj_1' });
    const canvas = makeCanvas([agentView]);
    const ctx = makeContext({
      agents: { durable_abc: makeAgent() },
      projects: { [project.id]: project },
      projectId: 'proj_1',
      exportProjectPath: '/Users/test/source/test-project',
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.projects).toHaveLength(1);
    expect(manifest.projects![0].name).toBe('test-project');
    expect(manifest.projects![0].relativePath).toBe('.');
    expect(manifest.projects![0].matchBy?.name).toBe('test-project');
  });

  it('computes relative path for sibling projects', () => {
    const project = makeProject({ path: '/Users/test/source/other-project' });
    const agentView = makeAgentView({ projectId: 'proj_1' });
    const canvas = makeCanvas([agentView]);
    const ctx = makeContext({
      agents: { durable_abc: makeAgent() },
      projects: { [project.id]: project },
      projectId: 'proj_1',
      exportProjectPath: '/Users/test/source/test-project',
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.projects).toHaveLength(1);
    expect(manifest.projects![0].relativePath).toBe('../other-project');
  });

  it('includes layout settings', () => {
    const canvas = makeCanvas([], {
      elkAlgorithm: 'radial',
      elkDirection: 'DOWN',
      layoutCenterId: 'cv_agent1',
      views: [makeAgentView()],
    });
    const manifest = exportCanvasToBlueprint(canvas, makeContext());

    expect(manifest.canvas.layout?.algorithm).toBe('radial');
    expect(manifest.canvas.layout?.direction).toBe('DOWN');
    // layoutCenterId should be mapped to refId
    expect(manifest.canvas.layout?.centerViewRef).toBeTruthy();
  });

  it('includes appVersion when provided', () => {
    const canvas = makeCanvas();
    const ctx = makeContext({ appVersion: '0.39.0-beta.18' });
    const manifest = exportCanvasToBlueprint(canvas, ctx);
    expect(manifest.exportedFrom).toBe('0.39.0-beta.18');
  });

  it('deduplicates agent defs for the same agent on multiple views', () => {
    const view1 = makeAgentView({ id: 'cv_1', agentId: 'durable_abc' });
    const view2 = makeAgentView({ id: 'cv_2', agentId: 'durable_abc', title: 'Same Agent (2)', displayName: 'Same Agent (2)' });
    const canvas = makeCanvas([view1, view2]);
    const ctx = makeContext({
      agents: { durable_abc: makeAgent() },
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);
    // Should only have one agent def even though two views reference same agent
    expect(manifest.agents).toHaveLength(1);
  });

  it('handles canvas with all view types', () => {
    const views = [
      makeAgentView(),
      makeAnchorView(),
      makePluginView(),
      makeStickyView(),
      makeZoneView(),
    ];
    const canvas = makeCanvas(views);
    const ctx = makeContext({
      agents: { durable_abc: makeAgent() },
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.canvas.views).toHaveLength(5);
    const types = manifest.canvas.views.map((v) => v.type);
    expect(types).toEqual(['agent', 'anchor', 'plugin', 'sticky-note', 'zone']);
  });
});

describe('serializeManifest', () => {
  it('produces valid JSON with all top-level fields', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const ctx = makeContext({ agents: { durable_abc: makeAgent() } });
    const manifest = exportCanvasToBlueprint(canvas, ctx);
    const json = serializeManifest(manifest);

    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('Test Canvas');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('preserves nested data at all levels', () => {
    const agent1 = makeAgent({ id: 'durable_abc', name: 'Agent A' });
    const agent2 = makeAgent({ id: 'durable_def', name: 'Agent B' });
    const view1 = makeAgentView({ id: 'cv_1', agentId: 'durable_abc' });
    const view2 = makeAgentView({
      id: 'cv_2', agentId: 'durable_def', title: 'Agent B', displayName: 'Agent B',
      metadata: { agentId: 'durable_def', agentName: 'Agent B' },
    });
    const wire = makeWire({ agentId: 'durable_abc', targetId: 'durable_def' });
    const canvas = makeCanvas([view1, view2]);
    const ctx = makeContext({
      agents: { durable_abc: agent1, durable_def: agent2 },
      wireDefinitions: [wire],
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);
    const json = serializeManifest(manifest);
    const parsed = JSON.parse(json);

    // Verify nested data is present (not dropped by serializer)
    expect(parsed.canvas).toBeDefined();
    expect(parsed.canvas.views).toHaveLength(2);
    expect(parsed.canvas.views[0].refId).toBeTruthy();
    expect(parsed.canvas.views[0].position).toEqual({ x: 100, y: 200 });
    expect(parsed.canvas.wires).toHaveLength(1);
    expect(parsed.canvas.wires[0].sourceRef).toBeTruthy();
    expect(parsed.canvas.wires[0].targetRef).toBeTruthy();
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0].name).toBe('Agent A');
    expect(parsed.agents[0].matchBy).toBeDefined();
    expect(parsed.agents[0].matchBy.name).toBe('Agent A');
  });
});

describe('slugify', () => {
  it('converts a name to a URL-friendly slug', () => {
    expect(slugify('My Canvas Board')).toBe('my-canvas-board');
    expect(slugify('test_123')).toBe('test-123');
    expect(slugify('---Leading---')).toBe('leading');
    expect(slugify('')).toBe('blueprint');
    expect(slugify('Hello World!')).toBe('hello-world');
  });
});

// ── LB-CB-004: refId guard — all exported views must have valid refIds ─

describe('LB-CB-004: exportCanvasToBlueprint guards against undefined refIds', () => {
  it('all exported views have non-null, non-undefined refIds', () => {
    const views = [
      makeAgentView(),
      makeAnchorView(),
      makePluginView(),
      makeStickyView(),
      makeZoneView(),
    ];
    const canvas = makeCanvas(views);
    const ctx = makeContext({ agents: { durable_abc: makeAgent() } });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.canvas.views).toHaveLength(5);
    for (const view of manifest.canvas.views) {
      expect(view.refId).toBeTruthy();
      expect(typeof view.refId).toBe('string');
    }
  });

  it('output view count matches input view count', () => {
    const agentView = makeAgentView();
    const canvas = makeCanvas([agentView]);
    const ctx = makeContext({ agents: { durable_abc: makeAgent() } });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    // Pre-fix: map() always returned one entry per view, even with undefined refId.
    // Post-fix: flatMap() with guard skips views with missing refIds but preserves
    // valid views. For a normal canvas this must still produce one view per input.
    expect(manifest.canvas.views).toHaveLength(1);
    expect(manifest.canvas.views[0].refId).toBeDefined();
  });

  it('wire sourceRef and targetRef are both non-null strings', () => {
    const agent1 = makeAgent({ id: 'durable_abc', name: 'A' });
    const agent2 = makeAgent({ id: 'durable_def', name: 'B' });
    const view1 = makeAgentView({ id: 'cv_1', agentId: 'durable_abc' });
    const view2 = makeAgentView({ id: 'cv_2', agentId: 'durable_def', title: 'B', displayName: 'B', metadata: { agentId: 'durable_def' } });
    const wire = makeWire({ agentId: 'durable_abc', targetId: 'durable_def' });
    const canvas = makeCanvas([view1, view2]);
    const ctx = makeContext({
      agents: { durable_abc: agent1, durable_def: agent2 },
      wireDefinitions: [wire],
    });

    const manifest = exportCanvasToBlueprint(canvas, ctx);

    expect(manifest.canvas.wires).toHaveLength(1);
    expect(manifest.canvas.wires[0].sourceRef).toBeTruthy();
    expect(manifest.canvas.wires[0].targetRef).toBeTruthy();
    expect(typeof manifest.canvas.wires[0].sourceRef).toBe('string');
    expect(typeof manifest.canvas.wires[0].targetRef).toBe('string');
  });
});

// ── LB-CB-2026-05-05: stable refIds when agents are removed ────────────

describe('LB-CB-2026-05-05: refId stability when canvas composition changes', () => {
  it('agent B retains the same refId whether or not agent A is on the canvas', () => {
    const agentA = makeAgent({ id: 'durable_aaa', name: 'Agent A' });
    const agentB = makeAgent({ id: 'durable_bbb', name: 'Agent B' });
    const viewA = makeAgentView({ id: 'cv_aaa', agentId: 'durable_aaa', title: 'A', displayName: 'A', metadata: { agentId: 'durable_aaa', agentName: 'A' } });
    const viewB = makeAgentView({ id: 'cv_bbb', agentId: 'durable_bbb', title: 'B', displayName: 'B', metadata: { agentId: 'durable_bbb', agentName: 'B' } });

    // Export with both agents present
    const manifestFull = exportCanvasToBlueprint(
      makeCanvas([viewA, viewB]),
      makeContext({ agents: { durable_aaa: agentA, durable_bbb: agentB } }),
    );
    const refIdBFull = manifestFull.canvas.views.find((v) => v.displayName === 'B')!.refId;

    // Export again with only agent B (agent A was removed)
    const manifestBOnly = exportCanvasToBlueprint(
      makeCanvas([viewB]),
      makeContext({ agents: { durable_bbb: agentB } }),
    );
    const refIdBOnly = manifestBOnly.canvas.views[0].refId;

    // Pre-fix: refIdBFull = 'v_2', refIdBOnly = 'v_1' (counter resets) — not equal.
    // Post-fix: both derive from view.id 'cv_bbb' — equal.
    expect(refIdBFull).toBe(refIdBOnly);
  });

  it('wire refs are identical regardless of whether a third agent is on the canvas', () => {
    const agentA = makeAgent({ id: 'durable_aaa', name: 'Agent A' });
    const agentB = makeAgent({ id: 'durable_bbb', name: 'Agent B' });
    const agentC = makeAgent({ id: 'durable_ccc', name: 'Agent C' });
    const viewA = makeAgentView({ id: 'cv_aaa', agentId: 'durable_aaa', title: 'A', displayName: 'A', metadata: { agentId: 'durable_aaa', agentName: 'A' } });
    const viewB = makeAgentView({ id: 'cv_bbb', agentId: 'durable_bbb', title: 'B', displayName: 'B', metadata: { agentId: 'durable_bbb', agentName: 'B' } });
    const viewC = makeAgentView({ id: 'cv_ccc', agentId: 'durable_ccc', title: 'C', displayName: 'C', metadata: { agentId: 'durable_ccc', agentName: 'C' } });
    const wire = makeWire({ agentId: 'durable_bbb', targetId: 'durable_ccc' });

    // Full canvas: A, B, C with wire B→C
    const manifestFull = exportCanvasToBlueprint(
      makeCanvas([viewA, viewB, viewC]),
      makeContext({
        agents: { durable_aaa: agentA, durable_bbb: agentB, durable_ccc: agentC },
        wireDefinitions: [wire],
      }),
    );

    // Reduced canvas: B, C with wire B→C (agent A removed)
    const manifestReduced = exportCanvasToBlueprint(
      makeCanvas([viewB, viewC]),
      makeContext({
        agents: { durable_bbb: agentB, durable_ccc: agentC },
        wireDefinitions: [wire],
      }),
    );

    expect(manifestFull.canvas.wires).toHaveLength(1);
    expect(manifestReduced.canvas.wires).toHaveLength(1);

    // Wire refs must be identical — removing agent A must not shift B or C's refId
    expect(manifestFull.canvas.wires[0].sourceRef).toBe(manifestReduced.canvas.wires[0].sourceRef);
    expect(manifestFull.canvas.wires[0].targetRef).toBe(manifestReduced.canvas.wires[0].targetRef);
  });
});
