import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, HandoffAgent, HandoffOffer } from '../../shared/handoffs';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));

import { HandoffStore } from './handoff-store';
import { HandoffService, type HandoffAuthorization } from './handoff-service';

const sender: HandoffAgent = { agentId: 'sender', machine: Array(16).fill('aa').join(':') };
const receiver: HandoffAgent = { agentId: 'receiver', machine: Array(16).fill('bb').join(':') };
const dispatcher: HandoffAgent = { agentId: 'dispatcher', machine: receiver.machine };
const input: HandoffOffer = {
  to: receiver, task: { title: 'Example task', brief: 'Goal, done, remaining, verification.' }, mode: 'worktree',
  manifest: { fileCount: 1, totalBytes: 10, sha256: 'a'.repeat(64) },
};
const checkpoint = { projectId: 'project', worktree: '/registered/project/handoff', branch: 'handoff/example', stagingId: randomUUID() };
let allowed: (request: HandoffAuthorization) => boolean;

function service(machine: string, store = new HandoffStore()): HandoffService {
  return new HandoffService({
    machine, store, authorize: async (request) => allowed(request),
    isDispatcher: (agent) => agent.agentId === dispatcher.agentId && agent.machine === dispatcher.machine,
  });
}

async function seed(offerInput = input): Promise<Handoff> {
  return service(sender.machine).offer(offerInput, sender);
}

beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-lifecycle-'));
  allowed = () => true;
});

afterEach(() => {
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe('durable handoff agreement', () => {
  it('persists offers and acceptance across restart and restricts queries to participants', async () => {
    const offer = await seed();
    const receiverService = service(receiver.machine);
    expect(await receiverService.receiveOffer(offer, sender.machine)).toEqual(offer);
    const accepted = await receiverService.respond(offer.id, receiver, true, offer.version);
    expect(service(receiver.machine).get(offer.id, receiver)).toEqual(accepted);
    expect(service(sender.machine).get(offer.id, sender)).toEqual(accepted);
    expect(service(receiver.machine).list(receiver, 'received', 'accepted')).toEqual([accepted]);
    expect(service(receiver.machine).list(receiver, 'sent')).toEqual([]);
    expect(() => receiverService.get(offer.id, { ...receiver, agentId: 'unrelated' })).toThrow('unavailable');
    expect(receiverService.list({ ...receiver, agentId: 'unrelated' })).toEqual([]);
    expect(() => receiverService.get(offer.id, sender)).toThrow('not local');
  });

  it('requires grants on offer and response, and never starts transfer on acceptance', async () => {
    allowed = () => false;
    await expect(seed()).rejects.toThrow('not authorized');
    expect(new HandoffStore().list()).toEqual([]);
    allowed = () => true;
    const offer = await seed();
    allowed = () => false;
    await expect(service(receiver.machine).respond(offer.id, receiver, true, 1)).rejects.toThrow('not authorized');
    expect(new HandoffStore().get(offer.id)?.state).toBe('offered');
    allowed = () => true;
    expect((await service(receiver.machine).respond(offer.id, receiver, true, 1)).state).toBe('accepted');
    expect(new HandoffStore().get(offer.id)?.progress).toBeUndefined();
  });

  it('lets only the machine Dispatcher select a local target, without authorizing unrelated responders', async () => {
    const offer = await seed({ ...input, to: { machine: receiver.machine, via: 'dispatcher' } });
    const instance = service(receiver.machine);
    await expect(instance.respond(offer.id, receiver, true, 1)).rejects.toThrow('addressed receiver');
    await expect(instance.respond(offer.id, dispatcher, true, 1, sender)).rejects.toThrow('Invalid handoff');
    const accepted = await instance.respond(offer.id, dispatcher, true, 1, receiver);
    expect(accepted.acceptance).toEqual({ by: dispatcher, target: receiver });
    expect(service(receiver.machine).get(offer.id, receiver)).toEqual(accepted);
  });

  it('declines durably and rejects acceptance after decline', async () => {
    const offer = await seed();
    const instance = service(receiver.machine);
    const declined = await instance.respond(offer.id, receiver, false, 1, undefined, 'Not enough capacity.');
    expect(declined).toMatchObject({ state: 'declined', version: 2 });
    await expect(instance.respond(offer.id, receiver, true, 2)).rejects.toThrow('Invalid handoff');
    expect(service(receiver.machine).get(offer.id, receiver)).toEqual(declined);
  });

  it('reconciles an unacknowledged response or cancellation by operation id after restart', async () => {
    const offer = await seed();
    const responseId = randomUUID();
    const accepted = await service(receiver.machine).respond(offer.id, receiver, true, 1, undefined, undefined, responseId);
    const restarted = service(receiver.machine);
    expect(await restarted.respond(offer.id, receiver, true, 1, undefined, undefined, responseId)).toEqual(accepted);
    await expect(restarted.respond(offer.id, receiver, false, 1, undefined, undefined, responseId)).rejects.toThrow('Conflicting handoff operation');
    const cancellationId = randomUUID();
    const cancelled = await restarted.cancelAtReceiver(offer.id, sender, sender.machine, 2, undefined, cancellationId);
    expect(await service(receiver.machine).cancelAtReceiver(offer.id, sender, sender.machine, 2, undefined, cancellationId)).toEqual(cancelled);
    expect(cancelled.version).toBe(3);
  });

  it('serializes competing accept/cancel decisions and forbids unilateral sender transitions', async () => {
    const offer = await seed();
    const store = new HandoffStore();
    const authority = service(receiver.machine, store);
    const results = await Promise.allSettled([
      authority.respond(offer.id, receiver, true, 1),
      authority.cancelAtReceiver(offer.id, sender, sender.machine, 1),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.get(offer.id)?.state).toBe('accepted');
    await expect(service(sender.machine).cancelAtReceiver(offer.id, sender, sender.machine, 2)).rejects.toThrow('receiving machine');
    await expect(authority.cancelAtReceiver(offer.id, sender, receiver.machine, 2)).rejects.toThrow('source');
    expect((await authority.cancelAtReceiver(offer.id, sender, sender.machine, 2)).state).toBe('cancelled');
    expect(service(receiver.machine).get(offer.id, receiver).state).toBe('cancelled');
  });

  it('fails closed on sender or receiver grant revocation at the next worker boundary', async () => {
    for (const action of ['handoff.offer', 'handoff.accept']) {
      allowed = () => true;
      const offer = await seed();
      const authority = service(receiver.machine);
      await authority.respond(offer.id, receiver, true, 1);
      allowed = (request) => request.action !== action;
      await expect(authority.advance(offer.id, { state: 'transferring', bytesDone: 0 }, 2)).rejects.toThrow('authorization changed');
      expect(service(receiver.machine).get(offer.id, receiver)).toMatchObject({
        state: 'failed', failure: { step: 'authorization', code: 'authorization_changed' },
      });
    }
  });

  it('retains the exact apply checkpoint and reports indeterminate recovery without retry or claiming rollback', async () => {
    const offer = await seed();
    const authority = service(receiver.machine);
    await authority.respond(offer.id, receiver, true, 1);
    await authority.advance(offer.id, { state: 'transferring', bytesDone: 10 }, 2);
    await authority.advance(offer.id, { state: 'verifying' }, 3);
    await authority.advance(offer.id, { state: 'applying', checkpoint }, 4);
    await expect(authority.cancelAtReceiver(offer.id, sender, sender.machine, 5)).rejects.toThrow('Invalid handoff');
    const restarted = service(receiver.machine);
    const [recovered] = await restarted.recover();
    expect(recovered).toMatchObject({
      state: 'failed', checkpoint, failure: { step: 'recovery', code: 'indeterminate_apply' },
    });
    expect(service(receiver.machine).get(offer.id, receiver)).toEqual(recovered);
    expect(await restarted.recover()).toEqual([]);
    expect(await service(sender.machine).recover()).toEqual([]);
  });

  it('leaves interrupted transfer resumable but rechecks grants after restart', async () => {
    const offer = await seed();
    const authority = service(receiver.machine);
    await authority.respond(offer.id, receiver, true, 1);
    await authority.advance(offer.id, { state: 'transferring', bytesDone: 5 }, 2);
    const restarted = service(receiver.machine);
    expect(await restarted.recover()).toEqual([]);
    expect(restarted.get(offer.id, receiver).progress?.bytesDone).toBe(5);
    allowed = () => false;
    await expect(restarted.advance(offer.id, { state: 'transferring', bytesDone: 10 }, 3)).rejects.toThrow('authorization changed');
  });
});

describe('handoff synchronization', () => {
  it('authenticates offer/snapshot sources, tolerates duplicates and stale prefixes, rejects rewritten history', async () => {
    const senderDirectory = state.dir;
    const offered = await seed();
    const senderService = service(sender.machine);
    const receiverDirectory = fs.mkdtempSync(path.join(senderDirectory, 'receiver-'));
    state.dir = receiverDirectory;
    try {
      const authority = service(receiver.machine);
      await expect(authority.receiveOffer(offered, receiver.machine)).rejects.toThrow('source');
      expect(await authority.receiveOffer(offered, sender.machine)).toEqual(offered);
      const accepted = await authority.respond(offered.id, receiver, true, 1);
      expect(await authority.receiveOffer(offered, sender.machine)).toEqual(accepted);
      const transferring = await authority.advance(offered.id, { state: 'transferring', bytesDone: 5 }, 2);
      state.dir = senderDirectory;
      await expect(senderService.receiveSnapshot(accepted, sender.machine)).rejects.toThrow('source');
      expect(await senderService.receiveSnapshot(transferring, receiver.machine)).toEqual(transferring);
      expect(await senderService.receiveSnapshot(accepted, receiver.machine)).toEqual(transferring);
      expect(await senderService.receiveSnapshot(transferring, receiver.machine)).toEqual(transferring);
      const forged = structuredClone(transferring);
      forged.task.brief = 'Changed immutable offer.';
      await expect(senderService.receiveSnapshot(forged, receiver.machine)).rejects.toThrow('Conflicting');
      expect(senderService.get(offered.id, sender)).toEqual(transferring);
    } finally {
      state.dir = senderDirectory;
    }
  });
});

describe('handoff durable storage faults', () => {
  it.each(['{broken', '{}', '{"schemaVersion":2,"records":[]}', '{"schemaVersion":1,"records":[{}]}'])('refuses to overwrite an unreadable or unsupported store: %s', async (contents) => {
    const file = path.join(state.dir, 'handoffs.json');
    await fs.promises.writeFile(file, contents);
    const store = new HandoffStore();
    expect(() => store.list()).toThrow('unreadable');
    await expect(service(sender.machine, store).offer(input, sender)).rejects.toThrow('unreadable');
    expect(await fs.promises.readFile(file, 'utf8')).toBe(contents);
  });

  it('does not expose or acknowledge a transition when its atomic disk replacement fails', async () => {
    const offered = await seed();
    const store = new HandoffStore();
    const authority = service(receiver.machine, store);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('Injected disk failure.'));
    await expect(authority.respond(offered.id, receiver, true, 1)).rejects.toThrow('Injected disk failure');
    expect(store.get(offered.id)).toEqual(offered);
    expect(new HandoffStore().get(offered.id)).toEqual(offered);
    expect((await authority.respond(offered.id, receiver, true, 1)).state).toBe('accepted');
    expect(await fs.promises.readdir(state.dir)).toEqual(['handoffs.json']);
    if (process.platform !== 'win32') expect((await fs.promises.stat(path.join(state.dir, 'handoffs.json'))).mode & 0o777).toBe(0o600);
  });

  it('hands out detached records and refuses lower-level history rewrites', async () => {
    const offered = await seed();
    const store = new HandoffStore();
    const copy = store.get(offered.id)!;
    copy.task.brief = 'Mutation.';
    expect(store.get(offered.id)).toEqual(offered);
    await expect(store.transact(offered.id, (current) => ({ ...current!, task: { ...input.task, title: 'Rewritten.' } }))).rejects.toThrow('Conflicting');
    expect(store.get(offered.id)).toEqual(offered);
  });

  it('keeps queries at the committed version while a disk write is still in flight', async () => {
    const offered = await seed();
    const store = new HandoffStore();
    const rename = fs.promises.rename;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reachedRename = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => {
      started();
      await waiting;
      return rename(from, to);
    });
    const accepting = service(receiver.machine, store).respond(offered.id, receiver, true, 1);
    await reachedRename;
    expect(store.get(offered.id)).toEqual(offered);
    release();
    expect((await accepting).state).toBe('accepted');
    expect(store.get(offered.id)?.state).toBe('accepted');
  });
});
