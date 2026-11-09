import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';

const W = vi.hoisted(() => ({
  agents: new Map<string, DurableAgentConfig[]>(),
  unreadable: new Set<string>(),
  registered: [] as string[],
  removed: [] as Array<[string, string]>,
  listener: null as null | ((event: { type: string; agentId?: string; projectPath?: string }) => void),
  userData: '',
}));

vi.mock('electron', () => ({ app: { getPath: () => W.userData } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./project-store', () => ({ list: async () => W.registered.map((p) => ({ path: p })) }));
vi.mock('./app-event-bus', () => ({
  onAppEvent: (l: typeof W.listener) => { W.listener = l; return () => { W.listener = null; }; },
}));
vi.mock('./agent-config', () => ({
  projectKey: async (p: string) => p.replace(/[\\/]+$/, ''),
  peekDurableConfigsChecked: async (p: string) => (W.unreadable.has(p)
    ? { agents: [], readable: false }
    : { agents: W.agents.get(p.replace(/[\\/]+$/, '')) ?? [], readable: true }),
  deleteUnregister: async (p: string, id: string) => {
    W.agents.set(p, (W.agents.get(p) ?? []).filter((a) => a.id !== id));
    W.removed.push([p, id]);
    return { ok: true, message: 'Removed' };
  },
}));

import {
  removeDisposedHelpersOf,
  removeOrphanedDisposedHelpers,
  removeOrphanedDisposedHelpersOnce,
  startDisposedHelperCleanup,
} from './disposed-helper-cleanup';

const A = path.join('/work', 'alpha');
const B = path.join('/work', 'beta');
const DISPOSED = '2026-11-01T00:00:00Z';
const row = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({ id, name: id, color: 'teal', ...extra } as DurableAgentConfig);
const ids = (p: string) => (W.agents.get(p) ?? []).map((a) => a.id);

beforeEach(() => {
  W.agents.clear();
  W.unreadable.clear();
  W.registered = [A, B];
  W.removed = [];
  W.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'disposed-cleanup-'));
});

afterEach(() => {
  fs.rmSync(W.userData, { recursive: true, force: true });
});

describe('removeDisposedHelpersOf (#3186)', () => {
  it('removes a deleted orchestrator\'s disposed helpers in its project and others, and theirs, keeping live and unrelated rows', async () => {
    W.agents.set(A, [
      row('other-lead'),
      row('h1', { parentAgentId: 'lead', disposedAt: DISPOSED }),
      row('h2', { parentAgentId: 'lead' }), // live: delete releases it, never removed here
      row('h3', { parentAgentId: 'other-lead', disposedAt: DISPOSED }),
      row('h1-child', { parentAgentId: 'h1', disposedAt: DISPOSED }),
    ]);
    W.agents.set(B, [
      row('x1', { parentAgentId: 'lead', parentProjectPath: A, disposedAt: DISPOSED }),
      // Same id, but its parent is a `lead` in beta, which isn't the one deleted.
      row('x2', { parentAgentId: 'lead', disposedAt: DISPOSED }),
      row('lead'),
    ]);
    expect(await removeDisposedHelpersOf(A, 'lead')).toBe(3);
    expect(ids(A)).toEqual(['other-lead', 'h2', 'h3']);
    expect(ids(B)).toEqual(['x2', 'lead']);
  });

  it('does nothing while the orchestrator is still there, as when a helper is only disposed', async () => {
    W.agents.set(A, [row('lead', { disposedAt: DISPOSED }), row('h1', { parentAgentId: 'lead', disposedAt: DISPOSED })]);
    expect(await removeDisposedHelpersOf(A, 'lead')).toBe(0);
    expect(W.removed).toEqual([]);
  });

  it('does nothing when the orchestrator\'s project can\'t be read, and skips another unreadable project', async () => {
    W.agents.set(A, [row('h1', { parentAgentId: 'lead', disposedAt: DISPOSED })]);
    W.unreadable.add(A);
    expect(await removeDisposedHelpersOf(A, 'lead')).toBe(0);
    W.unreadable.clear();
    W.unreadable.add(B);
    expect(await removeDisposedHelpersOf(A, 'lead')).toBe(1);
  });

  it('runs when an agent.deleted event arrives', async () => {
    W.agents.set(A, [row('h1', { parentAgentId: 'lead', disposedAt: DISPOSED })]);
    const stop = startDisposedHelperCleanup();
    W.listener!({ type: 'agent.created', agentId: 'lead', projectPath: A });
    W.listener!({ type: 'agent.deleted', agentId: 'lead', projectPath: A });
    await vi.waitFor(() => expect(ids(A)).toEqual([]));
    stop();
    expect(W.listener).toBeNull();
  });
});

describe('removeOrphanedDisposedHelpers (#3186)', () => {
  it('removes disposed helpers with no parent or a missing one, through nested helpers, and keeps what it can\'t judge', async () => {
    W.agents.set(A, [
      row('lead'),
      row('kept', { parentAgentId: 'lead', disposedAt: DISPOSED }),
      row('gone1', { parentAgentId: 'missing', disposedAt: DISPOSED }),
      row('released', { disposedAt: DISPOSED }),
      row('plain'),
    ]);
    W.agents.set(B, [
      row('nested', { parentAgentId: 'gone1', parentProjectPath: A, disposedAt: DISPOSED }),
      row('cross-kept', { parentAgentId: 'lead', parentProjectPath: A, disposedAt: DISPOSED }),
      // Its parent's project isn't registered: it might come back, so it stays for Settings.
      row('unregistered', { parentAgentId: 'lead', parentProjectPath: path.join('/work', 'removed'), disposedAt: DISPOSED }),
    ]);
    expect(await removeOrphanedDisposedHelpers()).toEqual({ removed: 3, complete: true });
    expect(ids(A)).toEqual(['lead', 'kept', 'plain']);
    expect(ids(B)).toEqual(['cross-kept', 'unregistered']);
  });

  it('leaves helpers whose parent project can\'t be read, and says it wasn\'t complete', async () => {
    W.agents.set(B, [row('x', { parentAgentId: 'lead', parentProjectPath: A, disposedAt: DISPOSED })]);
    W.unreadable.add(A);
    expect(await removeOrphanedDisposedHelpers()).toEqual({ removed: 0, complete: false });
  });

  it('runs once, and again only while a project couldn\'t be read', async () => {
    W.agents.set(A, [row('a', { disposedAt: DISPOSED })]);
    W.unreadable.add(B);
    await removeOrphanedDisposedHelpersOnce();
    expect(ids(A)).toEqual([]);
    W.agents.set(A, [row('b', { disposedAt: DISPOSED })]);
    W.unreadable.clear();
    await removeOrphanedDisposedHelpersOnce();
    expect(ids(A)).toEqual([]);
    W.agents.set(A, [row('c', { disposedAt: DISPOSED })]);
    await removeOrphanedDisposedHelpersOnce();
    expect(ids(A)).toEqual(['c']);
  });
});
