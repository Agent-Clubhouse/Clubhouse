/**
 * Startup binding rebuild from persisted canvas stores (#1544), against
 * fixture stores on disk: one app-wide (Home) store and two project stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const { home, projects, groupProjects } = vi.hoisted(() => ({
  home: { dir: '' },
  projects: { list: [] as Array<{ id: string; name: string; path: string; displayName?: string }>, readable: true },
  groupProjects: { list: [] as Array<{ id: string; name: string }>, fail: false },
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => home.dir },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), lstat: vi.fn(actual.lstat) };
});
vi.mock('./project-store', () => ({
  list: vi.fn(async () => projects.list),
  peekProjectsChecked: vi.fn(async () => ({ projects: projects.list, readable: projects.readable })),
}));
vi.mock('./group-project-registry', () => ({
  groupProjectRegistry: {
    peek: vi.fn(async () => {
      if (groupProjects.fail) throw new Error('registry unreadable');
      return groupProjects.list;
    }),
    list: vi.fn(async () => {
      if (groupProjects.fail) throw new Error('registry unreadable');
      return groupProjects.list;
    }),
  },
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  applyPersistedBinding,
  clearBindingRemovedByUser,
  consumeRestoredBinding,
  markBindingRemovedByUser,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  _resetPersistedBindingSourcesForTesting,
} from './persisted-bindings';
import { canvasWireBindingSource, bindingsFromCanvasStores } from './canvas-wire-source';
import {
  getAgentCanvasMemberships,
  getTargetCanvasIndex,
  readCanvasForNavigation,
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
  projects.readable = true;
  groupProjects.fail = false;
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
  const location = () => ({
    scope: 'project' as const, projectId: 'proj_w', projectName: 'wardfall',
    projectPath: wardfall, kvDir: projectCanvasKvDir(wardfall),
  });

  it('preserves strict legacy GP guidance inspection without writes, while navigation requires a genuine widget discriminator', async () => {
    fs.mkdirSync(projects.list[2].path, { recursive: true });
    writeKv(projectCanvasKvDir(other), 'canvas-instances', []);
    writeKv(projectCanvasKvDir(other), 'canvas-wires', []);
    const legacy = { id: 'legacy-gp', type: 'plugin', metadata: { groupProjectId: 'gp_wardfall' } };
    writeKv(location().kvDir, 'canvas-instances', [
      canvas('legacy-board', 'Legacy', [agentCard('agent', 'durable_w1'), legacy]),
    ]);
    writeKv(location().kvDir, 'canvas-wires', [
      wire('durable_w1', 'gp_wardfall', 'group-project', { instructions: { send_message: 'Saved guidance' }, disabledTools: ['broadcast'] }),
    ]);
    const before = snapshotTree(root);
    const inspect = canvasWireBindingSource.inspect;
    if (!inspect) throw new Error('Canvas saved-source inspection must be available.');
    const saved = await inspect();
    expect(saved).toContainEqual(expect.objectContaining({
      agentId: 'durable_w1', targetId: 'gp_wardfall', sourceStoreId: 'project:proj_w',
      instructions: { send_message: 'Saved guidance' }, disabledTools: ['broadcast'],
    }));
    const index = await getTargetCanvasIndex('group-project', 'gp_wardfall');
    expect(index.stores.flatMap((store) => store.hits)).toEqual([]);
    expect(index.stores.find((store) => store.projectId === 'proj_w')?.error).toBeUndefined();
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each([
    { key: 'canvas-instances', value: [canvas('valid', 'Valid', []), { future: true }] },
    { key: 'canvas-instances', value: [canvas('same', 'First', []), canvas('same', 'Second', [])] },
    { key: 'canvas-instances', value: [canvas('valid', 'Valid', [{ future: true }])] },
    { key: 'canvas-instances', value: [canvas('valid', 'Valid', [{ id: 'future', type: 'future' }])] },
    { key: 'canvas-instances', value: [canvas('valid', 'Valid', [agentCard('same', 'a'), agentCard('same', 'b')])] },
    { key: 'canvas-instances', value: [canvas('valid', 'Valid', [{ id: 'bad', type: 'agent', agentId: 7 }])] },
    { key: 'canvas-instances', value: [canvas('valid', 'Valid', [{ ...gpCard('gp', 'gp_wardfall'), metadata: { groupProjectId: 7 } }])] },
    { key: 'canvas-wires', value: [wire('a', 'gp_wardfall', 'group-project'), { future: true }] },
    { key: 'canvas-wires', value: [wire('a', 'gp_wardfall', 'future')] },
    { key: 'canvas-wires', value: [{ ...wire('a', 'gp_wardfall', 'agent'), targetKind: ['agent'] }] },
    { key: 'canvas-wires', value: [wire('a', 'gp_wardfall', 'group-project'), wire('a', 'gp_wardfall', 'agent')] },
  ])('strictly reports incomplete $key rows without changing any files', async ({ key, value }) => {
    writeKv(location().kvDir, 'canvas-wires', []);
    writeKv(location().kvDir, key, value);
    const before = snapshotTree(root);

    const strict = await readCanvasStore(location(), { strict: true });

    expect(strict.problems.length).toBeGreaterThan(0);
    expect(key === 'canvas-instances' ? strict.canvases : strict.wires).toBeNull();
    expect((await readCanvasStore(location())).problems).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each(['canvas-instances', 'canvas-wires'])('strictly refuses corrupt primary %s despite a healthy backup', async (key) => {
    const dir = location().kvDir;
    writeKv(dir, 'canvas-wires', []);
    const saved = key === 'canvas-instances' ? [canvas('good', 'Good', [])] : [];
    writeKv(dir, key, saved);
    fs.writeFileSync(path.join(dir, `${key}.json`), '{torn');
    const before = snapshotTree(root);

    expect((await readCanvasStore(location(), { strict: true })).problems.length).toBeGreaterThan(0);
    expect((await readCanvasStore(location())).problems).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each([
    { key: 'canvas-instances', recovery: 'sibling' },
    { key: 'canvas-wires', recovery: 'sibling' },
    { key: 'canvas-instances', recovery: 'named' },
    { key: 'canvas-wires', recovery: 'unreadable' },
  ])('does not trust backup-only $key ($recovery) as a complete strict inventory', async ({ key, recovery }) => {
    const dir = location().kvDir;
    writeKv(dir, 'canvas-instances', [canvas('valid', 'Valid', [])]);
    writeKv(dir, 'canvas-wires', []);
    fs.unlinkSync(path.join(dir, `${key}.json`));
    if (recovery === 'named') {
      fs.unlinkSync(path.join(dir, `${key}.json.bak`));
      writeKv(dir, 'canvas-instances-backup', [canvas('recovered', 'Recovered', [])]);
    }
    if (recovery === 'unreadable') fs.writeFileSync(path.join(dir, `${key}.json.bak`), '{torn');
    const before = snapshotTree(root);

    expect((await readCanvasStore(location(), { strict: true })).problems.length).toBeGreaterThan(0);
    if (recovery !== 'unreadable') expect((await readCanvasStore(location())).problems).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('strictly recognizes valid, missing and known retired rows without writes', async () => {
    const dir = location().kvDir;
    writeKv(dir, 'canvas-instances', [canvas('valid', 'Valid', [
      agentCard('a', 'a'), gpCard('gp', 'gp_wardfall'), { id: 'retired', type: 'terminal' },
    ])]);
    writeKv(dir, 'canvas-wires', [wire('a', 'gp_wardfall', 'group-project')]);
    const before = snapshotTree(root);
    expect((await readCanvasStore(location(), { strict: true })).problems).toEqual([]);
    expect((await readCanvasStore({ scope: 'app', kvDir: path.join(root, 'absent') }, { strict: true }))).toMatchObject({
      canvases: [], wires: [], problems: [],
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('does not classify a non-directory store as known empty in strict mode', async () => {
    const kvDir = path.join(root, 'not-a-directory');
    fs.writeFileSync(kvDir, 'keep');
    const before = snapshotTree(root);
    expect((await readCanvasStore({ scope: 'app', kvDir }, { strict: true })).problems.length).toBeGreaterThan(0);
    expect((await readCanvasStore({ scope: 'app', kvDir })).problems).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each(['store', 'ancestor'])('rejects Windows-shaped missing child reads under a non-directory %s', async (position) => {
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'keep');
    const kvDir = position === 'store' ? file : path.join(file, 'kv');
    const missing = Object.assign(new Error('missing child'), { code: 'ENOENT' });
    vi.mocked(fsp.readFile).mockRejectedValue(missing);
    vi.mocked(fsp.lstat).mockImplementation((candidate, ...args) => {
      if (position === 'ancestor' && String(candidate) === kvDir) return Promise.reject(missing);
      return fs.promises.lstat(candidate, ...args);
    });
    const before = snapshotTree(root);

    const strict = await readCanvasStore({ scope: 'app', kvDir }, { strict: true });

    expect(strict.problems.length).toBeGreaterThan(0);
    expect(strict).toMatchObject({ canvases: null, wires: null });
    expect((await readCanvasStore({ scope: 'app', kvDir })).problems).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each(['EACCES', 'ENOENT'])('refuses missing strict data when surrounding directories cannot be verified (%s)', async (code) => {
    const kvDir = path.join(root, 'unverified', 'kv');
    vi.mocked(fsp.readFile).mockRejectedValue(Object.assign(new Error('missing child'), { code: 'ENOENT' }));
    vi.mocked(fsp.lstat).mockRejectedValue(Object.assign(new Error('directory unavailable'), { code }));
    const before = snapshotTree(root);

    const strict = await readCanvasStore({ scope: 'app', kvDir }, { strict: true });

    expect(strict.problems.length).toBeGreaterThan(0);
    expect(strict).toMatchObject({ canvases: null, wires: null });
    expect((await readCanvasStore({ scope: 'app', kvDir })).problems).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('accepts a genuinely absent nested store beneath a verified directory without writes', async () => {
    const kvDir = path.join(root, 'absent', 'nested', 'kv');
    const before = snapshotTree(root);
    expect(await readCanvasStore({ scope: 'app', kvDir }, { strict: true })).toMatchObject({
      canvases: [], wires: [], problems: [],
    });
    expect(snapshotTree(root)).toEqual(before);
  });

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

  describe('connection target canvas index', () => {
    it('re-reads primary data at the hydration boundary and refuses missing/stale/corrupt stores without recovery writes', async () => {
      await expect(readCanvasForNavigation('proj_w')).rejects.toThrow(/invalid or unknown rows/);
      writeKv(projectCanvasKvDir(wardfall), 'canvas-wires', [wire('durable_w1', 'gp_wardfall', 'group-project')]);
      const before = snapshotTree(root);
      const snapshot = await readCanvasForNavigation('proj_w');
      expect(snapshot.canvases).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cv_w1' })]));
      expect(snapshot.wires.length).toBeGreaterThan(0);
      expect(snapshotTree(root)).toEqual(before);
      await expect(readCanvasForNavigation('unregistered')).rejects.toThrow(/no longer registered/);
      await expect(readCanvasForNavigation('proj_o')).rejects.toThrow(/missing or unreadable/);
      const kvDir = projectCanvasKvDir(wardfall);
      fs.rmSync(path.join(kvDir, 'canvas-instances.json'));
      // The healthy .bak must not be used by navigation to resurrect a deleted board.
      await expect(readCanvasForNavigation('proj_w')).rejects.toThrow(/missing or unreadable/);
    });

    it('indexes every persisted scope by actual GP identity and reports incomplete stores without writing', async () => {
      projects.list[0].displayName = 'Renamed project';
      const before = snapshotTree(root);
      const index = await getTargetCanvasIndex('group-project', 'gp_wardfall');
      expect(index.error).toBeUndefined();
      expect(index.stores.find((store) => store.projectId === 'proj_w')).toEqual({
        scope: 'project', projectId: 'proj_w', projectName: 'Renamed project',
        hits: [{ canvasId: 'cv_w1', name: 'drifting-forge', viewId: 'g1', nodeName: 'g1' }],
      });
      expect(index.stores.find((store) => store.projectId === 'proj_o')?.error).toMatch(/unusable/);
      expect(index.stores.find((store) => store.projectId === 'proj_empty')?.error).toMatch(/unavailable/);
      expect(snapshotTree(root)).toEqual(before);
    });

    it('keeps multiple representations labeled even with colliding names, and never uses names as identity', async () => {
      writeKv(projectCanvasKvDir(other), 'canvas-instances', [
        canvas('other-board', 'drifting-forge', [gpCard('other-node', 'gp_wardfall'), gpCard('same-name', 'gp_other')]),
      ]);
      writeKv(globalCanvasKvDir(), 'canvas-instances', [
        canvas('home-board', 'drifting-forge', [gpCard('home-node', 'gp_wardfall')]),
      ]);
      const index = await getTargetCanvasIndex('group-project', 'gp_wardfall');
      expect(index.stores.flatMap((store) => store.hits.map((hit) => [store.scope, store.projectId, hit.canvasId, hit.viewId]))).toEqual([
        ['app', undefined, 'home-board', 'home-node'],
        ['project', 'proj_w', 'cv_w1', 'g1'],
        ['project', 'proj_o', 'other-board', 'other-node'],
      ]);
      expect((await getTargetCanvasIndex('group-project', 'drifting-forge')).stores.flatMap((store) => store.hits)).toEqual([]);
    });

    it('does not claim a unique or absent owner when the registered-project inventory is unreadable', async () => {
      projects.readable = false;
      expect(await getTargetCanvasIndex('group-project', 'gp_wardfall')).toEqual({
        stores: [], error: expect.stringMatching(/Registered projects.*retry Open/),
      });
    });
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

  it('keeps the first store\'s copy when a pair is in two stores', () => {
    const snap = (scope: 'app' | 'project', label: string) => ({
      location: scope === 'app'
        ? { scope: 'app' as const, kvDir: '/a' }
        : { scope: 'project' as const, projectId: 'p', projectName: 'p', projectPath: '/p', kvDir: '/p' },
      canvases: [],
      wires: [{ ...wire('a', 'b', 'agent'), label, instructions: { '*': label } }],
      problems: [],
    });
    const out = bindingsFromCanvasStores([snap('app', 'from app'), snap('project', 'from project')], new Map());
    expect(out.map((b) => b.label)).toEqual(['from app']);
    const originals = bindingsFromCanvasStores([snap('app', 'from app'), snap('project', 'from project')], new Map(), { inspect: true });
    expect(originals.map((b) => [b.sourceLabel, b.instructions])).toEqual([
      ['Home', { '*': 'from app' }], ['p', { '*': 'from project' }],
    ]);
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

  it('retains stable store provenance for same-named projects without exposing private paths', () => {
    const snapshots = ['p1', 'p2'].map((projectId) => ({
      location: { scope: 'project' as const, projectId, projectName: 'Same name', projectPath: `/private/${projectId}`, kvDir: `/private/${projectId}/kv` },
      canvases: [], wires: [wire('a', 'b', 'agent', { instructions: { '*': 'Same text' } })], problems: [],
    }));
    const originals = bindingsFromCanvasStores(snapshots, new Map(), { inspect: true });
    expect(originals.map((binding) => binding.sourceStoreId)).toEqual(['project:p1', 'project:p2']);
    expect(originals.map((binding) => binding.sourceLabel)).toEqual(['Same name', 'Same name']);
    expect(JSON.stringify(originals)).not.toContain('/private/');
    expect(bindingsFromCanvasStores(snapshots, new Map())).toHaveLength(1);
  });
});

// ── Rebuild ──────────────────────────────────────────────────────────

describe('rebuildPersistedBindings', () => {
  it('rebuilds bindings from fixture stores without writing any file', async () => {
    const before = snapshotTree(root);
    registerPersistedBindingSource(canvasWireBindingSource);
    const result = await rebuildPersistedBindings();

    expect(result.sources).toEqual([{ id: 'canvas-wires', collected: 6, created: 6, existing: 0, removed: 0, invalid: 0 }]);
    expect(bindingManager.getAllBindings().map(key).sort()).toHaveLength(6);
    const gpMembers = bindingManager.getAllBindings().filter((b) => b.targetId === 'gp_wardfall');
    expect(gpMembers).toHaveLength(3);
    const w1 = bindingManager.getBindingsForAgent('durable_w1')[0];
    expect(w1.instructions).toEqual({ send_message: 'be brief' });
    expect(w1.disabledTools).toEqual(['broadcast']);
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
      { id: 'broken', collected: 0, created: 0, existing: 0, removed: 0, invalid: 0, error: 'nope' },
      { id: 'helpers', collected: 1, created: 1, existing: 0, removed: 0, invalid: 0 },
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

  it('marks the bindings it creates as restored, once, and not ones that already existed', async () => {
    bindingManager.bind('durable_w2', { targetId: 'gp_wardfall', targetKind: 'group-project', label: 'GP' });
    registerPersistedBindingSource(canvasWireBindingSource);
    await rebuildPersistedBindings();
    expect(consumeRestoredBinding('durable_w1', 'gp_wardfall')).toBe(true);
    expect(consumeRestoredBinding('durable_w1', 'gp_wardfall')).toBe(false);
    expect(consumeRestoredBinding('durable_w2', 'gp_wardfall')).toBe(false);
  });

  it('does not bring back a wire the user removed this session until it is drawn again', async () => {
    registerPersistedBindingSource(canvasWireBindingSource);
    await rebuildPersistedBindings();
    // The user deletes the wire; the store's save has not landed yet.
    bindingManager.unbind('durable_a', 'durable_b');
    markBindingRemovedByUser('durable_a', 'durable_b');

    const rerun = await rebuildPersistedBindings(); // e.g. MCP settings saved
    expect(rerun.sources[0]).toMatchObject({ created: 0, removed: 1 });
    expect(bindingManager.getBindingsForAgent('durable_a')).toHaveLength(0);

    clearBindingRemovedByUser('durable_a', 'durable_b'); // drawn again
    bindingManager.bind('durable_a', { targetId: 'durable_b', targetKind: 'agent', label: 'B' });
    expect((await rebuildPersistedBindings()).sources[0]).toMatchObject({ existing: 6, removed: 0 });
  });
});
