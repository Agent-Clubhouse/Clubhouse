import { beforeEach, describe, expect, it, vi } from 'vitest';

const { key } = vi.hoisted(() => ({ key: (a: string, t: string) => `${a}\u0000${t}` }));
const state = vi.hoisted(() => ({
  bySource: new Map<string, Set<string>>(),
  failed: [] as string[],
  bound: new Set<string>(),
  links: [] as Array<{ agentId: string; targetId: string; agentName: string; targetName: string; status: 'active' | 'suspended'; reason?: string }>,
  calls: [] as string[],
}));

vi.mock('./persisted-bindings', () => ({
  collectSourcesByPair: async () => ({ bySource: state.bySource, failed: state.failed }),
  persistedPairKey: key,
  releaseSourceBinding: (sourceId: string, a: string, t: string) => { state.calls.push(`release:${sourceId}:${a}>${t}`); return 'unbound'; },
  rebuildPersistedBindings: async () => { state.calls.push('rebuild'); },
  markBindingRemovedByUser: (a: string, t: string) => { state.calls.push(`removed-by-user:${a}>${t}`); },
}));
vi.mock('./clubhouse-mcp/binding-manager', () => ({
  bindingManager: {
    getAllBindings: () => [...state.bound].map((k) => { const [agentId, targetId] = k.split('\u0000'); return { agentId, targetId, targetKind: 'agent' }; }),
    getBindingsForAgent: (a: string) => [...state.bound].filter((k) => k.startsWith(`${a}\u0000`)).map((k) => ({ targetId: k.split('\u0000')[1] })),
  },
}));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => 'disp' }));
vi.mock('./dispatcher-connections', () => ({
  DISPATCHER_CONNECTION_SOURCE_ID: 'dispatcher-connections',
  listDispatcherLinksForUser: async () => state.links,
  recordUserRemoval: async (p: { agentId: string; targetId: string }) => {
    state.calls.push(`tombstone:${p.agentId}>${p.targetId}`);
    state.bySource.get('dispatcher-connections')?.delete(key(p.agentId, p.targetId));
    state.links = state.links.filter((l) => !(l.agentId === p.agentId && l.targetId === p.targetId));
    return true;
  },
}));
vi.mock('./dispatcher-wire-source', () => ({
  DISPATCHER_WIRE_SOURCE_ID: 'dispatcher-wires',
  saveWireRemoval: async (id: string) => { state.calls.push(`connect-to-dispatcher-off:${id}`); },
}));
vi.mock('./helper-wire-source', () => ({ HELPER_WIRE_SOURCE_ID: 'helper-wires' }));
vi.mock('./orchestrator-connections', () => ({
  ORCHESTRATOR_CONNECTION_SOURCE_ID: 'orchestrator-connections',
  removeStoredPair: async (a: string, t: string) => {
    state.calls.push(`drop-tool-link:${a}>${t}`);
    state.bySource.get('orchestrator-connections')?.delete(key(a, t));
    return 1;
  },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { listConnectionSources, removeConnectionSource } from './connection-sources';

function holds(sourceId: string, ...pairs: Array<[string, string]>) {
  state.bySource.set(sourceId, new Set(pairs.map(([a, t]) => key(a, t))));
}

beforeEach(() => {
  state.bySource = new Map();
  state.failed = [];
  state.bound = new Set();
  state.links = [];
  state.calls = [];
});

describe('the sources behind a connection (#2744)', () => {
  it('lists both directions with every source that holds each, from what is saved', async () => {
    holds('canvas-wires', ['lead', 'rev']);
    holds('orchestrator-connections', ['lead', 'rev'], ['rev', 'lead']);
    holds('helper-wires', ['lead', 'h1'], ['h1', 'lead']);
    holds('helper-wires-elsewhere', ['x', 'y']);
    state.bound = new Set([key('lead', 'rev'), key('rev', 'lead'), key('lead', 'h1'), key('h1', 'lead'), key('lead', 'stray')]);
    const { pairs } = await listConnectionSources('lead');
    const of = (a: string, t: string) => pairs.find((p) => p.agentId === a && p.targetId === t);
    expect(of('lead', 'rev')?.sources.map((s) => s.kind)).toEqual(['canvas', 'tool_link']);
    expect(of('rev', 'lead')?.sources.map((s) => s.kind)).toEqual(['tool_link']);
    expect(of('h1', 'lead')?.sources.map((s) => s.kind)).toEqual(['helper']);
    // Bound, but no source lists it: unresolved, never guessed.
    expect(of('lead', 'stray')).toMatchObject({ bound: true, sources: [], unresolved: true });
    expect(of('x', 'y')).toBeUndefined();
  });

  it('includes a suspended Dispatcher link, which has no binding, with why', async () => {
    state.links = [{ agentId: 'lead', targetId: 'rev', agentName: 'lead', targetName: 'rev', status: 'suspended', reason: 'orchestration_off' }];
    const { pairs } = await listConnectionSources('lead');
    expect(pairs).toEqual([{ agentId: 'lead', targetId: 'rev', bound: false, sources: [{ kind: 'dispatcher_link', sourceId: 'dispatcher-connections', suspended: 'Orchestration is off for one of these agents.' }] }]);
  });

  it('reports sources it couldn\'t read', async () => {
    state.failed = ['canvas-wires'];
    expect((await listConnectionSources('lead')).unreadable).toEqual(['canvas-wires']);
  });
});

describe('removing one source (#2744)', () => {
  it('drops an orchestrator\'s link and leaves the canvas wire holding it; not a user removal', async () => {
    holds('canvas-wires', ['lead', 'rev']);
    holds('orchestrator-connections', ['lead', 'rev']);
    state.bound = new Set([key('lead', 'rev')]);
    const result = await removeConnectionSource('lead', 'rev', 'tool_link');
    expect(state.calls).toContain('drop-tool-link:lead>rev');
    expect(state.calls).toContain('release:orchestrator-connections:lead>rev');
    expect(result).toMatchObject({ ok: true, stillConnected: true, remaining: [{ kind: 'canvas' }] });
    expect(state.calls.some((c) => c.startsWith('removed-by-user'))).toBe(false);
  });

  it('the last source gone counts as the user\'s removal, so it can\'t be made again this session', async () => {
    holds('dispatcher-connections', ['lead', 'rev']);
    state.links = [{ agentId: 'lead', targetId: 'rev', agentName: 'lead', targetName: 'rev', status: 'active' }];
    state.bound = new Set([key('lead', 'rev')]);
    const result = await removeConnectionSource('lead', 'rev', 'dispatcher_link');
    expect(state.calls).toEqual(expect.arrayContaining(['tombstone:lead>rev', 'release:dispatcher-connections:lead>rev', 'removed-by-user:lead>rev']));
    expect(result).toMatchObject({ ok: true, stillConnected: false });
  });

  it('Connect to Dispatcher goes off on the agent at the other end', async () => {
    holds('dispatcher-wires', ['disp', 'lead'], ['lead', 'disp']);
    state.bound = new Set([key('disp', 'lead')]);
    expect((await removeConnectionSource('disp', 'lead', 'dispatcher_auto')).ok).toBe(true);
    expect(state.calls).toEqual(expect.arrayContaining(['connect-to-dispatcher-off:lead', 'rebuild']));
  });

  it('refuses canvas wires, helper links, and a source that doesn\'t hold the pair', async () => {
    holds('canvas-wires', ['lead', 'rev']);
    holds('helper-wires', ['lead', 'h1']);
    expect(await removeConnectionSource('lead', 'rev', 'canvas')).toMatchObject({ ok: false, error: expect.stringContaining('canvas') });
    expect(await removeConnectionSource('lead', 'h1', 'helper')).toMatchObject({ ok: false, error: expect.stringContaining('Helpers card') });
    expect(await removeConnectionSource('lead', 'rev', 'tool_link')).toMatchObject({ ok: false, error: expect.stringContaining('no longer holds') });
    expect(state.calls).toEqual([]);
  });
});

describe('source ids', () => {
  it('match the registered persisted sources', async () => {
    const [{ HELPER_WIRE_SOURCE_ID }, { DISPATCHER_WIRE_SOURCE_ID }, { ORCHESTRATOR_CONNECTION_SOURCE_ID }, { DISPATCHER_CONNECTION_SOURCE_ID }] = await Promise.all([
      vi.importActual<typeof import('./helper-wire-source')>('./helper-wire-source'),
      vi.importActual<typeof import('./dispatcher-wire-source')>('./dispatcher-wire-source'),
      vi.importActual<typeof import('./orchestrator-connections')>('./orchestrator-connections'),
      vi.importActual<typeof import('./dispatcher-connections')>('./dispatcher-connections'),
    ]);
    expect([HELPER_WIRE_SOURCE_ID, DISPATCHER_WIRE_SOURCE_ID, ORCHESTRATOR_CONNECTION_SOURCE_ID, DISPATCHER_CONNECTION_SOURCE_ID])
      .toEqual(['helper-wires', 'dispatcher-wires', 'orchestrator-connections', 'dispatcher-connections']);
  });
});
