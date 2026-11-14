import { describe, expect, it, vi } from 'vitest';
import { ProjectLinksStore } from './project-links-store';
import { receiveProjectLinks, startProjectLinksNetwork, projectLinksCapabilities, type ProjectLinksNetworkOptions } from './project-links-network';
import { PROJECT_LINKS_CAPABILITIES_PATH, PROJECT_LINKS_SYNC_PATH } from '../../shared/project-links';
const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':');
const remote = `remote||${B}||copy`;
function store(self = A) {
  return new ProjectLinksStore({ read: () => ({ version: 1, records: [], migrated: [] }), save: async () => {}, self: () => self, legacyMirror: () => undefined, now: () => 10 });
}
function network(local: ProjectLinksStore, peer: ProjectLinksStore) {
  let connected = true, member = true, pin = 'pin';
  let onConnected = (_machine: string) => {}, onMembers = () => {};
  const post = vi.fn(async (_machine: string, path: string, body: Record<string, unknown>) => ({ status: 200, body: path === PROJECT_LINKS_CAPABILITIES_PATH ? projectLinksCapabilities() : await receiveProjectLinks(A, body, () => true, peer) }));
  const options: ProjectLinksNetworkOptions = {
    store: local, members: () => member ? [B] : [], isMember: () => member, pairing: () => pin,
    transport: { connected: () => connected, post, onConnected: (fn) => { onConnected = fn; return () => {}; } },
    onMembershipChanged: (fn) => { onMembers = fn; return () => {}; },
  };
  return { options, post, reconnect: () => { connected = true; onConnected(B); }, disconnect: () => { connected = false; }, repin: () => { pin += 'x'; onMembers(); }, remove: () => { member = false; onMembers(); } };
}
describe('project links pinned-member REST replication', () => {
  it('pushes changes, pulls on connect/reconnect, and stale offline links cannot resurrect a removal', async () => {
    const local = store(), peer = store(B);
    await local.migrate(); await peer.migrate();
    await local.apply({ type: 'link', a: 'site', b: remote });
    const f = network(local, peer), stop = startProjectLinksNetwork(f.options);
    try {
      await vi.waitFor(() => expect(peer.groups()).toEqual(local.groups()));
      f.disconnect();
      await peer.apply({ type: 'unlink', a: 'copy' });
      expect(local.groups()).toHaveLength(1);
      f.reconnect();
      await vi.waitFor(() => expect(local.groups()).toEqual([]));
      expect(peer.groups()).toEqual([]);
      expect(f.post.mock.calls.filter((c) => c[1] === PROJECT_LINKS_CAPABILITIES_PATH)).toHaveLength(2);
      await local.apply({ type: 'link', a: 'site', b: remote });
      await vi.waitFor(() => expect(peer.groups()).toHaveLength(1));
    } finally { stop(); }
  });
  it('skips older peers after a capability probe and probes again on reconnect', async () => {
    const f = network(store(), store(B));
    f.post.mockImplementation(async () => ({ status: 404, body: {} }));
    const stop = startProjectLinksNetwork(f.options);
    try {
      await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
      expect(f.post.mock.calls[0][1]).toBe(PROJECT_LINKS_CAPABILITIES_PATH);
      f.reconnect();
      await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
    } finally { stop(); }
  });
  it('invalidates a capability response from an old connection and catches up on the new one', async () => {
    const f = network(store(), store(B));
    let finish!: (r: { status: number; body: unknown }) => void;
    f.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stop = startProjectLinksNetwork(f.options);
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      f.reconnect(); finish({ status: 404, body: {} });
      await vi.waitFor(() => expect(f.post.mock.calls.some((c) => c[1] === PROJECT_LINKS_SYNC_PATH)).toBe(true));
    } finally { stop(); }
  });
  it('paginates the full set and preserves Keep separate tombstones', async () => {
    const local = store(), peer = store(B);
    await peer.migrate();
    for (let i = 0; i < 205; i++) await peer.apply({ type: 'keepSeparate', a: `left-${i}`, b: `right-${i}` });
    const f = network(local, peer), stop = startProjectLinksNetwork(f.options);
    try {
      await vi.waitFor(() => expect(local.records()).toHaveLength(205));
      expect(local.records().every((r) => !r.linked)).toBe(true);
      const pulls = f.post.mock.calls.filter((c) => c[1] === PROJECT_LINKS_SYNC_PATH && !c[2].records);
      expect(pulls).toHaveLength(2);
      expect(pulls[1][2].after).toBeTypeOf('string');
    } finally { stop(); }
  });
  it('rejects malformed/oversized requests and publications after unpairing', async () => {
    const replica = store();
    await expect(receiveProjectLinks(B, { version: 2 }, () => true, replica)).rejects.toThrow();
    await expect(receiveProjectLinks(B, { version: 1, records: Array(201).fill({}) }, () => true, replica)).rejects.toThrow();
    await expect(receiveProjectLinks(B, { version: 1 }, () => false, replica)).rejects.toThrow('pairing changed');
    expect(replica.records()).toEqual([]);
  });
});
