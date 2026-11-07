/** Optional work observation only: all fixture bytes are in memory; no 104-case harness rewiring. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { DurableAgentConfig } from '../../shared/types';
import { withFixtureWork } from '../../../test/dispatcher-work-owner';

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  listeners: new Set<(project: string) => void>(),
  messages: [] as string[],
  failStore: false,
  failPendingRead: false,
  throwLog: false,
}));
const BASE = 'observer-fixture';
const STORE = path.join(BASE, 'dispatcher-connections.json');
const PENDING = path.join(BASE, 'dispatcher-connections.pending-removals.json');

vi.mock('fs/promises', () => ({
  readFile: async (file: string) => {
    if (state.failPendingRead && file.endsWith('dispatcher-connections.pending-removals.json')) throw Object.assign(new Error('fake read failure'), { code: 'EIO' });
    if (!state.files.has(file)) throw Object.assign(new Error('fake missing file'), { code: 'ENOENT' });
    return state.files.get(file)!;
  },
  mkdir: async (): Promise<void> => undefined,
  writeFile: async (file: string, body: string) => {
    if (state.failStore && file.includes(`dispatcher-connections.json.tmp.`)) throw Object.assign(new Error('fake store failure'), { code: 'ENOSPC' });
    state.files.set(file, body);
  },
  rename: async (from: string, to: string) => {
    if (!state.files.has(from)) throw Object.assign(new Error('fake missing source'), { code: 'ENOENT' });
    state.files.set(to, state.files.get(from)!);
    state.files.delete(from);
  },
  rm: async (file: string) => { state.files.delete(file); },
}));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => 'observer-fixture' }));
vi.mock('./log-service', () => ({
  appLog: (_source: string, _level: string, message: string) => {
    if (state.throwLog) throw undefined;
    state.messages.push(message);
  },
}));
vi.mock('./project-store', () => ({
  list: async () => [{ id: 'project', path: 'observer-project', name: 'fixture' }],
  onProjectsChanged: (): (() => void) => (): void => undefined,
}));
vi.mock('./fs-utils', () => ({ pathExists: async () => true }));
vi.mock('./agent-config', () => ({
  listDurable: async () => ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id } as DurableAgentConfig)),
  onAgentConfigChanged: (listener: (project: string) => void) => {
    state.listeners.add(listener);
    return () => { state.listeners.delete(listener); };
  },
}));
vi.mock('./orchestration-policy', () => ({
  resolveOrchestrationPolicies: async (_project: string, agents: DurableAgentConfig[]) =>
    new Map(agents.map((agent) => [agent.id, { orchestrate: true, connectToDispatcher: true }])),
}));
vi.mock('./mcp-settings', () => ({ onMcpEnablementChanged: (): (() => void) => (): void => undefined }));
vi.mock('./dispatcher/dispatcher-service', () => ({
  isDispatcherEnabled: () => true,
  isDispatcherPath: () => false,
  onDispatcherChanged: (): (() => void) => (): void => undefined,
}));

import { _resetDispatcherConnectionsForTesting, readDispatcherConnections, watchDispatcherConnections } from './dispatcher-connections';
import { _resetPersistedBindingSourcesForTesting, clearBindingRemovedByUser, markBindingRemovedByUser } from './persisted-bindings';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  _resetDispatcherConnectionsForTesting();
  _resetPersistedBindingSourcesForTesting();
  state.files.clear();
  state.listeners.clear();
  state.messages.length = 0;
  state.failStore = false;
  state.failPendingRead = false;
  state.throwLog = false;
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('isolated Dispatcher watcher work observer', () => {
  it.each([false, true])('observes all four full terminal chains; observer throws=%s', async (throwObserver) => {
    await withFixtureWork(async (fixture) => {
      const entries = [['a', 'b'], ['c', 'd']].map(([agentId, targetId]) => ({
        agentId, targetId, agentProjectPath: 'observer-project', targetProjectPath: 'observer-project', createdBy: 'fixture',
      }));
      state.files.set(STORE, JSON.stringify({ version: 1, connections: entries, removedByUser: [] }));
      const callbackGate = gate();
      const callbackEntered = gate();
      fixture.releaseOnClose(callbackGate.release);
      fixture.releaseOnClose(callbackEntered.release);
      let stop: (() => void) | undefined;
      const epoch = fixture.epoch(() => stop?.());
      const records: Array<{ kind: string; terminal: Promise<unknown>; observed: Promise<unknown>; done: boolean }> = [];
      const onChanged = vi.fn(() => { callbackEntered.release(); return callbackGate.promise; });
      stop = watchDispatcherConnections(onChanged, (kind, terminal) => {
        const record = { kind, terminal, observed: epoch.work.observe(terminal), done: false };
        // Immediate rejection observation is deliberately independent of whether
        // the source contains the optional observer's own synchronous throw.
        void terminal.then(() => { record.done = true; }, () => { record.done = true; });
        records.push(record);
        if (throwObserver) throw undefined;
      });
      expect(typeof stop).toBe('function');
      expect(records.map((record) => record.kind)).toEqual(['initial-settlement']);
      await records[0].terminal;
      expect(vi.getTimerCount()).toBe(0);

      state.failStore = true;
      markBindingRemovedByUser('a', 'b');
      expect(records[1].kind).toBe('user-removal');
      await records[1].terminal;
      expect(state.files.has(PENDING)).toBe(true);
      expect(state.messages).toContain('The user removed a Dispatcher connection');
      expect(vi.getTimerCount()).toBe(1); // Existing unref30s retry, no observer timer.

      clearBindingRemovedByUser('a', 'b');
      expect(records[2].kind).toBe('user-draw');
      await records[2].terminal; // Includes existing refusal catch/log.
      expect(state.messages).toContain('Could not clear a Dispatcher connection removal');
      state.failStore = false;
      clearBindingRemovedByUser('a', 'b');
      await records[3].terminal;
      expect(state.files.has(PENDING)).toBe(false);

      for (const listener of state.listeners) listener('observer-project');
      // Fake-time stimulus only, NEVER evidence of detached completion. The
      // source observer owns the actual full check chain from its creation.
      await epoch.work.observe(vi.advanceTimersByTimeAsync(50));
      const check = records[4];
      expect(check.kind).toBe('change-check');
      await Promise.race([
        callbackEntered.promise,
        check.terminal.then(() => { throw new Error('Check settled before onChanged'); }),
      ]);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(check.done).toBe(false); // Full chain awaits onChanged, not just store work.
      expect(state.messages).not.toContain('Dropped Dispatcher connections whose ends are gone');
      callbackGate.release();
      await check.terminal;
      expect(check.done).toBe(true);
      expect(records.map((record) => record.kind)).toEqual(['initial-settlement', 'user-removal', 'user-draw', 'user-draw', 'change-check']);
      for (const record of records) expect(record.observed).toBe(record.terminal);
    });
    expect(state.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('omitting the observer retains the existing stop and empty-startup behavior', async () => {
    await withFixtureWork(async (fixture) => {
      const stop = watchDispatcherConnections(vi.fn());
      const epoch = fixture.epoch(stop);
      // Fixture-specific startup ordering only: no pending file, empty store,
      // no fired check. This is not a general watcher completion barrier.
      expect(await epoch.work.observe(readDispatcherConnections())).toEqual([]);
      expect(typeof stop).toBe('function');
      expect(vi.getTimerCount()).toBe(0);
    });
    expect(state.listeners.size).toBe(0);
  });

  it('accounts for a rejected original terminal chain without replacing it or treating rejection as lost work', async () => {
    await withFixtureWork(async (fixture) => {
      state.failPendingRead = true;
      state.throwLog = true; // Existing startup catch itself throws undefined.
      let stop: (() => void) | undefined;
      const epoch = fixture.epoch(() => stop?.());
      const terminals: Array<{ original: Promise<unknown>; observed: Promise<unknown> }> = [];
      stop = watchDispatcherConnections(vi.fn(), (_kind, terminal) => {
        terminals.push({ original: terminal, observed: epoch.work.observe(terminal) });
        throw undefined; // The optional observer cannot replace this chain's outcome.
      });
      expect(terminals[0].observed).toBe(terminals[0].original);
      const outcome = await terminals[0].original.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(outcome).toEqual({ ok: false, error: undefined });
      expect(epoch.work.rejected).toBe(1);
    });
    expect(state.listeners.size).toBe(0);
  });
});
