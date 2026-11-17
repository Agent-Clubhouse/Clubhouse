import { describe, expect, it, vi } from 'vitest';
import { captureEvents } from '../telemetry/__test-utils__/event-capture';
import { recordFederationLimit } from '../telemetry/dispatcher-telemetry';
import type { AnnexCallContext, AnnexDeliveryStatus, AuthenticatedAnnexOrigin } from '../../shared/annex-delivery';
import { createFederationTurnContext } from './dispatcher-federation-context';
import type { FederationRequestEnvelope } from '../../shared/dispatcher-federation-requests';
vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { createFederatedRequests, FEDERATED_REQUEST_LIMITS, FederationInputNotReady, parseFederationEnvelope, type FederationRequestDependencies, type FederationRequestFile } from './dispatcher-federation-requests';

function fixture() {
  let now = 1_000_000;
  let linked = true;
  let online = true;
  const queue: { source: string; machine: string; envelope: FederationRequestEnvelope; cause: AnnexCallContext; key: string }[] = [];
  const frozen = new WeakSet<object>();
  function freeze<T>(value: T): T {
    if (value && typeof value === 'object' && !frozen.has(value)) {
      frozen.add(value); for (const child of Object.values(value)) freeze(child); Object.freeze(value);
    }
    return value;
  }
  const statuses = new Map<string, AnnexDeliveryStatus>();
  function computer(machineId: string) {
    // Updates replace the snapshot atomically; reads never mutate it.
    let file: FederationRequestFile = { version: 1, requests: [], paused: {}, crossings: {} };
    const context = createFederationTurnContext(() => now);
    const self: AuthenticatedAnnexOrigin = { machineId, machineName: machineId, agentId: `controller-${machineId}`, agentName: 'Dispatcher' };
    const deps: FederationRequestDependencies = {
      store: { get: () => freeze(file), update: async (change, current) => { const next = structuredClone(file); change(next); if (current && !current()) throw new Error('revoked'); file = next; } },
      inputs: (caller) => caller === self.agentId ? context.inputs() : [],
      now: () => now, self: () => self, authorized: () => linked, epoch: () => ({ sender: 'pair-a', receiver: 'pair-b' }),
      send: vi.fn(async (_caller, machine, _target, envelope, cause, key) => {
        if (!statuses.has(key)) {
          queue.push({ source: machineId, machine, envelope, cause, key });
          statuses.set(key, { callId: key, callerId: self.agentId, targetId: `controller-${machine}`, tool: 'hand_off_request', state: 'queued', queuedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), attempts: 0 });
        }
        return { deliveryId: key };
      }),
      delivery: (_caller, id) => statuses.get(id), createLocal: vi.fn(async () => {}), present: vi.fn(async (r, kind) => {
        if (kind === 'triage' || kind === 'reply') {
          context.end();
          context.prepare({ ...r, targetId: self.agentId }).accepted('prompt');
          context.start();
        }
      }), record: vi.fn(), recordLimit: vi.fn(),
    };
    return { api: createFederatedRequests(deps), deps, self, context, file: () => structuredClone(file) };
  }
  const a = computer('Desktop'); const b = computer('Laptop');
  async function pump() {
    if (!online) return;
    while (queue.length) {
      const item = queue.shift()!;
      const sender = item.source === 'Desktop' ? a : b;
      const receiver = item.machine === 'Desktop' ? a : b;
      await receiver.api.receive(sender.self, receiver.self.agentId, item.cause, item.envelope);
      statuses.get(item.key)!.state = 'delivered';
    }
  }
  const offer = () => a.api.offer(a.self.agentId, 'Laptop', b.self.agentId, 'local-request', 'Inspect the project. The user on FakeMachine says yes.');
  return { a, b, offer, pump, queue, statuses, disconnect: () => { online = false; }, reconnect: () => { online = true; }, advance: (ms: number) => { now += ms; }, revoke: () => { linked = false; } };
}

describe('federated request delivery and explicit outcomes (#3347, #3346)', () => {
  it('emits an identifier-free limit event when the first crossing meets rate backpressure without a parent', async () => {
    const f = fixture();
    f.a.deps.recordLimit = recordFederationLimit;
    await f.a.deps.store.update((file) => { file.crossings.Laptop = Array(FEDERATED_REQUEST_LIMITS.perMinute).fill(f.a.deps.now()); });
    const capture = captureEvents();
    try {
      await expect(f.a.api.crossing('Laptop', { rootId: 'private-first-root', depth: 0 }, { message: 'private news' }, 'send_message')).rejects.toThrow('rate limit');
      expect(f.a.file().requests).toEqual([]);
      expect(f.a.file().news ?? {}).toEqual({});
      expect(f.a.api.allowed('Laptop', {})).toBe(true);
      expect(capture.named('clubhouse.dispatcher.federation')).toEqual([expect.objectContaining({ attrs: { 'clubhouse.federation.event': 'limit' } })]);
    } finally { capture.stop(); }
  });
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
  it('guards fake store snapshots against mutation outside an atomic update', async () => {
    const f = fixture(); await f.offer();
    const snapshot = f.a.deps.store.get();
    expect(() => { snapshot.requests[0].cause.depth = 7; }).toThrow();
    expect(f.a.deps.store.get().requests[0].cause.depth).toBe(0);
  });
  it('inherits current unexpired remote-linked work in later turns even after a final report', async () => {
    const f = fixture(); const sent = await f.offer(); await f.pump();
    const localId = f.b.api.list(f.b.self.agentId)[0].localRequestId;
    await f.b.api.report(f.b.self.agentId, sent.id, 'answered', 'Finished'); await f.pump();
    f.b.context.end(); f.b.context.start();
    const child = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, localId, 'Continue this work');
    expect(child.cause).toEqual({ rootId: sent.cause.rootId, depth: 1, parentId: sent.id });
    f.advance(FEDERATED_REQUEST_LIMITS.ttl + 1); f.b.context.end(); f.b.context.start();
    expect(f.b.api.cause(f.b.self.agentId, localId)).toBeUndefined();
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
  it('keeps bounded independent requests and explicit replies independent across desktops (#3553)', async () => {
    const f = fixture();
    for (let i = 0; i < 12; i++) {
      const from = i % 2 ? f.b : f.a; const to = i % 2 ? f.a : f.b;
      // A real tool sequence: hand_off_request, list, triage, final report, reply news.
      const sent = await from.api.offer(from.self.agentId, to.self.machineId, to.self.agentId, `local-${i}`, 'Inspect this independent build');
      await f.pump();
      expect(to.api.list(to.self.agentId).some((r) => r.id === sent.id)).toBe(true);
      await to.api.triage(to.self.agentId, sent.id, 'now', 'Starting build inspection');
      await f.pump();
      await to.api.report(to.self.agentId, sent.id, 'answered', 'Build inspected');
      await f.pump(); await from.api.reconcile();
      f.a.context.end(); f.b.context.end(); f.a.context.start(); f.b.context.start();
      f.advance(60_001); // Depth, not rate or queue pressure, must bound causation.
    }
    expect(f.a.file().paused).toEqual({});
    expect(f.b.file().paused).toEqual({});
  });
  it('allows 120 related autonomous hops with identical payloads and preserved ancestry', async () => {
    const f = fixture();
    let root: string | undefined;
    for (let depth = 0; depth < 120; depth++) {
      const from = depth % 2 ? f.b : f.a; const to = depth % 2 ? f.a : f.b;
      const sent = await from.api.offer(from.self.agentId, to.self.machineId, to.self.agentId, `hop-${depth}`, 'Continue the same work');
      root ??= sent.cause.rootId;
      expect(sent.cause).toMatchObject({ rootId: root, depth });
      await f.pump();
      await to.api.report(to.self.agentId, sent.id, 'answered', 'Continue the same work');
      await f.pump(); await f.a.api.reconcile(); await f.b.api.reconcile();
      f.advance(60_001); // Respect unchanged rate and queue resource controls.
    }
    expect(f.a.file().paused).toEqual({}); expect(f.b.file().paused).toEqual({});
    expect(f.a.deps.recordLimit).not.toHaveBeenCalled(); expect(f.b.deps.recordLimit).not.toHaveBeenCalled();
    expect(f.a.deps.present).not.toHaveBeenCalledWith(expect.anything(), 'pause');
  }, 60_000);
  it('ignores only retired automatic limit envelopes, retaining human and unknown reasons', async () => {
    const f = fixture();
    for (const reason of ['The cross-machine causal depth limit was reached.', 'The controller link rate limit was reached.', 'The controller link queue is full.']) {
      await f.a.api.receive(f.b.self, f.a.self.agentId, { rootId: 'old-limit', depth: 800 }, { v: 1, kind: 'pause', reason });
    }
    expect(f.a.file().paused).toEqual({});
    for (const reason of ['Paused by the person', 'An unknown pause']) {
      await f.a.api.receive(f.b.self, f.a.self.agentId, { rootId: 'pause', depth: 0 }, { v: 1, kind: 'pause', reason });
      expect(f.a.file().paused.Laptop).toBe(reason);
    }
  });
  it('refuses sustained rate excess without pausing or retrying, and admits work after the window', async () => {
    const f = fixture();
    for (let i = 0; i < FEDERATED_REQUEST_LIMITS.perMinute; i++) await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, `r-${i}`, 'Work');
    const first = f.a.file().requests[0];
    for (let i = 0; i < 50; i++) await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, `over-${i}`, 'Work')).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 60_000 });
    expect(f.a.api.allowed('Laptop', {})).toBe(true); expect(f.a.file().paused).toEqual({});
    expect(f.a.file().pauseNotices).toBeUndefined(); expect(f.a.deps.present).not.toHaveBeenCalled();
    expect(f.a.file().requests).toHaveLength(20); expect(f.a.deps.send).toHaveBeenCalledTimes(20);
    await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'r-0', 'Work'); // Existing id still replays at capacity.
    expect(f.a.file().requests[0].cause).toEqual(first.cause);
    f.advance(60_001);
    expect((await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'after-window', 'Work')).delivery).toBe('accepted');
    expect(f.a.deps.send).toHaveBeenCalledTimes(21);
  });
  it('refuses queue excess without pausing and recovers as existing work leaves the queue', async () => {
    const f = fixture(); f.disconnect();
    for (let i = 0; i < FEDERATED_REQUEST_LIMITS.queued; i++) {
      if (i === FEDERATED_REQUEST_LIMITS.perMinute) f.advance(60_001);
      await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, `queued-${i}`, 'Work');
    }
    const causes = f.a.file().requests.map((r) => r.cause);
    for (let i = 0; i < 10; i++) await expect(f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, `queue-overflow-${i}`, 'Work')).rejects.toMatchObject({ code: 'queue_full', retryAfterMs: 1000 });
    expect(f.a.api.list(f.a.self.agentId)).toHaveLength(FEDERATED_REQUEST_LIMITS.queued);
    expect(f.a.file().paused).toEqual({}); expect(f.a.deps.send).toHaveBeenCalledTimes(30);
    for (const status of f.statuses.values()) status.state = 'delivered';
    await f.a.api.reconcile();
    expect(f.a.file().requests.map((r) => r.cause)).toEqual(causes);
    expect((await f.a.api.offer(f.a.self.agentId, 'Laptop', f.b.self.agentId, 'queue-recovered', 'Work')).delivery).toBe('accepted');
    expect(f.a.deps.send).toHaveBeenCalledTimes(31);
  });
  it('never leaves a pending-news marker for rate-refused input, including concurrent attempts', async () => {
    const f = fixture();
    await f.b.deps.store.update((file) => { file.crossings.Desktop = Array(20).fill(f.b.deps.now()); });
    const send = () => f.b.api.news(f.a.self, f.b.self.agentId, { rootId: 'rate-news', depth: 900 }, { message: 'news' }, 'send_message', 'same-delivery');
    const attempts = await Promise.allSettled([send(), send(), send()]);
    expect(attempts.every((r) => r.status === 'rejected' && r.reason.code === 'rate_limited')).toBe(true);
    expect(Object.values(f.b.file().pendingNews ?? {})).toHaveLength(0);
    expect(f.b.file().paused).toEqual({}); expect(f.b.file().crossings.Desktop).toHaveLength(20);
    f.advance(60_001); const accepted = await send();
    expect(await send()).toEqual(accepted); expect(f.b.file().crossings.Desktop).toHaveLength(1);
  });
  it('inherits only news delivered into this turn, and retains the latest sample', async () => {
    const f = fixture();
    const news = await f.b.api.news(f.a.self, f.b.self.agentId, { rootId: 'news-root', depth: 4 }, { message: 'news' });
    expect(f.b.api.list(f.b.self.agentId)).toEqual([]);
    expect(f.b.deps.createLocal).not.toHaveBeenCalled();
    f.b.context.prepare(news!).accepted('prompt'); f.b.context.start();
    const next = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'response', 'Reply to news');
    expect(next.cause).toMatchObject({ rootId: 'news-root', depth: 5 });
    f.b.context.end(); f.b.context.start();
    const independent = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'independent', 'Independent work');
    expect(independent.cause.depth).toBe(0);
    await f.b.api.news(f.a.self, f.b.self.agentId, { rootId: 'latest-news', depth: 0 }, { message: 'unrelated news' });
    expect(f.b.file().news!.Desktop.cause).toEqual({ rootId: 'latest-news', depth: 0 });
  });
  it('inherits delivered request context even with omitted or unrelated linkage', async () => {
    const f = fixture(); const parent = await f.offer(); await f.pump();
    const next = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'unrelated-id', 'Follow up');
    expect(next.cause).toEqual({ rootId: parent.cause.rootId, depth: 1, parentId: parent.id });
    expect(f.b.api.cause(f.b.self.agentId)).toMatchObject({ id: parent.id });
    await expect(f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'spoof', 'Work', 'not-delivered')).rejects.toThrow('delivered into this turn');
    expect(f.b.api.cause('another-agent')).toBeUndefined();
    f.b.context.end(); f.b.context.start(); // A human turn has no delivered remote input.
    const human = await f.b.api.offer(f.b.self.agentId, 'Desktop', f.a.self.agentId, 'human', 'Human work');
    expect(human.cause.depth).toBe(0);
  });
  it('selects only among authorized delivered inputs, otherwise using the deepest in this turn', async () => {
    const f = fixture();
    const low = await f.b.api.news(f.a.self, f.b.self.agentId, { rootId: 'low', depth: 1 }, { message: 'low' });
    const high = await f.b.api.news(f.a.self, f.b.self.agentId, { rootId: 'high', depth: 5 }, { message: 'high' });
    f.b.context.prepare({ ...low!, localRequestId: 'low-task' }).accepted('prompt');
    f.b.context.prepare(high!, 'prompt', true).accepted('prompt'); f.b.context.start();
    expect(f.b.api.cause(f.b.self.agentId)?.id).toBe('high');
    expect(f.b.api.cause(f.b.self.agentId, 'unrelated')?.id).toBe('high');
    expect(f.b.api.cause(f.b.self.agentId, 'low-task')).toMatchObject({ id: 'low', cause: { depth: 5 } });
    expect(f.b.api.cause(f.b.self.agentId, undefined, 'low')).toMatchObject({ id: 'low', cause: { depth: 5 } });
    f.revoke();
    expect(f.b.api.cause(f.b.self.agentId)).toBeUndefined();
    expect(() => f.b.api.cause(f.b.self.agentId, undefined, 'high')).toThrow('authorized input');
  });
  it('sustains hundreds of independent requests and replies in both directions', async () => {
    const f = fixture();
    // The fixture deep-clones and deep-freezes the whole snapshot on every update, so the run grows with the square of
    // the count (12 s at 400 locally, 60 s on a slow Windows runner). 200 is still hundreds, in both directions.
    for (let i = 0; i < 200; i++) {
      const from = i % 2 ? f.b : f.a; const to = i % 2 ? f.a : f.b;
      const sent = await from.api.offer(from.self.agentId, to.self.machineId, to.self.agentId, `session-${i}`, 'Independent task');
      expect(sent.cause.depth).toBe(0);
      await f.pump();
      await to.api.triage(to.self.agentId, sent.id, 'now', 'Working'); await f.pump();
      await to.api.report(to.self.agentId, sent.id, 'answered', 'Done'); await f.pump();
      if (i % 20 === 19) { await f.a.api.reconcile(); await f.b.api.reconcile(); }
      expect(to.api.list(to.self.agentId).find((r) => r.id === sent.id)?.outcome).toBe('answered');
      f.a.context.end(); f.b.context.end(); f.a.context.start(); f.b.context.start(); f.advance(60_001);
    }
    await f.a.api.reconcile(); await f.b.api.reconcile();
    expect(f.a.file().paused).toEqual({}); expect(f.b.file().paused).toEqual({});
    expect(f.a.deps.recordLimit).not.toHaveBeenCalled(); expect(f.b.deps.recordLimit).not.toHaveBeenCalled();
  }, 60_000);
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
    held.context.end(); held.context.start();
    await held.api.offer(held.self.agentId, other.self.machineId, other.self.agentId, 'fresh-local-request', 'Independent new local request');
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

  it('preserves first causes through retry, duplicate replay and disconnect/reconnect', async () => {
    const f = fixture(); f.disconnect();
    const sent = await f.offer(); const delivery = structuredClone(f.queue[0]);
    await f.offer(); await f.a.api.reconcile(); await f.pump();
    expect(f.b.api.list(f.b.self.agentId)).toEqual([]);
    f.reconnect(); await f.pump(); await f.a.api.reconcile();
    const sends = vi.mocked(f.a.deps.send).mock.calls.length;
    await f.a.api.reconcile(); expect(f.a.deps.send).toHaveBeenCalledTimes(sends);
    await f.b.api.receive(f.a.self, f.b.self.agentId, { rootId: 'replayed-wrong-context', depth: 7 }, delivery.envelope);
    expect(f.b.api.list(f.b.self.agentId)[0].cause).toEqual(sent.cause);
    await f.b.api.report(f.b.self.agentId, sent.id, 'answered', 'Done');
    const reply = structuredClone(f.queue[0]);
    f.disconnect(); await f.b.api.reconcile(); await f.pump();
    f.reconnect(); await f.pump(); await f.b.api.reconcile();
    await f.a.api.receive(f.b.self, f.a.self.agentId, reply.cause, reply.envelope);
    expect(f.a.api.list(f.a.self.agentId)[0]).toMatchObject({ cause: sent.cause, outcome: 'answered', duplicates: 2 });
    expect(f.b.deps.createLocal).toHaveBeenCalledTimes(1);
    expect(f.a.file().paused).toEqual({}); expect(f.b.file().paused).toEqual({});
  });
  it('counts a retryable news admission only once even when other news arrives', async () => {
    const f = fixture();
    const cause = { rootId: 'news-root', depth: 3 };
    const original = await f.b.api.news(f.a.self, f.b.self.agentId, cause, { message: 'race' }, 'send_message', 'retryable-news');
    await f.b.api.outgoingNews('Desktop', f.a.self.agentId, { rootId: 'unrelated', depth: 0 }, { message: 'unrelated' });
    const crossings = f.b.file().crossings.Desktop.length;
    for (let i = 0; i < 200; i++) expect(await f.b.api.news(f.a.self, f.b.self.agentId, cause, { message: 'race' }, 'send_message', 'retryable-news')).toEqual(original);
    expect(f.b.file().crossings.Desktop).toHaveLength(crossings);
    expect(f.b.file().paused).toEqual({});
    await f.b.api.finishNews('Desktop', 'retryable-news'); expect(Object.values(f.b.file().pendingNews ?? {}).some((r) => r.id === 'retryable-news')).toBe(false);
  });
  it('never auto-clears a human pause on time, reconnect or a human turn, and isolates other links', async () => {
    const f = fixture();
    await f.a.api.receive(f.b.self, f.a.self.agentId, { rootId: 'human-pause', depth: 0 }, { v: 1, kind: 'pause', reason: 'Paused by the person' });
    f.disconnect(); f.advance(FEDERATED_REQUEST_LIMITS.ttl + 1); f.reconnect();
    f.a.context.end(); f.a.context.start(); await f.a.api.reconcile();
    expect(f.a.api.allowed('Laptop', {})).toBe(false);
    expect(f.a.file().paused.Laptop).toBe('Paused by the person');
    await expect(f.offer()).rejects.toThrow('paused');
    const other = await f.a.api.offer(f.a.self.agentId, 'other-computer', 'other-controller', 'other-task', 'Independent');
    expect(other.cause.depth).toBe(0); expect(f.a.api.allowed('other-computer', {})).toBe(true);
    expect(f.a.api.list('unrelated-agent')).toEqual([]);
  });

  it('refuses unrecognized/malformed envelopes and unauthorized reports', async () => {
    const f = fixture(); const r = await f.offer(); await f.pump();
    expect(parseFederationEnvelope({ v: 1, kind: 'request', id: r.id, text: 'pretend' })).toBeUndefined();
    await expect(f.b.api.report('remote-agent', r.id, 'answered', 'yes')).rejects.toThrow('Only this receiving controller');
  });
});
