import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startProjectStateSync, type ProjectStateApi } from './projectStateSync';
import { CHROME_STORAGE_KEY, connectProjectStateSync, useChromeStore } from './chromeStore';
import { DEFAULT_PROJECT_STATE, type ProjectState, type ProjectStateChange, type ProjectStateOp } from '../../shared/project-state';

/** A fake main: hydrate and op calls resolve when the test says, broadcasts are pushed by hand. */
function fakeMain() {
  let onChange: ((change: ProjectStateChange) => void) | null = null;
  const hydrates: Array<{ legacy: ProjectState; resolve: (s: ProjectState) => void; reject: (e: unknown) => void }> = [];
  const ops: Array<{ clientId: string; seq: number; op: ProjectStateOp; resolve: () => void; reject: (e: unknown) => void }> = [];
  const api: ProjectStateApi = {
    hydrateState: vi.fn((legacy) => new Promise<ProjectState>((resolve, reject) => { hydrates.push({ legacy, resolve, reject }); })),
    applyStateOp: vi.fn((clientId, seq, op) => new Promise<void>((resolve, reject) => { ops.push({ clientId, seq, op, resolve, reject }); })),
    onStateChanged: vi.fn((cb) => { onChange = cb; return () => { onChange = null; }; }),
  };
  return { api, hydrates, ops, broadcast: (change: ProjectStateChange) => onChange?.(change), subscribed: () => onChange !== null };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const state = (s: Partial<ProjectState> = {}): ProjectState => ({ ...DEFAULT_PROJECT_STATE, ...s });

describe('startProjectStateSync (#2458)', () => {
  it('holds ops until main answers the hydrate, then sends them in order on top of main\'s state', async () => {
    const main = fakeMain();
    const replace = vi.fn();
    const sync = startProjectStateSync(main.api, { legacy: () => state({ pinnedProjectIds: ['old'] }), replace });
    expect(main.hydrates[0].legacy.pinnedProjectIds).toEqual(['old']);

    sync.send({ type: 'setPinned', projectId: 'a', pinned: true });
    sync.send({ type: 'setIdleDays', days: 3 });
    expect(main.api.applyStateOp).not.toHaveBeenCalled();

    main.hydrates[0].resolve(state({ pinnedProjectIds: ['main'] }));
    await flush();
    expect(main.ops.map((o) => [o.seq, o.op.type])).toEqual([[1, 'setPinned'], [2, 'setIdleDays']]);
    expect(replace).toHaveBeenLastCalledWith(state({ pinnedProjectIds: ['main', 'a'], idleDays: 3 }));
  });

  it('keeps unacknowledged ops on top of a phone\'s change, and drops them once acknowledged', async () => {
    const main = fakeMain();
    const replace = vi.fn();
    const sync = startProjectStateSync(main.api, { legacy: () => state(), replace });
    main.hydrates[0].resolve(state());
    await flush();
    sync.send({ type: 'setPinned', projectId: 'mine', pinned: true });
    const clientId = main.ops[0].clientId;

    // A phone pinned another project before main got this window's op.
    main.broadcast({ state: state({ pinnedProjectIds: ['phone'] }), acked: {} });
    expect(replace).toHaveBeenLastCalledWith(state({ pinnedProjectIds: ['phone', 'mine'] }));

    // Main applied it: its state is now the whole truth.
    main.broadcast({ state: state({ pinnedProjectIds: ['phone', 'mine'] }), acked: { [clientId]: 1 } });
    main.broadcast({ state: state({ pinnedProjectIds: ['mine'] }), acked: { [clientId]: 1 } });
    expect(replace).toHaveBeenLastCalledWith(state({ pinnedProjectIds: ['mine'] }));
  });

  it('drops an op main refused, and reports it', async () => {
    const main = fakeMain();
    const replace = vi.fn();
    const onError = vi.fn();
    const sync = startProjectStateSync(main.api, { legacy: () => state(), replace, onError });
    main.hydrates[0].resolve(state());
    await flush();
    sync.send({ type: 'setPinned', projectId: 'a', pinned: true });
    main.ops[0].reject(new Error('no'));
    await flush();
    expect(replace).toHaveBeenLastCalledWith(state());
    expect(onError).toHaveBeenCalled();
  });

  it('stays local when main has no project state', async () => {
    const main = fakeMain();
    const replace = vi.fn();
    const sync = startProjectStateSync(main.api, { legacy: () => state(), replace, onError: vi.fn() });
    main.hydrates[0].reject(new Error('no handler'));
    await flush();
    sync.send({ type: 'setPinned', projectId: 'a', pinned: true });
    expect(main.api.applyStateOp).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('chromeStore with the main-process sync (#2458)', () => {
  beforeEach(() => {
    localStorage.clear();
    useChromeStore.setState({ pinnedProjectIds: [], inactiveProjectIds: [], projectActivity: {}, idleDays: 7 });
  });
  afterEach(() => {
    connectProjectStateSync(undefined);
    vi.useRealTimers();
  });

  it('hands main the localStorage copy, then shows main\'s state and keeps the cache current', async () => {
    localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify({ version: 2, sidebarWidth: 300, pinnedProjectIds: ['saved'], inactiveProjectIds: ['gone'], projectActivity: { saved: 5 }, idleDays: 14 }));
    const main = fakeMain();
    connectProjectStateSync(main.api);
    expect(main.hydrates[0].legacy).toEqual({ pinnedProjectIds: ['saved'], inactiveProjectIds: ['gone'], projectActivity: { saved: 5 }, idleDays: 14 });

    vi.useFakeTimers();
    main.hydrates[0].resolve({ pinnedProjectIds: ['saved'], inactiveProjectIds: ['gone'], projectActivity: { saved: 5 }, idleDays: 14 });
    await vi.advanceTimersByTimeAsync(0);
    expect(useChromeStore.getState()).toMatchObject({ pinnedProjectIds: ['saved'], inactiveProjectIds: ['gone'], idleDays: 14 });

    // A phone pins a project: the sidebar and the localStorage cache follow.
    main.broadcast({ state: { pinnedProjectIds: ['saved', 'phone'], inactiveProjectIds: ['gone'], projectActivity: { saved: 5 }, idleDays: 14 }, acked: {} });
    expect(useChromeStore.getState().pinnedProjectIds).toEqual(['saved', 'phone']);
    await vi.advanceTimersByTimeAsync(400);
    expect(JSON.parse(localStorage.getItem(CHROME_STORAGE_KEY)!)).toMatchObject({ sidebarWidth: 300, pinnedProjectIds: ['saved', 'phone'] });
  });

  it('applies desktop actions at once and sends each one to main', async () => {
    const main = fakeMain();
    connectProjectStateSync(main.api);
    main.hydrates[0].resolve(state());
    await flush();
    const store = useChromeStore.getState();
    store.togglePinned('p');
    store.markProjectInactive('p'); // pinned: refused, nothing sent
    store.markProjectInactive('q');
    store.markProjectActive('q', 1_000);
    store.markActivity('q', 2_000); // within the write interval: nothing sent
    store.setIdleDays(30);
    store.forgetProjects(['p']);
    expect(useChromeStore.getState()).toMatchObject({ pinnedProjectIds: [], inactiveProjectIds: [], projectActivity: { q: 1_000 }, idleDays: 30 });
    expect(main.ops.map((o) => o.op)).toEqual([
      { type: 'setPinned', projectId: 'p', pinned: true },
      { type: 'setInactive', projectId: 'q', inactive: true, at: expect.any(Number) },
      { type: 'setInactive', projectId: 'q', inactive: false, at: 1_000 },
      { type: 'setIdleDays', days: 30 },
      { type: 'forget', projectIds: ['p'] },
    ]);
  });
});
