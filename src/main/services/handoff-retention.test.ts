import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { isTerminalHandoff, parseHandoff, type Handoff, type HandoffAgent } from '../../shared/handoffs';
import { HandoffCoordinator, type HandoffCancellation } from './handoff-coordinator';
import { HANDOFF_OFFER_TTL_MS, HandoffService } from './handoff-service';
import { assertHandoffExtension, type HandoffStorage } from './handoff-store';
const a: HandoffAgent = { agentId: 'sender', machine: Array(16).fill('ab').join(':') };
const b: HandoffAgent = { agentId: 'receiver', machine: Array(16).fill('cd').join(':') };
const input = { to: b, mode: 'worktree' as const, task: { title: 'Task', brief: 'Continue' } };
function fixture() {
  let now = Date.now(); let online = true; let outgoing = true; let receiverAllows = true; let brokenTransport = false; let removed = false; let outboxGate: Promise<void> | undefined; let outboxMarked: (() => void) | undefined;
  const computers = new Map<string, { coordinator: HandoffCoordinator }>();
  const posts: unknown[] = [];
  function computer(machine: string) {
    const records = new Map<string, Handoff>(); const commands: HandoffCancellation[] = []; const undelivered = new Set<string>(); const acknowledgements = new Map<string, number>();
    const store: HandoffStorage = {
      get: (id) => records.has(id) ? structuredClone(records.get(id)!) : undefined, list: () => structuredClone([...records.values()]),
      prune: async (ids) => { for (const id of ids) records.delete(id); },
      transact: async (id, change) => {
        const current = records.get(id); const next = parseHandoff(await change(current && structuredClone(current)));
        if (current) assertHandoffExtension(current, next); else if (records.size >= 1000) throw new Error('Store full');
        records.set(id, structuredClone(next)); return next;
      },
    };
    const journal = {
      list: () => structuredClone(commands), put: async (command: HandoffCancellation) => { commands.push(command); },
      remove: async (id: string) => { const index = commands.findIndex((entry) => entry.operationId === id); if (index >= 0) commands.splice(index, 1); },
      markUndelivered: async (id: string) => { undelivered.add(id); outboxMarked?.(); await outboxGate; }, markAttempted: async (id: string) => { undelivered.delete(id); }, isUndelivered: (id: string) => undelivered.has(id),
      acknowledge: async (id: string, version: number) => { acknowledgements.set(id, version); }, acknowledged: (id: string) => acknowledgements.get(id),
      prune: async (retained: ReadonlySet<string>) => { for (const id of acknowledgements.keys()) if (!retained.has(id)) acknowledgements.delete(id); for (const id of undelivered) if (!retained.has(id)) undelivered.delete(id); },
    };
    const service = new HandoffService({ machine, store, now: () => now, authorize: async () => machine !== b.machine || receiverAllows, isDispatcher: (actor) => actor.agentId === 'dispatcher' });
    const makeCoordinator = () => new HandoffCoordinator({ machine, store, service, commands: journal, now: () => now, peerRemoved: () => removed, connected: () => online, authorizeOutgoing: async () => outgoing,
      post: async (peer, body) => { posts.push(body); if (brokenTransport) throw new Error('Unknown delivery'); return computers.get(peer)!.coordinator.receive(machine, body); } });
    const result = { store, service, coordinator: makeCoordinator(), commands, acknowledgements, undelivered, restart: () => { result.coordinator = makeCoordinator(); } };
    computers.set(machine, result); return result;
  }
  const sender = computer(a.machine); const receiver = computer(b.machine);
  return { sender, receiver, computer, posts, advance: () => { now += HANDOFF_OFFER_TTL_MS + 1; }, offline: () => { online = false; }, online: () => { online = true; }, revoke: () => { outgoing = false; }, refuse: () => { receiverAllows = false; }, breakTransport: () => { brokenTransport = true; }, removePeer: () => { removed = true; }, holdOutbox: () => { let release!: () => void; outboxGate = new Promise<void>((resolve) => { release = resolve; }); const marked = new Promise<void>((resolve) => { outboxMarked = resolve; }); return { release, marked }; } };
}
describe('handoff refusal, expiry and bounded retention', () => {
  it('settles an explicitly refused receiver offer locally, without storing or endlessly retrying it', async () => {
    const f = fixture(); f.refuse();
    const record = await f.sender.coordinator.offer(input, a);
    expect(record).toMatchObject({ state: 'failed', failure: { code: 'refused' } });
    expect(f.receiver.store.list()).toEqual([]);
    await f.sender.coordinator.flush(); f.sender.restart(); await f.sender.coordinator.flush();
    expect(f.posts).toHaveLength(1); expect(f.sender.commands).toEqual([]);
  });
  it('cancels directly after grant revocation, without re-offering or requiring the old grant', async () => {
    const f = fixture(); const record = await f.sender.coordinator.offer(input, a); f.offline();
    await f.sender.coordinator.cancel(record.id, a); f.revoke(); f.online();
    await f.sender.coordinator.flush();
    expect(f.sender.store.get(record.id)?.state).toBe('cancelled'); expect(f.receiver.store.get(record.id)?.state).toBe('cancelled');
    expect(f.sender.commands).toEqual([]); expect(f.posts).toEqual([expect.objectContaining({ op: 'offer' }), expect.objectContaining({ op: 'cancel' })]);
  });
  it('expires offers at the receiver and refuses acceptance after TTL', async () => {
    const f = fixture(); const record = await f.sender.coordinator.offer(input, a); f.advance();
    await expect(f.receiver.coordinator.respond(record.id, b, true)).rejects.toThrow();
    expect(f.receiver.store.get(record.id)).toMatchObject({ state: 'failed', failure: { code: 'expired' } });
    await f.receiver.coordinator.flush();
    expect(f.sender.store.get(record.id)?.failure?.code).toBe('expired');
  });
  it('locally cancels only an expired outbox entry known never to have attempted delivery, across restart', async () => {
    const f = fixture(); f.offline(); const record = await f.sender.coordinator.offer(input, a); f.advance(); f.sender.restart();
    await f.sender.coordinator.flush(); expect(f.sender.store.get(record.id)?.state).toBe('cancelled'); expect(f.posts).toEqual([]);
    const uncertain = fixture(); uncertain.breakTransport(); const pending = await uncertain.sender.coordinator.offer(input, a); uncertain.advance(); uncertain.offline();
    await uncertain.sender.coordinator.flush(); expect(uncertain.sender.store.get(pending.id)?.state).toBe('offered'); expect(uncertain.sender.commands).toHaveLength(1);
  });
  it('returns an expired refusal for an old offer that was never admitted, and enforces a per-peer active quota', async () => {
    const f = fixture(); f.offline(); const old = await f.sender.coordinator.offer(input, a); f.advance();
    expect(await f.receiver.coordinator.receive(a.machine, { op: 'offer', record: old })).toMatchObject({ kind: 'refused', record: { failure: { code: 'expired' } } });
    f.online();
    for (let index = 0; index < 64; index++) expect((await f.sender.coordinator.offer(input, a)).state).toBe('offered');
    expect((await f.sender.coordinator.offer(input, a)).failure?.code).toBe('refused');
    expect(f.receiver.store.list().filter((record) => !isTerminalHandoff(record.state))).toHaveLength(64);
    const other = { agentId: 'other', machine: Array(16).fill('ef').join(':') }; const computer = f.computer(other.machine);
    expect((await computer.coordinator.offer(input, other)).state).toBe('offered');
  });
  it('prunes acknowledged terminal history and its journal before 1000 completed handoffs can exhaust the store', async () => {
    const f = fixture(); const local = { ...b, machine: a.machine };
    for (let index = 0; index < 1100; index++) {
      const record = await f.sender.coordinator.offer({ ...input, to: local }, a);
      await f.sender.coordinator.cancel(record.id, a);
    }
    await f.sender.coordinator.flush();
    expect(f.sender.store.list()).toHaveLength(200); expect(f.sender.commands).toEqual([]); expect(f.sender.undelivered.size).toBeLessThanOrEqual(200);
    f.advance(); f.advance(); f.advance(); f.advance(); f.advance(); f.advance(); f.advance();
    await f.sender.coordinator.flush(); expect(f.sender.store.list()).toEqual([]);
  }, 30_000);
});


it('acknowledges a retired terminal snapshot without resurrecting its record or notice', async () => {
  const f = fixture(); const record = await f.sender.coordinator.offer(input, a);
  const terminal = await f.sender.coordinator.cancel(record.id, a);
  await f.sender.store.prune!(new Set([record.id]));
  expect(await f.sender.coordinator.receive(b.machine, { op: 'snapshot', record: terminal })).toEqual(terminal);
  expect(f.sender.store.get(record.id)).toBeUndefined();
  await f.receiver.coordinator.flush(); expect(f.receiver.acknowledgements.get(record.id)).toBe(terminal.version);
});


it('cancels a never-attempted offer locally after revocation without posting any brief', async () => {
  const f = fixture(); f.offline(); const record = await f.sender.coordinator.offer(input, a); f.revoke();
  expect((await f.sender.coordinator.cancel(record.id, a)).state).toBe('cancelled');
  f.online(); await f.sender.coordinator.flush();
  expect(f.posts).toEqual([]); expect(f.sender.commands).toEqual([]); expect(f.receiver.store.list()).toEqual([]);
});
it.each(['authorization', 'expired', 'future'] as const)('refuses an unadmitted cancellation with the same %s admission gate as an offer', async (cause) => {
  const f = fixture(); f.offline(); const original = await f.sender.coordinator.offer(input, a);
  if (cause === 'authorization') f.refuse();
  if (cause === 'expired') f.advance();
  const record = cause === 'future' ? { ...original, createdAt: original.createdAt + 10 * 60_000, updatedAt: original.updatedAt + 10 * 60_000,
    history: original.history.map((event) => ({ ...event, at: event.at + 10 * 60_000 })) } : original;
  expect(await f.receiver.coordinator.receive(a.machine, { op: 'cancel', record, command: { id: record.id, operationId: randomUUID(), from: a } })).toMatchObject({ kind: 'refused', record: { state: 'failed', failure: { code: cause === 'expired' ? 'expired' : 'refused' } } });
  expect(f.receiver.store.list()).toEqual([]);
});
it('prunes removed-peer terminal decisions even without an acknowledgement', async () => {
  const f = fixture(); const record = await f.sender.coordinator.offer(input, a); f.offline();
  await f.receiver.coordinator.respond(record.id, b, false);
  expect(f.receiver.acknowledgements.get(record.id)).toBeUndefined();
  await f.receiver.coordinator.flush(); expect(f.receiver.store.get(record.id)?.state).toBe('declined');
  f.removePeer(); await f.receiver.coordinator.flush(); expect(f.receiver.store.get(record.id)).toBeUndefined();
});


it('keeps delivery proof during concurrent pruning before an offer becomes visible', async () => {
  const f = fixture(); f.offline(); const gate = f.holdOutbox();
  const offering = f.sender.coordinator.offer(input, a); await gate.marked;
  expect(f.sender.store.list()).toEqual([]);
  await f.sender.coordinator.flush(); gate.release();
  const record = await offering; expect(f.sender.undelivered.has(record.id)).toBe(true);
  f.revoke(); expect((await f.sender.coordinator.cancel(record.id, a)).state).toBe('cancelled');
  f.online(); await f.sender.coordinator.flush(); expect(f.posts).toEqual([]); expect(f.receiver.store.list()).toEqual([]);
});


it('settles and prunes attempted outgoing offers when their receiving peer is permanently removed', async () => {
  const f = fixture(); f.breakTransport();
  const record = await f.sender.coordinator.offer(input, a);
  expect(f.posts).toHaveLength(1); expect(f.sender.undelivered.has(record.id)).toBe(false);
  f.offline(); f.advance(); await f.sender.coordinator.flush();
  expect(f.sender.store.get(record.id)?.state).toBe('offered'); expect(f.sender.commands).toHaveLength(1);
  f.removePeer(); await f.sender.coordinator.flush();
  expect(f.sender.store.list()).toEqual([]); expect(f.sender.commands).toEqual([]);
  expect(f.posts).toHaveLength(1);
  f.sender.restart(); await f.sender.coordinator.flush();
  expect(f.sender.store.list()).toEqual([]); expect(f.posts).toHaveLength(1);
});
