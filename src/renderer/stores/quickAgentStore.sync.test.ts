import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectFinishedQuickSync, useQuickAgentStore, type FinishedQuickAgentsApi } from './quickAgentStore';
import type { FinishedQuickAgentOp, FinishedQuickAgents, FinishedQuickAgentsChange } from '../../shared/finished-quick-agents';
import type { CompletedQuickAgent } from '../../shared/types';

/** A fake main: hydrate and op calls resolve when the test says, broadcasts are pushed by hand. */
function fakeMain() {
  let onChange: ((change: FinishedQuickAgentsChange) => void) | null = null;
  const hydrates: Array<{ legacy: FinishedQuickAgents; resolve: (s: FinishedQuickAgents) => void; reject: (e: unknown) => void }> = [];
  const ops: Array<{ clientId: string; seq: number; op: FinishedQuickAgentOp; resolve: () => void; reject: (e: unknown) => void }> = [];
  const api: FinishedQuickAgentsApi = {
    hydrate: vi.fn((legacy) => new Promise<FinishedQuickAgents>((resolve, reject) => { hydrates.push({ legacy, resolve, reject }); })),
    apply: vi.fn((clientId, seq, op) => new Promise<void>((resolve, reject) => { ops.push({ clientId, seq, op, resolve, reject }); })),
    onChanged: vi.fn((cb) => { onChange = cb; return () => { onChange = null; }; }),
  };
  return { api, hydrates, ops, broadcast: (change: FinishedQuickAgentsChange) => onChange?.(change) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const rec = (id: string, projectId = 'p'): CompletedQuickAgent => ({
  id, projectId, name: `n-${id}`, mission: 'm', summary: null, filesModified: [], exitCode: 0, completedAt: 1,
});
const cached = (projectId: string) => JSON.parse(localStorage.getItem(`quick_completed_${projectId}`) ?? 'null');

describe('quickAgentStore with the main-process sync (#2467)', () => {
  beforeEach(() => {
    localStorage.clear();
    useQuickAgentStore.setState({ completedAgents: {}, selectedCompletedId: null });
  });
  afterEach(() => {
    connectFinishedQuickSync(undefined);
  });

  it('hands main every project\'s localStorage list, once, as the migration source', () => {
    localStorage.setItem('quick_completed_p', JSON.stringify([rec('b'), rec('a')]));
    localStorage.setItem('quick_completed_q', JSON.stringify([rec('c', 'q')]));
    localStorage.setItem('quick_completed_broken', '{not json');
    localStorage.setItem('clubhouse_chrome_v2', JSON.stringify({ pinnedProjectIds: [] }));
    const main = fakeMain();
    connectFinishedQuickSync(main.api);
    expect(main.hydrates).toHaveLength(1);
    expect(main.hydrates[0].legacy).toEqual({ p: [rec('b'), rec('a')], q: [rec('c', 'q')], broken: [] });
  });

  it('shows main\'s lists and keeps the localStorage cache current, including a phone\'s dismissal', async () => {
    localStorage.setItem('quick_completed_p', JSON.stringify([rec('a')]));
    useQuickAgentStore.getState().loadCompleted('p');
    const main = fakeMain();
    connectFinishedQuickSync(main.api);
    // Another window or an earlier launch already moved the lists into main.
    main.hydrates[0].resolve({ p: [rec('b'), rec('a')], q: [rec('c', 'q')] });
    await flush();
    expect(useQuickAgentStore.getState().completedAgents).toEqual({ p: [rec('b'), rec('a')], q: [rec('c', 'q')] });
    expect(cached('p')).toEqual([rec('b'), rec('a')]);

    main.broadcast({ state: { p: [rec('a')], q: [] }, acked: {} });
    expect(useQuickAgentStore.getState().completedAgents).toEqual({ p: [rec('a')], q: [] });
    expect(cached('p')).toEqual([rec('a')]);
    expect(cached('q')).toEqual([]);
  });

  it('applies desktop actions at once and sends each one to main', async () => {
    const main = fakeMain();
    connectFinishedQuickSync(main.api);
    main.hydrates[0].resolve({});
    await flush();
    const store = useQuickAgentStore.getState();
    store.addCompleted(rec('a'));
    store.addCompleted(rec('b'));
    store.addCompleted(rec('a')); // already listed: kept once
    store.dismissCompleted('p', 'a');
    store.dismissCompleted('p', 'missing');
    store.clearCompleted('p');
    store.clearCompleted('p');
    expect(useQuickAgentStore.getState().completedAgents).toEqual({ p: [] });
    expect(cached('p')).toEqual([]);
    // Even ones that change nothing here: main may hold a list this window hasn't loaded, and ops are idempotent.
    expect(main.ops.map((o) => o.op)).toEqual([
      { type: 'add', record: rec('a') },
      { type: 'add', record: rec('b') },
      { type: 'add', record: rec('a') },
      { type: 'dismiss', projectId: 'p', agentId: 'a' },
      { type: 'dismiss', projectId: 'p', agentId: 'missing' },
      { type: 'clear', projectId: 'p' },
      { type: 'clear', projectId: 'p' },
    ]);
    expect(main.ops.map((o) => o.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps a quick agent that finished here on top of a phone\'s change main hasn\'t seen it in yet', async () => {
    const main = fakeMain();
    connectFinishedQuickSync(main.api);
    main.hydrates[0].resolve({ p: [rec('old')] });
    await flush();
    useQuickAgentStore.getState().addCompleted(rec('new'));
    const clientId = main.ops[0].clientId;

    // The phone cleared the list before main got this window's add.
    main.broadcast({ state: { p: [] }, acked: {} });
    expect(useQuickAgentStore.getState().completedAgents.p).toEqual([rec('new')]);

    main.broadcast({ state: { p: [rec('new')] }, acked: { [clientId]: 1 } });
    main.broadcast({ state: { p: [] }, acked: { [clientId]: 1 } });
    expect(useQuickAgentStore.getState().completedAgents.p).toEqual([]);
  });

  it('stays local, as before, when main has no lists', async () => {
    const main = fakeMain();
    connectFinishedQuickSync(main.api);
    main.hydrates[0].reject(new Error('no handler'));
    await flush();
    useQuickAgentStore.getState().addCompleted(rec('a'));
    expect(useQuickAgentStore.getState().completedAgents.p).toEqual([rec('a')]);
    expect(cached('p')).toEqual([rec('a')]);
    expect(main.api.apply).not.toHaveBeenCalled();
  });
});
