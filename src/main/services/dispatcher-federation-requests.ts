/** Durable request/outcome protocol. Agent text never supplies transport identity. */
import { randomUUID } from 'crypto';
import type { AnnexCallContext, AnnexDeliveryEpoch, AuthenticatedAnnexOrigin, AnnexDeliveryStatus } from '../../shared/annex-delivery';
import type { FederatedRequest, FederationOutcome, FederationRequestEnvelope, FederationTriage } from '../../shared/dispatcher-federation-requests';
import { deliveryHash } from './annex-delivery-store';
import { createSettingsStore } from './settings-store';
import { createRequestPauseDisplayReader, projectRequestPauseForDisplay, type RequestPauseDisplayReader } from './federation-pause-display';
import { federationStatusChanged } from './dispatcher-federation-policy';
import { appLog } from './log-service';

export const LEGACY_DEPTH_PAUSE = 'The cross-machine causal depth limit was reached.';
export const LEGACY_RATE_PAUSE = 'The controller link rate limit was reached.';
export const LEGACY_QUEUE_PAUSE = 'The controller link queue is full.';
const retiredLimitPause = (reason: string) => [LEGACY_DEPTH_PAUSE, LEGACY_RATE_PAUSE, LEGACY_QUEUE_PAUSE].includes(reason);

/** Only the retired automatic fixed-limit pauses are lifted. Human and unknown pauses stay. */
export function liftLegacyLimitPauses(file: FederationRequestFile): boolean {
  let changed = false;
  for (const [machine, reason] of Object.entries(file.paused)) {
    if (!retiredLimitPause(reason)) continue;
    delete file.paused[machine];
    delete file.pauseEpochs?.[machine];
    delete file.pauseNotices?.[machine];
    changed = true;
  }
  return changed;
}

/** Repair only the tracing arithmetic overflow written by older builds. */
function repairStoredDepths(file: FederationRequestFile): boolean {
  let repaired = false;
  const repair = (cause: AnnexCallContext | undefined) => {
    if (cause && Number.isInteger(cause.depth) && Number.isFinite(cause.depth) && cause.depth > Number.MAX_SAFE_INTEGER) {
      cause.depth = Number.MAX_SAFE_INTEGER; repaired = true;
    }
  };
  for (const record of [...file.requests, ...Object.values(file.news ?? {}), ...Object.values(file.pendingNews ?? {}),
    ...Object.values(file.pauseNotices ?? {}).map((notice) => notice?.request)]) {
    repair(record?.cause);
    if (Array.isArray(record?.replyPrompts)) for (const prompt of record.replyPrompts) repair(prompt?.cause);
  }
  return repaired;
}

export class FederationInputNotReady extends Error {}

export { FEDERATED_REQUEST_LIMITS } from '../../shared/dispatcher-federation-requests';
import { FEDERATED_REQUEST_LIMITS, FederationBackpressure, FederationRefusal, assertFederationDepth, nextFederationDepth } from '../../shared/dispatcher-federation-requests';
export interface FederationRequestFile {
  version: 1;
  requests: FederatedRequest[];
  paused: Record<string, string>;
  pauseEpochs?: Record<string, AnnexDeliveryEpoch>;
  crossings: Record<string, number[]>;
  /** Causal metadata for news; these never become DispatcherRequest records. */
  news?: Record<string, FederatedRequest>;
  /** Count an admitted news input only once while runtime delivery is retryable. */
  pendingNews?: Record<string, FederatedRequest>;
  pauseNotices?: Record<string, { request: FederatedRequest; localShown: boolean; peerSent: boolean }>;
}
export interface FederationRequestStore {
  get(): FederationRequestFile;
  /** Existing committed service view only; never get/ready/repair/clone raw requests for display. */
  readPauseForDisplay?: RequestPauseDisplayReader;
  /** Persist any retired automatic pause before reconciliation sends saved work. */
  ready?(): Promise<void>;
  update(change: (file: FederationRequestFile) => void, current?: () => boolean): Promise<void>;
}
const empty = (): FederationRequestFile => ({ version: 1, requests: [], paused: {}, crossings: {} });
export function createFederationRequestStore(filename = 'dispatcher-federation-requests.json'): FederationRequestStore {
  let unreadable = false;
  let depthRepairPending = false;
  const store = createSettingsStore<FederationRequestFile>(filename, empty(), (raw) => {
    if (raw.version !== 1 || !Array.isArray(raw.requests) || !raw.paused || !raw.crossings) throw new Error('Invalid federated requests');
    depthRepairPending = repairStoredDepths(raw as unknown as FederationRequestFile) || depthRepairPending;
    const valid = (r: FederatedRequest) => r && typeof r.id === 'string' && typeof r.machineId === 'string'
      && typeof r.callerId === 'string' && typeof r.targetId === 'string' && typeof r.text === 'string' && typeof r.originRequestId === 'string'
      && r.origin && typeof r.origin.agentId === 'string' && typeof r.origin.machineId === 'string'
      && r.epoch && typeof r.epoch.sender === 'string' && typeof r.epoch.receiver === 'string'
      && r.cause && typeof r.cause.rootId === 'string' && Number.isSafeInteger(r.cause.depth) && r.cause.depth >= 0
      && Number.isFinite(r.createdAt) && Number.isFinite(r.expiresAt) && ['incoming', 'outgoing'].includes(r.direction)
      && ['accepted', 'delivered', 'refused', 'expired'].includes(r.delivery) && ['under_way', 'waiting_user', 'answered', 'declined', 'failed'].includes(r.outcome);
    if (!(raw.requests as FederatedRequest[]).every(valid) || (raw.news && !Object.values(raw.news).every((r) => valid(r as FederatedRequest))) || (raw.pendingNews && !Object.values(raw.pendingNews).every((r) => valid(r as FederatedRequest)))) throw new Error('Invalid federated request record');
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
  let migrationPending = false;
  let serial: Promise<void> = Promise.resolve();
  const get = () => {
    const value = committed ?? store.get();
    if (unreadable) throw new Error('Federated request records are unreadable; no work was admitted.');
    if (!committed) {
      committed = structuredClone(value);
      migrationPending = liftLegacyLimitPauses(committed);
    }
    return structuredClone(committed);
  };
  const readPauseForDisplay = createRequestPauseDisplayReader((machine) => {
    if (!committed || unreadable || !committed.paused || typeof committed.paused !== 'object' || Array.isArray(committed.paused)) return undefined;
    const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
    if (!own(committed.paused, machine) && machine in committed.paused) return undefined;
    const reason = own(committed.paused, machine) ? committed.paused[machine] : undefined;
    const epochs = committed.pauseEpochs;
    const epochUnavailable = epochs !== undefined && (!epochs || typeof epochs !== 'object' || Array.isArray(epochs)
      || !own(epochs, machine) && machine in epochs);
    return projectRequestPauseForDisplay(reason, epochs && own(epochs, machine) ? epochs[machine] : undefined, epochUnavailable);
  });
  return { get, readPauseForDisplay, async ready() { get(); if (migrationPending || depthRepairPending) await this.update(() => {}); }, update(change, current = () => true) {
    const run = serial.catch(() => {}).then(async () => {
      const value = get();
      change(value);
      if (value.requests.length > FEDERATED_REQUEST_LIMITS.records || Buffer.byteLength(JSON.stringify(value, null, 2)) > 16 * 1024 * 1024) throw new Error('Federated request records are full.');
      const pausesBefore = JSON.stringify([committed?.paused, committed?.pauseEpochs]);
      await store.save(value, { prepare: async () => {}, check: () => { if (!current()) throw new Error('Federation authorization changed.'); } });
      committed = structuredClone(value);
      if (migrationPending) {
        migrationPending = false;
        appLog('core:dispatcher', 'info', 'Retired Dispatcher limit pause cleared', { meta: { state: 'legacy_limit_pause_cleared' } });
        federationStatusChanged();
      }
      if (depthRepairPending) {
        depthRepairPending = false;
        appLog('core:dispatcher', 'info', 'Dispatcher tracing depth metadata repaired', { meta: { state: 'federation_depth_metadata_repaired' } });
      }
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
  /** Runtime-owned input actually delivered into this caller's current turn. */
  inputs?(callerId: string): readonly FederatedRequest[];
  requestInputs?(callerId: string, requestId: string): readonly FederatedRequest[];
  self(): { machineId: string; machineName: string; agentId: string; agentName: string };
  /** Both pairing epochs and the derived controller direction must still match. */
  authorized(machine: string, agentId: string, epoch: AnnexDeliveryEpoch): boolean;
  authorizedNews?(machine: string, epoch: AnnexDeliveryEpoch): boolean;
  /**
   * Not authorized only because that member, same pairing, hasn't published its
   * controller yet: a restart (#3829). Such a request waits, until its expiry.
   */
  awaitingController?(machine: string, epoch: AnnexDeliveryEpoch): boolean;
  epoch(machine: string): AnnexDeliveryEpoch;
  send(callerId: string, machine: string, targetId: string, envelope: FederationRequestEnvelope, cause: AnnexCallContext, key: string): Promise<{ deliveryId: string; error?: string }>;
  flush?(machine: string): Promise<void>;
  delivery(callerId: string, id: string): AnnexDeliveryStatus | undefined;
  createLocal(request: FederatedRequest): Promise<void>;
  settleLocal?(request: FederatedRequest): void;
  present(request: FederatedRequest, kind: 'triage' | 'needs_user' | 'reply' | 'failure' | 'pause'): Promise<void>;
  fault?(): void;
  recordLimit(): void;
  record(request: FederatedRequest, event: 'crossing' | 'duplicate' | 'triage'): void;
}
const terminal = (o: FederationOutcome) => ['answered', 'declined', 'failed'].includes(o);
const nextCause = (r: FederatedRequest): AnnexCallContext => ({ rootId: r.cause.rootId, depth: nextFederationDepth(r.cause.depth), parentId: r.id });
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
  // Capture only an own data-property adapter, without executing accessors or
  // adopting a later replacement. The ordinary request service already owns d.
  let displayPause: RequestPauseDisplayReader | undefined;
  try {
    const pauseDescriptor = Object.getOwnPropertyDescriptor(d.store, 'readPauseForDisplay');
    if (pauseDescriptor && 'value' in pauseDescriptor && typeof pauseDescriptor.value === 'function') displayPause = pauseDescriptor.value;
  } catch { /* telemetry-exempt: optional display support cannot break ordinary service construction. */ }
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
        { rootId: r.cause.rootId, depth: r.cause.depth, parentId: r.id }, `pause:${r.cause.rootId}`);
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
    d.recordLimit();
    await finishPause(r.machineId);
  }
  async function admit(r: FederatedRequest) {
    let pressure: FederationBackpressure | undefined;
    await d.store.update((file) => {
      if (file.paused[r.machineId] && (!file.pauseEpochs?.[r.machineId] || deliveryHash(file.pauseEpochs[r.machineId]) === deliveryHash(r.epoch))) throw new Error(`Controller connection is paused: ${file.paused[r.machineId]}`);
      if (file.requests.some((q) => q.id === r.id || (r.direction === 'outgoing' && q.direction === 'outgoing' && q.callerId === r.callerId && q.machineId === r.machineId && q.targetId === r.targetId && q.originRequestId === r.originRequestId))) throw new Error('This request was already admitted. Retry with the same request id.');
      const now = d.now();
      const recent = (file.crossings[r.machineId] ?? []).filter((at) => now - at < 60_000);
      if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) pressure = new FederationBackpressure('rate_limited', LEGACY_RATE_PAUSE, Math.max(1, Math.min(...recent) + 60_000 - d.now()));
      else if (file.requests.filter((q) => q.machineId === r.machineId && (q.delivery === 'accepted' || (q.direction === 'incoming' && !terminal(q.outcome)))).length >= FEDERATED_REQUEST_LIMITS.queued) pressure = new FederationBackpressure('queue_full', LEGACY_QUEUE_PAUSE, 1000);
      if (pressure) return;
      file.crossings[r.machineId] = [...recent, now];
      // Retain ids longer than the transport's retry window; never evict live work.
      file.requests = file.requests.filter((q) => now < q.expiresAt + 24 * 60 * 60_000
        || q.noticePending || q.promptState === 'pending' || q.promptState === 'claimed'
        || q.replyPrompts?.some((p) => p.state === 'pending' || p.state === 'claimed')
        || q.replies?.some((p) => !p.delivery || p.delivery === 'accepted')
        || (!terminal(q.outcome) && q.delivery === 'delivered' && current(q)));
      file.requests.push(r);
    }, () => current(r));
    if (pressure) { d.record({ ...r, delivery: 'refused' }, 'crossing'); d.recordLimit(); throw pressure; }
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
      let cause: AnnexCallContext;
      try { cause = nextCause(r); }
      catch (err) {
        if (!(err instanceof FederationRefusal)) throw err;
        await replace(r.id, (q) => { const saved = q.replies!.find((x) => x.revision === reply.revision)!; saved.delivery = 'refused'; saved.error = err.code; });
        continue; // A repaired legacy trace cannot block unrelated retained work.
      }
      if (!reply.rateAdmitted) {
        // Unmarked legacy reports were already accepted. Reserve once before
        // dispatch, retaining their original ID and existing retry behavior.
        let pressure = false;
        await replace(r.id, (q, file) => {
          const saved = q.replies!.find((x) => x.revision === reply.revision)!;
          if (saved.rateAdmitted) return;
          const recent = (file.crossings[r.machineId] ?? []).filter((at) => d.now() - at < 60_000);
          if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) { pressure = true; return; }
          file.crossings[r.machineId] = [...recent, d.now()]; saved.rateAdmitted = true;
        }, () => current(r));
        if (pressure) continue;
      }
      const sent = await d.send(d.self().agentId, r.machineId, r.origin.agentId, { v: 1, kind: 'reply', id: r.id, originRequestId: r.originRequestId, revision: reply.revision, outcome: reply.outcome, text: reply.text }, cause, `${r.id}:reply:${reply.revision}`);
      const admitted = sent.deliveryId && d.delivery(d.self().agentId, sent.deliveryId);
      await replace(r.id, (q) => { const saved = q.replies?.find((x) => x.revision === reply.revision); if (saved) { if (admitted) { saved.deliveryId = sent.deliveryId; saved.delivery = 'accepted'; } saved.error = sent.error ?? (!admitted ? 'The reply has not been admitted to durable delivery; retry pending.' : undefined); } });
    }
  }
  return {
    readPauseForDisplay: ((machine, options) => displayPause ? displayPause(machine, options) : {
      state: 'unavailable', inputs: [{ field: 'Established request-service pause metadata', source: 'host-cache', observedAt: Date.now() }],
    }) as RequestPauseDisplayReader,
    pauseReason(machine: string): string | undefined {
      return this.allowed(machine, {}) ? undefined : d.store.get().paused[machine];
    },
    allowed(machine: string, args: Record<string, unknown>, tool = 'hand_off_request') {
      const envelope = tool === 'hand_off_request' ? parseFederationEnvelope(args.envelope) : undefined;
      const file = d.store.get();
      return envelope?.kind === 'pause' || !file.paused[machine] || (!!file.pauseEpochs?.[machine] && deliveryHash(file.pauseEpochs[machine]) !== deliveryHash(d.epoch(machine)));
    },
    async crossing(machine: string, cause: AnnexCallContext | undefined, args: Record<string, unknown>, tool = 'hand_off_request') {
      if (cause) assertFederationDepth(cause.depth);
      if (!this.allowed(machine, args, tool)) throw new Error('The controller connection is paused after a fixed limit was reached.');
      const envelope = tool === 'hand_off_request' ? parseFederationEnvelope(args.envelope) : undefined;
      if (envelope?.kind === 'pause' || envelope?.kind === 'request' || envelope?.kind === 'reply') return; // Requests and replies reserve rate at durable admission.
      let pressure: FederationBackpressure | undefined;
      await d.store.update((file) => {
        const recent = (file.crossings[machine] ?? []).filter((at) => d.now() - at < 60_000);
        if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) pressure = new FederationBackpressure('rate_limited', LEGACY_RATE_PAUSE, Math.max(1, Math.min(...recent) + 60_000 - d.now()));
        else file.crossings[machine] = [...recent, d.now()];
      });
      if (pressure) { d.recordLimit(); throw pressure; }
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
      assertFederationDepth(cause.depth);
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
    async news(origin: AuthenticatedAnnexOrigin, targetId: string, cause: AnnexCallContext, _args: Record<string, unknown>, _tool = 'send_message', deliveryId = cause.rootId) {
      assertFederationDepth(cause.depth);
      const admissionId = deliveryHash([origin.machineId, d.epoch(origin.machineId), deliveryId]);
      const pending = d.store.get().pendingNews?.[admissionId];
      if (pending) {
        if (pending.machineId !== origin.machineId || pending.origin.agentId !== origin.agentId || pending.targetId !== targetId || !current(pending)
          || deliveryHash(pending.cause) !== deliveryHash(cause)) throw new Error('News retry does not match its admitted origin and cause.');
        return pending;
      }
      const sample: FederatedRequest = {
        id: deliveryId, direction: 'incoming', callerId: targetId, machineId: origin.machineId, targetId, origin, originRequestId: cause.rootId,
        localRequestId: '', text: '', cause, epoch: d.epoch(origin.machineId), createdAt: d.now(), expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl,
        delivery: 'delivered', outcome: 'under_way', revision: 0, receivedRevision: 0, duplicates: 0,
      };
      let pressure: FederationBackpressure | undefined;
      let admitted = sample;
      let duplicate = false;
      await d.store.update((file) => {
        // Claim and count together. Concurrent retries cannot observe an input
        // marker before resource admission has succeeded.
        const saved = file.pendingNews?.[admissionId];
        if (saved) {
          if (saved.origin.agentId !== origin.agentId || saved.targetId !== targetId || !current(saved)
            || deliveryHash(saved.cause) !== deliveryHash(cause)) throw new Error('News retry does not match its admitted origin and cause.');
          admitted = saved; duplicate = true; return;
        }
        if (file.paused[origin.machineId] && (!file.pauseEpochs?.[origin.machineId]
          || deliveryHash(file.pauseEpochs[origin.machineId]) === deliveryHash(sample.epoch))) throw new Error('The controller connection is paused.');
        const recent = (file.crossings[origin.machineId] ?? []).filter((at) => d.now() - at < 60_000);
        if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) {
          pressure = new FederationBackpressure('rate_limited', LEGACY_RATE_PAUSE, Math.max(1, Math.min(...recent) + 60_000 - d.now()));
          return;
        }
        file.crossings[origin.machineId] = [...recent, d.now()];
        (file.news ??= {})[origin.machineId] = sample;
        // Only unresolved runtime admissions need a second dedup marker.
        for (const [id, saved] of Object.entries(file.pendingNews ?? {})) if (saved.expiresAt <= d.now()) delete file.pendingNews![id];
        (file.pendingNews ??= {})[admissionId] = sample;
      }, () => current(sample));
      if (pressure) { d.recordLimit(); throw pressure; }
      if (!duplicate) d.record(sample, 'crossing');
      return admitted;
    },
    async finishNews(machine: string, deliveryId: string) {
      const admissionId = deliveryHash([machine, d.epoch(machine), deliveryId]);
      if (d.store.get().pendingNews?.[admissionId]) await d.store.update((file) => { delete file.pendingNews?.[admissionId]; });
    },
    list(callerId: string) { return d.store.get().requests.filter((r) => r.callerId === callerId || d.self().agentId === callerId); },
    /** Whether a retained request names `agentId` as that member's controller: the target it was sent to, or the origin it answers (#3829). */
    namesController(machine: string, agentId: string) {
      const fp = machine.toLowerCase();
      return d.store.get().requests.some((r) => r.machineId.toLowerCase() === fp && (r.direction === 'outgoing' ? r.targetId : r.origin.agentId) === agentId);
    },
    /** IDs may select a delivered item, but can never suppress runtime ancestry. */
    cause(callerId: string, requestId?: string, causedBy?: unknown) {
      const active = (d.inputs?.(callerId) ?? []).filter((r) => r.targetId === callerId && r.expiresAt > d.now() && current(r));
      const linked = requestId ? [...d.store.get().requests.filter((r) => r.direction === 'incoming' && r.localRequestId === requestId && r.targetId === callerId), ...(d.requestInputs?.(callerId, requestId) ?? [])].filter((r) => r.expiresAt > d.now() && current(r)) : [];
      const candidates = [...active, ...linked];
      const select = (parent: FederatedRequest | undefined) => parent && ({ ...parent, cause: { ...parent.cause, depth: Math.max(parent.cause.depth, ...candidates.map((r) => r.cause.depth)) } });
      if (causedBy !== undefined) {
        if (!idValid(causedBy)) throw new Error('caused_by must identify input delivered into this turn.');
        const selected = candidates.find((r) => r.id === causedBy);
        if (!selected) throw new Error('caused_by must identify authorized input delivered into this turn.');
        return select(selected);
      }
      const matching = requestId ? active.filter((r) => r.localRequestId === requestId) : [];
      return select([...(matching.length ? matching : linked.length ? linked : active)].sort((a, b) => b.cause.depth - a.cause.depth)[0]);
    },
    async offer(callerId: string, machineId: string, targetId: string, originRequestId: string, text: string, causedBy?: unknown) {
      if (!idValid(originRequestId) || !textValid(text)) throw new Error('Give an origin request id and request text (at most 8000 characters).');
      const old = d.store.get().requests.find((r) => r.direction === 'outgoing' && r.callerId === callerId && r.machineId === machineId && r.targetId === targetId && r.originRequestId === originRequestId);
      if (old) {
        if (old.text !== text || !current(old)) throw new Error('This request id already names different content or a former pairing.');
        const duplicate = await replace(old.id, (r) => { r.duplicates++; });
        d.record(duplicate, 'duplicate');
        return duplicate;
      }
      const self = d.self();
      const parent = this.cause(callerId, originRequestId, causedBy);
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
      assertFederationDepth(cause.depth);
      const envelope = parseFederationEnvelope(raw);
      if (!envelope) throw new Error('Malformed federated request envelope.');
      const epoch = d.epoch(origin.machineId);
      if (!d.authorized(origin.machineId, origin.agentId, epoch)) throw new Error('Controller connection is no longer authorized.');
      if (envelope.kind === 'pause') {
        // An offline older peer may still deliver a retired automatic limit notice.
        if (retiredLimitPause(envelope.reason)) return;
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
          || cause.rootId !== original.cause.rootId || cause.depth !== nextFederationDepth(original.cause.depth) || cause.parentId !== original.id) throw new Error('Reply does not match an authorized origin request and cause.');
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
    async report(callerId: string, id: string, outcome: FederationOutcome, text: string, triage?: FederationTriage) {
      const found = read(id);
      if (callerId !== d.self().agentId || !found || found.direction !== 'incoming' || !current(found)) throw new Error('Only this receiving controller can report this request.');
      if (!textValid(text)) throw new Error('Give a short explicit outcome or reason.');
      if (terminal(found.outcome)) throw new Error('This request already has a final outcome.');
      nextCause(found); // Checked before any report, triage, notice or rate mutation.
      let updated: FederatedRequest;
      try {
        updated = await replace(id, (r, file) => {
          if (terminal(r.outcome)) throw new Error('This request already has a final outcome.');
          if ((r.replies?.length ?? 0) >= 64) throw new Error('This request has reached its report limit.');
          const recent = (file.crossings[r.machineId] ?? []).filter((at) => d.now() - at < 60_000);
          if (recent.length >= FEDERATED_REQUEST_LIMITS.perMinute) throw new FederationBackpressure('rate_limited', LEGACY_RATE_PAUSE, Math.max(1, Math.min(...recent) + 60_000 - d.now()));
          file.crossings[r.machineId] = [...recent, d.now()];
          if (triage) { r.triage = triage; if (triage === 'needs_user') r.noticePending = 'needs_user'; }
          r.outcome = outcome; r.reason = text; r.revision++;
          (r.replies ??= []).push({ rateAdmitted: true, revision: r.revision, outcome, text, expiresAt: d.now() + FEDERATED_REQUEST_LIMITS.ttl });
        }, () => current(found));
      } catch (err) { if (err instanceof FederationBackpressure) d.recordLimit(); throw err; }
      if (triage) { d.record(updated, 'triage'); if (triage === 'needs_user') await showNotice(updated); }
      d.settleLocal?.(updated);
      try { await sendPending(updated); } catch { d.fault?.(); } // telemetry-exempt: the admitted report is retained for durable retry
      d.record(updated, 'crossing');
      return updated;
    },
    async triage(callerId: string, id: string, choice: FederationTriage, reason: string) {
      if (!['now', 'check_in', 'needs_user', 'decline'].includes(choice)) throw new Error('Choose now, check_in, needs_user or decline.');
      const found = read(id);
      if (callerId !== d.self().agentId || !found || found.direction !== 'incoming' || terminal(found.outcome) || !current(found)) throw new Error('Only the receiving controller can triage this live request.');
      if (!textValid(reason)) throw new Error('Give the reason for this triage choice.');
      return this.report(callerId, id, choice === 'decline' ? 'declined' : choice === 'needs_user' ? 'waiting_user' : 'under_way', reason, choice);
    },
    async reconcile() {
      await d.store.ready?.();
      const file = d.store.get();
      for (const machine of Object.keys(file.pauseNotices ?? {})) await finishPause(machine);
      for (const machine of new Set([...file.requests.map((r) => r.machineId), ...Object.keys(file.news ?? {})])) await d.flush?.(machine);
      for (const request of d.store.get().requests) {
        await sendPending(request);
        await showNotice(request);
        if (request.direction === 'incoming' && request.promptState === 'pending' && this.allowed(request.machineId, {})) await presentIncoming(request);
        const authorizedNow = current(request);
        const waiting = !authorizedNow && !!d.awaitingController?.(request.machineId, request.epoch);
        if (!authorizedNow && !waiting && request.direction === 'incoming' && !request.revocationNotified) {
          const revoked = await replace(request.id, (r) => { r.revocationNotified = true; r.noticePending = 'failure'; r.reason = 'The origin computer or controller connection was removed. Queued replies have been dropped.'; });
          await showNotice({ ...revoked, delivery: 'refused' });
        }
        const status = request.deliveryId && d.delivery(request.callerId, request.deliveryId);
        const expired = d.now() >= request.expiresAt;
        // A final outbox answer still wins over a restart wait.
        const finalStatus = !!status && ['refused', 'expired', 'indeterminate'].includes(status.state);
        const state = request.delivery !== 'accepted' ? request.delivery
          : waiting && !finalStatus ? expired ? 'expired' : request.delivery
          : waiting ? status!.state === 'expired' ? 'expired' : 'refused'
          : !authorizedNow ? 'refused' : status && status.state === 'delivered' ? 'delivered' : expired ? 'expired'
          : status && ['refused', 'expired', 'indeterminate'].includes(status.state) ? status.state === 'expired' ? 'expired' : 'refused'
          : request.delivery;
        if (state === request.delivery) continue;
        const updated = await replace(request.id, (r) => { r.delivery = state; if (state === 'refused' || state === 'expired') r.noticePending = 'failure'; r.reason = !authorizedNow && !waiting ? 'The network member or controller connection was removed.' : status && (!waiting || finalStatus) ? status.reason : 'The request expired while waiting for the other machine.'; });
        d.record(updated, 'crossing');
        if (state === 'refused' || state === 'expired') await showNotice(updated);
      }
    },
  };
}
export type FederatedRequests = ReturnType<typeof createFederatedRequests>;
