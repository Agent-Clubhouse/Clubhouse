import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, HandoffAgent, HandoffOffer } from '../../shared/handoffs';
import { parseHandoff, transitionHandoff } from '../../shared/handoffs';
import { HandoffService } from './handoff-service';
import { assertHandoffExtension, HandoffStore, type HandoffStorage } from './handoff-store';
import { HandoffCoordinator, type HandoffCancellation, type HandoffCoordinatorOptions, type HandoffSyncAdmission } from './handoff-coordinator';
import { HandoffCommandStore } from './handoff-command-store';

const disk = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => disk.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));

const sender: HandoffAgent = { agentId: 'sender', machine: Array(16).fill('ab').join(':') };
const receiver: HandoffAgent = { agentId: 'receiver', machine: Array(16).fill('cd').join(':') };
const input: HandoffOffer = { to: receiver, task: { title: 'Continue task', brief: 'Run checks and finish the task.' }, mode: 'worktree' };
function storage(): HandoffStorage {
  const records = new Map<string, Handoff>();
  return {
    get: (id) => records.has(id) ? structuredClone(records.get(id)!) : undefined,
    list: () => structuredClone([...records.values()]),
    transact: async (id, change) => {
      const prior = records.get(id);
      const next = parseHandoff(await change(prior && structuredClone(prior)));
      if (prior) assertHandoffExtension(prior, next);
      records.set(id, structuredClone(next));
      return next;
    },
  };
}
function fixture(sameMachine = false) {
  let online = true;
  let allowed = true;
  const machines = new Map<string, HandoffCoordinator>();
  const notices: Handoff[] = [];
  const posts: Array<{ from: string; body: Record<string, unknown> }> = [];
  function computer(machine: string, store = storage(), commands: HandoffCancellation[] = []) {
    const service = new HandoffService({ machine, store, authorize: async () => allowed, isDispatcher: (actor) => actor.agentId === 'dispatcher' });
    const coordinator = new HandoffCoordinator({
      machine, store, service,
      commands: { list: () => structuredClone(commands), put: async (command) => { if (!commands.some((old) => old.operationId === command.operationId)) commands.push(command); }, remove: async (id) => { const index = commands.findIndex((command) => command.operationId === id); if (index !== -1) commands.splice(index, 1); } },
      post: (peer, body) => { posts.push({ from: machine, body }); return machines.get(peer)!.receive(machine, body); }, connected: () => online,
      authorizeOutgoing: async () => allowed, changed: async (record) => { notices.push(record); },
    });
    machines.set(machine, coordinator);
    return { coordinator, store, commands, restart: () => computer(machine, store, commands) };
  }
  const a = computer(sender.machine);
  const b = sameMachine ? a : computer(receiver.machine);
  return { a, b, notices, posts, offline: () => { online = false; }, reconnect: () => { online = true; }, revoke: () => { allowed = false; } };
}

describe('reverse sync actual history and command queue assembly', () => {
  beforeEach(() => { disk.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-sync-queue-')); });
  afterEach(() => { fs.rmSync(disk.dir, { recursive: true, force: true }); });
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }
  async function queueFixture(sending = false, pending = false, terminal = false) {
    const store = new HandoffStore(); const commands = new HandoffCommandStore();
    const service = new HandoffService({ machine: sending ? sender.machine : receiver.machine, store,
      authorize: async () => true, isDispatcher: () => false });
    const at = Date.now();
    const offered = parseHandoff({ ...input, schemaVersion: 1, id: randomUUID(), createdAt: at, updatedAt: at, version: 1,
      from: sender, state: 'offered', history: [{ operationId: randomUUID(), at, state: 'offered', by: { kind: 'agent', address: sender } }] });
    const accepted = transitionHandoff(offered, { state: 'accepted', target: receiver, operationId: randomUUID(), at: at + 1,
      by: { kind: 'agent', address: receiver } }, 1);
    const declined = transitionHandoff(offered, { state: 'declined', operationId: randomUUID(), at: at + 1,
      by: { kind: 'agent', address: receiver } }, 1);
    const command = { id: offered.id, operationId: randomUUID(), from: sender };
    const cancelled = transitionHandoff(accepted, { state: 'cancelled', operationId: command.operationId, at: at + 2,
      by: { kind: 'agent', address: sender } }, 2);
    await store.transact(offered.id, () => sending ? offered : declined);
    if (pending) await commands.put(command);
    let live = true; let posts = 0;
    const check = () => { if (!live) throw new Error('Original reverse admission retired'); };
    const admission: HandoffSyncAdmission = { check, checkOutgoing: check, holdPost: () => () => {}, release: vi.fn() };
    const post = vi.fn(async (_peer: string, _body: Record<string, unknown>, _admission?: HandoffSyncAdmission) =>
      !sending || terminal ? declined : ++posts === 1 ? accepted : cancelled);
    const changed = vi.fn(async (_record: Handoff) => {});
    const options: HandoffCoordinatorOptions = { machine: sending ? sender.machine : receiver.machine, store, service, commands,
      post, connected: () => false, captureSync: () => admission, authorizeOutgoing: async () => !pending,
      changed, now: () => at + 8 * 24 * 60 * 60_000 };
    const coordinator = new HandoffCoordinator(options);
    return { store, commands, service, coordinator, options, admission, post, changed, offered, accepted, declined, cancelled, command,
      retire: () => { live = false; } };
  }

  describe('native incoming coordinator admission', () => {
    it.each(['existing-offer', 'cancel-with-offer', 'cancel', 'newer-snapshot', 'older-snapshot'] as const)(
      'carries the original callback into the real %s queue', async (operation) => {
        const f = await queueFixture(true);
        const snapshot = operation.endsWith('snapshot');
        if (operation === 'older-snapshot') await f.store.transact(f.offered.id, () => f.declined);
        const machine = snapshot ? sender.machine : receiver.machine;
        const service = new HandoffService({ machine, store: f.store, authorize: async () => false, isDispatcher: () => false });
        const coordinator = new HandoffCoordinator({ ...f.options, machine, service, now: Date.now });
        const before = f.store.get(f.offered.id);
        const raw = operation === 'existing-offer' ? { op: 'offer', record: f.offered }
          : snapshot ? { op: 'snapshot', record: operation === 'older-snapshot' ? f.offered : f.declined }
            : { op: 'cancel', command: f.command, ...(operation === 'cancel-with-offer' && { record: f.offered }) };
        const entered = barrier(), held = barrier();
        const transact = f.store.transact.bind(f.store);
        let blocking: Promise<Handoff> | undefined;
        const spy = vi.spyOn(f.store, 'transact').mockImplementationOnce((id, change) => {
          blocking = transact(id, async (current: Handoff | undefined) => {
            entered.release(); await held.promise;
            if (!current) throw new Error('Missing owned queue record');
            return current;
          });
          return transact(id, change);
        });
        let live = true;
        const check = () => { if (!live) throw new Error('Original native request retired'); };
        const work = coordinator.receive(snapshot ? receiver.machine : sender.machine, raw, check);
        try {
          await entered.promise;
          live = false; held.release();
          await expect(work).rejects.toThrow('Original native request retired');
          expect(f.store.get(f.offered.id)).toEqual(before);
          expect(f.changed).not.toHaveBeenCalled();
        } finally { held.release(); await Promise.allSettled([blocking, work]); spy.mockRestore(); }
      });

    it.each(['terminal-ACK', 'terminal-cancel'] as const)(
      'checks original admission before its synchronous %s decision', async (operation) => {
        const f = await queueFixture(false);
        const ack = operation === 'terminal-ACK';
        const machine = ack ? sender.machine : receiver.machine;
        const service = new HandoffService({ machine, store: f.store, authorize: async () => false, isDispatcher: () => false });
        const coordinator = new HandoffCoordinator({ ...f.options, machine, service, now: Date.now });
        let checked = false;
        const check = () => {
          if (checked) throw new Error('Original native request retired');
          checked = true;
        };
        const record = parseHandoff({ ...f.declined, id: randomUUID() });
        const work = coordinator.receive(ack ? receiver.machine : sender.machine,
          ack ? { op: 'snapshot', record } : { op: 'cancel', command: f.command }, check);
        await expect(work).rejects.toThrow('Original native request retired');
        expect(f.store.get(record.id)).toBeUndefined();
        expect(f.changed).not.toHaveBeenCalled();
      });

    it('retains separately admitted local expiry but refuses the retired incoming message afterwards', async () => {
      const f = await queueFixture(true);
      const at = Date.now() - 2 * 24 * 60 * 60_000;
      const expired = parseHandoff({ ...f.offered, id: randomUUID(), createdAt: at, updatedAt: at,
        history: [{ ...f.offered.history[0], at }] });
      await f.store.transact(expired.id, () => expired);
      const incoming = parseHandoff({ ...f.offered, id: randomUUID() });
      const service = new HandoffService({ machine: receiver.machine, store: f.store, authorize: async () => true, isDispatcher: () => false });
      const coordinator = new HandoffCoordinator({ ...f.options, machine: receiver.machine, service, now: Date.now });
      let live = true;
      const transact = f.store.transact.bind(f.store);
      const spy = vi.spyOn(f.store, 'transact').mockImplementation((id, change) => transact(id, async (current: Handoff | undefined) => {
        const result = await change(current);
        if (id === expired.id) live = false;
        return result;
      }));
      try {
        await expect(coordinator.receive(sender.machine, { op: 'offer', record: incoming }, () => {
          if (!live) throw new Error('Original native request retired');
        })).rejects.toThrow('Original native request retired');
        expect(f.store.get(expired.id)).toMatchObject({ state: 'failed', failure: { code: 'expired' } });
        expect(f.store.get(incoming.id)).toBeUndefined();
      } finally { spy.mockRestore(); }
    });
  });

  it.each(['receiver-ACK', 'terminal-ACK', 'secondary-ACK', 'primary-remove', 'secondary-remove'] as const)(
    'carries the original capture into queued %s and refuses before its real mutation', async (stage) => {
      const sending = stage !== 'receiver-ACK'; const terminal = stage === 'terminal-ACK' || stage === 'primary-remove';
      const f = await queueFixture(sending, sending, terminal);
      const entered = barrier(); const held = barrier(); const queued = barrier(); const unrelated = randomUUID();
      const rename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === path.join(disk.dir, 'handoff-commands.json')
          && JSON.parse(fs.readFileSync(String(from), 'utf8')).undelivered?.includes(unrelated)) {
          entered.release(); await held.promise;
        }
        return rename(from, to);
      });
      let earlier: Promise<void> | undefined;
      const enqueueEarlier = () => { earlier = f.commands.markUndelivered(unrelated); queued.release(); };
      if (stage.endsWith('remove')) {
        const original = f.commands.remove.bind(f.commands);
        vi.spyOn(f.commands, 'remove').mockImplementation((id, guard) => { enqueueEarlier(); return original(id, guard); });
      } else {
        const original = f.commands.acknowledge.bind(f.commands);
        vi.spyOn(f.commands, 'acknowledge').mockImplementation((id, version, guard) => { enqueueEarlier(); return original(id, version, guard); });
      }
      const syncing = f.coordinator.sync(f.offered.id);
      const refusal = expect(syncing).rejects.toThrow('Original reverse admission retired');
      try {
        await Promise.all([entered.promise, queued.promise]); f.retire(); held.release(); await earlier; await refusal;
        expect(f.commands.acknowledged(f.offered.id)).toBe(stage.endsWith('remove') ? terminal ? 2 : 3 : undefined);
        expect(f.commands.list()).toEqual(sending ? [f.command] : []);
        expect(new HandoffCommandStore().list()).toEqual(f.commands.list());
        expect(f.post.mock.calls.every((call) => call[2] === f.admission)).toBe(true);
        if (stage === 'receiver-ACK') {
          await f.coordinator.flush();
          expect(f.store.get(f.offered.id)).toEqual(f.declined);
        }
      } finally { held.release(); await earlier; await Promise.allSettled([syncing]); }
    });

  it('does not advance reverse ACK memory after either deterministic precommit failure or ambiguous post-rename failure', async () => {
    for (const phase of ['before-rename', 'after-real-rename']) {
      const f = await queueFixture(); const rename = fs.promises.rename;
      const fault = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (phase === 'after-real-rename') await rename(from, to);
        throw new Error(`Injected ${phase} ACK failure`);
      });
      await expect(f.coordinator.sync(f.offered.id)).rejects.toThrow(`Injected ${phase} ACK failure`);
      expect(f.commands.acknowledged(f.offered.id)).toBeUndefined();
      expect(new HandoffCommandStore().acknowledged(f.offered.id)).toBe(phase === 'before-rename' ? undefined : 2);
      fault.mockRestore(); f.retire(); await f.coordinator.flush();
      expect(f.store.get(f.offered.id)).toEqual(f.declined);
    }
  });

  it.each([false, true])('requires actual durable ACK only for reverse, preserving legacy direct defaults (direct=%s)', async (direct) => {
    const f = await queueFixture();
    f.options.connected = () => direct;
    f.options.commands = { list: () => [], put: (command) => f.commands.put(command), remove: (id, guard) => f.commands.remove(id, guard) };
    if (direct) await expect(f.coordinator.sync(f.offered.id)).resolves.toBeUndefined();
    else await expect(f.coordinator.sync(f.offered.id)).rejects.toThrow('Durable reverse handoff acknowledgement is unavailable');
    expect(f.commands.acknowledged(f.offered.id)).toBeUndefined();
    if (!direct) { f.retire(); await f.coordinator.flush(); expect(f.store.get(f.offered.id)).toEqual(f.declined); }
  });

  it('commits history admitted before retirement but refuses the next secondary POST under the original capture', async () => {
    const f = await queueFixture(true, true);
    const entered = barrier(); const held = barrier(); const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(disk.dir, 'handoffs.json')) { entered.release(); await held.promise; }
      return rename(from, to);
    });
    const syncing = f.coordinator.sync(f.offered.id);
    const refusal = expect(syncing).rejects.toThrow('Original reverse admission retired');
    try {
      await entered.promise; f.retire(); held.release(); await refusal;
      expect(f.store.get(f.offered.id)).toEqual(f.accepted); expect(new HandoffStore().get(f.offered.id)).toEqual(f.accepted);
      expect(f.post).toHaveBeenCalledTimes(1); expect(f.commands.list()).toEqual([f.command]);
      expect(f.changed).not.toHaveBeenCalled();
    } finally { held.release(); await Promise.allSettled([syncing]); }
  });

  it('publishes a real ACK admitted before retirement but refuses the distinct primary removal', async () => {
    const f = await queueFixture(true, true, true);
    const entered = barrier(); const held = barrier(); const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(disk.dir, 'handoff-commands.json')
        && JSON.parse(fs.readFileSync(String(from), 'utf8')).acknowledgements?.[f.offered.id] === 2) {
        entered.release(); await held.promise;
      }
      return rename(from, to);
    });
    const syncing = f.coordinator.sync(f.offered.id);
    const refusal = expect(syncing).rejects.toThrow('Original reverse admission retired');
    try {
      await entered.promise; f.retire(); held.release(); await refusal;
      expect(f.commands.acknowledged(f.offered.id)).toBe(2); expect(new HandoffCommandStore().acknowledged(f.offered.id)).toBe(2);
      expect(f.commands.list()).toEqual([f.command]); expect(f.store.get(f.offered.id)).toEqual(f.declined);
      expect(f.post).toHaveBeenCalledTimes(1);
    } finally { held.release(); await Promise.allSettled([syncing]); }
  });

  it('uses one original capture and cancellation ID through primary adoption and every secondary adoption/ACK/removal', async () => {
    const f = await queueFixture(true, true);
    const adopted = vi.spyOn(f.service, 'receiveSnapshot'), acknowledged = vi.spyOn(f.commands, 'acknowledge'), removed = vi.spyOn(f.commands, 'remove');
    await f.coordinator.sync(f.offered.id);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls.map((call) => call[2])).toEqual([f.admission, f.admission]);
    expect(f.post.mock.calls.map((call) => call[1])).toEqual([
      { op: 'cancel', command: f.command, record: f.offered }, { op: 'cancel', command: f.command },
    ]);
    expect(adopted).toHaveBeenCalledTimes(2); expect(adopted.mock.calls.every((call) => typeof call[2] === 'function')).toBe(true);
    expect(acknowledged).toHaveBeenCalledWith(f.offered.id, 3, expect.any(Function));
    expect(removed).toHaveBeenCalledWith(f.command.operationId, expect.any(Function));
    expect(f.store.get(f.offered.id)).toEqual(f.cancelled); expect(new HandoffStore().get(f.offered.id)).toEqual(f.cancelled);
    expect(f.commands.list()).toEqual([]); expect(f.commands.acknowledged(f.offered.id)).toBe(3);
    expect(f.admission.release).toHaveBeenCalledTimes(1);
  });
});
describe('handoff agreement synchronization', () => {
  it('offers, accepts and cancels locally without using a network transport', async () => {
    const { a } = fixture(true);
    const localReceiver = { ...receiver, machine: sender.machine };
    const offer = await a.coordinator.offer({ ...input, to: localReceiver }, sender);
    const accepted = await a.coordinator.respond(offer.id, localReceiver, true);
    expect(accepted).toMatchObject({ state: 'accepted', version: 2 });
    expect(await a.coordinator.respond(offer.id, localReceiver, true)).toEqual(accepted);
    expect((await a.coordinator.cancel(offer.id, sender)).state).toBe('cancelled');
    expect(a.commands).toEqual([]);
  });

  it('synchronizes a receiver decision and preserves one response across retries and restart', async () => {
    const { a, b } = fixture();
    const offer = await a.coordinator.offer(input, sender);
    expect(b.store.get(offer.id)).toEqual(offer);
    const accepted = await b.coordinator.respond(offer.id, receiver, true);
    expect(a.store.get(offer.id)).toEqual(accepted);
    const restarted = b.restart();
    expect(await restarted.coordinator.respond(offer.id, receiver, true)).toEqual(accepted);
    await a.coordinator.sync(offer.id);
    expect(restarted.store.get(offer.id)?.history).toHaveLength(2);
  });

  it('retains offline offers and sender cancellations until reconnect after restart', async () => {
    const f = fixture();
    f.offline();
    const offer = await f.a.coordinator.offer(input, sender);
    expect(f.b.store.get(offer.id)).toBeUndefined();
    await f.a.coordinator.cancel(offer.id, sender, 'Reassigned');
    expect(f.a.store.get(offer.id)?.state).toBe('offered');
    expect(f.a.commands).toHaveLength(1);
    const restarted = f.a.restart();
    f.reconnect();
    await restarted.coordinator.flush();
    expect(f.b.store.get(offer.id)?.state).toBe('cancelled');
    expect(restarted.store.get(offer.id)?.state).toBe('cancelled');
    expect(restarted.commands).toEqual([]);
    await restarted.coordinator.flush();
    expect(f.b.store.get(offer.id)?.history).toHaveLength(2);
  });

  it('refuses forged transport identity and does not deliver a queued offer after revocation', async () => {
    const f = fixture();
    f.offline();
    const offer = await f.a.coordinator.offer(input, sender);
    await expect(f.b.coordinator.receive(receiver.machine, { op: 'offer', record: offer })).rejects.toThrow('source');
    f.revoke();
    f.reconnect();
    await f.a.coordinator.flush();
    expect(f.b.store.get(offer.id)).toBeUndefined();
  });

  it('lets only an addressed Dispatcher choose a receiver and preserves participant privacy', async () => {
    const { a, b } = fixture();
    const dispatcher = { ...receiver, agentId: 'dispatcher' };
    const offer = await a.coordinator.offer({ ...input, to: { machine: receiver.machine, via: 'dispatcher' } }, sender);
    await expect(b.coordinator.respond(offer.id, receiver, true)).rejects.toThrow('unavailable');
    const accepted = await b.coordinator.respond(offer.id, dispatcher, true, receiver);
    expect(b.coordinator.service.get(offer.id, receiver)).toEqual(accepted);
    expect(b.coordinator.service.list({ ...receiver, agentId: 'stranger' })).toEqual([]);
    expect(() => b.coordinator.service.get(offer.id, { ...receiver, agentId: 'stranger' })).toThrow('unavailable');
  });
  it('recovers a same-machine cancellation intent committed just before a crash', async () => {
    const { a } = fixture(true);
    const offer = await a.coordinator.offer({ ...input, to: { ...receiver, machine: sender.machine } }, sender);
    a.commands.push({ id: offer.id, operationId: randomUUID(), from: sender, reason: 'Reassigned before crash' });
    const restarted = a.restart();
    await restarted.coordinator.flush();
    expect(restarted.store.get(offer.id)?.state).toBe('cancelled');
    expect(restarted.commands).toEqual([]);
    await restarted.coordinator.flush();
    expect(restarted.store.get(offer.id)?.history).toHaveLength(2);
  });

  it('does not treat an unrelated participant as the author of an idempotent decline', async () => {
    const { a } = fixture(true);
    const localReceiver = { ...receiver, machine: sender.machine };
    const offer = await a.coordinator.offer({ ...input, to: localReceiver }, sender);
    const declined = await a.coordinator.respond(offer.id, localReceiver, false);
    expect(await a.coordinator.respond(offer.id, localReceiver, false)).toEqual(declined);
    await expect(a.coordinator.respond(offer.id, sender, false)).rejects.toThrow('addressed receiver');
  });

  it('services an active agreement before retained terminal history after restart', async () => {
    const f = fixture();
    for (let index = 0; index < 12; index++) {
      const old = await f.a.coordinator.offer(input, sender);
      await f.b.coordinator.respond(old.id, receiver, false);
    }
    const restarted = f.b.restart();
    const active = await f.a.coordinator.offer(input, sender);
    f.posts.length = 0;
    await restarted.coordinator.flush();
    expect((f.posts[0].body.record as Handoff).id).toBe(active.id);
    expect(f.posts).toHaveLength(10);
    f.posts.length = 0;
    await restarted.coordinator.flush();
    expect(f.posts).toHaveLength(4);
  });

});
