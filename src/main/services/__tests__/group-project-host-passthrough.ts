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
    return undefined;
  }
}

export async function passthroughHostModule() {
  const registryModule = await import('../group-project-registry');
  const bulletin = await import('../group-project-bulletin');
  const registry = registryModule.groupProjectRegistry as unknown as Record<string, (...args: unknown[]) => unknown>;
  const inbox = (name: string) => optional<(name: string) => string>(bulletin, 'inboxChannelName')?.(name) ?? `inbox-${name.toLowerCase()}`;
  const board = (id: string) => bulletin.getBulletinBoard(id) as unknown as Record<string, (...args: unknown[]) => unknown>;
  const groupProjectHost = {
    selfMachine: vi.fn(() => null),
    isThisMachine: vi.fn(() => true),
    list: vi.fn(async () => registry.list()),
    get: vi.fn(async (id: string) => registry.get(id)),
    create: vi.fn(async (name: string, options?: unknown) => registry.create(name, options)),
    update: vi.fn(async (id: string, fields: unknown) => registry.update(id, fields)),
    delete: vi.fn(async (id: string) => {
      const deleted = await registry.delete(id);
      const destroy = optional<(id: string) => Promise<void>>(bulletin, 'destroyBulletinBoard');
      if (deleted && destroy) await destroy(id);
      return { deleted: !!deleted };
    }),
    exclusive: vi.fn(async (id: string, fn: (c: unknown) => unknown) => fn({ project: await registry.get(id), seq: 0 })),
    getMembership: vi.fn(async () => ({ version: 1, autoJoin: false, explicit: [], excluded: [] })),
    updateMembership: vi.fn(async () => ({ membership: { version: 1, autoJoin: false, explicit: [], excluded: [] }, seq: 0 })),
    setMemberResolver: vi.fn(),
    resolveMembers: vi.fn(async () => []),
    listTombstones: vi.fn(async () => []),
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
    onChange: vi.fn(() => () => undefined),
  };
  return { groupProjectHost, GroupProjectHostError: class extends Error {} };
}
