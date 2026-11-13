import { describe, expect, it } from 'vitest';
import type { Handoff, HandoffAgent, HandoffOffer } from '../../shared/handoffs';
import { parseHandoff } from '../../shared/handoffs';
import { HandoffService } from './handoff-service';
import { assertHandoffExtension, type HandoffStorage } from './handoff-store';
import { HandoffCoordinator, type HandoffCancellation } from './handoff-coordinator';

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
  function computer(machine: string, store = storage(), commands: HandoffCancellation[] = []) {
    const service = new HandoffService({ machine, store, authorize: async () => allowed, isDispatcher: (actor) => actor.agentId === 'dispatcher' });
    const coordinator = new HandoffCoordinator({
      machine, store, service,
      commands: { list: () => structuredClone(commands), put: async (command) => { if (!commands.some((old) => old.operationId === command.operationId)) commands.push(command); }, remove: async (id) => { const index = commands.findIndex((command) => command.operationId === id); if (index !== -1) commands.splice(index, 1); } },
      post: (peer, body) => machines.get(peer)!.receive(machine, body), connected: () => online,
      authorizeOutgoing: async () => allowed, changed: async (record) => { notices.push(record); },
    });
    machines.set(machine, coordinator);
    return { coordinator, store, commands, restart: () => computer(machine, store, commands) };
  }
  const a = computer(sender.machine);
  const b = sameMachine ? a : computer(receiver.machine);
  return { a, b, notices, offline: () => { online = false; }, reconnect: () => { online = true; }, revoke: () => { allowed = false; } };
}

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
});
