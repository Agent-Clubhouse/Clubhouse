/** Durable request/outcome protocol. Agent text never supplies transport identity. */
import { randomUUID } from 'crypto';
import type { AnnexCallContext, AnnexDeliveryEpoch, AuthenticatedAnnexOrigin, AnnexDeliveryStatus } from '../../shared/annex-delivery';
import type { FederatedRequest, FederationOutcome, FederationRequestEnvelope, FederationTriage } from '../../shared/dispatcher-federation-requests';
import { deliveryHash } from './annex-delivery-store';
import { createSettingsStore } from './settings-store';
import { federationStatusChanged } from './dispatcher-federation-policy';

export class FederationInputNotReady extends Error {}

export const FEDERATED_REQUEST_LIMITS = Object.freeze({ depth: 8, queued: 30, perMinute: 20, ttl: 7 * 24 * 60 * 60_000, records: 1000 });
export interface FederationRequestFile {
  version: 1;
  requests: FederatedRequest[];
  paused: Record<string, string>;
  pauseEpochs?: Record<string, AnnexDeliveryEpoch>;
  crossings: Record<string, number[]>;
  /** Causal metadata for news; these never become DispatcherRequest records. */
  news?: Record<string, FederatedRequest>;
  pauseNotices?: Record<string, { request: FederatedRequest; localShown: boolean; peerSent: boolean }>;
}
export interface FederationRequestStore {
  get(): FederationRequestFile;
  update(change: (file: FederationRequestFile) => void, current?: () => boolean): Promise<void>;
}
const empty = (): FederationRequestFile => ({ version: 1, requests: [], paused: {}, crossings: {} });
export function createFederationRequestStore(filename = 'dispatcher-federation-requests.json'): FederationRequestStore {
  let unreadable = false;
  const store = createSettingsStore<FederationRequestFile>(filename, empty(), (raw) => {
    if (raw.version !== 1 || !Array.isArray(raw.requests) || !raw.paused || !raw.crossings) throw new Error('Invalid federated requests');
    const valid = (r: FederatedRequest) => r && typeof r.id === 'string' && typeof r.machineId === 'string'
      && typeof r.callerId === 'string' && typeof r.targetId === 'string' && typeof r.text === 'string' && typeof r.originRequestId === 'string'
      && r.origin && typeof r.origin.agentId === 'string' && typeof r.origin.machineId === 'string'
      && r.epoch && typeof r.epoch.sender === 'string' && typeof r.epoch.receiver === 'string'
      && r.cause && typeof r.cause.rootId === 'string' && Number.isSafeInteger(r.cause.depth) && r.cause.depth >= 0 && r.cause.depth <= FEDERATED_REQUEST_LIMITS.depth
      && Number.isFinite(r.createdAt) && Number.isFinite(r.expiresAt) && ['incoming', 'outgoing'].includes(r.direction)
      && ['accepted', 'delivered', 'refused', 'expired'].includes(r.delivery) && ['under_way', 'waiting_user', 'answered', 'declined', 'failed'].includes(r.outcome);
    if (!(raw.requests as FederatedRequest[]).every(valid) || (raw.news && !Object.values(raw.news).every((r) => valid(r as FederatedRequest)))) throw new Error('Invalid federated request record');
    return raw as unknown as FederationRequestFile;
  }, { atomic: true, mode: 0o600, rollBackFailedSaves: true, onLoad: (r) => {
    if ('error' in r && (r.error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable = true;
    if ('raw' in r) {
      try {
        const value = JSON.parse(r.raw);
        if (value?.version !== 1 || !Array.isArray(value.requests) || !value.paused || !value.crossings) unreadable = true;
      } catch { unreadable = true; } // telemetry-exempt: get fails closed to the caller
    }
  } });
  let committed: FederationRequestFile | undefined;
  let serial: Promise<void> = Promise.resolve();
  const get = () => {
    const value = committed ?? store.get();
    if (unreadable) throw new Error('Federated request records are unreadable; no work was admitted.');
    committed ??= structuredClone(value);
    return structuredClone(committed);
  };
  return { get, update(change, current = () => true) {
    const run = serial.catch(() => {}).then(async () => {
      const value = get();
      change(value);
      if (value.requests.length > FEDERATED_REQUEST_LIMITS.records || Buffer.byteLength(JSON.stringify(value, null, 2)) > 16 * 1024 * 1024) throw new Error('Federated request records are full.');
      const pausesBefore = JSON.stringify([committed?.paused, committed?.pauseEpochs]);
      await store.save(value, { prepare: async () => {}, check: () => { if (!current()) throw new Error('Federation authorization changed.'); } });
      committed = structuredClone(value);
      // A link tripping (or a new pairing clearing it) changes its status everywhere it shows (#3349).
      if (JSON.stringify([value.paused, value.pauseEpochs]) !== pausesBefore) federationStatusChanged();
    });
    serial = run;
    return run;
  } };
}
export interface FederationRequestDependencies {
  store: FederationRequestStore;
  now(): number;
  self(): { machineId: string; machineName: string; agentId: string; agentName: string };
  /** Both pairing epochs and the derived controller direction must still match. */
  authorized(machine: string, agentId: string, epoch: AnnexDeliveryEpoch): boolean;
  authorizedNews?(machine: string, epoch: AnnexDeliveryEpoch): boolean;
  epoch(machine: string): AnnexDeliveryEpoch;
  send(callerId: string, machine: string, targetId: string, envelope: FederationRequestEnvelope, cause: AnnexCallContext, key: string): Promise<{ deliveryId: string; error?: string }>;
  flush?(machine: string): Promise<void>;
  delivery(callerId: string, id: string): AnnexDeliveryStatus | undefined;
  createLocal(request: FederatedRequest): Promise<void>;
  settleLocal?(request: FederatedRequest): void;
  present(request: FederatedRequest, kind: 'triage' | 'needs_user' | 'reply' | 'failure' | 'pause'): Promise<void>;
  fault?(): void;
  record(request: FederatedRequest, event: 'crossing' | 'duplicate' | 'triage' | 'limit'): void;
}
const terminal = (o: FederationOutcome) => ['answered', 'declined', 'failed'].includes(o);
const nextCause = (r: FederatedRequest): AnnexCallContext => ({ rootId: r.cause.rootId, depth: r.cause.depth + 1, parentId: r.id });
const textValid = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 8000;
const idValid = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 200;
export function parseFederationEnvelope(raw: unknown): FederationRequestEnvelope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return;
  if (r.kind === 'pause' && textValid(r.reason)) return { v: 1, kind: 'pause', reason: r.reason };
  if (!idValid(r.id) || !idValid(r.originRequestId) || !textValid(r.text)) return;
  if (r.kind === 'request') return { v: 1, kind: 'request', id: r.id, originRequestId: r.originRequestId, text: r.text };
  if (r.kind === 'reply' && Number.isSafeInteger(r.revision) && Number(r.revision) > 0 && ['under_way', 'waiting_user', 'answered', 'declined', 'failed'].includes(String(r.outcome))) {
    return { v: 1, kind: 'reply', id: r.id, originRequestId: r.originRequestId, text: r.text, revision: Number(r.revision), outcome: r.outcome as FederationOutcome };
  }
}

export function createFederatedRequests(d: FederationRequestDependencies) {
  const current = (r: FederatedRequest) => !r.localRequestId && d.authorizedNews ? d.authorizedNews(r.machineId, r.epoch)
    : d.authorized(r.machineId, r.direction === 'incoming' ? r.origin.agentId : r.targetId, r.epoch);
  const read = (id: string) => d.store.get().requests.find((r) => r.id === id);
  const replace = async (id: string, change: (r: FederatedRequest, file: FederationRequestFile) => void, guard?: () => boolean) => {
    await d.store.update((file) => {
      const r = file.requests.find((r) => r.id === id);
      if (!r) throw new Error('No retained federated request with that id.');
      change(r, file);
    }, guard);
    return read(id)!;
  };
  async function showNotice(r: FederatedRequest) {
    if (!r.noticePending) return;
    if (r.noticePending === 'reply') {
      for (const prompt of r.replyPrompts ?? []) {
        if (prompt.state !== 'pending' || !current(r)) continue;
        let claimed = false;
        await replace(r.id, (saved) => {
          const entry = saved.replyPrompts?.find((p) => p.revision === prompt.revision);
          if (entry?.state === 'pending') { entry.state = 'claimed'; claimed = true; }
        }, () => current(r));
        if (!claimed) continue;
        try {
          await d.present({ ...r, outcome: prompt.outcome, reason: prompt.text, cause: prompt.cause, receivedRevision: prompt.revision }, 'reply');
          await replace(r.id, (saved) => { saved.replyPrompts!.find((p) => p.revision === prompt.revision)!.state = 'accepted'; });
        } catch (err) {
          if (err instanceof FederationInputNotReady) await replace(r.id, (saved) => { saved.replyPrompts!.find((p) => p.revision === prompt.revision)!.state = 'pending'; });
          else d.fault?.(); // Unknown input acceptance remains claimed, never blindly replayed.
        }
      }
      await replace(r.id, (saved) => { if (!saved.replyPrompts?.some((p) => p.state === 'pending')) delete saved.noticePending; });
      return;
    }
    try {
      await d.present(r, r.noticePending);
      await replace(r.id, (saved) => { if (saved.receivedRevision === r.receivedRevision && saved.noticePending === r.noticePending) delete saved.noticePending; });
    } catch { d.fault?.(); } // telemetry-exempt: the pending notice remains durable for retry
  }
  async function finishPause(machine: string) {
    const notice = d.store.get().pauseNotices?.[machine];
    if (!notice) return;
    const r = notice.request;
    if (!current(r)) return;
    if (!notice.localShown) {
      try {
        await d.present(r, 'pause');
        await d.store.update((file) => { if (file.pauseNotices?.[machine]) file.pauseNotices[machine].localShown = true; });
      } catch { d.fault?.(); } // telemetry-exempt: the pause notice remains durable
    }
    if (!notice.peerSent) {
      const sent = await d.send(d.self().agentId, machine, r.direction === 'incoming' ? r.origin.agentId : r.targetId,
        { v: 1, kind: 'pause', reason: r.reason ?? 'A fixed controller limit was reached.' },
        { rootId: r.cause.rootId, depth: Math.min(r.cause.depth, FEDERATED_REQUEST_LIMITS.depth), parentId: r.id }, `pause:${r.cause.rootId}`);
      if (sent.deliveryId && !sent.error) await d.store.update((file) => { if (file.pauseNotices?.[machine]) file.pauseNotices[machine].peerSent = true; });
    }
  }
  async function pause(r: FederatedRequest, reason: string, informPeer = true) {
    if (!current(r)) return;
    await d.store.update((file) => {
      file.paused[r.machineId] = reason; (file.pauseEpochs ??= {})[r.machineId] = r.epoch;
      const previous = file.pauseNotices?.[r.machineId];
      if (!previous || deliveryHash(previous.request.epoch) !== deliveryHash(r.epoch)) (file.pauseNotices ??= {})[r.machineId] = { request: { ...r, reason }, localShown: false, peerSent: !informPeer };
    }, () => current(r));
    d.record(r, 'limit');
    await finishPause(r.machineId);
  }
  async function admit(r: FederatedRequest) {
    let reason: string | undefined;
    await d.store.update((file) => {
      if (file.paused[r.machineId] && (!file.pauseEpochs?.[r.machineId] || deliveryHash(file.pauseEpochs[r.machineId]) === deliveryHash(r.epoch))) throw new Error(`Controller link is paused: ${file.paused[r.machineId]}`);
      if (file.requests.some((q) => q.id === r.id || (r.direction === 'outgoing' && q.direction === 'outgoing' && q.callerId === r.callerId && q.machineId === r.machineId && q.targetId === r.targetId && q.originRequestId === r.originRequestId))) throw new Error('This request was already admitted. Retry with the same request id.');
      const now = d.now();
      const recent = (file.crossings[r.machineId] ?? []).filter((at) => now - at < 60_000);
      if (r.cause.depth >= FEDERATED_REQUEST_LIMITS.depth) reason = 'The cross-machine causal depth limit was reached.';
      else if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) reason = 'The controller link rate limit was reached.';
      else if (file.requests.filter((q) => q.machineId === r.machineId && (q.delivery === 'accepted' || (q.direction === 'incoming' && !terminal(q.outcome)))).length >= FEDERATED_REQUEST_LIMITS.queued) reason = 'The controller link queue is full.';
      if (reason) { file.paused[r.machineId] = reason; (file.pauseEpochs ??= {})[r.machineId] = r.epoch; return; }
      file.crossings[r.machineId] = [...recent, now];
      // Retain ids longer than the transport's retry window; never evict live work.
      file.requests = file.requests.filter((q) => now < q.expiresAt + 24 * 60 * 60_000
        || q.noticePending || q.promptState === 'pending' || q.promptState === 'claimed'
        || q.replyPrompts?.some((p) => p.state === 'pending' || p.state === 'claimed')
        || q.replies?.some((p) => !p.delivery || p.delivery === 'accepted')
        || (!terminal(q.outcome) && q.delivery === 'delivered' && current(q)));
      file.requests.push(r);
    }, () => current(r));
    if (reason) { d.record({ ...r, delivery: 'refused' }, 'crossing'); await pause(r, reason); throw new Error(reason); }
    d.record(r, 'crossing');
  }
  async function presentIncoming(request: FederatedRequest) {
    if (!current(request) || terminal(request.outcome)) return;
    let claimed = false;
    await replace(request.id, (r) => { if (r.promptState === 'pending') { r.promptState = 'claimed'; claimed = true; } }, () => current(request));
    if (!claimed) return;
    try {
      await d.createLocal(request);
    } catch (err) {
      await replace(request.id, (r) => { r.promptState = 'pending'; });
      throw err;
    }
    try {
      await d.present(request, 'triage');
      await replace(request.id, (r) => { r.promptState = 'accepted'; });
    } catch (err) {
      if (!(err instanceof FederationInputNotReady)) d.fault?.();
      await replace(request.id, (r) => {
        // An unknown runtime failure can follow accepted input. Keep the request
        // discoverable by list_remote_requests; never blindly replay that prompt.
        r.promptState = err instanceof FederationInputNotReady ? 'pending' : 'claimed';
        r.reason = err instanceof FederationInputNotReady ? 'Waiting for this controller to be ready.' : 'Controller input acceptance is unconfirmed. Inspect this request before continuing.';
      });
    }
  }
  async function sendPending(r: FederatedRequest) {
    if (!current(r) || (d.store.get().paused[r.machineId] && (!d.store.get().pauseEpochs?.[r.machineId] || deliveryHash(d.store.get().pauseEpochs![r.machineId]) === deliveryHash(r.epoch)))) return;
    if (r.direction === 'outgoing' && !r.deliveryId && r.delivery === 'accepted' && d.now() < r.expiresAt) {
      const sent = await d.send(r.callerId, r.machineId, r.targetId, { v: 1, kind: 'request', id: r.id, originRequestId: r.originRequestId, text: r.text }, r.cause, r.id);
      await replace(r.id, (q) => { q.deliveryId = sent.deliveryId; if (sent.error) { q.delivery = 'refused'; q.reason = sent.error; } });
    }
    for (const reply of r.replies ?? []) {
      if (reply.delivery === 'delivered' || reply.delivery === 'refused' || reply.delivery === 'expired') continue;
      const status = reply.deliveryId && d.delivery(d.self().agentId, reply.deliveryId);
      const failed = status && ['refused', 'expired', 'indeterminate'].includes(status.state);
      if (failed || (!reply.deliveryId && d.now() >= (reply.expiresAt ?? r.expiresAt))) {
        const reason = status ? `Reply ${reply.revision} could not be delivered: ${status.reason ?? status.state}.` : `Reply ${reply.revision} expired while waiting for durable admission.`;
        const updated = await replace(r.id, (q) => { const saved = q.replies!.find((x) => x.revision === reply.revision)!; saved.delivery = status && status.state !== 'expired' ? 'refused' : 'expired'; saved.error = reason; q.reason = reason; q.noticePending = 'failure'; });
        await showNotice(updated);
        continue;
      }
      if (reply.deliveryId) {
        if (status && status.state === 'delivered') await replace(r.id, (q) => { q.replies!.find((x) => x.revision === reply.revision)!.delivery = 'delivered'; });
        continue;
      }
      const sent = await d.send(d.self().agentId, r.machineId, r.origin.agentId, { v: 1, kind: 'reply', id: r.id, originRequestId: r.originRequestId, revision: reply.revision, outcome: reply.outcome, text: reply.text }, nextCause(r), `${r.id}:reply:${reply.revision}`);
      const admitted = sent.deliveryId && d.delivery(d.self().agentId, sent.deliveryId);
      await replace(r.id, (q) => { const saved = q.replies?.find((x) => x.revision === reply.revision); if (saved) { if (admitted) { saved.deliveryId = sent.deliveryId; saved.delivery = 'accepted'; } saved.error = sent.error ?? (!admitted ? 'The reply has not been admitted to durable delivery; retry pending.' : undefined); } });
    }
  }
  return {
    pauseReason(machine: string): string | undefined {
      return this.allowed(machine, {}) ? undefined : d.store.get().paused[machine];
    },
    allowed(machine: string, args: Record<string, unknown>, tool = 'hand_off_request') {
      const envelope = tool === 'hand_off_request' ? parseFederationEnvelope(args.envelope) : undefined;
      const file = d.store.get();
      return envelope?.kind === 'pause' || !file.paused[machine] || (!!file.pauseEpochs?.[machine] && deliveryHash(file.pauseEpochs[machine]) !== deliveryHash(d.epoch(machine)));
    },
    async crossing(machine: string, cause: AnnexCallContext | undefined, args: Record<string, unknown>, tool = 'hand_off_request') {
      if (!this.allowed(machine, args, tool)) throw new Error('The controller link is paused after a fixed limit was reached.');
      const envelope = tool === 'hand_off_request' ? parseFederationEnvelope(args.envelope) : undefined;
      if (envelope?.kind === 'pause' || envelope?.kind === 'request') return;
      const file = d.store.get();
      const parent = [...file.requests, ...Object.values(file.news ?? {})].filter((r) => r.machineId === machine).sort((a, b) => b.createdAt - a.createdAt)[0];
      let reason: string | undefined;
      await d.store.update((file) => {
        const recent = (file.crossings[machine] ?? []).filter((at) => d.now() - at < 60_000);
        if (cause && cause.depth >= FEDERATED_REQUEST_LIMITS.depth) reason = 'The cross-machine causal depth limit was reached.';
        else if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) reason = 'The controller link rate limit was reached.';
        if (reason) { file.paused[machine] = reason; (file.pauseEpochs ??= {})[machine] = d.epoch(machine); }
        else file.crossings[machine] = [...recent, d.now()];
      });
      if (reason) { if (parent) await pause({ ...parent, reason }, reason); throw new Error(reason); }
    },
    async duplicate(machine: string, agent: string, args: Record<string, unknown>) {
      const envelope = parseFederationEnvelope(args.envelope);
      if (!envelope || envelope.kind === 'pause') return;
      const found = read(envelope.id);
      if (!found || found.machineId !== machine || (found.direction === 'incoming' ? found.origin.agentId : found.targetId) !== agent || !current(found)) return;
      const updated = await replace(found.id, (r) => { r.duplicates++; });
      d.record(updated, 'duplicate');
    },
    async outgoingNews(machine: string, targetId: string, cause: AnnexCallContext, args: Record<string, unknown>, tool = 'send_message', callerId = d.self().agentId) {
      if (tool === 'hand_off_request' && parseFederationEnvelope(args.envelope)) return this.crossing(machine, cause, args, tool);
      const sample: FederatedRequest = {
        id: cause.rootId, direction: 'outgoing', callerId, machineId: machine, targetId, origin: { ...d.self(), agentId: callerId, ...(callerId !== d.self().agentId && { agentName: callerId }) }, originRequestId: cause.rootId,
        localRequestId: '', text: '', cause, epoch: d.epoch(machine), createdAt: d.now(), expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl,
        delivery: 'accepted', outcome: 'under_way', revision: 0, receivedRevision: 0, duplicates: 0,
      };
      await d.store.update((file) => { (file.news ??= {})[machine] = sample; }, () => current(sample));
      await this.crossing(machine, cause, args, tool);
      d.record(sample, 'crossing');
    },
    async news(origin: AuthenticatedAnnexOrigin, targetId: string, cause: AnnexCallContext, args: Record<string, unknown>, tool = 'send_message') {
      const sample: FederatedRequest = {
        id: cause.rootId, direction: 'incoming', callerId: targetId, machineId: origin.machineId, targetId, origin, originRequestId: cause.rootId,
        localRequestId: '', text: '', cause, epoch: d.epoch(origin.machineId), createdAt: d.now(), expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl,
        delivery: 'delivered', outcome: 'under_way', revision: 0, receivedRevision: 0, duplicates: 0,
      };
      await d.store.update((file) => {
        const previous = file.news?.[origin.machineId];
        if (!previous || previous.cause.depth <= cause.depth || previous.expiresAt <= d.now()) (file.news ??= {})[origin.machineId] = sample;
      }, () => current(sample));
      try { await this.crossing(origin.machineId, cause, args, tool); d.record(sample, 'crossing'); }
      catch (err) {
        if (d.store.get().paused[origin.machineId]) await pause(sample, d.store.get().paused[origin.machineId]);
        throw err;
      }
    },
    list(callerId: string) { return d.store.get().requests.filter((r) => r.callerId === callerId || d.self().agentId === callerId); },
    /** Inherit causal depth from live incoming work; caller-supplied context is never consulted. */
    cause() {
      const file = d.store.get();
      const active = [...file.requests, ...Object.values(file.news ?? {})].filter((r) => (r.direction === 'incoming' || r.localRequestId === '') && !terminal(r.outcome) && r.expiresAt > d.now() && current(r));
      return active.sort((a, b) => b.cause.depth - a.cause.depth)[0];
    },
    async offer(callerId: string, machineId: string, targetId: string, originRequestId: string, text: string, freshLocalRequest = false) {
      if (!idValid(originRequestId) || !textValid(text)) throw new Error('Give an origin request id and request text (at most 8000 characters).');
      const old = d.store.get().requests.find((r) => r.direction === 'outgoing' && r.callerId === callerId && r.machineId === machineId && r.targetId === targetId && r.originRequestId === originRequestId);
      if (old) {
        if (old.text !== text || !current(old)) throw new Error('This request id already names different content or a former pairing.');
        const duplicate = await replace(old.id, (r) => { r.duplicates++; });
        d.record(duplicate, 'duplicate');
        return duplicate;
      }
      const self = d.self();
      const parent = freshLocalRequest ? undefined : this.cause();
      const id = randomUUID();
      const request: FederatedRequest = {
        id, direction: 'outgoing', callerId, machineId, targetId, origin: { ...self, agentId: callerId }, originRequestId,
        localRequestId: originRequestId, text, cause: parent ? nextCause(parent) : { rootId: id, depth: 0 }, epoch: d.epoch(machineId),
        createdAt: d.now(), expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl, delivery: 'accepted', outcome: 'under_way', revision: 0, receivedRevision: 0, duplicates: 0,
      };
      await admit(request);
      try { await sendPending(request); } catch { d.fault?.(); } // telemetry-exempt: durable admission is retained and reconciled
      return read(id)!;
    },
    async receive(origin: AuthenticatedAnnexOrigin, targetId: string, cause: AnnexCallContext, raw: unknown) {
      const envelope = parseFederationEnvelope(raw);
      if (!envelope) throw new Error('Malformed federated request envelope.');
      const epoch = d.epoch(origin.machineId);
      if (!d.authorized(origin.machineId, origin.agentId, epoch)) throw new Error('Controller link is no longer authorized.');
      if (envelope.kind === 'pause') {
        await d.store.update((file) => { file.paused[origin.machineId] = envelope.reason; (file.pauseEpochs ??= {})[origin.machineId] = epoch; }, () => d.authorized(origin.machineId, origin.agentId, epoch));
        const file = d.store.get();
        const news = file.news?.[origin.machineId];
        const sample: FederatedRequest = file.requests.find((r) => r.machineId === origin.machineId && current(r)) ?? (news && current(news) ? news : undefined) ?? {
          id: cause.rootId, direction: 'incoming', callerId: targetId, machineId: origin.machineId, targetId, origin, originRequestId: cause.rootId,
          localRequestId: '', text: '', cause, epoch, createdAt: d.now(), expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl,
          delivery: 'delivered', outcome: 'under_way', revision: 0, receivedRevision: 0, duplicates: 0,
        };
        await pause(sample, envelope.reason, false);
        return;
      }
      if (envelope.kind === 'reply') {
        const original = read(envelope.id);
        if (!original || original.direction !== 'outgoing' || original.machineId !== origin.machineId || original.targetId !== origin.agentId
          || original.originRequestId !== envelope.originRequestId || !current(original)
          || cause.rootId !== original.cause.rootId || cause.depth <= original.cause.depth) throw new Error('Reply does not match an authorized origin request and cause.');
        if (cause.depth >= FEDERATED_REQUEST_LIMITS.depth) { await pause(original, 'The cross-machine causal depth limit was reached.'); throw new Error('Causal depth limit reached.'); }
        if (envelope.revision <= original.receivedRevision) {
          const r = await replace(original.id, (r) => { r.duplicates++; }); d.record(r, 'duplicate'); return r;
        }
        if (terminal(original.outcome)) throw new Error('The receiver already reported a final outcome.');
        let replay = false;
        const updated = await replace(original.id, (r, file) => {
          if (envelope.revision <= r.receivedRevision) { r.duplicates++; replay = true; return; }
          if (terminal(r.outcome)) throw new Error('The receiver already reported a final outcome.');
          r.outcome = envelope.outcome; r.receivedRevision = envelope.revision; r.reason = envelope.text; r.noticePending = 'reply';
          if ((r.replyPrompts?.length ?? 0) >= 64) throw new Error('This request has reached its report limit.');
          (r.replyPrompts ??= []).push({ revision: envelope.revision, outcome: envelope.outcome, text: envelope.text, cause, state: 'pending' });
          (file.news ??= {})[origin.machineId] = { ...r, direction: 'incoming', origin, targetId, cause, localRequestId: '', outcome: 'under_way', text: '' };
        }, () => current(original));
        if (replay) { d.record(updated, 'duplicate'); return updated; }
        await showNotice(updated);
        d.record(updated, 'crossing');
        return updated;
      }
      const existing = read(envelope.id);
      if (existing) {
        if (existing.direction !== 'incoming' || deliveryHash(existing.epoch) !== deliveryHash(epoch) || existing.origin.machineId !== origin.machineId
          || existing.origin.agentId !== origin.agentId || existing.text !== envelope.text || existing.originRequestId !== envelope.originRequestId) throw new Error('Request id conflicts with an existing request.');
        const r = await replace(existing.id, (r) => { r.duplicates++; }); d.record(r, 'duplicate');
        if (r.promptState === 'pending') { try { await presentIncoming(r); } catch { d.fault?.(); } } // telemetry-exempt: durable admission is retained and reconciled
        return r;
      }
      const request: FederatedRequest = {
        id: envelope.id, direction: 'incoming', callerId: targetId, machineId: origin.machineId, targetId,
        origin, originRequestId: envelope.originRequestId, localRequestId: `remote_${deliveryHash([origin.machineId, epoch, envelope.id]).slice(0, 32)}`,
        text: envelope.text, cause, epoch, createdAt: d.now(), expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl,
        delivery: 'delivered', outcome: 'under_way', promptState: 'pending', revision: 0, receivedRevision: 0, duplicates: 0,
      };
      await admit(request);
      try { await presentIncoming(request); } catch { d.fault?.(); } // telemetry-exempt: durable admission is retained and reconciled
      return read(request.id)!;
    },
    async report(callerId: string, id: string, outcome: FederationOutcome, text: string) {
      const found = read(id);
      if (callerId !== d.self().agentId || !found || found.direction !== 'incoming' || !current(found)) throw new Error('Only this receiving controller can report this request.');
      if (!textValid(text)) throw new Error('Give a short explicit outcome or reason.');
      if (terminal(found.outcome)) throw new Error('This request already has a final outcome.');
      const cause = nextCause(found);
      if (cause.depth >= FEDERATED_REQUEST_LIMITS.depth) { await pause(found, 'The cross-machine causal depth limit was reached.'); throw new Error('Causal depth limit reached.'); }
      const updated = await replace(id, (r) => {
        if (terminal(r.outcome)) throw new Error('This request already has a final outcome.');
        if ((r.replies?.length ?? 0) >= 64) throw new Error('This request has reached its report limit.');
        r.outcome = outcome; r.reason = text; r.revision++;
        (r.replies ??= []).push({ revision: r.revision, outcome, text, expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl });
      }, () => current(found));
      d.settleLocal?.(updated);
      try { await sendPending(updated); } catch { d.fault?.(); } // telemetry-exempt: the explicit report is retained for durable retry
      d.record(updated, 'crossing');
      return updated;
    },
    async triage(callerId: string, id: string, choice: FederationTriage, reason: string) {
      if (!['now', 'check_in', 'needs_user', 'decline'].includes(choice)) throw new Error('Choose now, check_in, needs_user or decline.');
      const found = read(id);
      if (callerId !== d.self().agentId || !found || found.direction !== 'incoming' || terminal(found.outcome) || !current(found)) throw new Error('Only the receiving controller can triage this live request.');
      if (!textValid(reason)) throw new Error('Give the reason for this triage choice.');
      const updated = await replace(id, (r) => { r.triage = choice; if (choice === 'needs_user') { r.reason = reason; r.noticePending = 'needs_user'; } }, () => current(found));
      d.record(updated, 'triage');
      if (choice === 'needs_user') await showNotice(updated);
      return this.report(callerId, id, choice === 'decline' ? 'declined' : choice === 'needs_user' ? 'waiting_user' : 'under_way', reason);
    },
    async reconcile() {
      const file = d.store.get();
      for (const machine of Object.keys(file.pauseNotices ?? {})) await finishPause(machine);
      for (const machine of new Set([...file.requests.map((r) => r.machineId), ...Object.keys(file.news ?? {})])) await d.flush?.(machine);
      for (const request of d.store.get().requests) {
        await sendPending(request);
        await showNotice(request);
        if (request.direction === 'incoming' && request.promptState === 'pending' && this.allowed(request.machineId, {})) await presentIncoming(request);
        if (!current(request) && request.direction === 'incoming' && !request.revocationNotified) {
          const revoked = await replace(request.id, (r) => { r.revocationNotified = true; r.noticePending = 'failure'; r.reason = 'The origin computer or controller link was removed. Queued replies have been dropped.'; });
          await showNotice({ ...revoked, delivery: 'refused' });
        }
        const status = request.deliveryId && d.delivery(request.callerId, request.deliveryId);
        const state = request.delivery !== 'accepted' ? request.delivery : !current(request) ? 'refused' : status && status.state === 'delivered' ? 'delivered' : d.now() >= request.expiresAt && request.delivery === 'accepted' ? 'expired'
          : status && ['refused', 'expired', 'indeterminate'].includes(status.state) ? status.state === 'expired' ? 'expired' : 'refused'
          : request.delivery;
        if (state === request.delivery) continue;
        const updated = await replace(request.id, (r) => { r.delivery = state; if (state === 'refused' || state === 'expired') r.noticePending = 'failure'; r.reason = !current(request) ? 'The network member or controller link was removed.' : status ? status.reason : 'The request expired while waiting for the other machine.'; });
        d.record(updated, 'crossing');
        if (state === 'refused' || state === 'expired') await showNotice(updated);
      }
    },
  };
}
export type FederatedRequests = ReturnType<typeof createFederatedRequests>;
