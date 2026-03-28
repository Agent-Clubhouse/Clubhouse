import { describe, it, expect } from 'vitest';
import {
  exportBlueprint,
  importBlueprint,
  validateBlueprint,
  BLUEPRINT_VERSION,
} from './canvas-blueprint';
import type { CanvasBlueprint, BlueprintView } from './canvas-blueprint';
import type {
  CanvasInstance,
  AgentCanvasView,
  AnchorCanvasView,
  PluginCanvasView,
  ZoneCanvasView,
} from './canvas-types';

// ── Test helpers ──────────────────────────────────────────────────────

function makeAgentView(overrides: Partial<AgentCanvasView> = {}): AgentCanvasView {
  return {
    id: 'cv_existing1',
    type: 'agent',
    position: { x: 100, y: 200 },
    size: { width: 480, height: 480 },
    title: 'My Agent',
    displayName: 'My Agent',
    zIndex: 0,
    metadata: {
      agentId: 'durable_abc123',
      agentName: 'My Agent',
      projectName: 'Test Project',
      orchestrator: 'claude-code',
      model: 'opus',
      projectId: 'proj_123',
    },
    agentId: 'durable_abc123',
    projectId: 'proj_123',
    ...overrides,
  };
}

function makeAnchorView(overrides: Partial<AnchorCanvasView> = {}): AnchorCanvasView {
  return {
    id: 'cv_existing2',
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
    id: 'cv_existing3',
    type: 'plugin',
    position: { x: 600, y: 200 },
    size: { width: 560, height: 480 },
    title: 'Group Project',
    displayName: 'Group Project',
    zIndex: 2,
    metadata: { groupProjectId: 'gp_456', name: 'Sprint Board' },
    pluginWidgetType: 'plugin:group-project:group-project',
    pluginId: 'group-project',
    ...overrides,
  };
}

function makeZoneView(overrides: Partial<ZoneCanvasView> = {}): ZoneCanvasView {
  return {
    id: 'cv_existing4',
    type: 'zone',
    position: { x: 0, y: 0 },
    size: { width: 600, height: 400 },
    title: 'Dev Zone',
    displayName: 'Dev Zone',
    zIndex: 3,
    metadata: {},
    themeId: 'catppuccin-mocha',
    containedViewIds: ['cv_existing1'],
    ...overrides,
  };
}

function makeCanvas(views: AgentCanvasView[] | AnchorCanvasView[] | PluginCanvasView[] | ZoneCanvasView[] | any[] = []): CanvasInstance {
  return {
    id: 'canvas_test1234',
    name: 'Test Board',
    views,
    viewport: { panX: 50, panY: -30, zoom: 0.8 },
    nextZIndex: views.length,
    zoomedViewId: 'cv_existing1',
    selectedViewId: 'cv_existing2',
    minimapAutoHide: false,
  };
}

// ── Export tests ──────────────────────────────────────────────────────

describe('exportBlueprint', () => {
  it('exports a canvas with the correct version and name', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.version).toBe(BLUEPRINT_VERSION);
    expect(blueprint.name).toBe('Test Board');
  });

  it('preserves viewport', () => {
    const canvas = makeCanvas([]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.viewport).toEqual({ panX: 50, panY: -30, zoom: 0.8 });
  });

  it('strips view IDs from exported views', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const blueprint = exportBlueprint(canvas);

    expect((blueprint.views[0] as any).id).toBeUndefined();
  });

  it('strips zIndex from exported views', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const blueprint = exportBlueprint(canvas);

    expect((blueprint.views[0] as any).zIndex).toBeUndefined();
  });

  it('strips ephemeral metadata (agentId, agentName, model, orchestrator, projectName)', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const blueprint = exportBlueprint(canvas);

    const meta = blueprint.views[0].metadata;
    expect(meta.agentId).toBeUndefined();
    expect(meta.agentName).toBeUndefined();
    expect(meta.projectName).toBeUndefined();
    expect(meta.orchestrator).toBeUndefined();
    expect(meta.model).toBeUndefined();
  });

  it('preserves non-ephemeral metadata (groupProjectId, etc.)', () => {
    const canvas = makeCanvas([makePluginView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views[0].metadata.groupProjectId).toBe('gp_456');
    expect(blueprint.views[0].metadata.name).toBe('Sprint Board');
  });

  it('preserves projectId on agent views but strips agentId', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views[0].projectId).toBe('proj_123');
    // agentId is ephemeral — must not appear
    expect(blueprint.views[0].metadata.agentId).toBeUndefined();
  });

  it('exports anchor views with label and autoCollapse', () => {
    const canvas = makeCanvas([makeAnchorView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views[0].type).toBe('anchor');
    expect(blueprint.views[0].label).toBe('My Notes');
    expect(blueprint.views[0].autoCollapse).toBe(true);
  });

  it('exports plugin views with pluginWidgetType and pluginId', () => {
    const canvas = makeCanvas([makePluginView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views[0].pluginWidgetType).toBe('plugin:group-project:group-project');
    expect(blueprint.views[0].pluginId).toBe('group-project');
  });

  it('exports zone views with themeId', () => {
    const canvas = makeCanvas([makeZoneView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views[0].themeId).toBe('catppuccin-mocha');
    // containedViewIds is ephemeral — must not appear
    expect((blueprint.views[0] as any).containedViewIds).toBeUndefined();
  });

  it('preserves position and size', () => {
    const canvas = makeCanvas([makeAgentView()]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views[0].position).toEqual({ x: 100, y: 200 });
    expect(blueprint.views[0].size).toEqual({ width: 480, height: 480 });
  });

  it('exports all view types in a mixed canvas', () => {
    const canvas = makeCanvas([
      makeAgentView(),
      makeAnchorView(),
      makePluginView(),
      makeZoneView(),
    ]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views).toHaveLength(4);
    expect(blueprint.views.map((v) => v.type)).toEqual(['agent', 'anchor', 'plugin', 'zone']);
  });

  it('exports an empty canvas', () => {
    const canvas = makeCanvas([]);
    const blueprint = exportBlueprint(canvas);

    expect(blueprint.views).toHaveLength(0);
    expect(blueprint.name).toBe('Test Board');
  });
});

// ── Import tests ──────────────────────────────────────────────────────

describe('importBlueprint', () => {
  it('generates fresh canvas ID', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView()]));
    const canvas = importBlueprint(blueprint);

    expect(canvas.id).toMatch(/^canvas_[0-9a-f]{8}$/);
    expect(canvas.id).not.toBe('canvas_test1234');
  });

  it('generates fresh view IDs', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView(), makeAnchorView()]));
    const canvas = importBlueprint(blueprint);

    expect(canvas.views).toHaveLength(2);
    for (const view of canvas.views) {
      expect(view.id).toMatch(/^cv_[0-9a-f]{8}$/);
      expect(view.id).not.toBe('cv_existing1');
      expect(view.id).not.toBe('cv_existing2');
    }
  });

  it('generates unique view IDs', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView(), makeAnchorView(), makePluginView()]));
    const canvas = importBlueprint(blueprint);

    const ids = new Set(canvas.views.map((v) => v.id));
    expect(ids.size).toBe(3);
  });

  it('assigns sequential zIndex ordering', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView(), makeAnchorView(), makePluginView()]));
    const canvas = importBlueprint(blueprint);

    expect(canvas.views.map((v) => v.zIndex)).toEqual([0, 1, 2]);
    expect(canvas.nextZIndex).toBe(3);
  });

  it('preserves the blueprint name by default', () => {
    const blueprint = exportBlueprint(makeCanvas([]));
    const canvas = importBlueprint(blueprint);

    expect(canvas.name).toBe('Test Board');
  });

  it('allows overriding the canvas name', () => {
    const blueprint = exportBlueprint(makeCanvas([]));
    const canvas = importBlueprint(blueprint, { name: 'Custom Board' });

    expect(canvas.name).toBe('Custom Board');
  });

  it('preserves viewport from blueprint', () => {
    const blueprint = exportBlueprint(makeCanvas([]));
    const canvas = importBlueprint(blueprint);

    expect(canvas.viewport).toEqual({ panX: 50, panY: -30, zoom: 0.8 });
  });

  it('resets viewport when option is set', () => {
    const blueprint = exportBlueprint(makeCanvas([]));
    const canvas = importBlueprint(blueprint, { resetViewport: true });

    expect(canvas.viewport).toEqual({ panX: 0, panY: 0, zoom: 1 });
  });

  it('resets ephemeral state (selection, zoom)', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView()]));
    const canvas = importBlueprint(blueprint);

    expect(canvas.zoomedViewId).toBeNull();
    expect(canvas.selectedViewId).toBeNull();
  });

  it('imports agent views with null agentId', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView()]));
    const canvas = importBlueprint(blueprint);

    const agent = canvas.views[0] as AgentCanvasView;
    expect(agent.type).toBe('agent');
    expect(agent.agentId).toBeNull();
    expect(agent.projectId).toBe('proj_123');
  });

  it('imports anchor views with label and autoCollapse', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAnchorView()]));
    const canvas = importBlueprint(blueprint);

    const anchor = canvas.views[0] as AnchorCanvasView;
    expect(anchor.type).toBe('anchor');
    expect(anchor.label).toBe('My Notes');
    expect(anchor.autoCollapse).toBe(true);
  });

  it('imports plugin views with pluginWidgetType and pluginId', () => {
    const blueprint = exportBlueprint(makeCanvas([makePluginView()]));
    const canvas = importBlueprint(blueprint);

    const plugin = canvas.views[0] as PluginCanvasView;
    expect(plugin.type).toBe('plugin');
    expect(plugin.pluginWidgetType).toBe('plugin:group-project:group-project');
    expect(plugin.pluginId).toBe('group-project');
    expect(plugin.metadata.groupProjectId).toBe('gp_456');
  });

  it('imports zone views with themeId and empty containedViewIds', () => {
    const blueprint = exportBlueprint(makeCanvas([makeZoneView()]));
    const canvas = importBlueprint(blueprint);

    const zone = canvas.views[0] as ZoneCanvasView;
    expect(zone.type).toBe('zone');
    expect(zone.themeId).toBe('catppuccin-mocha');
    expect(zone.containedViewIds).toEqual([]);
  });

  it('deduplicates display names on import', () => {
    const blueprint: CanvasBlueprint = {
      version: 1,
      name: 'Dupe Test',
      views: [
        { type: 'agent', title: 'Agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, metadata: {} },
        { type: 'agent', title: 'Agent', position: { x: 500, y: 0 }, size: { width: 480, height: 480 }, metadata: {} },
        { type: 'agent', title: 'Agent', position: { x: 1000, y: 0 }, size: { width: 480, height: 480 }, metadata: {} },
      ],
    };
    const canvas = importBlueprint(blueprint);

    const names = canvas.views.map((v) => v.displayName);
    expect(names).toEqual(['Agent', 'Agent (2)', 'Agent (3)']);
  });

  it('snaps positions to grid', () => {
    const blueprint: CanvasBlueprint = {
      version: 1,
      name: 'Snap Test',
      views: [
        { type: 'agent', title: 'Agent', position: { x: 103, y: 207 }, size: { width: 480, height: 480 }, metadata: {} },
      ],
    };
    const canvas = importBlueprint(blueprint);

    // snapToGrid rounds to nearest 20
    expect(canvas.views[0].position.x).toBe(100);
    expect(canvas.views[0].position.y).toBe(200);
  });

  it('throws on missing pluginWidgetType for plugin views', () => {
    const blueprint: CanvasBlueprint = {
      version: 1,
      name: 'Bad Plugin',
      views: [
        { type: 'plugin', title: 'Broken', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, metadata: {} },
      ],
    };

    expect(() => importBlueprint(blueprint)).toThrow('missing pluginWidgetType or pluginId');
  });

  it('throws on unsupported version', () => {
    const blueprint = { version: 999, name: 'Future', views: [] } as CanvasBlueprint;
    expect(() => importBlueprint(blueprint)).toThrow('Unsupported blueprint version');
  });

  it('throws on invalid blueprint (not an object)', () => {
    expect(() => importBlueprint(null as any)).toThrow('Invalid blueprint');
  });

  it('throws on missing views array', () => {
    expect(() => importBlueprint({ version: 1, name: 'X' } as any)).toThrow('views must be an array');
  });

  it('defaults zone themeId to catppuccin-mocha when not specified', () => {
    const blueprint: CanvasBlueprint = {
      version: 1,
      name: 'Zone Default',
      views: [
        { type: 'zone', title: 'Zone', position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, metadata: {} },
      ],
    };
    const canvas = importBlueprint(blueprint);
    expect((canvas.views[0] as ZoneCanvasView).themeId).toBe('catppuccin-mocha');
  });
});

// ── Roundtrip tests ──────────────────────────────────────────────────

describe('export → import roundtrip', () => {
  it('roundtrips a mixed canvas preserving layout and config', () => {
    const original = makeCanvas([
      makeAgentView(),
      makeAnchorView(),
      makePluginView(),
      makeZoneView(),
    ]);

    const blueprint = exportBlueprint(original);
    const imported = importBlueprint(blueprint);

    // Same number of views
    expect(imported.views).toHaveLength(4);

    // Types preserved
    expect(imported.views.map((v) => v.type)).toEqual(['agent', 'anchor', 'plugin', 'zone']);

    // Positions preserved
    expect(imported.views[0].position).toEqual(original.views[0].position);
    expect(imported.views[1].position).toEqual(original.views[1].position);
    expect(imported.views[2].position).toEqual(original.views[2].position);

    // Sizes preserved
    expect(imported.views[0].size).toEqual(original.views[0].size);
    expect(imported.views[1].size).toEqual(original.views[1].size);
    expect(imported.views[2].size).toEqual(original.views[2].size);

    // Plugin metadata preserved
    expect(imported.views[2].metadata.groupProjectId).toBe('gp_456');

    // Agent agentId is null (not carried over)
    expect((imported.views[0] as AgentCanvasView).agentId).toBeNull();

    // Canvas name preserved
    expect(imported.name).toBe(original.name);
  });

  it('roundtrip produces valid JSON', () => {
    const original = makeCanvas([makeAgentView(), makePluginView()]);
    const blueprint = exportBlueprint(original);

    // Serialize to JSON and back
    const json = JSON.stringify(blueprint);
    const parsed = JSON.parse(json) as CanvasBlueprint;

    expect(validateBlueprint(parsed)).toBeNull();

    const imported = importBlueprint(parsed);
    expect(imported.views).toHaveLength(2);
  });
});

// ── Validation tests ──────────────────────────────────────────────────

describe('validateBlueprint', () => {
  it('returns null for a valid blueprint', () => {
    const blueprint = exportBlueprint(makeCanvas([makeAgentView()]));
    expect(validateBlueprint(blueprint)).toBeNull();
  });

  it('rejects null', () => {
    expect(validateBlueprint(null)).toContain('expected an object');
  });

  it('rejects non-objects', () => {
    expect(validateBlueprint('string')).toContain('expected an object');
    expect(validateBlueprint(42)).toContain('expected an object');
  });

  it('rejects missing version', () => {
    expect(validateBlueprint({ views: [] })).toContain('Unsupported blueprint version');
  });

  it('rejects future version', () => {
    expect(validateBlueprint({ version: 999, views: [] })).toContain('Unsupported blueprint version');
  });

  it('rejects missing views', () => {
    expect(validateBlueprint({ version: 1 })).toContain('views must be an array');
  });

  it('rejects unknown view types', () => {
    expect(validateBlueprint({
      version: 1,
      views: [{ type: 'unknown' }],
    })).toContain('unknown type');
  });

  it('rejects plugin views without pluginWidgetType', () => {
    expect(validateBlueprint({
      version: 1,
      views: [{ type: 'plugin', pluginId: 'foo' }],
    })).toContain('missing pluginWidgetType or pluginId');
  });

  it('rejects plugin views without pluginId', () => {
    expect(validateBlueprint({
      version: 1,
      views: [{ type: 'plugin', pluginWidgetType: 'plugin:foo:bar' }],
    })).toContain('missing pluginWidgetType or pluginId');
  });

  it('accepts empty views array', () => {
    expect(validateBlueprint({ version: 1, name: 'Empty', views: [] })).toBeNull();
  });

  it('accepts all valid view types', () => {
    expect(validateBlueprint({
      version: 1,
      views: [
        { type: 'agent' },
        { type: 'anchor' },
        { type: 'plugin', pluginWidgetType: 'plugin:x:y', pluginId: 'x' },
        { type: 'zone' },
      ],
    })).toBeNull();
  });
});
