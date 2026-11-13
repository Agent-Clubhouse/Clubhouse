/**
 * Test double for group-project-host: forwards each host write to the
 * registry and board modules, so a caller's tests that mock those stores keep
 * asserting on them. The real host is covered by group-project-host.test.ts.
 *
 *   vi.mock('./group-project-host', async () =>
 *     (await import('./__tests__/group-project-host-passthrough')).passthroughHostModule());
 */
import { vi } from 'vitest';

/** A mocked module throws on exports its factory didn't define. */
function optional<T>(mod: object, name: string): T | undefined {
  try {
    return (mod as Record<string, T>)[name];
  } catch {
    // telemetry-exempt: test double
    return undefined;
  }
}

export async function passthroughHostModule() {
  const registryModule = await import('../group-project-registry');
  const bulletin = await import('../group-project-bulletin');
  const registry = registryModule.groupProjectRegistry as unknown as Record<string, (...args: unknown[]) => unknown>;
  const inbox = (name: string) => optional<(name: string) => string>(bulletin, 'inboxChannelName')?.(name) ?? `inbox-${name.toLowerCase()}`;
  const board = (id: string) => bulletin.getBulletinBoard(id) as unknown as Record<string, (...args: unknown[]) => unknown>;
  // Membership records, kept in memory so membership policy (#3357) can be exercised.
  type Membership = { version: 1; autoJoin: boolean; explicit: unknown[]; excluded: unknown[]; [extra: string]: unknown };
  const memberships = new Map<string, Membership>();
  const membershipOf = (id: string): Membership => structuredClone(memberships.get(id) ?? { version: 1, autoJoin: false, explicit: [], excluded: [] });
  const listeners = new Set<(change: unknown) => void>();
  const groupProjectHost = {
    _resetForTesting: vi.fn(() => { memberships.clear(); }),
    selfMachine: vi.fn(() => null),
    isThisMachine: vi.fn(() => true),
    // Everything is on this machine: addresses are bare agent ids (#3363).
    memberAddress: vi.fn((_project: unknown, agentId: string) => agentId),
    localAgentId: vi.fn((_project: unknown, address: string) => address),
    list: vi.fn(async () => registry.list()),
    get: vi.fn(async (id: string) => registry.get(id)),
    create: vi.fn(async (name: string, options?: unknown) => {
      const project = await registry.create(name, options) as { id: string };
      await optional<(id: string) => Promise<void>>(bulletin, 'ensureProjectChannels')?.(project.id);
      return project;
    }),
    update: vi.fn(async (id: string, fields: unknown) => registry.update(id, fields)),
    delete: vi.fn(async (id: string) => {
      const project = await registry.get(id);
      const deleted = await registry.delete(id);
      if (deleted && project) for (const listener of listeners) listener({ groupProjectId: id, seq: 0, part: 'deleted', project });
      const destroy = optional<(id: string) => Promise<void>>(bulletin, 'destroyBulletinBoard');
      if (deleted && destroy) await destroy(id);
      return { deleted: !!deleted };
    }),
    exclusive: vi.fn(async (id: string, fn: (c: unknown) => unknown) => fn({ project: await registry.get(id), seq: 0 })),
    getMembership: vi.fn(async (id: string) => membershipOf(id)),
    updateMembership: vi.fn(async (id: string, fn: (draft: Membership) => Membership | void) => {
      const draft = membershipOf(id);
      const next: Membership = fn(draft) || draft;
      memberships.set(id, structuredClone(next));
      return { membership: structuredClone(next), seq: 0 };
    }),
    setMemberResolver: vi.fn(),
    resolveMembers: vi.fn(async () => []),
    listTombstones: vi.fn(async () => []),
    listPendingDeletes: vi.fn(async () => []),
    scopeOptions: vi.fn(() => ({ network: { available: false, reason: 'Network reach needs Annex Network.' } })),
    previewScope: vi.fn(async (_id: string, scope: unknown) => ({ scope, leaving: [] })),
    setScope: vi.fn(async (id: string) => ({ project: await registry.get(id), left: [] })),
    admits: vi.fn(async () => true),
    setNetworkLink: vi.fn(),
    setRemoteWriteGate: vi.fn(),
    isReplica: vi.fn(() => false),
    hostNameOf: vi.fn(() => 'This computer'),
    addressOf: vi.fn((_project: unknown, reference: string) => reference),
    syncFrom: vi.fn(async () => undefined),
    flushOutbox: vi.fn(async () => undefined),
    networkSnapshot: vi.fn(async () => ({ v: 1, projects: [], unchanged: [], tombstones: [] })),
    applyRemoteWrites: vi.fn(async () => ({ v: 1, results: [] })),
    machineRemoved: vi.fn(async () => undefined),
    dismissRefusals: vi.fn(async () => undefined),
    removedGroupProjectIds: vi.fn(async () => []),
    pendingViewPurges: vi.fn(async () => []),
    markViewsPurged: vi.fn(async () => undefined),
    inScope: vi.fn(async () => true),
    excludeOutOfScope: vi.fn(async () => undefined),
    outOfScopeMessage: vi.fn((project: { name: string }, agentName: string) => `${agentName} is outside the scope of "${project.name}", so it can't join. Widen the scope in Settings > Group Projects first.`),
    recordScopedWireMembers: vi.fn(async () => 0),
    beginDelete: vi.fn(async (id: string) => ({ groupProjectId: id, host: { machine: null }, seq: 0, deletedAt: new Date(0).toISOString(), state: 'deleting' })),
    finishDelete: vi.fn(async (id: string) => {
      await registry.delete(id);
      return { groupProjectId: id, host: { machine: null }, seq: 0, deletedAt: new Date(0).toISOString(), state: 'deleted' };
    }),
    exclusivePending: vi.fn(async (id: string, fn: (t: unknown) => unknown) => fn({ groupProjectId: id, host: { machine: null }, seq: 0, deletedAt: new Date(0).toISOString(), state: 'deleting' })),
    digest: vi.fn(async (id: string) => board(id).getDigest()),
    readDigest: vi.fn(async (id: string, since?: unknown, channels?: unknown) => (channels === undefined ? board(id).getDigest(since) : board(id).getDigest(since, channels))),
    readTopic: vi.fn(async (id: string, topic: string, since?: string, limit?: number) => board(id).getTopicMessages(topic, since, limit)),
    readAll: vi.fn(async (id: string, since?: string, limit?: number) => board(id).getAllMessages(since, limit)),
    getMessage: vi.fn(async (id: string, messageId: string) => board(id).getMessageById(messageId)),
    estimateTrim: vi.fn(async (id: string, maxPerTopic: number, maxTotal: number) => board(id).estimateTrimCount(maxPerTopic, maxTotal)),
    post: vi.fn(async (id: string, sender: string, topic: string, body: string) => board(id).postMessage(sender, topic, body)),
    deleteMessage: vi.fn(async (id: string, topic: string, messageId: string) => board(id).deleteMessage(topic, messageId)),
    deleteTopic: vi.fn(async (id: string, topic: string) => board(id).deleteTopic(topic)),
    setTopicProtected: vi.fn(async (id: string, topic: string, value: boolean) => { board(id).setTopicProtected(topic, value); }),
    clearAll: vi.fn(async (id: string) => board(id).clearAll()),
    setRetention: vi.fn(async (id: string, maxPerTopic: number, maxTotal: number) => {
      await registry.update(id, { metadata: { maxPerTopic, maxTotal } });
      board(id).setLimits(maxPerTopic, maxTotal);
      return board(id).trimToLimits();
    }),
    ensureChannels: vi.fn(async (id: string) => optional<(id: string) => Promise<void>>(bulletin, 'ensureProjectChannels')?.(id)),
    ensureInbox: vi.fn(async (id: string, name: string): Promise<string> => (await optional<(id: string, name: string) => Promise<string>>(bulletin, 'ensureInboxChannel')?.(id, name)) ?? inbox(name)),
    inboxFor: vi.fn(async (_id: string, name: string) => inbox(name)),
    flushRegistry: vi.fn(async () => registry.flush()),
    flushBoards: vi.fn(async () => optional<() => Promise<void>>(bulletin, 'flushAllBulletinBoards')?.()),
    onChange: vi.fn((listener: (change: unknown) => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  };
  return { groupProjectHost, GroupProjectHostError: class extends Error {} };
}
