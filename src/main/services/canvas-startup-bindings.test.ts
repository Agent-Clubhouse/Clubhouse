/**
 * Startup binding rebuild from persisted canvas stores (#1544), against
 * fixture stores on disk: one app-wide (Home) store and two project stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const { home, projects, groupProjects } = vi.hoisted(() => ({
  home: { dir: '' },
  projects: { list: [] as Array<{ id: string; name: string; path: string; displayName?: string }> },
  groupProjects: { list: [] as Array<{ id: string; name: string }>, fail: false },
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => home.dir },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => projects.list) }));
vi.mock('./group-project-registry', () => ({
  groupProjectRegistry: {
    list: vi.fn(async () => {
      if (groupProjects.fail) throw new Error('registry unreadable');
      return groupProjects.list;
    }),
  },
}));
const bootstrapAdmin = vi.fn(async () => {});
vi.mock('./group-project-admin-service', () => ({
  bootstrapGroupProjectAdmin: (...args: unknown[]) => bootstrapAdmin(...(args as [])),
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  applyPersistedBinding,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  _resetPersistedBindingSourcesForTesting,
} from './persisted-bindings';
import { canvasWireBindingSource, bindingsFromCanvasStores } from './canvas-wire-source';
import {
  getAgentCanvasMemberships,
  globalCanvasKvDir,
  projectCanvasKvDir,
  readCanvasStore,
  readKvKey,
} from './canvas-store-reader';

// ── Fixture helpers ──────────────────────────────────────────────────

function writeKv(kvDir: string, key: string, value: unknown, opts: { raw?: string; bak?: boolean } = {}): void {
  fs.mkdirSync(kvDir, { recursive: true });
  const json = opts.raw ?? JSON.stringify(value);
  fs.writeFileSync(path.join(kvDir, `${key}.json`), json);
  if (opts.bak !== false) fs.writeFileSync(path.join(kvDir, `${key}.json.bak`), json);
}

const agentCard = (id: string, agentId: string) => ({ id, type: 'agent', agentId, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, metadata: {} });
const gpCard = (id: string, gpId: string) => ({ id, type: 'plugin', pluginWidgetType: 'plugin:group-project:group-project', metadata: { groupProjectId: gpId } });
const browserCard = (id: string) => ({ id, type: 'plugin', pluginWidgetType: 'plugin:browser:webview', metadata: {} });
const canvas = (id: string, name: string, views: unknown[]) => ({ id, name, views, viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: views.length });
const wire = (agentId: string, targetId: string, targetKind: string, extra: Record<string, unknown> = {}) => ({
  agentId, targetId, targetKind, label: `${agentId}->${targetId}`, ...extra,
});

/** sha256 of every file under dir, to prove nothing was written. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

let root: string;
let wardfall: string;
let other: string;

/**
 * Home store: two agents wired to each other plus one wire to an agent whose
 * card was removed (stale). Wardfall: three agents wired to a group project
 * card, one with instructions and disabled tools, one wire to a deleted group
 * project, one wire to a browser widget. Other project: canvas data is torn.
 */
function writeFixtures(): void {
  writeKv(globalCanvasKvDir(), 'canvas-instances', [
    canvas('cv_home', 'home-board', [agentCard('v1', 'durable_a'), agentCard('v2', 'durable_b')]),
  ]);
  writeKv(globalCanvasKvDir(), 'canvas-wires', [
    wire('durable_a', 'durable_b', 'agent'),
    wire('durable_b', 'durable_a', 'agent'),
    wire('durable_a', 'durable_gone', 'agent'),
  ]);

  const wk = projectCanvasKvDir(wardfall);
  writeKv(wk, 'canvas-instances', [
    canvas('cv_w1', 'drifting-forge', [
      agentCard('w1', 'durable_w1'), agentCard('w2', 'durable_w2'), gpCard('g1', 'gp_wardfall'),
      gpCard('g2', 'gp_deleted'), browserCard('br1'), { id: 'z1', type: 'zone', metadata: {} },
    ]),
    canvas('cv_w2', 'second-board', [agentCard('w3', 'durable_w3'), agentCard('w1b', 'durable_w1')]),
  ]);
  writeKv(wk, 'canvas-wires', [
    wire('durable_w1', 'gp_wardfall', 'group-project', { projectName: 'Old name', instructions: { send_message: 'be brief' }, disabledTools: ['broadcast'] }),
    wire('durable_w2', 'gp_wardfall', 'group-project'),
    wire('durable_w3', 'gp_wardfall', 'group-project'),
    wire('durable_w1', 'gp_deleted', 'group-project'),
    wire('durable_w2', 'br1', 'browser'),
    { agentId: 'durable_w2', targetId: 'durable_w1' }, // malformed: no label/kind
  ]);

  const ok = projectCanvasKvDir(other);
  writeKv(ok, 'canvas-instances', null, { raw: '[{"id":"cv_torn",' });
  writeKv(ok, 'canvas-instances-backup', null, { raw: '{"also":' });
  writeKv(ok, 'canvas-wires', [wire('durable_o1', 'durable_o2', 'agent')]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-startup-'));
  home.dir = path.join(root, 'home');
  wardfall = path.join(root, 'wardfall');
  other = path.join(root, 'other');
  projects.list = [
    { id: 'proj_w', name: 'wardfall', path: wardfall },
    { id: 'proj_o', name: 'other', path: other },
    { id: 'proj_empty', name: 'empty', path: path.join(root, 'empty') },
  ];
  groupProjects.list = [{ id: 'gp_wardfall', name: 'Wardfall' }];
  groupProjects.fail = false;
  bootstrapAdmin.mockClear();
  bindingManager._resetForTesting();
  _resetPersistedBindingSourcesForTesting();
  writeFixtures();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const key = (b: { agentId: string; targetId: string }) => `${b.agentId}->${b.targetId}`;

// ── Reader ───────────────────────────────────────────────────────────

describe('canvas-store-reader', () => {
  it('falls back to the .bak sibling and never quarantines a corrupt primary', async () => {
    const dir = path.join(root, 'kv');
    writeKv(dir, 'k', null, { raw: '{torn', bak: false });
    fs.writeFileSync(path.join(dir, 'k.json.bak'), JSON.stringify([1]));
    expect(await readKvKey(dir, 'k')).toEqual({ status: 'ok', value: [1] });
    expect(fs.readFileSync(path.join(dir, 'k.json'), 'utf-8')).toBe('{torn');
    expect(fs.readdirSync(dir).sort()).toEqual(['k.json', 'k.json.bak']);
  });

  it('reports a store whose instances are unusable instead of guessing', async () => {
    const snap = await readCanvasStore({ scope: 'project', projectId: 'proj_o', projectName: 'other', projectPath: other, kvDir: projectCanvasKvDir(other) });
    expect(snap.canvases).toBeNull();
    expect(snap.problems[0]).toMatch(/canvas instances unusable/);
  });

  it('uses canvas-instances-backup when the primary key is missing', async () => {
    const wk = projectCanvasKvDir(wardfall);
    fs.renameSync(path.join(wk, 'canvas-instances.json'), path.join(wk, 'canvas-instances-backup.json'));
    fs.rmSync(path.join(wk, 'canvas-instances.json.bak'));
    const snap = await readCanvasStore({ scope: 'project', projectId: 'proj_w', projectName: 'wardfall', projectPath: wardfall, kvDir: wk });
    expect(snap.canvases?.map((c) => c.id)).toEqual(['cv_w1', 'cv_w2']);
  });
});

// ── Membership index ─────────────────────────────────────────────────

describe('canvas membership index', () => {
  it('finds an agent on every canvas in its project and on Home', async () => {
    expect(await getAgentCanvasMemberships('durable_w1', 'proj_w')).toEqual([
      { scope: 'project', projectId: 'proj_w', canvasId: 'cv_w1', name: 'drifting-forge', viewId: 'w1' },
      { scope: 'project', projectId: 'proj_w', canvasId: 'cv_w2', name: 'second-board', viewId: 'w1b' },
    ]);
    expect(await getAgentCanvasMemberships('durable_a', 'proj_w')).toEqual([
      { scope: 'app', canvasId: 'cv_home', name: 'home-board', viewId: 'v1' },
    ]);
  });

  it('only searches the agent\'s own project store', async () => {
    expect(await getAgentCanvasMemberships('durable_w1', 'proj_o')).toEqual([]);
    expect(await getAgentCanvasMemberships('durable_w1', null)).toEqual([]);
  });

  it('is empty for an agent on no canvas, including an unreadable store', async () => {
    expect(await getAgentCanvasMemberships('durable_nobody', 'proj_o')).toEqual([]);
  });
});

// ── Canvas wire source ───────────────────────────────────────────────

describe('canvas wire binding source', () => {
  it('collects live wires from every store and drops stale ones', async () => {
    const bindings = await canvasWireBindingSource.collect();
    expect(bindings.map(key).sort()).toEqual([
      'durable_a->durable_b',
      'durable_b->durable_a',
      'durable_w1->gp_wardfall',
      'durable_w2->br1',
      'durable_w2->gp_wardfall',
      'durable_w3->gp_wardfall',
    ]);
    const w1 = bindings.find((b) => key(b) === 'durable_w1->gp_wardfall')!;
    expect(w1.projectName).toBe('Wardfall'); // refreshed from the registry
    expect(w1.instructions).toEqual({ send_message: 'be brief' });
    expect(w1.disabledTools).toEqual(['broadcast']);
  });

  it('keeps group-project wires when the registry cannot be read', async () => {
    groupProjects.fail = true;
    const bindings = await canvasWireBindingSource.collect();
    expect(bindings.map(key)).toContain('durable_w1->gp_deleted');
  });

  it('binds every wire of a store with no canvases yet (renderer rule)', () => {
    const out = bindingsFromCanvasStores([{
      location: { scope: 'app', kvDir: '/x' },
      canvases: [],
      wires: [wire('a', 'b', 'agent')],
      problems: [],
    }], new Map());
    expect(out.map(key)).toEqual(['a->b']);
  });
});

// ── Rebuild ──────────────────────────────────────────────────────────

describe('rebuildPersistedBindings', () => {
  it('rebuilds bindings from fixture stores without writing any file', async () => {
    const before = snapshotTree(root);
    registerPersistedBindingSource(canvasWireBindingSource);
    const result = await rebuildPersistedBindings();

    expect(result.sources).toEqual([{ id: 'canvas-wires', collected: 6, created: 6, existing: 0, invalid: 0 }]);
    expect(bindingManager.getAllBindings().map(key).sort()).toHaveLength(6);
    const gpMembers = bindingManager.getAllBindings().filter((b) => b.targetId === 'gp_wardfall');
    expect(gpMembers).toHaveLength(3);
    const w1 = bindingManager.getBindingsForAgent('durable_w1')[0];
    expect(w1.instructions).toEqual({ send_message: 'be brief' });
    expect(w1.disabledTools).toEqual(['broadcast']);
    expect(bootstrapAdmin).toHaveBeenCalledTimes(3);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('is idempotent: a second rebuild and a later renderer hydrate create nothing twice', async () => {
    registerPersistedBindingSource(canvasWireBindingSource);
    await rebuildPersistedBindings();
    const changes = vi.fn();
    bindingManager.onChange(changes);

    const second = await rebuildPersistedBindings();
    expect(second.sources[0]).toMatchObject({ created: 0, existing: 6 });

    // What the canvas does on first open: bind each restored wire over IPC.
    const hydrated = (await canvasWireBindingSource.collect()).map((b) => bindingManager.bind(b.agentId, b));
    expect(hydrated.every((created) => created === false)).toBe(true);
    expect(bindingManager.getAllBindings()).toHaveLength(6);
    expect(changes).not.toHaveBeenCalled();
  });

  it('leaves a binding the renderer created first (and its edits) alone', async () => {
    bindingManager.bind('durable_w1', { targetId: 'gp_wardfall', targetKind: 'group-project', label: 'GP' });
    bindingManager.setInstructions('durable_w1', 'gp_wardfall', { send_message: 'edited since' });
    registerPersistedBindingSource(canvasWireBindingSource);
    const result = await rebuildPersistedBindings();
    expect(result.sources[0]).toMatchObject({ created: 5, existing: 1 });
    expect(bindingManager.getBindingsForAgent('durable_w1')[0].instructions).toEqual({ send_message: 'edited since' });
  });

  it('runs every registered source and survives one failing', async () => {
    registerPersistedBindingSource({ id: 'broken', collect: async () => { throw new Error('nope'); } });
    registerPersistedBindingSource({
      id: 'helpers',
      collect: async () => [{ agentId: 'h1', targetId: 'h2', targetKind: 'agent', label: 'helper' }],
    });
    const result = await rebuildPersistedBindings();
    expect(result.sources).toEqual([
      { id: 'broken', collected: 0, created: 0, existing: 0, invalid: 0, error: 'nope' },
      { id: 'helpers', collected: 1, created: 1, existing: 0, invalid: 0 },
    ]);
    expect(bindingManager.getBindingsForAgent('h1')).toHaveLength(1);
  });

  it('replaces a source registered twice under one id, and unregisters', async () => {
    const first = vi.fn(async () => []);
    const second = vi.fn(async () => []);
    registerPersistedBindingSource({ id: 's', collect: first });
    const unregister = registerPersistedBindingSource({ id: 's', collect: second });
    await rebuildPersistedBindings();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unregister();
    await rebuildPersistedBindings();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed bindings', () => {
    expect(applyPersistedBinding({ agentId: 'a', targetId: 'b', targetKind: 'nonsense' as never, label: 'x' })).toBe('invalid');
    expect(applyPersistedBinding({ agentId: '', targetId: 'b', targetKind: 'agent', label: 'x' })).toBe('invalid');
    expect(bindingManager.getAllBindings()).toHaveLength(0);
  });
});
