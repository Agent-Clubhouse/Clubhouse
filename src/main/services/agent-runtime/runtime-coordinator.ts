import {
  runtimeAdmissionBrand,
  runtimeDispatchIdBrand,
  runtimeHandoffBrand,
  runtimeResourceIdBrand,
  type AgentRuntimeKind,
  type RuntimeAttemptHooks,
  type RuntimeDispatchId,
  type RuntimeEntryDecision,
  type RuntimeHandoff,
  type RuntimeHandoffReceipt,
  type RuntimeJournalEntryDecision,
  type RuntimeLoss,
  type RuntimeLossCommit,
  type RuntimeResourceId,
  type RuntimeRetirementInfo,
  type RuntimeTransportAdmission,
} from '../../../shared/chat/runtime';
import { appLog } from '../log-service';

const generationBrand: unique symbol = Symbol('runtime-generation');
const leaseBrand: unique symbol = Symbol('runtime-lease');
const transitionBrand: unique symbol = Symbol('runtime-transition');
const startBrand: unique symbol = Symbol('runtime-start');
const admissionLeaseBrand: unique symbol = Symbol('runtime-admission-lease');
const holdBrand: unique symbol = Symbol('runtime-admission-hold');
const MAX_TIMER_DELAY = 2 ** 31 - 1;

export interface RuntimeGeneration { readonly [generationBrand]: true }
export interface RuntimeDormantLease {
  readonly [leaseBrand]: true;
  readonly kind: 'dormant';
  readonly generation: RuntimeGeneration;
}
export interface RuntimeLiveLease {
  readonly [leaseBrand]: true;
  readonly kind: 'live';
  readonly generation: RuntimeGeneration;
  readonly resource: RuntimeResourceId;
}
export type RuntimeLease = RuntimeLiveLease | RuntimeDormantLease;
export interface RuntimeTransition {
  readonly [transitionBrand]: true;
  readonly generation: RuntimeGeneration;
}
export interface RuntimeStartClaim {
  readonly [startBrand]: true;
  readonly generation: RuntimeGeneration;
}
export interface RuntimeAdmissionLease { readonly [admissionLeaseBrand]: true }
export interface RuntimeAdmissionHold { readonly [holdBrand]: true }
export type RuntimeOwnerIdentity = object;
export type RuntimeAuthorizedNoticeScope = object;
export type RuntimeQueueIdentity = object;
export type RuntimePublicationIdentity = object;
export type RuntimeAdmissionDeadline = number;
export type RuntimeTransitionReason = 'start' | 'sleep' | 'stop' | 'reset' | 'replace' | 'work_recovery';
export interface RuntimeNativeWitness { readonly kind: AgentRuntimeKind; readonly instance: object }
export type RuntimeNoticeAuthorityResult =
  | { kind: 'authorized'; scope: RuntimeAuthorizedNoticeScope }
  | { kind: 'denied'; reason: string };
export interface RuntimeAdmissionHoldStatus {
  state: 'pending' | 'released' | 'failed' | 'expired';
  reason?: string;
}
type Refusal = { kind: 'superseded' } | { kind: 'failed'; reason: string };
export type RuntimeTransitionResult = { kind: 'applied'; transition: RuntimeTransition } | Refusal;
export type RuntimeStartResult = { kind: 'applied'; start: RuntimeStartClaim } | Refusal;
export type RuntimeAttachResult = { kind: 'applied'; lease: RuntimeLiveLease } | Refusal;
export type RuntimeAdmissionResult = { kind: 'applied'; admission: RuntimeAdmissionLease } | Refusal;
export type RuntimePreIntentRefusalReason = 'scope_closed' | 'scope_held' | 'lease_not_current' | 'admission_not_current';

/** Admission preflight only; never evidence about an already-persisted attempt. */
export class RuntimePreIntentRefusal extends Error {
  readonly kind = 'pre_intent_refusal';

  constructor(readonly reason: RuntimePreIntentRefusalReason) {
    super(`Runtime pre-intent admission refused: ${reason}`);
    this.name = 'RuntimePreIntentRefusal';
  }
}

interface Frame {
  agentId: string;
  owner: RuntimeOwnerIdentity;
  generation: RuntimeGeneration;
  dormant: RuntimeDormantLease;
  live?: RuntimeLiveLease;
  phase: 'dormant' | 'claimed' | 'live' | 'retiring';
  revoked: boolean;
  resource?: ResourceRecord;
  handoffs: Set<HandoffRecord>;
}
interface ResourceRecord { id: RuntimeResourceId; frame: Frame; witness: RuntimeNativeWitness }
interface ScopeRecord {
  revision: object;
  open: boolean;
  admissions: Set<AdmissionRecord>;
  holds: Set<HoldRecord>;
}
interface AdmissionRecord {
  scope: ScopeRecord;
  revision: object;
  open: boolean;
  handoffs: Set<HandoffRecord>;
}
interface HoldRecord {
  scope: ScopeRecord;
  key: RuntimeAuthorizedNoticeScope;
  revision: object;
  deadline: number;
  status: RuntimeAdmissionHoldStatus;
  timer?: ReturnType<typeof setTimeout>;
}
interface TicketState { open: boolean }
interface HandoffRecord {
  frame?: Frame;
  admission?: AdmissionRecord;
  queue?: RuntimeQueueIdentity;
  publication?: RuntimePublicationIdentity;
  marker?: RuntimeAttemptHooks['markEntered'];
  lossHook?: RuntimeAttemptHooks['onLoss'];
  entry: 'pending' | 'entered' | 'unknown' | 'journal_owned';
  retired: boolean;
  disposition: RuntimeLoss | 'journal_owned';
  lossPhase: 'none' | 'claiming' | 'claimed' | 'journal_owned' | 'failed';
  settlement?: Promise<RuntimeLossCommit>;
  receiptBinding: { resource?: RuntimeResourceId };
  tickets: Set<TicketState>;
}

// Keep the ES2020 target and avoid a strong ticket fallback retaining owner or journal hooks.
interface WeakHandoffReference { deref(): HandoffRecord | undefined }
declare const WeakRef: { new (target: HandoffRecord): WeakHandoffReference };

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function reject(reason: string): never {
  appLog('core:agent', 'warn', 'Runtime operation rejected', { meta: { reason } });
  throw new Error(`Runtime operation: ${reason}`);
}

function refused(reason: string): Refusal {
  appLog('core:agent', 'warn', 'Runtime operation refused', { meta: { reason } });
  return { kind: 'failed', reason };
}

function refusePreIntent(reason: RuntimePreIntentRefusalReason): never {
  appLog('core:agent', 'warn', 'Runtime pre-intent admission refused', { meta: { reason } });
  throw new RuntimePreIntentRefusal(reason);
}

function transportPredicate(reference: WeakHandoffReference, state: TicketState): () => boolean {
  return () => coordinator.ticketAllowed(reference, state);
}

function receiptObserver(
  dispatchId: RuntimeDispatchId,
  binding: { resource?: RuntimeResourceId },
  onReceipt: RuntimeAttemptHooks['onReceipt'],
): (receipt: RuntimeHandoffReceipt) => Promise<void> {
  return async (receipt) => {
    if (receipt.dispatchId !== dispatchId || !binding.resource || receipt.resource !== binding.resource) reject('receipt_identity_mismatch');
    if (receipt.kind === 'approved_handoff_ack') reject('ack_mapper_not_approved');
    await onReceipt(receipt);
  };
}

class RuntimeCoordinator {
  private owners = new Map<string, Frame>();
  private leases = new WeakMap<object, Frame>();
  private transitions = new WeakMap<object, Frame>();
  private starts = new WeakMap<object, Frame>();
  private nativeInstances = new WeakMap<object, ResourceRecord>();
  private scopes = new WeakMap<object, ScopeRecord>();
  private admissions = new WeakMap<object, AdmissionRecord>();
  private holds = new WeakMap<object, HoldRecord>();
  private activeHolds = new Set<HoldRecord>();
  private handoffs = new WeakMap<RuntimeHandoff, HandoffRecord>();
  private issuedHandoffs = new WeakSet<object>();
  private issuedTickets = new WeakSet<object>();

  private current(frame: Frame): boolean {
    return !frame.revoked && this.owners.get(frame.agentId) === frame;
  }

  private newFrame(agentId: string, owner: RuntimeOwnerIdentity): Frame {
    const generation = Object.freeze<RuntimeGeneration>({ [generationBrand]: true });
    const dormant = Object.freeze<RuntimeDormantLease>({ [leaseBrand]: true, kind: 'dormant', generation });
    const frame: Frame = {
      agentId, owner, generation, dormant, phase: 'dormant', revoked: false, handoffs: new Set(),
    };
    this.leases.set(dormant, frame);
    this.owners.set(agentId, frame);
    return frame;
  }

  registerOwner(agentId: string, owner: RuntimeOwnerIdentity): RuntimeDormantLease {
    if (!agentId || !isObject(owner)) reject('invalid_owner');
    if (this.owners.has(agentId)) reject('owner_already_registered');
    return this.newFrame(agentId, owner).dormant;
  }

  captureLease(agentId: string): RuntimeLease | undefined {
    if (!agentId) reject('invalid_agent');
    const frame = this.owners.get(agentId);
    if (!frame || !this.current(frame)) return undefined;
    return frame.phase === 'dormant' ? frame.dormant : frame.phase === 'live' ? frame.live : undefined;
  }

  beginTransition(lease: RuntimeLease, _reason: RuntimeTransitionReason): RuntimeTransitionResult {
    const old = this.leases.get(lease);
    if (!old) reject('unregistered_lease');
    if (!this.current(old)) return { kind: 'superseded' };
    old.revoked = true;
    const pending = [...old.handoffs];
    for (const record of pending) this.closeTickets(record);
    old.resource = undefined;
    const frame = this.newFrame(old.agentId, old.owner);
    frame.phase = 'retiring';
    const transition = Object.freeze<RuntimeTransition>({ [transitionBrand]: true, generation: frame.generation });
    this.transitions.set(transition, frame);
    for (const record of pending) this.retire(record);
    return { kind: 'applied', transition };
  }

  retireResource(lease: RuntimeLiveLease, reason: RuntimeTransitionReason): RuntimeTransitionResult {
    return this.beginTransition(lease, reason);
  }

  claimStart(lease: RuntimeDormantLease | RuntimeTransition): RuntimeStartResult {
    const frame = this.transitions.get(lease) ?? this.leases.get(lease);
    if (!frame) reject('unregistered_start_owner');
    if (!this.current(frame)) return { kind: 'superseded' };
    if (frame.phase !== 'dormant' && frame.phase !== 'retiring') return refused('start_already_claimed');
    frame.phase = 'claimed';
    const start = Object.freeze<RuntimeStartClaim>({ [startBrand]: true, generation: frame.generation });
    this.starts.set(start, frame);
    return { kind: 'applied', start };
  }

  attachResource(start: RuntimeStartClaim, witness: RuntimeNativeWitness): RuntimeAttachResult {
    const frame = this.starts.get(start);
    if (!frame) reject('unregistered_start');
    if (!this.current(frame)) return { kind: 'superseded' };
    if (frame.phase !== 'claimed' || frame.resource) return refused('resource_already_attached');
    const { kind, instance } = witness;
    if (!isObject(instance) || (kind !== 'chat' && kind !== 'pty')) reject('invalid_native_witness');
    const previous = this.nativeInstances.get(instance);
    if (previous && (this.current(previous.frame) || previous.frame.owner !== frame.owner
      || previous.frame.agentId !== frame.agentId)) return refused('resource_owned');
    const id = Object.freeze<RuntimeResourceId>({ [runtimeResourceIdBrand]: true });
    const resource: ResourceRecord = { id, frame, witness: Object.freeze({ kind, instance }) };
    const live = Object.freeze<RuntimeLiveLease>({ [leaseBrand]: true, kind: 'live', generation: frame.generation, resource: id });
    frame.resource = resource;
    frame.live = live;
    frame.phase = 'live';
    this.nativeInstances.set(instance, resource);
    this.leases.set(live, frame);
    for (const record of frame.handoffs) record.receiptBinding.resource = id;
    return { kind: 'applied', lease: live };
  }

  private scope(key: RuntimeAuthorizedNoticeScope): ScopeRecord {
    if (!isObject(key)) reject('invalid_scope');
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { revision: {}, open: true, admissions: new Set(), holds: new Set() };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  captureAdmission(key: RuntimeAuthorizedNoticeScope): RuntimeAdmissionLease {
    const scope = this.scope(key);
    this.expireDue(scope);
    if (scope.holds.size) refusePreIntent('scope_held');
    if (!scope.open) refusePreIntent('scope_closed');
    return this.newAdmission(scope);
  }

  private newAdmission(scope: ScopeRecord): RuntimeAdmissionLease {
    const admission = Object.freeze<RuntimeAdmissionLease>({ [admissionLeaseBrand]: true });
    const record: AdmissionRecord = { scope, revision: scope.revision, open: true, handoffs: new Set() };
    scope.admissions.add(record);
    this.admissions.set(admission, record);
    return admission;
  }

  private admissionOpen(record: AdmissionRecord): boolean {
    return record.open && record.scope.open && !record.scope.holds.size && record.revision === record.scope.revision;
  }

  /** Scope-wide permission/membership revocation, not ordinary attempt completion. */
  revokeScope(admission: RuntimeAdmissionLease): void {
    const record = this.admissions.get(admission);
    if (!record) reject('unregistered_admission');
    if (!record.open || record.revision !== record.scope.revision) return;
    const pending = this.closeScope(record.scope);
    for (const handoff of pending) this.retire(handoff);
  }

  private closeScope(scope: ScopeRecord): Set<HandoffRecord> {
    scope.open = false;
    scope.revision = {};
    const pending = new Set<HandoffRecord>();
    for (const admission of scope.admissions) {
      admission.open = false;
      for (const handoff of admission.handoffs) {
        this.closeTickets(handoff);
        pending.add(handoff);
      }
    }
    scope.admissions.clear();
    return pending;
  }

  holdScope(key: RuntimeAuthorizedNoticeScope, deadline: RuntimeAdmissionDeadline): RuntimeAdmissionHold {
    const delay = deadline - performance.now();
    if (!Number.isFinite(deadline) || delay <= 0 || delay > MAX_TIMER_DELAY) reject('invalid_hold_deadline');
    const scope = this.scope(key);
    const pending = this.closeScope(scope);
    const hold = Object.freeze<RuntimeAdmissionHold>({ [holdBrand]: true });
    const record: HoldRecord = {
      scope, key, revision: scope.revision, deadline, status: { state: 'pending' },
    };
    scope.holds.add(record);
    this.activeHolds.add(record);
    this.holds.set(hold, record);
    this.armHold(record);
    for (const handoff of pending) this.retire(handoff);
    return hold;
  }

  private armHold(record: HoldRecord): void {
    record.timer = setTimeout(() => {
      if (record.status.state !== 'pending') return;
      if (performance.now() < record.deadline) this.armHold(record);
      else this.endHold(record, 'expired', 'hold_deadline_expired');
    }, Math.max(1, record.deadline - performance.now()));
    record.timer.unref?.();
  }

  private expireDue(scope: ScopeRecord): void {
    for (const record of [...scope.holds]) {
      if (record.deadline <= performance.now()) this.endHold(record, 'expired', 'hold_deadline_expired');
    }
  }

  private endHold(record: HoldRecord, state: RuntimeAdmissionHoldStatus['state'], reason?: string): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.status = { state, ...(reason ? { reason } : {}) };
    record.scope.holds.delete(record);
    this.activeHolds.delete(record);
    if (state === 'expired' || state === 'failed') {
      appLog('core:agent', 'warn', 'Runtime admission hold unavailable', { meta: { state, reason } });
    }
  }

  scopeHoldStatus(hold: RuntimeAdmissionHold): RuntimeAdmissionHoldStatus {
    const record = this.holds.get(hold);
    if (!record) reject('unregistered_hold');
    this.expireDue(record.scope);
    return { ...record.status };
  }

  finishScopeHold(hold: RuntimeAdmissionHold, authority: RuntimeNoticeAuthorityResult): RuntimeAdmissionResult {
    const record = this.holds.get(hold);
    if (!record) reject('unregistered_hold');
    this.expireDue(record.scope);
    if (record.status.state !== 'pending') return { kind: 'superseded' };
    if (record.revision !== record.scope.revision) {
      this.endHold(record, 'failed', 'scope_superseded');
      return { kind: 'superseded' };
    }
    if (authority.kind !== 'authorized' || authority.scope !== record.key) {
      this.endHold(record, 'failed', authority.kind === 'denied' ? 'authority_denied' : 'authority_scope_mismatch');
      return refused('scope_authority_unconfirmed');
    }
    this.endHold(record, 'released');
    if (record.scope.holds.size) return refused('scope_still_held');
    record.scope.open = true;
    return { kind: 'applied', admission: this.newAdmission(record.scope) };
  }

  isRegisteredHandoff(value: unknown): value is RuntimeHandoff {
    return isObject(value) && this.issuedHandoffs.has(value);
  }

  isRegisteredAdmission(value: unknown): value is RuntimeTransportAdmission {
    return isObject(value) && this.issuedTickets.has(value);
  }

  private handoff(value: unknown): HandoffRecord {
    if (!this.isRegisteredHandoff(value)) reject('unregistered_handoff');
    const record = this.handoffs.get(value);
    if (!record) reject('unregistered_handoff');
    return record;
  }

  createHandoff(lease: RuntimeLease, admission: RuntimeAdmissionLease, hooks: RuntimeAttemptHooks): RuntimeHandoff {
    const frame = this.leases.get(lease);
    const admitted = this.admissions.get(admission);
    if (!frame) reject('unregistered_lease');
    if (!admitted) reject('unregistered_admission');
    if (!this.current(frame)) refusePreIntent('lease_not_current');
    if (admitted.scope.holds.size) refusePreIntent('scope_held');
    if (!admitted.scope.open) refusePreIntent('scope_closed');
    if (!this.admissionOpen(admitted)) refusePreIntent('admission_not_current');
    const { markEntered, onLoss, onReceipt } = hooks;
    if (typeof markEntered !== 'function' || typeof onLoss !== 'function' || typeof onReceipt !== 'function') reject('invalid_attempt_hooks');
    const dispatchId = Object.freeze({ [runtimeDispatchIdBrand]: true as const });
    const receiptBinding = { resource: frame.resource?.id };
    const record: HandoffRecord = {
      frame, admission: admitted, marker: markEntered, lossHook: onLoss, entry: 'pending',
      retired: false, disposition: 'unsubmitted', lossPhase: 'none', receiptBinding, tickets: new Set(),
    };
    const handoff = Object.freeze<RuntimeHandoff>({
      [runtimeHandoffBrand]: true,
      dispatchId,
      tryEnter: () => this.tryEnter(record),
      observe: receiptObserver(dispatchId, receiptBinding, onReceipt),
    });
    this.issuedHandoffs.add(handoff);
    this.handoffs.set(handoff, record);
    frame.handoffs.add(record);
    admitted.handoffs.add(record);
    return handoff;
  }

  bindQueue(handoff: RuntimeHandoff, queue: RuntimeQueueIdentity): void {
    const record = this.handoff(handoff);
    if (!isObject(queue) || record.retired || record.entry !== 'pending') reject('queue_binding_unavailable');
    if (record.queue && record.queue !== queue) reject('queue_already_bound');
    record.queue = queue;
  }

  bindPublication(handoff: RuntimeHandoff, publication: RuntimePublicationIdentity): void {
    const record = this.handoff(handoff);
    if (!isObject(publication) || record.retired || record.entry !== 'pending') reject('publication_binding_unavailable');
    if (record.publication && record.publication !== publication) reject('publication_already_bound');
    record.publication = publication;
  }

  private live(record: HandoffRecord): boolean {
    return !!record.frame && this.current(record.frame) && record.frame.phase === 'live'
      && !!record.frame.resource && !!record.admission && this.admissionOpen(record.admission);
  }

  mayPublish(handoff: RuntimeHandoff, publication: RuntimePublicationIdentity): boolean {
    const record = this.handoff(handoff);
    return !record.retired && record.publication === publication && this.live(record);
  }

  private tryEnter(record: HandoffRecord): RuntimeEntryDecision {
    // P1 is live-resource-only. Pre-spawn mission argv needs a separately reviewed entry extension.
    if (record.entry === 'journal_owned') return { kind: 'journal_owned' };
    if (record.retired || record.entry !== 'pending' || !record.queue || !record.publication || !this.live(record)) return { kind: 'rejected' };
    const marker = record.marker;
    if (!marker) reject('entry_marker_missing');
    let decision: RuntimeJournalEntryDecision;
    try {
      decision = marker();
      if (decision !== 'entered' && decision !== 'journal_owned') throw new Error('Invalid runtime journal entry decision');
    } catch (error) {
      record.entry = 'unknown';
      appLog('core:agent', 'error', 'Runtime entry marker failed; outcome unknown', { meta: { reason: 'entry_marker_exception' } });
      this.retire(record);
      throw error;
    }
    if (decision === 'journal_owned') {
      record.entry = 'journal_owned';
      this.retire(record);
      return { kind: 'journal_owned' };
    }
    record.entry = 'entered';
    record.marker = undefined;
    for (const ticket of record.tickets) ticket.open = true;
    return { kind: 'entered' };
  }

  transportAdmission(handoff: RuntimeHandoff, resource: RuntimeResourceId): RuntimeTransportAdmission {
    const record = this.handoff(handoff);
    if (record.retired || !this.live(record) || record.receiptBinding.resource !== resource) reject('transport_resource_not_current');
    if (typeof WeakRef !== 'function') reject('weak_reference_unavailable');
    const state: TicketState = { open: record.entry === 'entered' };
    const ticket = Object.freeze<RuntimeTransportAdmission>({
      [runtimeAdmissionBrand]: true,
      dispatchId: handoff.dispatchId,
      resource,
      allowed: transportPredicate(new WeakRef(record), state),
    });
    record.tickets.add(state);
    this.issuedTickets.add(ticket);
    return ticket;
  }

  ticketAllowed(reference: WeakHandoffReference, state: TicketState): boolean {
    if (!state.open) return false;
    const record = reference.deref();
    return !!record && !record.retired && this.live(record);
  }

  private closeTickets(record: HandoffRecord): void {
    for (const ticket of record.tickets) ticket.open = false;
  }

  private observeLoss(record: HandoffRecord, promise: Promise<RuntimeLossCommit>): void {
    record.settlement = promise;
    void promise.then(undefined, () => {
      record.lossPhase = 'failed';
      record.disposition = 'unknown';
      appLog('core:agent', 'error', 'Runtime loss settlement failed; reconciliation required', { meta: { reason: 'loss_settlement_failed' } });
    });
  }

  private retire(record: HandoffRecord): RuntimeRetirementInfo {
    if (record.retired) return { candidateDisposition: record.disposition, firstRetirement: false };
    record.retired = true;
    this.closeTickets(record);
    record.tickets.clear();
    record.frame?.handoffs.delete(record);
    record.admission?.handoffs.delete(record);
    record.frame = undefined;
    record.admission = undefined;
    record.queue = undefined;
    record.publication = undefined;
    record.marker = undefined;
    const loss = record.lossHook;
    record.lossHook = undefined;
    if (record.entry === 'journal_owned') {
      record.disposition = 'journal_owned';
      record.lossPhase = 'journal_owned';
    } else {
      record.disposition = record.entry === 'entered' || record.entry === 'unknown' ? 'unknown' : 'unsubmitted';
      record.lossPhase = 'claiming';
      try {
        if (!loss) throw new Error('Runtime loss hook missing');
        const claim = loss(record.disposition);
        if (claim.kind === 'journal_owned') {
          record.lossPhase = 'journal_owned';
        } else if (claim.kind === 'claimed') {
          record.lossPhase = 'claimed';
          this.observeLoss(record, claim.committed);
        } else {
          throw new Error('Invalid runtime loss claim');
        }
      } catch (error) {
        // telemetry-exempt: lossSettlement retains this rejection; observeLoss logs reconciliation failure.
        record.disposition = 'unknown';
        record.lossPhase = 'failed';
        this.observeLoss(record, Promise.reject(error));
      }
    }
    return { candidateDisposition: record.disposition, firstRetirement: true };
  }

  retireHandoff(handoff: RuntimeHandoff): RuntimeRetirementInfo {
    return this.retire(this.handoff(handoff));
  }

  lossSettlement(handoff: RuntimeHandoff): Promise<RuntimeLossCommit> | undefined {
    const record = this.handoff(handoff);
    if (record.lossPhase === 'none') reject('loss_not_requested');
    if (record.lossPhase === 'claiming') reject('loss_claim_in_progress');
    if (record.lossPhase === 'journal_owned') return undefined;
    if (!record.settlement) reject('loss_settlement_missing');
    return record.settlement;
  }

  resetForTests(): void {
    if (process.env.VITEST !== 'true' || process.env.NODE_ENV === 'production') reject('test_environment_required');
    for (const hold of this.activeHolds) if (hold.timer) clearTimeout(hold.timer);
    for (const frame of this.owners.values()) {
      frame.revoked = true;
      frame.resource = undefined;
      for (const record of frame.handoffs) {
        this.closeTickets(record);
        record.retired = true;
        record.marker = undefined;
        record.lossHook = undefined;
        record.frame = undefined;
        record.admission = undefined;
        record.queue = undefined;
        record.publication = undefined;
      }
    }
    this.activeHolds.clear();
    this.owners.clear();
    this.leases = new WeakMap();
    this.transitions = new WeakMap();
    this.starts = new WeakMap();
    this.nativeInstances = new WeakMap();
    this.scopes = new WeakMap();
    this.admissions = new WeakMap();
    this.holds = new WeakMap();
    this.handoffs = new WeakMap();
    this.issuedHandoffs = new WeakSet();
    this.issuedTickets = new WeakSet();
  }
}

const coordinator = new RuntimeCoordinator();

export const runtimeOwnerPort = Object.freeze({
  registerOwner: coordinator.registerOwner.bind(coordinator),
  beginTransition: coordinator.beginTransition.bind(coordinator),
  claimStart: coordinator.claimStart.bind(coordinator),
  attachResource: coordinator.attachResource.bind(coordinator),
  bindQueue: coordinator.bindQueue.bind(coordinator),
  bindPublication: coordinator.bindPublication.bind(coordinator),
  mayPublish: coordinator.mayPublish.bind(coordinator),
  retireResource: coordinator.retireResource.bind(coordinator),
});

export const runtimeNoticePort = Object.freeze({
  isRegisteredHandoff: coordinator.isRegisteredHandoff.bind(coordinator),
  isRegisteredAdmission: coordinator.isRegisteredAdmission.bind(coordinator),
  captureLease: coordinator.captureLease.bind(coordinator),
  captureAdmission: coordinator.captureAdmission.bind(coordinator),
  revokeScope: coordinator.revokeScope.bind(coordinator),
  holdScope: coordinator.holdScope.bind(coordinator),
  scopeHoldStatus: coordinator.scopeHoldStatus.bind(coordinator),
  finishScopeHold: coordinator.finishScopeHold.bind(coordinator),
  createHandoff: coordinator.createHandoff.bind(coordinator),
  transportAdmission: coordinator.transportAdmission.bind(coordinator),
  retireHandoff: coordinator.retireHandoff.bind(coordinator),
  lossSettlement: coordinator.lossSettlement.bind(coordinator),
});

/** Test-only: drop issuance state and pending timers without creating another coordinator. */
export function _resetRuntimeCoordinatorForTests(): void {
  coordinator.resetForTests();
}
