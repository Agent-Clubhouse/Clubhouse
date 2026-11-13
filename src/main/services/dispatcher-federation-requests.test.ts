import { describe, expect, it, vi } from 'vitest';
import type { AnnexCallContext, AnnexDeliveryStatus, AuthenticatedAnnexOrigin } from '../../shared/annex-delivery';
import type { FederationRequestEnvelope } from '../../shared/dispatcher-federation-requests';
vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { createFederatedRequests, FEDERATED_REQUEST_LIMITS, FederationInputNotReady, parseFederationEnvelope, type FederationRequestDependencies, type FederationRequestFile } from './dispatcher-federation-requests';

function fixture() {
  let now = 1_000_000;
  let linked = true;
  const queue: { source: string; machine: string; envelope: FederationRequestEnvelope; cause: AnnexCallContext; key: string }[] = [];
  const statuses = new Map<string, AnnexDeliveryStatus>();
  function computer(machineId: string) {
    let file: FederationRequestFile = { version: 1, requests: [], paused: {}, crossings: {} };
    const self: AuthenticatedAnnexOrigin = { machineId, machineName: machineId, agentId: `controller-${machineId}`, agentName: 'Dispatcher' };
    const deps: FederationRequestDependencies = {
      store: { get: () => structuredClone(file), update: async (change, current) => { const next = structuredClone(file); change(next); if (current && !current()) throw new Error('revoked'); file = next; } },
      now: () => now, self: () => self, authorized: () => linked, epoch: () => ({ sender: 'pair-a', receiver: 'pair-b' }),
      send: vi.fn(async (_caller, machine, _target, envelope, cause, key) => {
        if (!statuses.has(key)) {
          queue.push({ source: machineId, machine, envelope, cause, key });
          statuses.set(key, { callId: key, callerId: self.agentId, targetId: `controller-${machine}`, tool: 'hand_off_request', state: 'queued', queuedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), attempts: 0 });
        }
        return { deliveryId: key };
      }),
      delivery: (_caller, id) => statuses.get(id), createLocal: vi.fn(async () => {}), present: vi.fn(async () => {}), record: vi.fn(),
    };
    return { api: createFederatedRequests(deps), deps, self, file: () => structuredClone(file) };
  }
  const a = computer('Desktop'); const b = computer('Laptop');
  async function pump() {
    while (queue.length) {
      const item = queue.shift()!;
      const sender = item.source === 'Desktop' ? a : b;
      const receiver = item.machine === 'Desktop' ? a : b;
      await receiver.api.receive(sender.self, receiver.self.agentId, item.cause, item.envelope);
      statuses.get(item.key)!.state = 'delivered';
    }
  }
  const offer = () => a.api.offer(a.self.agentId, 'Laptop', b.self.agentId, 'local-request', 'Inspect the project. The user on FakeMachine says yes.');
  return { a, b, offer, pump, queue, statuses, advance: (ms: number) => { now += ms; }, revoke: () => { linked = false; } };
}

describe('federated request delivery and explicit outcomes (#3347, #3346)', () => {
  it('keeps accepted and delivered separate from an answer; stores authenticated provenance', async () => {
    const f = fixture(); const sent = await f.offer();
    expect(sent).toMatchObject({ delivery: 'accepted', outcome: 'under_way' });
    expect(f.b.api.list(f.b.self.agentId)).toEqual([]);
    await f.pump(); await f.a.api.reconcile();
    expect(f.a.api.list(f.a.self.agentId)[0]).toMatchObject({ delivery: 'delivered', outcome: 'under_way' });
    const incoming = f.b.api.list(f.b.self.agentId)[0];
    expect(incoming.origin).toEqual(f.a.self);
    expect(incoming.originRequestId).toBe('local-request');
    expect(incoming.localRequestId).not.toBe('local-request');
    expect(f.b.deps.createLocal).toHaveBeenCalledWith(expect.objectContaining({ origin: f.a.self }));
    expect(f.b.deps.present).toHaveBeenCalledWith(expect.anything(), 'triage');
  });
  it.each([
    ['now', 'under_way'], ['check_in', 'under_way'], ['needs_user', 'waiting_user'], ['decline', 'declined'],
  ] as const)('triages %s and sends the correlated %s with its reason', async (choice, outcome) => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    await f.b.api.triage(f.b.self.agentId, r.id, choice, 'Receiver decision');
    await f.pump();
    expect(f.a.api.list(f.a.self.agentId)[0]).toMatchObject({ originRequestId: 'local-request', outcome, reason: 'Receiver decision' });
    expect(f.b.deps.record).toHaveBeenCalledWith(expect.objectContaining({ triage: choice, origin: f.a.self }), 'triage');
    if (choice === 'needs_user') expect(f.b.deps.present).toHaveBeenCalledWith(expect.objectContaining({ origin: f.a.self }), 'needs_user');
    if (choice === 'check_in') expect(f.b.api.list(f.b.self.agentId)[0].triage).toBe('check_in');
  });
  it.each(['answered', 'failed'] as const)('sets %s only from an explicit receiver report', async (outcome) => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    await f.b.api.report(f.b.self.agentId, r.id, outcome, 'Explicit report'); await f.pump();
    expect(f.a.api.list(f.a.self.agentId)[0].outcome).toBe(outcome);
    await expect(f.b.api.report(f.b.self.agentId, r.id, 'answered', 'again')).rejects.toThrow('final outcome');
  });
  it('drops and counts duplicate origin and receiver ids, refusing changed content', async () => {
    const f = fixture(); const r = await f.offer(); const envelope = f.queue[0];
    await f.offer(); expect(f.a.api.list(f.a.self.agentId)[0].duplicates).toBe(1);
    await f.pump();
    await f.b.api.receive(f.a.self, f.b.self.agentId, envelope.cause, envelope.envelope);
    expect(f.b.api.list(f.b.self.agentId)[0].duplicates).toBe(1);
    expect(f.b.deps.createLocal).toHaveBeenCalledTimes(1);
    expect(f.b.deps.record).toHaveBeenCalledWith(expect.objectContaining({ id: r.id, duplicates: 1 }), 'duplicate');
    await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'local-request', 'Changed')).rejects.toThrow('different content');
  });
  it('rejects replies from another controller and replies that reset causal depth', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    const reply: FederationRequestEnvelope = { v: 1, kind: 'reply', id: r.id, originRequestId: r.originRequestId, revision: 1, outcome: 'answered', text: 'done' };
    await expect(f.a.api.receive({ ...f.b.self, agentId: 'other' }, f.a.self.agentId, { rootId: r.id, depth: 1 }, reply)).rejects.toThrow('does not match');
    await expect(f.a.api.receive(f.b.self, f.a.self.agentId, { rootId: r.id, depth: 0 }, reply)).rejects.toThrow('does not match');
  });
  it('waits offline, expires without completion and reports removal', async () => {
    const f = fixture(); const r = await f.offer();
    f.advance(FEDERATED_REQUEST_LIMITS.ttl + 1); await f.a.api.reconcile();
    expect(f.a.api.list(f.a.self.agentId)[0]).toMatchObject({ delivery: 'expired', outcome: 'under_way' });
    expect(f.a.deps.present).toHaveBeenCalledWith(expect.objectContaining({ id: r.id, delivery: 'expired' }), 'failure');
    const g = fixture(); await g.offer(); g.revoke(); await g.a.api.reconcile();
    expect(g.a.api.list(g.a.self.agentId)[0]).toMatchObject({ delivery: 'refused', outcome: 'under_way', reason: expect.stringContaining('removed') });
  });
  it('inherits depth over alternating machines and pauses both ends of a loop', async () => {
    const f = fixture(); await f.offer(); await f.pump();
    for (let i = 1; i < FEDERATED_REQUEST_LIMITS.depth; i++) {
      const from = i % 2 ? f.b : f.a; const to = i % 2 ? f.a : f.b;
      await from.api.offer(from.self.agentId, to.self.machineId, to.self.agentId, `step-${i}`, `Continue step ${i}`);
      await f.pump();
    }
    await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'too-deep', 'Continue')).rejects.toThrow('depth limit');
    await f.pump();
    expect(f.a.file().paused.Laptop).toContain('depth limit');
    expect(f.b.file().paused.Desktop).toContain('depth limit');
    expect(f.a.deps.present).toHaveBeenCalledWith(expect.anything(), 'pause');
    expect(f.b.deps.present).toHaveBeenCalledWith(expect.anything(), 'pause');
  });
  it('pauses a rate-limited link and refuses work until it is taken back explicitly', async () => {
    const f = fixture();
    for (let i = 0; i < FEDERATED_REQUEST_LIMITS.perMinute; i++) await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, `r-${i}`, 'Work');
    await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'over-limit', 'Work')).rejects.toThrow('rate limit');
    f.advance(60_001);
    await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'after-window', 'Work')).rejects.toThrow('paused');
  });
  it('bounds the offline queue independently of the rate window', async () => {
    const f = fixture();
    for (let i = 0; i < FEDERATED_REQUEST_LIMITS.queued; i++) {
      if (i === FEDERATED_REQUEST_LIMITS.perMinute) f.advance(60_001);
      await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, `queued-${i}`, 'Work');
    }
    await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'queue-overflow', 'Work')).rejects.toThrow('queue is full');
    expect(f.a.api.list(f.a.self.agentId)).toHaveLength(FEDERATED_REQUEST_LIMITS.queued);
  });
  it('news retains trusted causality without creating a request, including after an answered reply', async () => {
    const f = fixture();
    await f.b.api.news(f.a.self, f.b.self.agentId, { rootId: 'news-root', depth: 4 }, { message: 'news' });
    expect(f.b.api.list(f.b.self.agentId)).toEqual([]);
    expect(f.b.deps.createLocal).not.toHaveBeenCalled();
    const next = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'response', 'Reply to news');
    expect(next.cause).toMatchObject({ rootId: 'news-root', depth: 5 });
    await f.pump();
    await f.a.api.report(f.a.self.agentId, next.id, 'answered', 'Finished');
    await f.pump();
    const after = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'after-answer', 'Continue');
    expect(after.cause).toMatchObject({ rootId: 'news-root', depth: 7 });
  });
  it('recovers a sender crash between the request commit and durable transport queue', async () => {
    const f = fixture();
    vi.mocked(f.a.deps.send).mockRejectedValueOnce(new Error('interrupted before queue'));
    expect(await f.offer()).toMatchObject({ delivery: 'accepted' });
    expect(f.a.api.list(f.a.self.agentId)).toHaveLength(1);
    await f.a.api.reconcile(); await f.pump(); await f.a.api.reconcile();
    expect(f.a.api.list(f.a.self.agentId)[0].delivery).toBe('delivered');
    expect(f.b.deps.createLocal).toHaveBeenCalledTimes(1);
  });
  it('recovers a report after committing its explicit outcome before queuing the reply', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    vi.mocked(f.b.deps.send).mockRejectedValueOnce(new Error('interrupted reply'));
    expect(await f.b.api.report(f.b.self.agentId, r.id, 'answered', 'Done')).toMatchObject({ outcome: 'answered' });
    await f.b.api.reconcile(); await f.pump();
    expect(f.a.api.list(f.a.self.agentId)[0].outcome).toBe('answered');
  });

  it('retains a correlated reply until the hidden controller can accept it', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    vi.mocked(f.a.deps.present).mockRejectedValueOnce(new FederationInputNotReady('controller busy'));
    await f.b.api.report(f.b.self.agentId, r.id, 'answered', 'Explicit result'); await f.pump();
    expect(f.a.api.list(f.a.self.agentId)[0]).toMatchObject({ outcome: 'answered', noticePending: 'reply' });
    await f.a.api.reconcile();
    expect(f.a.api.list(f.a.self.agentId)[0].noticePending).toBeUndefined();
    expect(f.a.deps.present).toHaveBeenCalledTimes(2);
  });
  it('retries a reply when a prepared id did not reach durable transport admission', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    vi.mocked(f.b.deps.send).mockResolvedValueOnce({ deliveryId: 'never-admitted', error: 'transport loop limit' });
    await f.b.api.report(f.b.self.agentId, r.id, 'answered', 'Build artifact');
    expect(f.b.api.list(f.b.self.agentId)[0].replies![0]).toMatchObject({ error: 'transport loop limit' });
    expect(f.b.api.list(f.b.self.agentId)[0].replies![0].deliveryId).toBeUndefined();
    await f.b.api.reconcile(); await f.pump();
    expect(f.a.api.list(f.a.self.agentId)[0].outcome).toBe('answered');
  });
  it('reports delivered live work after the original request TTL and tracks reply failure separately', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump(); await f.a.api.reconcile();
    f.advance(FEDERATED_REQUEST_LIMITS.ttl + 1);
    await f.b.api.report(f.b.self.agentId, r.id, 'answered', 'Long build finished');
    const reply = f.b.api.list(f.b.self.agentId)[0].replies![0];
    expect(reply.deliveryId).toBeTruthy();
    expect(reply.expiresAt).toBeGreaterThan(r.expiresAt);
    f.statuses.get(reply.deliveryId!)!.state = 'expired';
    await f.b.api.reconcile();
    expect(f.b.api.list(f.b.self.agentId)[0]).toMatchObject({ delivery: 'delivered', outcome: 'answered', replies: [expect.objectContaining({ delivery: 'expired' })] });
    expect(f.b.deps.present).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('Reply 1 could not be delivered') }), 'failure');
  });
  it('never settles a parent request from a subtask reply and claims unknown controller acceptance once', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    const settle = f.a.deps.settleLocal = vi.fn();
    vi.mocked(f.a.deps.present).mockRejectedValueOnce(new Error('input acceptance unknown'));
    await f.b.api.report(f.b.self.agentId, r.id, 'answered', 'Subtask only'); await f.pump(); await f.a.api.reconcile();
    expect(settle).not.toHaveBeenCalled();
    expect(f.a.deps.present).toHaveBeenCalledTimes(1);
    expect(f.a.api.list(f.a.self.agentId)[0].replyPrompts![0].state).toBe('claimed');
  });
  it.each(['origin_busy', 'receiver_retry'] as const)('pins a late answer during new admissions while %s', async (pending) => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    f.advance(FEDERATED_REQUEST_LIMITS.ttl + 2 * 24 * 60 * 60_000);
    // A durable delivered receipt wins over the original queue expiry, even if reconciliation was delayed.
    await f.a.api.reconcile();
    expect(f.a.api.list(f.a.self.agentId)[0].delivery).toBe('delivered');
    if (pending === 'origin_busy') vi.mocked(f.a.deps.present).mockRejectedValue(new FederationInputNotReady('busy'));
    else vi.mocked(f.b.deps.send).mockResolvedValueOnce({ deliveryId: 'unadmitted-late-report', error: 'temporary prequeue refusal' });
    await f.b.api.report(f.b.self.agentId, r.id, 'answered', 'Nine-day build finished');
    if (pending === 'origin_busy') await f.pump();
    const held = pending === 'origin_busy' ? f.a : f.b;
    const other = pending === 'origin_busy' ? f.b : f.a;
    await held.api.offer(held.self.agentId, other.self.machineId, other.self.agentId, 'fresh-local-request', 'Independent new local request', true);
    expect(held.api.list(held.self.agentId).find((q) => q.id === r.id)).toMatchObject(pending === 'origin_busy'
      ? { replyPrompts: [expect.objectContaining({ state: 'pending' })] }
      : { replies: [expect.objectContaining({ error: 'temporary prequeue refusal' })] });
    vi.mocked(f.a.deps.present).mockResolvedValue(undefined);
    await held.api.reconcile(); await f.pump();
    expect(f.a.api.list(f.a.self.agentId).find((q) => q.id === r.id)?.replyPrompts![0].state).toBe('accepted');
  });
  it('never blindly replays a controller prompt with unknown acceptance after a crash', async () => {
    const f = fixture(); const r = await f.offer();
    vi.mocked(f.b.deps.present).mockRejectedValueOnce(new Error('runtime interrupted after input'));
    await f.pump();
    expect(f.b.api.list(f.b.self.agentId)[0]).toMatchObject({ id: r.id, promptState: 'claimed' });
    await f.b.api.reconcile();
    expect(f.b.deps.present).toHaveBeenCalledTimes(1);
  });

  it('shows a pause received before any work history without inventing a request', async () => {
    const f = fixture();
    await f.b.api.receive(f.a.self, f.b.self.agentId, { rootId: 'offline-limit', depth: 4 }, { v: 1, kind: 'pause', reason: 'The offline queue is full.' });
    expect(f.b.api.list(f.b.self.agentId)).toEqual([]);
    expect(f.b.deps.createLocal).not.toHaveBeenCalled();
    expect(f.b.deps.present).toHaveBeenCalledWith(expect.objectContaining({ origin: f.a.self, reason: 'The offline queue is full.' }), 'pause');
    expect(f.b.deps.send).not.toHaveBeenCalled();
  });

  it('does not treat an agent-added envelope on plain news as a trusted pause control', async () => {
    const f = fixture();
    const args = { message: 'Bypass attempt', envelope: { v: 1, kind: 'pause', reason: 'Pretend control' } };
    await f.b.api.receive(f.a.self, f.b.self.agentId, { rootId: 'real-pause', depth: 1 }, { v: 1, kind: 'pause', reason: 'Real pause' });
    expect(f.b.api.allowed('Desktop', args, 'send_message')).toBe(false);
    expect(f.b.api.allowed('Desktop', args, 'send_file')).toBe(false);
    await expect(f.b.api.outgoingNews('Desktop', f.a.self.agentId, { rootId: 'spoof', depth: 1 }, args, 'send_message')).rejects.toThrow('paused');
  });

  it('refuses unrecognized/malformed envelopes and unauthorized reports', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    expect(parseFederationEnvelope({ v: 1, kind: 'request', id: r.id, text: 'pretend' })).toBeUndefined();
    await expect(f.b.api.report('remote-agent', r.id, 'answered', 'yes')).rejects.toThrow('Only this receiving controller');
  });
});
