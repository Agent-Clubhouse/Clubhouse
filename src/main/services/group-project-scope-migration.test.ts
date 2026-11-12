import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { DurableAgentConfig, Project } from '../../shared/types';
import type { AgentRegistration } from './agent-registry';

const fixture = vi.hoisted(() => ({
  home: '',
  projects: [] as Project[],
  configs: new Map<string, DurableAgentConfig[]>(),
  registrations: new Map<string, AgentRegistration>(),
  generation: 0,
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => fixture.home } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => fixture.projects) }));
vi.mock('./plugin-storage', () => ({ getGlobalPluginDataDir: () => path.join(fixture.home, 'plugins') }));
vi.mock('./agent-config', () => ({
  peekDurableConfigsChecked: vi.fn(async (projectPath: string) => ({
    agents: fixture.configs.get(projectPath) ?? [], readable: fixture.configs.has(projectPath),
  })),
  agentConfigGeneration: () => fixture.generation,
  projectKey: vi.fn(async (projectPath: string) => path.resolve(projectPath)),
  onAgentConfigChanged: vi.fn(() => () => {}),
}));
vi.mock('./agent-registry', () => ({
  agentRegistry: { getAllRegistrations: () => new Map(fixture.registrations) },
}));

import { groupProjectRegistry } from './group-project-registry';
import { globalCanvasKvDir, projectCanvasKvDir } from './canvas-store-reader';
import { connectionsStorePath, _resetOrchestratorConnectionsForTesting } from './orchestrator-connections';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { appLog } from './log-service';
import { peekDurableConfigsChecked } from './agent-config';

const registryFile = () => path.join(fixture.home, '.clubhouse-dev', 'group-projects', 'registry.json');
const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id, name: id, color: 'emerald', createdAt: '2026-11-12T00:00:00Z', ...extra,
});
const wire = (agentId: string) => ({ agentId, targetId: 'gp_legacy', targetKind: 'group-project' as const, label: 'Legacy' });

async function write(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value));
}

async function canvas(agentIds: string[], kvDir = globalCanvasKvDir()): Promise<void> {
  await write(path.join(kvDir, 'canvas-wires.json'), agentIds.map(wire));
}

async function connection(project: Project, agentId: string, extra: Record<string, string> = {}): Promise<void> {
  await write(connectionsStorePath(project.path), {
    version: 1,
    connections: [{ ownerId: agentId, ...wire(agentId), createdAt: '2026-11-12T00:00:00Z', ...extra }],
  });
}

beforeEach(async () => {
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  fixture.home = await fsp.mkdtemp(path.join(cache, 'gp-scope-migration-'));
  fixture.projects = [
    { id: 'p_a', name: 'A', path: path.join(fixture.home, 'a') },
    { id: 'p_b', name: 'B', path: path.join(fixture.home, 'b') },
  ];
  fixture.configs.clear();
  fixture.configs.set(fixture.projects[0].path, [agent('a')]);
  fixture.configs.set(fixture.projects[1].path, [agent('b')]);
  fixture.registrations.clear();
  fixture.generation = 0;
  groupProjectRegistry._resetForTesting();
  bindingManager._resetForTesting();
  _resetOrchestratorConnectionsForTesting();
  await write(registryFile(), [{
    id: 'gp_legacy', name: 'Legacy', description: 'Existing purpose', instructions: 'Keep history',
    createdAt: '2020-01-01T00:00:00Z',
    metadata: { admins: ['a'], subscriptions: { a: ['work'] }, pollingEnabled: true },
  }]);
});

afterEach(async () => {
  groupProjectRegistry._resetForTesting();
  bindingManager._resetForTesting();
  _resetOrchestratorConnectionsForTesting();
  vi.restoreAllMocks();
  await fsp.rm(fixture.home, { recursive: true, force: true });
});

describe('one-shot legacy group project scope migration', () => {
  it('uses the member inventory rather than the app canvas location and changes no membership or subscriptions', async () => {
    await canvas(['a']);
    const canvasFile = path.join(globalCanvasKvDir(), 'canvas-wires.json');
    const before = await fsp.readFile(canvasFile, 'utf-8');

    const project = await groupProjectRegistry.get('gp_legacy');

    expect(project?.scope).toEqual({ level: 'project', projectId: 'p_a', reach: 'local' });
    expect(project?.metadata).toEqual({ admins: ['a'], subscriptions: { a: ['work'] }, pollingEnabled: true });
    expect(await fsp.readFile(canvasFile, 'utf-8')).toBe(before);
    expect(bindingManager.getAllBindings()).toEqual([]);
    expect(JSON.parse(await fsp.readFile(registryFile(), 'utf-8'))[0].scope).toEqual(project?.scope);
  });

  it('finds saved connections before any live bindings or canvas has opened', async () => {
    await connection(fixture.projects[1], 'b');
    const file = connectionsStorePath(fixture.projects[1].path);
    const before = await fsp.readFile(file, 'utf-8');

    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_b', reach: 'local',
    });
    expect(await fsp.readFile(file, 'utf-8')).toBe(before);
    expect(bindingManager.getAllBindings()).toEqual([]);
  });

  it('unions saved sources for mixed scope and never infers it again after restart', async () => {
    await canvas(['a']);
    await connection(fixture.projects[1], 'b');
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({ level: 'app', reach: 'local' });
    await canvas([]);
    await fsp.rm(connectionsStorePath(fixture.projects[1].path));
    groupProjectRegistry._resetForTesting();
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({ level: 'app', reach: 'local' });
  });

  it('uses app scope for a verified empty membership', async () => {
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({ level: 'app', reach: 'local' });
  });

  it('includes live quick members and resolves their real registered project', async () => {
    fixture.registrations.set('quick', { projectPath: fixture.projects[1].path, orchestrator: 'claude-code', runtime: 'pty' });
    bindingManager.bind('quick', wire('quick'));
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_b', reach: 'local',
    });
  });

  it('resolves a saved foreign helper by its own project, not the owner store', async () => {
    fixture.configs.set(fixture.projects[1].path, [agent('helper', {
      parentAgentId: 'a', parentProjectPath: fixture.projects[0].path,
    })]);
    await connection(fixture.projects[0], 'helper', { ownerId: 'a', agentProjectPath: fixture.projects[1].path });
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_b', reach: 'local',
    });
  });

  it('ignores a saved connection that is no longer within its owner reach', async () => {
    await canvas(['a'], projectCanvasKvDir(fixture.projects[0].path));
    await connection(fixture.projects[0], 'b', { ownerId: 'a', agentProjectPath: fixture.projects[1].path });
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_a', reach: 'local',
    });
  });

  it.each([
    'unreadable project', 'unknown member', 'corrupt canvas', 'unsupported connections', 'changing inventory',
    'unknown canvas wire', 'unknown canvas instance', 'unknown canvas view', 'changing projects',
  ])(
    'defers %s without guessing or writing, and logs a retryable failure',
    async (kind) => {
      await canvas([kind === 'unknown member' ? 'unknown' : 'a']);
      if (kind === 'unreadable project') fixture.configs.delete(fixture.projects[1].path);
      if (kind === 'corrupt canvas') {
        const file = path.join(projectCanvasKvDir(fixture.projects[1].path), 'canvas-wires.json');
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, '{corrupt');
      }
      if (kind === 'unsupported connections') await write(connectionsStorePath(fixture.projects[1].path), { version: 2, connections: [] });
      if (kind === 'unknown canvas wire') {
        await write(path.join(globalCanvasKvDir(), 'canvas-wires.json'), [wire('a'), { future: true }]);
      }
      if (kind === 'unknown canvas instance') {
        await write(path.join(globalCanvasKvDir(), 'canvas-instances.json'), [{ future: true }]);
      }
      if (kind === 'unknown canvas view') {
        await write(path.join(globalCanvasKvDir(), 'canvas-instances.json'), [{ id: 'canvas', views: [{ future: true }] }]);
      }
      if (kind === 'changing inventory') {
        vi.mocked(peekDurableConfigsChecked).mockImplementationOnce(async (projectPath) => {
          fixture.generation++;
          return { agents: fixture.configs.get(projectPath) ?? [], readable: true };
        });
      }
      if (kind === 'changing projects') {
        vi.mocked(peekDurableConfigsChecked).mockImplementationOnce(async (projectPath) => {
          fixture.projects.pop();
          return { agents: fixture.configs.get(projectPath) ?? [], readable: true };
        });
      }
      const before = await fsp.readFile(registryFile(), 'utf-8');

      expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toBeUndefined();
      expect(await fsp.readFile(registryFile(), 'utf-8')).toBe(before);
      expect(appLog).toHaveBeenCalledWith(
        'core:group-project', 'warn', expect.stringContaining('migration deferred'),
        expect.objectContaining({ meta: expect.objectContaining({ retryable: true }) }),
      );
    },
  );

  it('retries deferred inventory on restart after it is repaired', async () => {
    await canvas(['a']);
    fixture.configs.delete(fixture.projects[1].path);
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toBeUndefined();
    fixture.configs.set(fixture.projects[1].path, []);
    groupProjectRegistry._resetForTesting();
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_a', reach: 'local',
    });
  });

  it('persists migration before publishing the registry to concurrent first readers', async () => {
    await canvas(['a']);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === registryFile()) { enter(); await held; }
      await rename(from, to);
    });
    const loading = groupProjectRegistry.list();
    try {
      expect(await Promise.race([entered.then(() => 'writing'), loading.then(() => 'loaded')])).toBe('writing');
      expect(groupProjectRegistry.getSync('gp_legacy')).toBeNull();
    } finally {
      release();
      await loading;
    }
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_a', reach: 'local',
    });
  });

  it('leaves the old registry readable after a failed migration write and retries without losing data', async () => {
    await canvas(['a']);
    const before = await fsp.readFile(registryFile(), 'utf-8');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('migration disk unavailable'));

    await expect(groupProjectRegistry.list()).rejects.toThrow('migration disk unavailable');
    expect(await fsp.readFile(registryFile(), 'utf-8')).toBe(before);
    expect(groupProjectRegistry.getSync('gp_legacy')).toBeNull();
    expect((await groupProjectRegistry.get('gp_legacy'))?.scope).toEqual({
      level: 'project', projectId: 'p_a', reach: 'local',
    });
  });
});
