import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-identity', () => ({ getIdentity: () => null }));

import { ProjectLinksStore } from './project-links-store';
import { LinkedProjectStateStore } from './linked-project-state-store';
import { startLinkedProjectState, type LinkedProjectState } from './linked-project-state-service';
import { receiveProjectLinks, startProjectLinksNetwork } from './project-links-network';
import { receiveLinkedProjectState, startLinkedProjectStateNetwork } from './linked-project-state-network';
import { applyProjectStateOp, DEFAULT_PROJECT_STATE, type ProjectState, type ProjectStateChange, type ProjectStateOp } from '../../shared/project-state';
import { PROJECT_LINKS_CAPABILITIES_PATH, PROJECT_LINKS_SYNC_PATH } from '../../shared/project-links';
import { LINKED_PROJECT_STATE_CAPABILITIES_PATH, LINKED_PROJECT_STATE_SYNC_PATH } from '../../shared/linked-project-state';
import type { ReplicaNetworkOptions } from './replica-network';
import type { NetworkProjectRef } from '../../shared/project-links';

const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':'), C = Array(16).fill('cc').join(':');
const remote = (machine: string, id: string) => `remote||${machine}||${id}`;
// Real time: received clocks more than a day ahead are dropped as skew.
let clock = Date.now();
const now = () => clock;

/**
 * One computer: its project state (the same rules as project-state-store:
 * a refused mark isn't shared), its link and linked-state replicas, and the
 * sharing service between them.
 */
function desktop(self: string, initial: Partial<ProjectState> = {}, opts: { save?: () => Promise<void>; listed?: (ref: NetworkProjectRef) => boolean } = {}) {
  let state: ProjectState = { ...DEFAULT_PROJECT_STATE, ...initial };
  let writer: ((op: ProjectStateOp, before: ProjectState) => void) | null = null;
  const listedListeners = new Set<() => void>();
  const listeners = new Set<(change: ProjectStateChange) => void>();
  const notify = () => { for (const l of listeners) l({ state, acked: {} }); };
  const links = new ProjectLinksStore({ read: () => ({ version: 1, records: [], migrated: [] }), save: async () => {}, self: () => self, legacyMirror: () => undefined, now });
  const linked = new LinkedProjectStateStore({ read: () => ({ version: 1, records: [] }), save: opts.save ?? (async () => {}), now });
  const service: LinkedProjectState = startLinkedProjectState({
    linked, links, self: () => self, now, listed: opts.listed,
    onListedChange: (l) => { listedListeners.add(l); return () => listedListeners.delete(l); },
    projectState: {
      get: () => state, ready: () => true,
      reproject: (fn) => { const next = fn(state); if (next === state) return false; state = next; notify(); return true; },
      onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
      setWriter: (w) => { writer = w; },
    },
  });
  return {
    self, links, linked, service,
    get state() { return state; },
    listedChanged() { for (const l of listedListeners) l(); },
    /** A window's or a phone's change, as applyProjectStateChange takes it. */
    apply(op: ProjectStateOp) {
      const refused = op.type === 'setInactive' && op.inactive && state.pinnedProjectIds.includes(op.projectId);
      if (writer && (op.type === 'setPinned' || op.type === 'setInactive') && !refused) writer(op, state);
      const next = applyProjectStateOp(state, op);
      if (next !== state) { state = next; notify(); }
    },
  };
}
type Desktop = ReturnType<typeof desktop>;

/** Desktops that can reach each other over Annex, with a switch per computer. */
function mesh(...desktops: Desktop[]) {
  const online = new Set(desktops.map((d) => d.self));
  const connectListeners = new Map<string, Set<(machine: string) => void>>();
  const stops: Array<() => void> = [];
  for (const d of desktops) {
    const others = desktops.filter((o) => o !== d);
    const listeners = new Set<(machine: string) => void>();
    connectListeners.set(d.self, listeners);
    const options: ReplicaNetworkOptions = {
      transport: {
        connected: (m) => online.has(d.self) && online.has(m),
        post: async (machine, path, body) => {
          const peer = desktops.find((o) => o.self === machine)!;
          const current = () => online.has(d.self) && online.has(machine);
          if (!current()) throw new Error('ECONNREFUSED');
          if (path === PROJECT_LINKS_CAPABILITIES_PATH || path === LINKED_PROJECT_STATE_CAPABILITIES_PATH) return { status: 200, body: { version: 1, maxRecords: 200 } };
          if (path === PROJECT_LINKS_SYNC_PATH) return { status: 200, body: await receiveProjectLinks(d.self, body, current, peer.links) };
          if (path === LINKED_PROJECT_STATE_SYNC_PATH) return { status: 200, body: await receiveLinkedProjectState(d.self, body, current, peer.linked) };
          return { status: 404, body: {} };
        },
        onConnected: (l) => { listeners.add(l); return () => listeners.delete(l); },
      },
      members: () => others.map((o) => o.self), isMember: (m) => others.some((o) => o.self === m),
      pairing: () => 'pin', onMembershipChanged: () => () => {},
    };
    stops.push(startProjectLinksNetwork({ ...options, store: d.links }), startLinkedProjectStateNetwork({ ...options, store: d.linked }));
  }
  const announce = (machine: string) => {
    for (const d of desktops) {
      if (d.self === machine) for (const o of desktops) if (o.self !== machine && online.has(o.self)) for (const l of connectListeners.get(machine)!) l(o.self);
      if (d.self !== machine && online.has(d.self)) for (const l of connectListeners.get(d.self)!) l(machine);
    }
  };
  return {
    offline: (d: Desktop) => { online.delete(d.self); },
    online: (d: Desktop) => { online.add(d.self); announce(d.self); },
    stop: () => { for (const s of stops) s(); for (const d of desktops) d.service.stop(); },
  };
}
let net: ReturnType<typeof mesh> | undefined;
afterEach(() => { net?.stop(); net = undefined; });

describe('Pin and Mark inactive shared by linked copies', () => {
  it('a pin on one computer reaches every linked copy on three computers', async () => {
    const a = desktop(A), b = desktop(B), c = desktop(C);
    net = mesh(a, b, c);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await a.links.apply({ type: 'link', a: 'site', b: remote(C, 'site-c') });
    await vi.waitFor(() => { expect(b.links.groups()).toHaveLength(1); expect(c.links.groups()[0]).toHaveLength(3); });
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    await vi.waitFor(() => {
      expect(a.state.pinnedProjectIds).toEqual(expect.arrayContaining(['site', remote(B, 'site-b'), remote(C, 'site-c')]));
      expect(b.state.pinnedProjectIds).toEqual(expect.arrayContaining([remote(A, 'site'), 'site-b', remote(C, 'site-c')]));
      expect(c.state.pinnedProjectIds).toEqual(expect.arrayContaining([remote(A, 'site'), remote(B, 'site-b'), 'site-c']));
    });
    expect(b.service.isLinked('site-b')).toBe(true);
  });

  it('a phone or window on a remote row of the group writes for the whole group, and a refused mark writes nothing', async () => {
    const a = desktop(A), b = desktop(B);
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await vi.waitFor(() => expect(b.links.groups()).toHaveLength(1));
    clock += 1000;
    b.apply({ type: 'setPinned', projectId: remote(A, 'site'), pinned: true });
    await vi.waitFor(() => expect(a.state.pinnedProjectIds).toContain('site'));
    const before = a.linked.records();
    a.apply({ type: 'setInactive', projectId: 'site', inactive: true, at: clock });
    await a.service.settled();
    expect(a.linked.records()).toEqual(before);
    expect(a.state.inactiveProjectIds).toEqual([]);
  });

  it('folds values from before sharing as pinned if any and inactive only if all when copies are linked', async () => {
    const a = desktop(A, { pinnedProjectIds: ['site'], inactiveProjectIds: ['site', 'docs'] });
    const b = desktop(B, { inactiveProjectIds: ['docs-b'] });
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await a.links.apply({ type: 'link', a: 'docs', b: remote(B, 'docs-b') });
    await vi.waitFor(() => {
      expect(b.state.pinnedProjectIds).toEqual(expect.arrayContaining([remote(A, 'site'), 'site-b']));
      // `site` was inactive only on A: not every copy, so not inactive.
      expect(a.state.inactiveProjectIds).not.toContain('site');
      expect(b.state.inactiveProjectIds).not.toContain('site-b');
      // `docs` was inactive on both.
      expect(b.state.inactiveProjectIds).toEqual(expect.arrayContaining(['docs-b', remote(A, 'docs')]));
    });
  });

  it('keeps this computer\'s own Mark inactive from before linking when the group shows active, and unlink brings it back', async () => {
    const a = desktop(A, { inactiveProjectIds: ['site'] }), b = desktop(B);
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    // Inactive only if every copy is: B's isn't, so the group shows active on both.
    await vi.waitFor(() => expect(b.linked.records()).toHaveLength(4));
    await a.service.settled(); await b.service.settled();
    expect(a.state.inactiveProjectIds).not.toContain('site');
    expect(b.state.inactiveProjectIds).toEqual([]);
    // The reprojection is offered again at clock zero; A's own saved mark survives it.
    const own = () => a.linked.records().find((r) => r.project.machine === A && r.field === 'inactive');
    expect(own()).toEqual({ project: { machine: A, projectId: 'site' }, field: 'inactive', value: true, at: 0, by: A });
    await a.links.apply({ type: 'unlink', a: 'site' });
    await vi.waitFor(() => expect(a.state.inactiveProjectIds).toContain('site'));
    await b.service.settled();
    expect(b.state.inactiveProjectIds).toEqual([]);
  });

  it('a Mark active after unlinking holds over the mark from before sharing', async () => {
    const a = desktop(A, { inactiveProjectIds: ['site'] }), b = desktop(B);
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await vi.waitFor(() => expect(a.linked.records().length).toBeGreaterThanOrEqual(2));
    await a.service.settled();
    await a.links.apply({ type: 'unlink', a: 'site' });
    await vi.waitFor(() => expect(a.state.inactiveProjectIds).toContain('site'));
    clock += 1000;
    a.apply({ type: 'setInactive', projectId: 'site', inactive: false, at: clock });
    await a.service.settled();
    await new Promise((r) => setTimeout(r, 20));
    await a.service.settled();
    expect(a.state.inactiveProjectIds).toEqual([]);
  });

  it('a third copy joining a group with an explicit value keeps it after a split, not its mark from before sharing', async () => {
    const a = desktop(A), b = desktop(B), c = desktop(C, { inactiveProjectIds: ['site-c'] });
    net = mesh(a, b, c);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await vi.waitFor(() => expect(b.links.groups()).toHaveLength(1));
    clock += 1000;
    a.apply({ type: 'setInactive', projectId: 'site', inactive: false, at: clock });
    await vi.waitFor(() => expect(b.linked.records().filter((r) => r.field === 'inactive' && r.at > 0)).toHaveLength(2));
    await b.links.apply({ type: 'link', a: 'site-b', b: remote(C, 'site-c') });
    await vi.waitFor(() => {
      expect(c.links.groups()[0]).toHaveLength(3);
      expect(c.state.inactiveProjectIds).not.toContain('site-c');
    });
    await c.service.settled();
    await c.links.apply({ type: 'split', a: 'site-c' });
    await vi.waitFor(() => expect(c.links.groups()).toEqual([]));
    await c.service.settled();
    await new Promise((r) => setTimeout(r, 20));
    await c.service.settled();
    expect(c.state.inactiveProjectIds).not.toContain('site-c');
  });

  it('Mark active records that moment as activity on every copy', async () => {
    const a = desktop(A), b = desktop(B, { projectActivity: { 'site-b': clock - 30 * 86_400_000 } });
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    clock += 1000;
    b.apply({ type: 'setInactive', projectId: 'site-b', inactive: true, at: clock });
    await vi.waitFor(() => expect(a.state.inactiveProjectIds).toContain('site'));
    clock += 1000;
    const markedAt = clock;
    a.apply({ type: 'setInactive', projectId: 'site', inactive: false, at: markedAt });
    await vi.waitFor(() => {
      expect(b.state.inactiveProjectIds).toEqual([]);
      expect(b.state.projectActivity['site-b']).toBe(markedAt);
    });
  });

  it('an offline computer catches up on reconnect; its own newer offline edit wins everywhere', async () => {
    const a = desktop(A), b = desktop(B), c = desktop(C);
    net = mesh(a, b, c);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await a.links.apply({ type: 'link', a: 'site', b: remote(C, 'site-c') });
    await vi.waitFor(() => expect(c.links.groups()[0]).toHaveLength(3));
    net.offline(c);
    clock += 1000;
    a.apply({ type: 'setInactive', projectId: 'site', inactive: true, at: clock });
    await vi.waitFor(() => expect(b.state.inactiveProjectIds).toContain('site-b'));
    // C, still offline, applies locally at once; no claim it reached anyone else.
    clock += 1000;
    c.apply({ type: 'setPinned', projectId: 'site-c', pinned: true });
    expect(c.state.pinnedProjectIds).toContain('site-c');
    expect(a.state.pinnedProjectIds).toEqual([]);
    net.online(c);
    await vi.waitFor(() => {
      // C learns of the mark it missed, then its newer pin (which clears inactive) wins on all three.
      for (const d of [a, b, c]) expect(d.state.pinnedProjectIds).toHaveLength(3);
      for (const d of [a, b, c]) expect(d.state.inactiveProjectIds).toEqual([]);
    });
  });

  it('an offline computer\'s older edit loses to a newer one made meanwhile', async () => {
    const a = desktop(A), b = desktop(B);
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await vi.waitFor(() => expect(b.links.groups()).toHaveLength(1));
    net.offline(b);
    clock += 1000;
    b.apply({ type: 'setPinned', projectId: 'site-b', pinned: true });
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: false });
    net.online(b);
    await vi.waitFor(() => expect(b.state.pinnedProjectIds).toEqual([]));
    expect(a.state.pinnedProjectIds).toEqual([]);
  });

  it('a third copy joining takes the group value, and a split keeps it on each copy', async () => {
    const a = desktop(A), b = desktop(B), c = desktop(C, { inactiveProjectIds: ['site-c'] });
    net = mesh(a, b, c);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    await vi.waitFor(() => expect(b.state.pinnedProjectIds).toContain('site-b'));
    await b.links.apply({ type: 'link', a: 'site-b', b: remote(C, 'site-c') });
    await vi.waitFor(() => {
      expect(c.state.pinnedProjectIds).toContain('site-c');
      // The explicit pin also cleared inactive on every copy then in the group; C's old mark loses.
      expect(c.state.inactiveProjectIds).not.toContain('site-c');
    });
    await c.links.apply({ type: 'split', a: 'site-c' });
    await vi.waitFor(() => expect(a.links.groups()).toEqual([]));
    await a.service.settled(); await c.service.settled();
    // Nothing restored: each copy keeps the shared pin, and later edits stay on their own copy.
    expect(c.state.pinnedProjectIds).toContain('site-c');
    expect(a.state.pinnedProjectIds).toContain('site');
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: false });
    await a.service.settled(); await b.service.settled();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.state.pinnedProjectIds).toContain('site-b');
  });

  it('leaves unlinked projects to each computer, exactly as before', async () => {
    const a = desktop(A, { pinnedProjectIds: ['solo'] }), b = desktop(B, { pinnedProjectIds: [remote(A, 'other')] });
    net = mesh(a, b);
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'other', pinned: true });
    a.apply({ type: 'setInactive', projectId: 'idle', inactive: true, at: clock });
    await a.service.settled();
    await new Promise((r) => setTimeout(r, 20));
    await b.service.settled();
    expect(a.state.pinnedProjectIds).toEqual(['solo', 'other']);
    expect(b.state).toEqual({ ...DEFAULT_PROJECT_STATE, pinnedProjectIds: [remote(A, 'other')] });
    expect(a.service.isLinked('solo')).toBe(false);
  });

  it('removing a project here keeps the group\'s value for the other copies, and stays removed here', async () => {
    const gone = new Set<string>();
    const a = desktop(A, {}, { listed: (ref) => !(ref.machine === A && gone.has(ref.projectId)) }), b = desktop(B);
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    await vi.waitFor(() => expect(b.state.pinnedProjectIds).toContain('site-b'));
    gone.add('site');
    a.listedChanged();
    a.apply({ type: 'forget', projectIds: ['site'] });
    await a.service.settled(); await b.service.settled();
    expect(a.state.pinnedProjectIds).not.toContain('site');
    // Another change to the group doesn't bring it back here.
    clock += 1000;
    b.apply({ type: 'setInactive', projectId: 'site-b', inactive: false, at: clock });
    a.apply({ type: 'setPinned', projectId: remote(B, 'site-b'), pinned: true });
    await a.service.settled();
    expect(a.state.pinnedProjectIds).not.toContain('site');
    expect(b.state.pinnedProjectIds).toContain('site-b');
    expect(a.linked.records().some((r) => r.project.projectId === 'site' && r.field === 'pinned' && r.value)).toBe(true);
  });

  it('a machine leaving takes its rows with it here, and they stay gone', async () => {
    const paired = new Set([B]);
    const a = desktop(A, {}, { listed: (ref) => ref.machine === A || paired.has(ref.machine) }), b = desktop(B);
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    await vi.waitFor(() => expect(a.state.pinnedProjectIds).toContain(remote(B, 'site-b')));
    // Unpairing: the renderer forgets the machine's rows (forgetProjectsWithPrefix).
    paired.delete(B);
    a.listedChanged();
    a.apply({ type: 'forget', projectIds: [remote(B, 'site-b')] });
    await a.service.settled();
    clock += 1000;
    a.apply({ type: 'setPinned', projectId: 'site', pinned: false });
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    await a.service.settled();
    expect(a.state.pinnedProjectIds).toEqual(['site']);
  });

  it('back-to-back edits while a save is slow end as the last one, in the same millisecond too', async () => {
    let release: () => void = () => {};
    let gate = Promise.resolve();
    const a = desktop(A, {}, { save: () => gate });
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await a.service.settled();
    gate = new Promise((r) => { release = r; });
    // Two windows, a double toggle, or a phone retry: pin then unpin, no time passing.
    a.apply({ type: 'setPinned', projectId: 'site', pinned: true });
    a.apply({ type: 'setPinned', projectId: 'site', pinned: false });
    release();
    await a.service.settled();
    const pins = a.linked.records().filter((r) => r.field === 'pinned');
    expect(pins.map((r) => r.value)).toEqual([false, false]);
    expect(new Set(pins.map((r) => r.at)).size).toBe(1);
    expect(a.state.pinnedProjectIds).toEqual([]);
  });

  it('Mark active on a group idle only by time, or an unlinked project, shares no activity', async () => {
    const old = clock - 30 * 86_400_000;
    const a = desktop(A, { projectActivity: { site: old, solo: old } }), b = desktop(B, { projectActivity: { 'site-b': old } });
    net = mesh(a, b);
    await a.links.apply({ type: 'link', a: 'site', b: remote(B, 'site-b') });
    await vi.waitFor(() => expect(b.links.groups()).toHaveLength(1));
    clock += 1000;
    a.apply({ type: 'setInactive', projectId: 'site', inactive: false, at: clock });
    a.apply({ type: 'setInactive', projectId: 'solo', inactive: false, at: clock });
    await a.service.settled();
    await new Promise((r) => setTimeout(r, 20));
    await b.service.settled();
    expect(a.linked.records().some((r) => r.field === 'activated')).toBe(false);
    expect(b.state.projectActivity['site-b']).toBe(old);
  });
});
