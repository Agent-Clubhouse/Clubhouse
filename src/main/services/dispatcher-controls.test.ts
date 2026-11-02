/**
 * The Dispatcher's controls over connected orchestrators (#2661), end to end
 * through the tool registry, the real binding manager and persisted bindings,
 * and a real store and audit file in a temp folder. Only the agents, projects and
 * policies are faked. A restart is simulated by forgetting everything in memory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';

const state = vi.hoisted(() => ({
  base: '',
  projects: [] as Array<{ id: string; name: string; path: string }>,
  agents: new Map<string, unknown[]>(),
  /** Stored policy fields by agent id, resolved over connected-orchestrator defaults. */
  policies: new Map<string, Record<string, unknown>>(),
  dispatcherOn: true,
  globalCap: 20,
  helpers: new Map<string, unknown[]>(),
  unreadable: new Set<string>(),
  /** Runs just before a policy write's precondition: a user change arriving in the gap. */
  beforeWrite: null as null | (() => void),
  /** Which file writes fail, by the temp file's path. */
  failWrite: null as null | ((file: string) => boolean),
  /** Which file reads fail. */
  failRead: null as null | ((file: string) => boolean),
  /** Runs once after the next successful rename into place. */
  afterRename: null as null | (() => void),
  kept: 0,
  dispatcherListeners: new Set<() => void>(),
  agentListeners: new Set<(p: string) => void>(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const failed = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (state.failWrite?.(String(args[0]))) throw failed('ENOSPC');
      return actual.writeFile(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (state.failRead?.(String(args[0]))) throw failed('EACCES');
      return actual.readFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const after = state.afterRename;
      state.afterRename = null;
      after?.();
    },
  };
});
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => state.base }));
vi.mock('./project-store', () => ({
  list: vi.fn(async () => [...state.projects]),
  onProjectsChanged: vi.fn(() => () => undefined),
}));
vi.mock('./fs-utils', () => ({ pathExists: vi.fn(async () => true) }));
vi.mock('./agent-config', () => ({
  listDurable: vi.fn(async (p: string) => {
    if (state.unreadable.has(p)) throw new Error('EACCES');
    return state.agents.get(p) ?? [];
  }),
  onAgentConfigChanged: vi.fn((listener: (p: string) => void) => {
    state.agentListeners.add(listener);
    return () => state.agentListeners.delete(listener);
  }),
}));
vi.mock('./mcp-settings', () => ({ onMcpEnablementChanged: vi.fn(() => () => undefined) }));
vi.mock('./persona-change-hook', () => ({ onPersonaChanged: vi.fn(() => () => undefined) }));
vi.mock('./helper-index', () => ({
  listHelpersEverywhere: vi.fn(async (_p: string, id: string) => state.helpers.get(id) ?? []),
}));
vi.mock('./orchestration-settings', () => ({ getGlobalHelperCap: () => state.globalCap }));
vi.mock('./orchestration-policy', () => {
  const resolve = (id: string) => {
    const stored = state.policies.get(id) ?? {};
    const mcpOff = stored.mcpOff === true;
    const policy = {
      orchestrate: !mcpOff && (stored.orchestrate ?? true),
      connectToDispatcher: !mcpOff && (stored.connectToDispatcher ?? true),
      crossProjectHelpers: stored.crossProjectHelpers ?? false,
      maxHelpers: stored.maxHelpers ?? 5,
      sources: { crossProjectHelpers: stored.crossProjectHelpers === undefined ? 'default' : 'agent', maxHelpers: stored.maxHelpers === undefined ? 'default' : 'agent' },
      ...(mcpOff && { mcpOff: { orchestrate: true, crossProjectHelpers: false, connectToDispatcher: true } }),
    };
    return policy;
  };
  return {
    resolveOrchestrationPolicies: vi.fn(async (_p: string, agents: Array<{ id: string }>) => new Map(agents.map((a) => [a.id, resolve(a.id)]))),
    getHelperSummary: vi.fn(async (_p: string, id: string) => ({ hasHelpers: false, helperIds: (state.helpers.get(id) ?? []).map((_, i) => `h${i}`), projects: [] })),
    setOrchestrationPolicy: vi.fn(async (p: string, id: string, patch: Record<string, unknown>, options: { precondition?: (a: unknown, c: unknown) => void }) => {
      state.beforeWrite?.();
      const agent = (state.agents.get(p) as Array<{ id: string }>).find((a) => a.id === id);
      options.precondition?.(agent, resolve(id));
      state.policies.set(id, { ...state.policies.get(id), ...patch });
      return { ok: true, message: 'Saved', policy: resolve(id), ...(state.kept > 0 && { crossProjectHelpersKept: state.kept }) };
    }),
  };
});
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherEnabled: () => state.dispatcherOn,
  isDispatcherAgentId: (id: string) => id === 'dispatcher',
  isDispatcherPath: () => false,
  onDispatcherChanged: vi.fn((listener: () => void) => {
    state.dispatcherListeners.add(listener);
    return () => state.dispatcherListeners.delete(listener);
  }),
}));
vi.mock('./clubhouse-mcp/dispatcher-gate', async (importOriginal) => ({
  ...await importOriginal<typeof import('./clubhouse-mcp/dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => id === 'dispatcher' && state.dispatcherOn,
}));

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { callTool, getScopedToolList, _resetForTesting } from './clubhouse-mcp/tool-registry';
import { registerDispatcherControlTools } from './clubhouse-mcp/tools/dispatcher-control-tools';
import { agentRegistry } from './agent-registry';
import { auditPath, appendAudit, readAudit, MAX_AUDIT_BYTES, _resetDispatcherAuditForTesting, type AuditRow } from './dispatcher-audit';
import {
  dispatcherConnectionSource,
  dispatcherConnectionsPath,
  dispatcherPendingRemovalsPath,
  isRemovalUnsaved,
  listDispatcherLinksForUser,
  readDispatcherConnections,
  watchDispatcherConnections,
  MAX_DISPATCHER_LINKS_PER_AGENT,
  _resetDispatcherConnectionsForTesting,
} from './dispatcher-connections';
import { setOrchestratorHelpers } from './dispatcher-controls';
import {
  clearBindingRemovedByUser,
  markBindingRemovedByUser,
  rebuildPersistedBindings,
  registerPersistedBindingSource,
  _resetPersistedBindingSourcesForTesting,
  type PersistedBinding,
} from './persisted-bindings';

const P1 = path.join(path.sep, 'tmp', 'p1');
const P2 = path.join(path.sep, 'tmp', 'p2');

const agent = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id, name: `${id}-name`, color: 'teal', createdAt: '', ...extra,
} as DurableAgentConfig);

let stopWatching: (() => void) | null = null;
/** User wires the canvas source lists, as canvas storage would. */
let canvasWires: PersistedBinding[] = [];

function startApp(): void {
  registerPersistedBindingSource({ id: 'canvas', collect: async () => canvasWires });
  registerPersistedBindingSource(dispatcherConnectionSource);
  stopWatching = watchDispatcherConnections(() => rebuildPersistedBindings());
}

/** Everything in memory goes; the files stay. */
async function restart(): Promise<void> {
  stopWatching?.();
  for (const { agentId } of bindingManager.getAllBindings()) bindingManager.unbindAgent(agentId);
  _resetPersistedBindingSourcesForTesting();
  _resetDispatcherConnectionsForTesting();
  _resetDispatcherAuditForTesting();
  startApp();
  await rebuildPersistedBindings();
}

const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text ?? '';
const call = (name: string, args: Record<string, unknown> = {}, caller = 'dispatcher') => callTool(caller, name, args);
const isBound = (a: string, b: string) => bindingManager.getBindingsForAgent(a).some((x) => x.targetId === b);
const storedPairs = async () => (await readDispatcherConnections()).map((c) => `${c.agentId}>${c.targetId}`);

function auditRows(): AuditRow[] {
  if (!fs.existsSync(auditPath())) return [];
  return fs.readFileSync(auditPath(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const lastAudit = () => auditRows().at(-1)!;

function storeFile(): Record<string, unknown[]> {
  return JSON.parse(fs.readFileSync(dispatcherConnectionsPath(), 'utf-8'));
}

/** A user drew a wire on the canvas. */
function userDraws(a: string, b: string): void {
  clearBindingRemovedByUser(a, b);
  bindingManager.bind(a, { targetId: b, targetKind: 'agent', label: b });
  canvasWires.push({ agentId: a, targetId: b, targetKind: 'agent', label: b });
}

/** A user deleted a wire in the UI, as the UNBIND handler does. */
async function userRemoves(a: string, b: string): Promise<void> {
  bindingManager.unbind(a, b);
  canvasWires = canvasWires.filter((w) => !(w.agentId === a && w.targetId === b));
  markBindingRemovedByUser(a, b);
  await vi.waitFor(async () => expect(await storedPairs()).not.toContain(`${a}>${b}`));
}

const controls = async (args: Record<string, unknown> = {}) => JSON.parse(text(await call('list_orchestrator_controls', args)));
const linkRow = async (from: string, to: string) => (await controls()).links.find((l: { from: string; to: string }) => l.from === from && l.to === to);

function agentChanged(): void {
  for (const listener of state.agentListeners) listener(P1);
}

beforeEach(async () => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-controls-'));
  state.projects = [{ id: 'p1', name: 'one', path: P1 }, { id: 'p2', name: 'two', path: P2 }];
  state.agents = new Map<string, unknown[]>([
    [P1, [agent('a'), agent('b'), agent('plain'), agent('helper', { parentAgentId: 'a' }), agent('gone', { disposedAt: '2026-01-01' } as Partial<DurableAgentConfig>)]],
    [P2, [agent('c')]],
  ]);
  state.policies = new Map([['plain', { orchestrate: false, connectToDispatcher: false }]]);
  state.dispatcherOn = true;
  state.globalCap = 20;
  state.helpers = new Map();
  state.unreadable = new Set();
  state.beforeWrite = null;
  state.failWrite = null;
  state.failRead = null;
  state.afterRename = null;
  state.kept = 0;
  state.dispatcherListeners.clear();
  state.agentListeners.clear();
  canvasWires = [];
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  _resetForTesting();
  registerDispatcherControlTools();
  agentRegistry.register('a', { projectPath: P1, orchestrator: 'claude-code', runtime: 'chat' });
  agentRegistry.register('dispatcher', { projectPath: state.base, orchestrator: 'claude-code', runtime: 'chat' });
  await restart();
});

afterEach(() => {
  stopWatching?.();
  stopWatching = null;
  fs.rmSync(state.base, { recursive: true, force: true });
});

describe('callers', () => {
  const TOOLS = ['set_orchestrator_helpers', 'connect_orchestrators', 'disconnect_orchestrators', 'list_orchestrator_controls'];

  it('lists the tools for the Dispatcher and nobody else', () => {
    expect(getScopedToolList('dispatcher').map((t) => t.name)).toEqual(expect.arrayContaining(TOOLS));
    const others = getScopedToolList('a').map((t) => t.name);
    for (const tool of TOOLS) expect(others).not.toContain(tool);
  });

  it.each(TOOLS)('refuses %s from any other agent, changing nothing', async (tool) => {
    const result = await call(tool, { agent_id: 'b', max_helpers: 3, from: 'a', to: 'b' }, 'a');
    expect(result.isError).toBe(true);
    expect(state.policies.get('b')).toBeUndefined();
    expect(isBound('a', 'b')).toBe(false);
  });

  it('refuses a Dispatcher that was turned off, on the next call', async () => {
    state.dispatcherOn = false;
    const result = await call('connect_orchestrators', { from: 'a', to: 'b' });
    expect(result.isError).toBe(true);
    expect(isBound('a', 'b')).toBe(false);
  });

  it('refuses and audits at the service too, past the registry', async () => {
    await expect(setOrchestratorHelpers('a', { agent_id: 'b', max_helpers: 3 })).rejects.toMatchObject({ code: 'not_dispatcher' });
    expect(state.policies.get('b')).toBeUndefined();
    expect(lastAudit()).toMatchObject({ actorId: 'a', outcome: 'refused', code: 'not_dispatcher' });
  });
});

describe('set_orchestrator_helpers', () => {
  it('sets both fields, reads them back and audits before and after', async () => {
    const result = await call('set_orchestrator_helpers', { agent_id: 'a', cross_project_helpers: true, max_helpers: 7 });
    expect(JSON.parse(text(result))).toMatchObject({ id: 'a', cross_project_helpers: true, max_helpers: 7, live_helpers: 0, global_cap: 20 });
    expect(state.policies.get('a')).toEqual({ crossProjectHelpers: true, maxHelpers: 7 });
    expect(lastAudit()).toMatchObject({
      tool: 'set_orchestrator_helpers', actorId: 'dispatcher', targets: ['a'], outcome: 'ok',
      before: { crossProjectHelpers: false, maxHelpers: 5 }, after: { crossProjectHelpers: true, maxHelpers: 7 },
    });
  });

  it.each(['orchestrate', 'connectToDispatcher', 'connect_to_dispatcher', 'access', 'control'])('refuses %s by name and changes nothing', async (field) => {
    const result = await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 3, [field]: false });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(field);
    expect(state.policies.get('a')).toBeUndefined();
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'unknown_field' });
  });

  it.each([
    ['a helper', 'helper', 'helper'],
    ['a disposed agent', 'gone', 'not_connected_orchestrator'],
    ['an agent that is not an orchestrator', 'plain', 'not_connected_orchestrator'],
    ['an unknown id', 'nobody', 'not_connected_orchestrator'],
    ['itself', 'dispatcher', 'dispatcher_wire'],
  ])('refuses %s', async (_name, id, code) => {
    const result = await call('set_orchestrator_helpers', { agent_id: id, max_helpers: 3 });
    expect(result.isError).toBe(true);
    expect(state.policies.get(id)?.maxHelpers).toBeUndefined();
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code });
  });

  it('refuses an orchestrator connected in name only: MCP off, or the switch off', async () => {
    state.policies.set('a', { mcpOff: true });
    expect((await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 3 })).isError).toBe(true);
    state.policies.set('a', { connectToDispatcher: false });
    expect((await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 3 })).isError).toBe(true);
    expect(state.policies.get('a')?.maxHelpers).toBeUndefined();
  });

  it('refuses when the user disconnects the target between the check and the write', async () => {
    state.beforeWrite = () => state.policies.set('a', { connectToDispatcher: false });
    const result = await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 3 });
    expect(result.isError).toBe(true);
    expect(state.policies.get('a')?.maxHelpers).toBeUndefined();
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'not_connected_orchestrator' });
  });

  it('refuses a max_helpers of the wrong type at the registry, before any audit row', async () => {
    for (const value of ['5', null]) {
      expect((await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: value })).isError).toBe(true);
    }
    expect(state.policies.get('a')).toBeUndefined();
  });

  it.each([0, -1, 21, 1.5])('refuses max_helpers %s under an app cap of 20', async (value) => {
    const result = await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: value });
    expect(result.isError).toBe(true);
    expect(state.policies.get('a')).toBeUndefined();
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'max_helpers_out_of_range' });
  });

  it('accepts the ceiling itself', async () => {
    expect((await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 20 })).isError).toBeFalsy();
    expect(state.policies.get('a')?.maxHelpers).toBe(20);
  });

  it('needs something to set', async () => {
    expect((await call('set_orchestrator_helpers', { agent_id: 'a' })).isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'invalid_args' });
  });

  it('reports a cap below the live helpers, without stopping any', async () => {
    state.helpers.set('a', [{}, {}, {}]);
    const result = JSON.parse(text(await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 1 })));
    expect(result).toMatchObject({ max_helpers: 1, live_helpers: 3, helpersOverCap: 2 });
  });

  it('says what keeps running when cross-project helpers go off', async () => {
    state.kept = 2;
    const result = JSON.parse(text(await call('set_orchestrator_helpers', { agent_id: 'a', cross_project_helpers: false })));
    expect(result.crossProjectHelpersKept).toBe(2);
  });
});

describe('connect_orchestrators', () => {
  it('binds across projects and saves provenance', async () => {
    const result = await call('connect_orchestrators', { from: 'a', to: 'c' });
    expect(JSON.parse(text(result)).links[0]).toMatchObject({ from: 'a', to: 'c', outcome: 'created' });
    expect(isBound('a', 'c')).toBe(true);
    expect(isBound('c', 'a')).toBe(false);
    const [entry] = await readDispatcherConnections();
    expect(entry).toMatchObject({ agentId: 'a', targetId: 'c', agentProjectPath: P1, targetProjectPath: P2, createdBy: 'dispatcher' });
    expect(lastAudit()).toMatchObject({ tool: 'connect_orchestrators', outcome: 'ok', targets: ['a', 'c'], code: 'created' });
  });

  it('is a no-op for a link it already made', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    const again = await call('connect_orchestrators', { from: 'a', to: 'b' });
    expect(again.isError).toBeFalsy();
    expect(await storedPairs()).toEqual(['a>b']);
  });

  it.each([
    ['a helper', 'helper', 'helper'],
    ['a disposed agent', 'gone', 'not_connected_orchestrator'],
    ['a plain agent', 'plain', 'not_connected_orchestrator'],
    ['the Dispatcher', 'dispatcher', 'dispatcher_wire'],
  ])('refuses %s as an end, in either position', async (_name, id, code) => {
    for (const args of [{ from: 'a', to: id }, { from: id, to: 'a' }]) {
      expect((await call('connect_orchestrators', args)).isError).toBe(true);
      expect(lastAudit()).toMatchObject({ outcome: 'refused', code });
    }
    expect(fs.existsSync(dispatcherConnectionsPath())).toBe(false);
    expect(bindingManager.getBindingsForAgent('a')).toEqual([]);
  });

  it('refuses a user wire rather than claiming it', async () => {
    userDraws('a', 'b');
    const result = await call('connect_orchestrators', { from: 'a', to: 'b' });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'already_linked' });
    expect(await storedPairs()).toEqual([]);
    expect(isBound('a', 'b')).toBe(true);
  });

  it('refuses the outgoing link past the per-agent limit', async () => {
    const extra = Array.from({ length: MAX_DISPATCHER_LINKS_PER_AGENT + 1 }, (_, i) => agent(`x${i}`));
    state.agents.set(P2, [agent('c'), ...extra]);
    for (const target of extra.slice(0, MAX_DISPATCHER_LINKS_PER_AGENT)) {
      expect((await call('connect_orchestrators', { from: 'a', to: target.id })).isError).toBeFalsy();
    }
    const over = await call('connect_orchestrators', { from: 'a', to: extra[MAX_DISPATCHER_LINKS_PER_AGENT].id });
    expect(over.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'link_limit' });
    expect(await storedPairs()).toHaveLength(MAX_DISPATCHER_LINKS_PER_AGENT);
    expect(isBound('a', extra[MAX_DISPATCHER_LINKS_PER_AGENT].id)).toBe(false);
  });

  it('refuses the link past the total limit', async () => {
    const many = Array.from({ length: 12 }, (_, i) => agent(`m${i}`));
    state.agents.set(P2, [agent('c'), ...many]);
    const entries = [];
    for (let i = 0; i < 50; i++) {
      entries.push({ agentId: `s${i}`, targetId: `t${i}`, agentProjectPath: P1, targetProjectPath: P1, createdAt: '', createdBy: 'dispatcher' });
    }
    fs.writeFileSync(dispatcherConnectionsPath(), JSON.stringify({ version: 1, connections: entries, removedByUser: [] }));
    expect((await call('connect_orchestrators', { from: 'a', to: 'b' })).isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'link_limit' });
    expect(isBound('a', 'b')).toBe(false);
  });
});

describe('two_way is all or nothing', () => {
  it('makes both directions when both are clear', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b', two_way: true });
    expect(isBound('a', 'b') && isBound('b', 'a')).toBe(true);
    expect((await storedPairs()).sort()).toEqual(['a>b', 'b>a']);
  });

  it('writes neither leg when the reverse leg is a user wire', async () => {
    userDraws('b', 'a');
    const result = await call('connect_orchestrators', { from: 'a', to: 'b', two_way: true });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'already_linked' });
    expect(await storedPairs()).toEqual([]);
    expect(isBound('a', 'b')).toBe(false);
    expect(isBound('b', 'a')).toBe(true);
  });

  it('writes neither leg when the reverse leg was removed by the user', async () => {
    await call('connect_orchestrators', { from: 'b', to: 'a' });
    await userRemoves('b', 'a');
    const result = await call('connect_orchestrators', { from: 'a', to: 'b', two_way: true });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'removed_by_user' });
    expect(await storedPairs()).toEqual([]);
    expect(isBound('a', 'b')).toBe(false);
  });

  it('writes neither leg when only one leg fits the limit', async () => {
    const entries = Array.from({ length: 49 }, (_, i) => (
      { agentId: `s${i}`, targetId: `t${i}`, agentProjectPath: P1, targetProjectPath: P1, createdAt: '', createdBy: 'dispatcher' }
    ));
    fs.writeFileSync(dispatcherConnectionsPath(), JSON.stringify({ version: 1, connections: entries, removedByUser: [] }));
    expect((await call('connect_orchestrators', { from: 'a', to: 'b', two_way: true })).isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'link_limit' });
    expect(await storedPairs()).toHaveLength(49);
    expect(isBound('a', 'b') || isBound('b', 'a')).toBe(false);
  });

  it('removes neither leg when one leg of a disconnect is not its own', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    userDraws('b', 'a');
    const result = await call('disconnect_orchestrators', { from: 'a', to: 'b', two_way: true });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'not_dispatcher_owned' });
    expect(await storedPairs()).toEqual(['a>b']);
    expect(isBound('a', 'b') && isBound('b', 'a')).toBe(true);
  });
});

describe('disconnect_orchestrators', () => {
  it('severs a link it made', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    const result = await call('disconnect_orchestrators', { from: 'a', to: 'b' });
    expect(JSON.parse(text(result)).links[0].outcome).toBe('unbound');
    expect(isBound('a', 'b')).toBe(false);
    expect(await storedPairs()).toEqual([]);
    expect(lastAudit()).toMatchObject({ tool: 'disconnect_orchestrators', outcome: 'ok', code: 'unbound' });
  });

  it('refuses a user-created link and leaves it bound', async () => {
    userDraws('a', 'b');
    const result = await call('disconnect_orchestrators', { from: 'a', to: 'b' });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'not_dispatcher_owned' });
    expect(isBound('a', 'b')).toBe(true);
    await rebuildPersistedBindings();
    expect(isBound('a', 'b')).toBe(true);
  });

  it('refuses the Dispatcher\'s own wires, so a target stays connected to it', async () => {
    bindingManager.bind('dispatcher', { targetId: 'a', targetKind: 'agent', label: 'a' });
    bindingManager.bind('a', { targetId: 'dispatcher', targetKind: 'agent', label: 'Dispatcher' });
    for (const args of [{ from: 'dispatcher', to: 'a' }, { from: 'a', to: 'dispatcher' }, { from: 'a', to: 'dispatcher', two_way: true }]) {
      expect((await call('disconnect_orchestrators', args)).isError).toBe(true);
      expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'dispatcher_wire' });
    }
    expect(isBound('dispatcher', 'a') && isBound('a', 'dispatcher')).toBe(true);
  });

  it('drops its entry but keeps the wire when the user also drew the pair', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    userDraws('a', 'b');
    const result = await call('disconnect_orchestrators', { from: 'a', to: 'b' });
    expect(JSON.parse(text(result)).links[0].outcome).toBe('kept');
    expect(await storedPairs()).toEqual([]);
    expect(isBound('a', 'b')).toBe(true);
  });

  it('has no way to name a wider disconnect', async () => {
    const result = await call('disconnect_orchestrators', { from: 'a', to: 'b', all: true });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'unknown_field' });
  });
});

describe('provenance across a restart', () => {
  it('restores its link, still its own to sever', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'c', two_way: true });
    await restart();
    expect(isBound('a', 'c') && isBound('c', 'a')).toBe(true);
    await call('disconnect_orchestrators', { from: 'a', to: 'c' });
    expect(isBound('a', 'c')).toBe(false);
    expect(isBound('c', 'a')).toBe(true);
    await restart();
    expect(isBound('a', 'c')).toBe(false);
    expect(isBound('c', 'a')).toBe(true);
  });

  it('still refuses a user wire after a restart', async () => {
    userDraws('a', 'b');
    await restart();
    expect(isBound('a', 'b')).toBe(true);
    expect((await call('disconnect_orchestrators', { from: 'a', to: 'b' })).isError).toBe(true);
    expect(isBound('a', 'b')).toBe(true);
  });

  it('leaves the binding the user\'s when the user also drew a pair it made', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    userDraws('a', 'b');
    await restart();
    expect(JSON.parse(text(await call('disconnect_orchestrators', { from: 'a', to: 'b' }))).links[0].outcome).toBe('kept');
    expect(isBound('a', 'b')).toBe(true);
  });
});

describe('a link the user removes stays removed', () => {
  beforeEach(async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    await userRemoves('a', 'b');
  });

  const expectRefused = async () => {
    const result = await call('connect_orchestrators', { from: 'a', to: 'b' });
    expect(result.isError).toBe(true);
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'removed_by_user' });
    expect(isBound('a', 'b')).toBe(false);
  };

  it('drops the entry and writes a tombstone', async () => {
    expect(storeFile().connections).toEqual([]);
    expect(storeFile().removedByUser).toEqual([expect.objectContaining({ agentId: 'a', targetId: 'b' })]);
    await expectRefused();
  });

  it('holds across a restart', async () => {
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    await expectRefused();
  });

  it('holds across the Dispatcher going off and on', async () => {
    state.dispatcherOn = false;
    await rebuildPersistedBindings();
    state.dispatcherOn = true;
    await rebuildPersistedBindings();
    expect(isBound('a', 'b')).toBe(false);
    await expectRefused();
  });

  it('holds across the Dispatcher going off and on with a restart in between', async () => {
    state.dispatcherOn = false;
    await restart();
    state.dispatcherOn = true;
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    expect(storeFile().removedByUser).toHaveLength(1);
    await expectRefused();
  });

  it('only covers that direction', async () => {
    expect((await call('connect_orchestrators', { from: 'b', to: 'a' })).isError).toBeFalsy();
  });

  it('ends when the user draws the pair', async () => {
    userDraws('a', 'b');
    await vi.waitFor(() => expect(storeFile().removedByUser).toEqual([]));
    await restart();
    expect(isBound('a', 'b')).toBe(true);
    // It is the user's now: the Dispatcher still can't claim or remove it.
    expect((await call('connect_orchestrators', { from: 'a', to: 'b' })).isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'already_linked' });
  });

  it('leaves no tombstone for a wire the Dispatcher never made', async () => {
    userDraws('b', 'c');
    await userRemoves('b', 'c');
    expect(storeFile().removedByUser).toHaveLength(1);
  });
});

describe('a removal the store can\'t take', () => {
  /** Only the store file refuses, as a store from a stuck volume or a bad path would. */
  const storeRefuses = (file: string) => file.includes('dispatcher-connections.json.tmp');
  /** Nothing in the folder can be written. */
  const folderRefuses = (file: string) => file.includes('dispatcher-connections');

  beforeEach(async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
  });

  /** What the UNBIND handler does, without the canvas forgetting the wire. */
  const removeWire = async (a: string, b: string): Promise<boolean> => {
    bindingManager.unbind(a, b);
    markBindingRemovedByUser(a, b);
    return isRemovalUnsaved({ agentId: a, targetId: b });
  };
  const expectRefused = async () => {
    expect((await call('connect_orchestrators', { from: 'a', to: 'b' })).isError).toBe(true);
    expect(lastAudit()).toMatchObject({ outcome: 'refused', code: 'removed_by_user' });
    expect(isBound('a', 'b')).toBe(false);
  };
  const pendingFile = () => fs.existsSync(dispatcherPendingRemovalsPath());

  it('stays removed across restarts when only the store refuses, then lands when it takes writes', async () => {
    state.failWrite = storeRefuses;
    expect(await removeWire('a', 'b')).toBe(false);
    expect(storeFile().connections).toHaveLength(1);
    expect(pendingFile()).toBe(true);

    await restart();
    expect(isBound('a', 'b')).toBe(false);
    expect(await storedPairs()).toEqual([]);
    expect(await listDispatcherLinksForUser()).toEqual([]);
    expect((await controls()).unconfirmed_removals).toEqual([{ from: 'a', to: 'b', saved: true }]);
    await expectRefused();
    expect((await call('disconnect_orchestrators', { from: 'a', to: 'b' })).isError).toBe(true);
    expect(lastAudit()).toMatchObject({ code: 'not_dispatcher_owned' });

    state.failWrite = null;
    await restart();
    await vi.waitFor(() => expect(pendingFile()).toBe(false));
    expect(storeFile().connections).toEqual([]);
    expect(storeFile().removedByUser).toEqual([expect.objectContaining({ agentId: 'a', targetId: 'b', agentProjectPath: P1 })]);
    expect((await controls()).unconfirmed_removals).toBeUndefined();
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    await expectRefused();
  });

  it('holds in the session and says it isn\'t saved when nothing can be written, and lands on the retry', async () => {
    state.failWrite = folderRefuses;
    expect(await removeWire('a', 'b')).toBe(true);
    expect((await controls()).unconfirmed_removals).toEqual([{ from: 'a', to: 'b', saved: false }]);
    await rebuildPersistedBindings();
    expect(isBound('a', 'b')).toBe(false);
    await expectRefused();

    state.failWrite = null;
    agentChanged();
    await vi.waitFor(() => expect(storeFile().removedByUser).toHaveLength(1));
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    await expectRefused();
  });

  it('retries by itself', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    state.failWrite = folderRefuses;
    await removeWire('a', 'b');
    await vi.waitFor(() => expect(timers.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true));
    const retry = timers.mock.calls.find(([, ms]) => ms === 30_000)![0] as () => void;
    timers.mockRestore();
    state.failWrite = null;
    retry();
    await vi.waitFor(() => expect(storeFile().removedByUser).toHaveLength(1));
  });

  it('restores nothing while the folder still takes no writes after a restart, and says why', async () => {
    state.failWrite = folderRefuses;
    expect(await removeWire('a', 'b')).toBe(true);

    await restart();
    expect(isBound('a', 'b')).toBe(false);
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'suspended', reason: 'store_unwritable' });
    expect(await listDispatcherLinksForUser()).toEqual([expect.objectContaining({ status: 'suspended', reason: 'store_unwritable' })]);

    // The limit the user was told about: with no record at all, it returns once writes do.
    state.failWrite = null;
    agentChanged();
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(true));
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'active' });
  });

  it('holds when the store can\'t even be read at the time of removal', async () => {
    state.failRead = (file) => file.endsWith('dispatcher-connections.json');
    expect(await removeWire('a', 'b')).toBe(false);
    state.failRead = null;
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    await vi.waitFor(() => expect(pendingFile()).toBe(false));
    expect(storeFile().connections).toEqual([]);
    expect(storeFile().removedByUser).toEqual([expect.objectContaining({ agentId: 'a', targetId: 'b', agentProjectPath: P1 })]);
  });

  it('holds on a store from a newer Clubhouse, which stays unchanged', async () => {
    const body = JSON.stringify({ ...storeFile(), version: 99 });
    fs.writeFileSync(dispatcherConnectionsPath(), body);
    expect(await removeWire('a', 'b')).toBe(false);
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    expect(await storedPairs()).toEqual([]);
    expect(fs.readFileSync(dispatcherConnectionsPath(), 'utf-8')).toBe(body);
    expect(pendingFile()).toBe(true);
  });

  it('restores nothing past a pending file it can\'t read, and doesn\'t overwrite it', async () => {
    fs.writeFileSync(dispatcherPendingRemovalsPath(), '{ torn');
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    expect((await call('connect_orchestrators', { from: 'a', to: 'c' })).isError).toBe(true);
    expect(await removeWire('a', 'b')).toBe(true);
    expect(fs.readFileSync(dispatcherPendingRemovalsPath(), 'utf-8')).toBe('{ torn');
    expect(storeFile().connections).toHaveLength(1);
  });

  it('holds when the user removes the pair between connect\'s check and its claim, and the write fails', async () => {
    await call('disconnect_orchestrators', { from: 'a', to: 'b' });
    state.afterRename = () => {
      state.failWrite = storeRefuses;
      markBindingRemovedByUser('a', 'b');
    };
    const result = await call('connect_orchestrators', { from: 'a', to: 'b' });
    expect(result.isError).toBe(true);
    expect(isBound('a', 'b')).toBe(false);
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    await expectRefused();
  });

  it('tombstones only the removed direction when that race hits a two-way connect', async () => {
    await call('disconnect_orchestrators', { from: 'a', to: 'b' });
    state.afterRename = () => markBindingRemovedByUser('a', 'b');
    expect((await call('connect_orchestrators', { from: 'a', to: 'b', two_way: true })).isError).toBe(true);
    expect(await storedPairs()).toEqual([]);
    expect(storeFile().removedByUser).toEqual([expect.objectContaining({ agentId: 'a', targetId: 'b' })]);
    await restart();
    expect(isBound('a', 'b') || isBound('b', 'a')).toBe(false);
    await expectRefused();
  });

  describe('also_user_wire', () => {
    beforeEach(() => {
      userDraws('a', 'b');
      userDraws('b', 'a');
    });

    it.each([
      ['only the store refuses', storeRefuses],
      ['nothing can be written', folderRefuses],
    ])('%s: a user wire the canvas still lists comes back as the user\'s', async (_name, failWrite) => {
      state.failWrite = failWrite;
      await removeWire('a', 'b');
      await restart();
      expect(isBound('a', 'b')).toBe(true);
      expect(isBound('b', 'a')).toBe(true);
      await rebuildPersistedBindings();
      expect(isBound('a', 'b')).toBe(true);
    });

    it('the Dispatcher can\'t claim or drop the user\'s wire while the removal is pending', async () => {
      state.failWrite = storeRefuses;
      await removeWire('a', 'b');
      await restart();
      expect(await storedPairs()).toEqual([]);
      expect(await linkRow('a', 'b')).toBeUndefined();
      expect((await call('disconnect_orchestrators', { from: 'a', to: 'b' })).isError).toBe(true);
      expect(lastAudit()).toMatchObject({ code: 'not_dispatcher_owned' });
      expect(isBound('a', 'b')).toBe(true);
    });

    it('a user wire stays up, and stays the user\'s, while the store is suspended', async () => {
      state.failWrite = folderRefuses;
      await restart();
      expect(isBound('a', 'b')).toBe(true);
      expect(await linkRow('a', 'b')).toMatchObject({ status: 'suspended', reason: 'store_unwritable', also_user_wire: true });
      expect(await listDispatcherLinksForUser()).toEqual([]);
      state.failWrite = null;
      agentChanged();
      await vi.waitFor(async () => expect(await linkRow('a', 'b')).toMatchObject({ status: 'active' }));
      expect(isBound('a', 'b')).toBe(true);
      expect(JSON.parse(text(await call('disconnect_orchestrators', { from: 'a', to: 'b' }))).links[0].outcome).toBe('kept');
      expect(isBound('a', 'b')).toBe(true);
    });

    it('drawing the pair again ends a pending removal once it can be saved', async () => {
      state.failWrite = storeRefuses;
      await removeWire('a', 'b');
      state.failWrite = null;
      userDraws('a', 'b');
      await vi.waitFor(() => expect(storeFile().connections).toEqual([]));
      expect(storeFile().removedByUser).toEqual([]);
      expect(pendingFile()).toBe(false);
      await restart();
      expect(isBound('a', 'b')).toBe(true);
    });

    it('drawing the pair while nothing can be saved keeps the Dispatcher refused and leaves the wire', async () => {
      state.failWrite = storeRefuses;
      await removeWire('a', 'b');
      userDraws('a', 'b');
      await restart();
      expect(isBound('a', 'b')).toBe(true);
      expect(await storedPairs()).toEqual([]);
      expect((await controls()).unconfirmed_removals).toEqual([{ from: 'a', to: 'b', saved: true }]);
    });
  });
});

describe('suspended links', () => {
  beforeEach(async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
  });

  it.each([
    ['orchestration off', { orchestrate: false, connectToDispatcher: true }, 'orchestration_off'],
    ['Connect to Dispatcher off', { connectToDispatcher: false }, 'not_connected_to_dispatcher'],
    ['MCP off', { mcpOff: true }, 'mcp_off'],
  ])('%s: the binding goes, the entry stays, readback says why, and it returns', async (_name, policy, reason) => {
    state.policies.set('b', policy);
    agentChanged();
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(false));
    expect(await storedPairs()).toEqual(['a>b']);
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'suspended', reason, reason_agent: 'b' });
    expect(await listDispatcherLinksForUser()).toEqual([expect.objectContaining({ agentId: 'a', targetId: 'b', status: 'suspended', reason })]);

    state.policies.delete('b');
    agentChanged();
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(true));
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'active' });
    expect((await linkRow('a', 'b')).reason).toBeUndefined();
  });

  it('the Dispatcher off: lists nothing, names the reason, restores when on', async () => {
    state.dispatcherOn = false;
    for (const listener of state.dispatcherListeners) listener();
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(false));
    expect(await storedPairs()).toEqual(['a>b']);
    expect(await listDispatcherLinksForUser()).toEqual([expect.objectContaining({ status: 'suspended', reason: 'dispatcher_off' })]);

    state.dispatcherOn = true;
    for (const listener of state.dispatcherListeners) listener();
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(true));
  });

  it('stays suspended across a restart, and lets the Dispatcher sever it', async () => {
    state.policies.set('b', { orchestrate: false, connectToDispatcher: false });
    await restart();
    expect(isBound('a', 'b')).toBe(false);
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'suspended', reason: 'orchestration_off' });
    expect((await call('disconnect_orchestrators', { from: 'a', to: 'b' })).isError).toBeFalsy();
    expect(await storedPairs()).toEqual([]);
  });

  it('can be removed by the user, and then stays removed', async () => {
    state.policies.set('b', { orchestrate: false, connectToDispatcher: false });
    agentChanged();
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(false));
    await userRemoves('a', 'b');
    expect(await listDispatcherLinksForUser()).toEqual([]);
    state.policies.delete('b');
    await restart();
    expect(isBound('a', 'b')).toBe(false);
  });

  it.each([
    ['disposed', () => state.agents.set(P1, [agent('a'), agent('b', { disposedAt: '2026-01-01' } as Partial<DurableAgentConfig>), agent('plain')])],
    ['deleted', () => state.agents.set(P1, [agent('a'), agent('plain')])],
    ['became a helper', () => state.agents.set(P1, [agent('a'), agent('b', { parentAgentId: 'a' }), agent('plain')])],
  ])('an end %s: dropped for good', async (_name, change) => {
    change();
    agentChanged();
    await vi.waitFor(async () => expect(await storedPairs()).toEqual([]));
    await vi.waitFor(() => expect(isBound('a', 'b')).toBe(false));
  });

  it('a project unregistered: dropped for good', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'c' });
    state.projects = state.projects.filter((p) => p.path !== P2);
    agentChanged();
    await vi.waitFor(async () => expect(await storedPairs()).toEqual(['a>b']));
    await vi.waitFor(() => expect(isBound('a', 'c')).toBe(false));
  });

  it('an unreadable project: entry and binding stay, and readback says unverified', async () => {
    state.unreadable.add(P1);
    agentChanged();
    await rebuildPersistedBindings();
    expect(isBound('a', 'b')).toBe(true);
    expect(await storedPairs()).toEqual(['a>b']);
    expect((await readDispatcherConnections())[0].agentProjectPath).toBe(P1);
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'unverified' });
  });
});

describe('readback', () => {
  it('never claims an external link', async () => {
    userDraws('b', 'a');
    bindingManager.bind('dispatcher', { targetId: 'a', targetKind: 'agent', label: 'a' });
    await call('connect_orchestrators', { from: 'a', to: 'c' });
    const { links } = await controls();
    expect(links.map((l: { from: string; to: string }) => `${l.from}>${l.to}`)).toEqual(['a>c']);
    expect(await listDispatcherLinksForUser()).toEqual([expect.objectContaining({ agentId: 'a', targetId: 'c', status: 'active' })]);
  });

  it('marks a pair the user also drew, and the card treats it as an ordinary wire', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    userDraws('a', 'b');
    expect(await linkRow('a', 'b')).toMatchObject({ also_user_wire: true });
    expect(await listDispatcherLinksForUser()).toEqual([]);
  });

  it('does not say suspended about a user wire that stays up', async () => {
    await call('connect_orchestrators', { from: 'a', to: 'b' });
    userDraws('a', 'b');
    state.policies.set('b', { connectToDispatcher: false });
    await rebuildPersistedBindings();
    expect(isBound('a', 'b')).toBe(true);
    expect(await linkRow('a', 'b')).toMatchObject({ status: 'suspended', also_user_wire: true });
    expect(await listDispatcherLinksForUser()).toEqual([]);
  });

  it('lists only connected orchestrators, with sources', async () => {
    const { orchestrators, global_cap, max_helpers_ceiling } = await controls();
    expect(orchestrators.map((o: { id: string }) => o.id)).toEqual(['a', 'b', 'c']);
    expect(orchestrators[0]).toMatchObject({ project: 'one', cross_project_helpers: { value: false, source: 'default' }, max_helpers: { value: 5, source: 'default' } });
    expect([global_cap, max_helpers_ceiling]).toEqual([20, 20]);
  });

  it('pages, and refuses a page or audit size past its bound', async () => {
    const first = await controls({ limit: 2 });
    expect(first.orchestrators).toHaveLength(2);
    expect(first.total).toBe(3);
    const second = await controls({ limit: 2, cursor: first.next_cursor });
    expect(second.orchestrators.map((o: { id: string }) => o.id)).toEqual(['c']);
    expect(second.next_cursor).toBeUndefined();
    for (const bad of [{ limit: 26 }, { limit: 0 }, { audit: 51 }, { cursor: 'x' }, { everything: true }]) {
      expect((await call('list_orchestrator_controls', bad)).isError).toBe(true);
    }
  });

  it('refuses a helper as the agent_id', async () => {
    expect((await call('list_orchestrator_controls', { agent_id: 'helper' })).isError).toBe(true);
  });

  it('returns the newest audit rows first, on request only', async () => {
    await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 2 });
    await call('set_orchestrator_helpers', { agent_id: 'b', max_helpers: 3 });
    expect((await controls()).audit).toBeUndefined();
    const { audit } = await controls({ audit: 1 });
    expect(audit).toHaveLength(1);
    expect(audit[0].targets).toEqual(['b']);
  });
});

describe('audit', () => {
  it('keeps no value the caller supplied beyond a short allowlist', async () => {
    await call('set_orchestrator_helpers', { agent_id: 'x'.repeat(500), max_helpers: 3, note: 'secret text' });
    const row = lastAudit();
    expect(row.targets[0]).toHaveLength(100);
    expect(JSON.stringify(row)).not.toContain('secret text');
    expect(row.requested?.fields).toEqual(['max_helpers', 'note']);
  });

  it('rotates to one older file and reads across it', async () => {
    const big = { tool: 'x', actorId: 'dispatcher', targets: ['y'.repeat(100)], outcome: 'ok' as const };
    fs.writeFileSync(auditPath(), `${JSON.stringify({ ts: 'old', ...big })}\n${'z'.repeat(MAX_AUDIT_BYTES)}\n`);
    await appendAudit({ tool: 'new', actorId: 'dispatcher', targets: [], outcome: 'ok' });
    expect(fs.existsSync(`${auditPath()}.1`)).toBe(true);
    expect(fs.statSync(auditPath()).size).toBeLessThan(1000);
    const rows = await readAudit(5);
    expect(rows.map((r) => r.tool)).toEqual(['new', 'x']);
  });

  it('skips a torn line', async () => {
    await appendAudit({ tool: 'first', actorId: 'dispatcher', targets: [], outcome: 'ok' });
    fs.appendFileSync(auditPath(), '{"torn');
    expect((await readAudit(5)).map((r) => r.tool)).toEqual(['first']);
  });

  it('keeps the change and warns when the row can\'t be written', async () => {
    fs.mkdirSync(auditPath());
    const result = JSON.parse(text(await call('set_orchestrator_helpers', { agent_id: 'a', max_helpers: 3 })));
    expect(state.policies.get('a')?.maxHelpers).toBe(3);
    expect(result.audit_warning).toEqual(expect.stringContaining('audit record'));
  });
});

describe('the store', () => {
  it('moves a corrupt file aside and carries on empty', async () => {
    fs.writeFileSync(dispatcherConnectionsPath(), '{ not json');
    expect(await readDispatcherConnections()).toEqual([]);
    expect(fs.readdirSync(state.base).some((f) => f.startsWith('dispatcher-connections.json.corrupt-'))).toBe(true);
  });

  it('reads a newer store but won\'t rewrite it', async () => {
    const body = JSON.stringify({ version: 99, connections: [{ agentId: 'a', targetId: 'b', agentProjectPath: P1, targetProjectPath: P1, createdBy: 'd' }] });
    fs.writeFileSync(dispatcherConnectionsPath(), body);
    expect(await storedPairs()).toEqual(['a>b']);
    expect((await call('connect_orchestrators', { from: 'b', to: 'c' })).isError).toBe(true);
    expect(fs.readFileSync(dispatcherConnectionsPath(), 'utf-8')).toBe(body);
  });

  it('lives outside the Dispatcher\'s working folder', () => {
    expect(dispatcherConnectionsPath().startsWith(path.join(state.base, 'dispatcher') + path.sep)).toBe(false);
    expect(auditPath().startsWith(path.join(state.base, 'dispatcher') + path.sep)).toBe(false);
  });
});
