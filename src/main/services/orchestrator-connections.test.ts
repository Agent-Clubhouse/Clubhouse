/**
 * Orchestrator connections scoped across projects (#2513): an entry whose end
 * is a helper in another project stays in scope, binds with that project's
 * name, and is only pruned once that project says the helper is gone.
 * The tools, store format and watcher are covered end to end in
 * clubhouse-mcp/tools/connection-tools.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DurableAgentConfig } from '../../shared/types';

const { configs, projects } = vi.hoisted(() => ({
  configs: new Map<string, DurableAgentConfig[]>(),
  projects: { list: [] as Array<{ id: string; name: string; path: string; displayName?: string }> },
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: vi.fn(async () => projects.list) }));
vi.mock('./group-project-registry', () => ({ groupProjectRegistry: { list: vi.fn(async () => []), onChange: vi.fn(() => () => undefined) } }));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (p: string) => {
    const agents = configs.get(p);
    if (!agents) throw new Error('EACCES');
    return agents;
  }),
  projectKey: vi.fn(async (p: string) => path.resolve(p)),
  onAgentConfigChanged: vi.fn(() => () => undefined),
}));
vi.mock('./helper-index', () => ({
  listHelpersEverywhere: vi.fn(async (home: string, id: string) => {
    const out: Array<{ projectPath: string; config: DurableAgentConfig }> = [];
    for (const [p, agents] of configs) {
      for (const a of agents) {
        if (a.parentAgentId === id && (a.parentProjectPath ?? p) === home && !a.disposedAt) out.push({ projectPath: p, config: a });
      }
    }
    return out;
  }),
}));

import {
  addConnections,
  bindingsFromConnections,
  connectionStatus,
  loadConnectionScope,
  pruneOutOfScopeConnections,
  readConnections,
  _resetOrchestratorConnectionsForTesting,
  type OrchestratorConnection,
} from './orchestrator-connections';

let root: string;
let home: string;
let far: string;

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id,
  name: id.replace('durable_', ''),
  color: 'emerald',
  createdAt: '2026-10-31T00:00:00.000Z',
  ...extra,
} as DurableAgentConfig);

const entry = (agentId: string, targetId: string, extra: Partial<OrchestratorConnection> = {}): OrchestratorConnection => ({
  ownerId: 'durable_lead', agentId, targetId, targetKind: 'agent', createdAt: '2026-10-31T00:00:00.000Z', ...extra,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-orch-scope-'));
  home = path.join(root, 'home');
  far = path.join(root, 'far');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(far, { recursive: true });
  configs.clear();
  _resetOrchestratorConnectionsForTesting();
  projects.list = [
    { id: 'proj_h', name: 'home', displayName: 'Home', path: home },
    { id: 'proj_f', name: 'far', displayName: 'Far', path: far },
  ];
  configs.set(home, [agent('durable_lead'), agent('durable_h1', { parentAgentId: 'durable_lead' })]);
  configs.set(far, [
    agent('durable_far', { parentAgentId: 'durable_lead', parentProjectPath: home }),
    agent('durable_stranger'),
  ]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('connectionStatus across projects', () => {
  it('counts a live helper in another project as in scope, with its project\'s name on the binding', async () => {
    const connections = [entry('durable_h1', 'durable_far', { targetProjectPath: far }), entry('durable_far', 'durable_lead', { agentProjectPath: far })];
    const scope = await loadConnectionScope(home, configs.get(home)!, connections, 'Home');
    expect(connections.map((c) => connectionStatus(c, scope))).toEqual(['in', 'in']);
    const { bindings, unknown } = bindingsFromConnections(connections, scope, null);
    expect(unknown).toEqual([]);
    expect(bindings).toEqual([
      { agentId: 'durable_h1', targetId: 'durable_far', targetKind: 'agent', label: 'far', agentName: 'h1', targetName: 'far', projectName: 'Far' },
      { agentId: 'durable_far', targetId: 'durable_lead', targetKind: 'agent', label: 'lead', agentName: 'far', targetName: 'lead', projectName: 'Home' },
    ]);
  });

  it('puts out of scope an agent in another project that is not the owner\'s helper, or a recorded end that is gone', async () => {
    const connections = [
      entry('durable_lead', 'durable_stranger', { targetProjectPath: far }),
      entry('durable_lead', 'durable_deleted', { targetProjectPath: far }),
      // An end with no recorded project must be one of this project's agents.
      entry('durable_lead', 'durable_far'),
    ];
    const scope = await loadConnectionScope(home, configs.get(home)!, connections);
    expect(connections.map((c) => connectionStatus(c, scope))).toEqual(['out', 'out', 'out']);
  });

  it('is unknown while the recorded project can\'t be read, and the pair is kept unverified', async () => {
    configs.delete(far);
    const connections = [entry('durable_lead', 'durable_far', { targetProjectPath: far })];
    const scope = await loadConnectionScope(home, configs.get(home)!, connections);
    expect(connectionStatus(connections[0], scope)).toBe('unknown');
    expect(bindingsFromConnections(connections, scope, null)).toEqual({
      bindings: [],
      unknown: [{ agentId: 'durable_lead', targetId: 'durable_far' }],
    });
  });

  it('reads no other project for entries that are all in the store\'s project', async () => {
    const { listHelpersEverywhere } = await import('./helper-index');
    vi.mocked(listHelpersEverywhere).mockClear();
    const scope = await loadConnectionScope(home, configs.get(home)!, [entry('durable_lead', 'durable_h1')]);
    expect(connectionStatus(entry('durable_lead', 'durable_h1'), scope)).toBe('in');
    expect(listHelpersEverywhere).not.toHaveBeenCalled();
  });
});

describe('pruneOutOfScopeConnections across projects', () => {
  it('keeps a connection to a live helper in another project and drops it once the helper is disposed', async () => {
    await addConnections(home, [entry('durable_lead', 'durable_far', { targetProjectPath: far }), entry('durable_lead', 'durable_h1')]);
    expect(await pruneOutOfScopeConnections(home)).toEqual([]);

    configs.set(far, configs.get(far)!.map((a) => (a.id === 'durable_far' ? { ...a, disposedAt: '2026-10-31T01:00:00.000Z' } : a)));
    const removed = await pruneOutOfScopeConnections(home);
    expect(removed.map((c) => c.targetId)).toEqual(['durable_far']);
    expect((await readConnections(home)).map((c) => c.targetId)).toEqual(['durable_h1']);
  });

  it('keeps the connection while the helper\'s project can\'t be read, and still prunes this project\'s own', async () => {
    await addConnections(home, [entry('durable_lead', 'durable_far', { targetProjectPath: far }), entry('durable_lead', 'durable_h1')]);
    configs.delete(far);
    configs.set(home, [agent('durable_lead')]); // h1 deleted
    const removed = await pruneOutOfScopeConnections(home);
    expect(removed.map((c) => c.targetId)).toEqual(['durable_h1']);
    expect((await readConnections(home)).map((c) => c.targetId)).toEqual(['durable_far']);
  });
});
