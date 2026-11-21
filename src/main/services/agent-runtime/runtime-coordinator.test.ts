import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runtimeAdmissionBrand,
  runtimeHandoffBrand,
  runtimeProviderRequestIdBrand,
  type RuntimeAttemptHooks,
  type RuntimeHandoff,
  type RuntimeLossCommit,
} from '../../../shared/chat/runtime';
import {
  _resetRuntimeCoordinatorForTests,
  RuntimePreIntentRefusal,
  runtimeNoticePort as notice,
  runtimeOwnerPort as owner,
  type RuntimeDormantLease,
  type RuntimeLease,
  type RuntimeLiveLease,
  type RuntimeStartClaim,
} from './runtime-coordinator';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

function claim(lease: RuntimeDormantLease): RuntimeStartClaim {
  const result = owner.claimStart(lease);
  if (result.kind !== 'applied') throw new Error(`Test start failed: ${result.kind}`);
  return result.start;
}

function attach(start: RuntimeStartClaim, instance: object = {}): RuntimeLiveLease {
  const result = owner.attachResource(start, { kind: 'chat', instance });
  if (result.kind !== 'applied') throw new Error(`Test attach failed: ${result.kind}`);
  return result.lease;
}

function hooks() {
  const committed = Promise.resolve<RuntimeLossCommit>({ committedOutcome: 'uncertain' });
  return {
    markEntered: vi.fn(() => 'entered' as const),
    onLoss: vi.fn((_outcome: 'unsubmitted' | 'unknown') => ({ kind: 'claimed' as const, committed })),
    onReceipt: vi.fn(async () => {}),
    committed,
  };
}

function dispatch(lease: RuntimeLease, scope: object = {}, attempt: RuntimeAttemptHooks = hooks()) {
  const handoff = notice.createHandoff(lease, notice.captureAdmission(scope), attempt);
  const queue = {};
  const publication = {};
  owner.bindQueue(handoff, queue);
  owner.bindPublication(handoff, publication);
  return { handoff, queue, publication };
}

function live(agentId = 'agent', identity: object = {}, instance: object = {}) {
  const dormant = owner.registerOwner(agentId, identity);
  return { dormant, lease: attach(claim(dormant), instance) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  _resetRuntimeCoordinatorForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetRuntimeCoordinatorForTests();
  vi.useRealTimers();
});

describe('runtime owner generation and exact resource', () => {
  it('promotes a dormant dispatch on the same exclusive generation', () => {
    const dormant = owner.registerOwner('agent', {});
    const attempt = hooks();
    const { handoff } = dispatch(dormant, {}, attempt);
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(attempt.markEntered).not.toHaveBeenCalled();
    const start = claim(dormant);
    expect(owner.claimStart(dormant)).toMatchObject({ kind: 'failed', reason: 'start_already_claimed' });
    const lease = attach(start);
    expect(lease.generation).toBe(dormant.generation);
    expect(owner.attachResource(start, { kind: 'pty', instance: {} })).toMatchObject({ kind: 'failed' });
    expect(notice.captureLease('agent')).toBe(lease);
    expect(handoff.tryEnter()).toEqual({ kind: 'entered' });
    expect(attempt.markEntered).toHaveBeenCalledTimes(1);
  });

  it('closes old tickets synchronously and does not adopt equal-name replacement work', () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff, publication } = dispatch(lease, {}, attempt);
    const ticket = notice.transportAdmission(handoff, lease.resource);
    expect(ticket.allowed()).toBe(false);
    handoff.tryEnter();
    expect(ticket.allowed()).toBe(true);
    const replacement = owner.beginTransition(lease, 'work_recovery');
    expect(replacement.kind).toBe('applied');
    expect(ticket.allowed()).toBe(false);
    expect(owner.mayPublish(handoff, publication)).toBe(false);
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(owner.beginTransition(lease, 'reset')).toEqual({ kind: 'superseded' });
    if (replacement.kind !== 'applied') throw new Error('Test transition failed');
    const next = owner.claimStart(replacement.transition);
    if (next.kind !== 'applied') throw new Error('Test start failed');
    const nextLease = attach(next.start);
    expect(nextLease.generation).not.toBe(lease.generation);
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(() => notice.createHandoff(lease, notice.captureAdmission({}), hooks())).toThrow(RuntimePreIntentRefusal);
    expect(() => notice.createHandoff(lease, notice.captureAdmission({}), hooks())).toThrow('lease_not_current');
    expect(attempt.markEntered).toHaveBeenCalledTimes(1);
  });

  it('rejects a late start after its generation was replaced', () => {
    const dormant = owner.registerOwner('agent', {});
    const start = claim(dormant);
    owner.beginTransition(dormant, 'replace');
    expect(owner.attachResource(start, { kind: 'chat', instance: {} })).toEqual({ kind: 'superseded' });
    expect(owner.claimStart(dormant)).toEqual({ kind: 'superseded' });
  });

  it('never attaches another owner or another logical agent to the same native instance', () => {
    const identity = {};
    const instance = {};
    const { lease } = live('first', identity, instance);
    const second = claim(owner.registerOwner('second', identity));
    expect(owner.attachResource(second, { kind: 'chat', instance })).toMatchObject({ kind: 'failed', reason: 'resource_owned' });
    owner.beginTransition(lease, 'stop');
    expect(owner.attachResource(second, { kind: 'chat', instance })).toMatchObject({ kind: 'failed', reason: 'resource_owned' });
  });

  it('binds exact queue and publication once, before entry', () => {
    const { lease } = live();
    const { handoff, queue, publication } = dispatch(lease);
    owner.bindQueue(handoff, queue);
    owner.bindPublication(handoff, publication);
    expect(() => owner.bindQueue(handoff, {})).toThrow('queue_already_bound');
    expect(() => owner.bindPublication(handoff, {})).toThrow('publication_already_bound');
    expect(owner.mayPublish(handoff, {})).toBe(false);
    expect(owner.mayPublish(handoff, publication)).toBe(true);
    handoff.tryEnter();
    expect(() => owner.bindQueue(handoff, queue)).toThrow('queue_binding_unavailable');
  });
});

describe('private registered handoff and transport capabilities', () => {
  it.each(['production', 'missing-runner'] as const)('refuses test reset in %s without changing owner, tickets or hold timers', (mode) => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    handoff.tryEnter();
    const ticket = notice.transportAdmission(handoff, lease.resource);
    const hold = notice.holdScope({}, performance.now() + 20);
    if (mode === 'production') vi.stubEnv('NODE_ENV', 'production');
    else vi.stubEnv('VITEST', undefined);
    expect(() => _resetRuntimeCoordinatorForTests()).toThrow('test_environment_required');
    expect(notice.captureLease('agent')).toBe(lease);
    expect(notice.isRegisteredHandoff(handoff)).toBe(true);
    expect(notice.isRegisteredAdmission(ticket)).toBe(true);
    expect(ticket.allowed()).toBe(true);
    expect(notice.scopeHoldStatus(hold)).toEqual({ state: 'pending' });
    expect(vi.getTimerCount()).toBe(1);
    expect(attempt.onLoss).not.toHaveBeenCalled();
  });

  it('fails closed when native weak-reference support is unavailable, without a strong fallback', () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    vi.stubGlobal('WeakRef', undefined);
    expect(() => notice.transportAdmission(handoff, lease.resource)).toThrow('weak_reference_unavailable');
    expect(attempt.markEntered).not.toHaveBeenCalled();
    expect(attempt.onLoss).not.toHaveBeenCalled();
  });

  it('does not admit a ticket whose weak original record is unavailable even after entry', () => {
    const { lease } = live();
    const { handoff } = dispatch(lease);
    vi.stubGlobal('WeakRef', class { deref() { return undefined; } });
    const ticket = notice.transportAdmission(handoff, lease.resource);
    handoff.tryEnter();
    expect(notice.isRegisteredAdmission(ticket)).toBe(true);
    expect(ticket.allowed()).toBe(false);
  });

  it('rejects fabricated and cloned symbol-branded handoffs without invoking their methods', () => {
    const { lease } = live();
    const real = dispatch(lease).handoff;
    const fabricated: RuntimeHandoff = {
      [runtimeHandoffBrand]: true,
      dispatchId: real.dispatchId,
      tryEnter: vi.fn(() => ({ kind: 'entered' as const })),
      observe: vi.fn(async () => {}),
    };
    const cloned = { ...real, tryEnter: fabricated.tryEnter, observe: fabricated.observe };
    for (const fake of [fabricated, cloned]) {
      expect(notice.isRegisteredHandoff(fake)).toBe(false);
      expect(() => notice.transportAdmission(fake, lease.resource)).toThrow('unregistered_handoff');
      expect(() => owner.bindQueue(fake, {})).toThrow('unregistered_handoff');
      expect(() => notice.retireHandoff(fake)).toThrow('unregistered_handoff');
    }
    expect(fabricated.tryEnter).not.toHaveBeenCalled();
    expect(fabricated.observe).not.toHaveBeenCalled();
  });

  it('does not authorize a fake or cloned transport ticket by brand or matching IDs', () => {
    const { lease } = live();
    const { handoff } = dispatch(lease);
    const real = notice.transportAdmission(handoff, lease.resource);
    const fake = {
      [runtimeAdmissionBrand]: true as const,
      dispatchId: real.dispatchId,
      resource: real.resource,
      allowed: vi.fn(() => true),
    };
    expect(notice.isRegisteredAdmission(fake)).toBe(false);
    expect(notice.isRegisteredAdmission({ ...real })).toBe(false);
    expect(notice.isRegisteredAdmission(real)).toBe(true);
    expect(fake.allowed).not.toHaveBeenCalled();
  });

  it('rejects a prior private registry even though the shared brand and IDs remain identical', () => {
    const { lease } = live();
    const { handoff } = dispatch(lease);
    const ticket = notice.transportAdmission(handoff, lease.resource);
    handoff.tryEnter();
    _resetRuntimeCoordinatorForTests();
    live();
    expect(notice.isRegisteredHandoff(handoff)).toBe(false);
    expect(notice.isRegisteredAdmission(ticket)).toBe(false);
    expect(ticket.allowed()).toBe(false);
    expect(() => notice.transportAdmission(handoff, lease.resource)).toThrow('unregistered_handoff');
  });

  it('rejects another resource ID and keeps its driver-facing check hook-free', () => {
    const { lease } = live('first');
    const other = live('second').lease;
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    expect(() => notice.transportAdmission(handoff, other.resource)).toThrow('transport_resource_not_current');
    const ticket = notice.transportAdmission(handoff, lease.resource);
    for (let i = 0; i < 3; i++) expect(ticket.allowed()).toBe(false);
    expect(attempt.markEntered).not.toHaveBeenCalled();
    expect(attempt.onLoss).not.toHaveBeenCalled();
    expect(attempt.onReceipt).not.toHaveBeenCalled();
  });
});

describe('single entry and coordinator-owned loss claim', () => {
  it('rejects its own pre-marker queue guard without creating journal entry', () => {
    const { lease } = live();
    const attempt = hooks();
    const handoff = notice.createHandoff(lease, notice.captureAdmission({}), attempt);
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(attempt.markEntered).not.toHaveBeenCalled();
    expect(attempt.onLoss).not.toHaveBeenCalled();
    expect(() => notice.lossSettlement(handoff)).toThrow('loss_not_requested');
    expect(notice.retireHandoff(handoff)).toEqual({ candidateDisposition: 'unsubmitted', firstRetirement: true });
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unsubmitted');
  });

  it('requires captured publication as well as exact queue identity before the marker', () => {
    const { lease } = live();
    const attempt = hooks();
    const handoff = notice.createHandoff(lease, notice.captureAdmission({}), attempt);
    owner.bindQueue(handoff, {});
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(attempt.markEntered).not.toHaveBeenCalled();
    owner.bindPublication(handoff, {});
    expect(handoff.tryEnter()).toEqual({ kind: 'entered' });
  });

  it('treats journal_owned as this candidate not newly entered, without an unsubmitted producer', () => {
    const { lease } = live();
    const attempt = { ...hooks(), markEntered: vi.fn(() => 'journal_owned' as const) };
    const { handoff } = dispatch(lease, {}, attempt);
    const ticket = notice.transportAdmission(handoff, lease.resource);
    expect(handoff.tryEnter()).toEqual({ kind: 'journal_owned' });
    expect(handoff.tryEnter()).toEqual({ kind: 'journal_owned' });
    expect(ticket.allowed()).toBe(false);
    expect(notice.retireHandoff(handoff)).toEqual({ candidateDisposition: 'journal_owned', firstRetirement: false });
    expect(notice.lossSettlement(handoff)).toBeUndefined();
    expect(attempt.onLoss).not.toHaveBeenCalled();
    expect(attempt.markEntered).toHaveBeenCalledTimes(1);
  });

  it('retains one actual committed promise and does not infer it from retirement classification', async () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    handoff.tryEnter();
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(notice.retireHandoff(handoff)).toEqual({ candidateDisposition: 'unknown', firstRetirement: true });
    expect(notice.retireHandoff(handoff)).toEqual({ candidateDisposition: 'unknown', firstRetirement: false });
    expect(notice.lossSettlement(handoff)).toBe(attempt.committed);
    await expect(notice.lossSettlement(handoff)).resolves.toEqual({ committedOutcome: 'uncertain' });
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(attempt.markEntered).toHaveBeenCalledTimes(1);
  });

  it('preserves actual uncertain coercion when a locally unsubmitted candidate loses', async () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    expect(notice.retireHandoff(handoff).candidateDisposition).toBe('unsubmitted');
    await expect(notice.lossSettlement(handoff)).resolves.toEqual({ committedOutcome: 'uncertain' });
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unsubmitted');
  });

  it('does not produce settlement or downgrade UNKNOWN when the loss claim is journal_owned', () => {
    const { lease } = live();
    const attempt = { ...hooks(), onLoss: vi.fn(() => ({ kind: 'journal_owned' as const })) };
    const { handoff } = dispatch(lease, {}, attempt);
    handoff.tryEnter();
    expect(notice.retireHandoff(handoff).candidateDisposition).toBe('unknown');
    notice.retireHandoff(handoff);
    expect(notice.lossSettlement(handoff)).toBeUndefined();
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
  });

  it('unexpected marker throw is UNKNOWN and invokes exactly one loss hook before surfacing the error', async () => {
    const { lease } = live();
    const error = new Error('unexpected marker failure');
    const attempt = { ...hooks(), markEntered: vi.fn(() => { throw error; }) };
    const { handoff } = dispatch(lease, {}, attempt);
    const ticket = notice.transportAdmission(handoff, lease.resource);
    expect(() => handoff.tryEnter()).toThrow(error);
    expect(ticket.allowed()).toBe(false);
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(notice.retireHandoff(handoff).firstRetirement).toBe(false);
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(notice.lossSettlement(handoff)).toBe(attempt.committed);
    await expect(notice.lossSettlement(handoff)).resolves.toEqual({ committedOutcome: 'uncertain' });
    expect(attempt.onLoss).toHaveBeenCalledTimes(1);
    expect(attempt.markEntered).toHaveBeenCalledTimes(1);
  });

  it('unexpected marker throw still makes the sole loss claim when the journal declines it', () => {
    const { lease } = live();
    const attempt = {
      ...hooks(),
      markEntered: vi.fn(() => { throw new Error('marker failed'); }),
      onLoss: vi.fn(() => ({ kind: 'journal_owned' as const })),
    };
    const { handoff } = dispatch(lease, {}, attempt);
    expect(() => handoff.tryEnter()).toThrow('marker failed');
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(notice.retireHandoff(handoff).candidateDisposition).toBe('unknown');
    expect(notice.lossSettlement(handoff)).toBeUndefined();
  });

  it('retains a failed promise and the latch after a synchronous loss-hook throw', async () => {
    const { lease } = live();
    const error = new Error('synchronous loss failure');
    const attempt = { ...hooks(), onLoss: vi.fn(() => { throw error; }) };
    const { handoff } = dispatch(lease, {}, attempt);
    handoff.tryEnter();
    expect(notice.retireHandoff(handoff)).toEqual({ candidateDisposition: 'unknown', firstRetirement: true });
    const failed = notice.lossSettlement(handoff);
    expect(failed).toBeInstanceOf(Promise);
    await expect(failed).rejects.toBe(error);
    expect(notice.retireHandoff(handoff).firstRetirement).toBe(false);
    expect(notice.lossSettlement(handoff)).toBe(failed);
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
  });

  it('keeps an asynchronously failed committed promise rather than returning ready or retrying', async () => {
    const { lease } = live();
    const error = new Error('journal append failed');
    const committed = Promise.reject<RuntimeLossCommit>(error);
    const attempt = { ...hooks(), onLoss: vi.fn(() => ({ kind: 'claimed' as const, committed })) };
    const { handoff } = dispatch(lease, {}, attempt);
    notice.retireHandoff(handoff);
    expect(notice.lossSettlement(handoff)).toBe(committed);
    await expect(notice.lossSettlement(handoff)).rejects.toBe(error);
    expect(notice.retireHandoff(handoff).candidateDisposition).toBe('unknown');
    expect(attempt.onLoss).toHaveBeenCalledTimes(1);
  });

  it('sets the retirement latch before a reentrant synchronous loss hook', async () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    attempt.onLoss.mockImplementation(() => {
      expect(notice.retireHandoff(handoff).firstRetirement).toBe(false);
      expect(() => notice.lossSettlement(handoff)).toThrow('loss_claim_in_progress');
      return { kind: 'claimed', committed: attempt.committed };
    });
    handoff.tryEnter();
    notice.retireHandoff(handoff);
    await expect(notice.lossSettlement(handoff)).resolves.toEqual({ committedOutcome: 'uncertain' });
    expect(attempt.onLoss).toHaveBeenCalledTimes(1);
  });
});

describe('bounded scope holds and fresh authority', () => {
  it('ordinary per-attempt retirement leaves concurrent work and admission in the same scope live', () => {
    const { lease } = live();
    const scope = {};
    const first = hooks();
    const second = hooks();
    const one = dispatch(lease, scope, first).handoff;
    const two = dispatch(lease, scope, second).handoff;
    one.tryEnter();
    two.tryEnter();
    const retiredTicket = notice.transportAdmission(one, lease.resource);
    const siblingTicket = notice.transportAdmission(two, lease.resource);
    notice.retireHandoff(one);
    expect(retiredTicket.allowed()).toBe(false);
    expect(siblingTicket.allowed()).toBe(true);
    expect(notice.captureAdmission(scope)).toBeDefined();
    expect(first.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
    expect(second.onLoss).not.toHaveBeenCalled();
    expect(second.markEntered).toHaveBeenCalledTimes(1);
  });

  it('closed and held admission preflight has typed refusals, no handoff entry and no loss/retry', () => {
    const { lease } = live();
    const scope = {};
    const admission = notice.captureAdmission(scope);
    const attempt = hooks();
    notice.revokeScope(admission);
    expect(() => notice.captureAdmission(scope)).toThrow(RuntimePreIntentRefusal);
    expect(() => notice.captureAdmission(scope)).toThrow('scope_closed');
    expect(() => notice.createHandoff(lease, admission, attempt)).toThrow(RuntimePreIntentRefusal);
    expect(() => notice.createHandoff(lease, admission, attempt)).toThrow('scope_closed');
    notice.holdScope(scope, performance.now() + 25);
    expect(() => notice.captureAdmission(scope)).toThrow(RuntimePreIntentRefusal);
    expect(() => notice.captureAdmission(scope)).toThrow('scope_held');
    expect(() => notice.createHandoff(lease, admission, attempt)).toThrow('scope_held');
    expect(attempt.markEntered).not.toHaveBeenCalled();
    expect(attempt.onLoss).not.toHaveBeenCalled();
    expect(attempt.onReceipt).not.toHaveBeenCalled();
  });

  it('revokes the entire original scope, not unrelated scopes or fresh verified admissions', () => {
    const { lease } = live();
    const scope = {};
    const admission = notice.captureAdmission(scope);
    const first = notice.createHandoff(lease, admission, hooks());
    owner.bindQueue(first, {});
    owner.bindPublication(first, {});
    const sameScope = dispatch(lease, scope).handoff;
    const unrelated = dispatch(lease).handoff;
    const tickets = [first, sameScope, unrelated].map((handoff) => {
      handoff.tryEnter();
      return notice.transportAdmission(handoff, lease.resource);
    });
    notice.revokeScope(admission);
    expect(tickets.map((ticket) => ticket.allowed())).toEqual([false, false, true]);
    expect(() => notice.captureAdmission(scope)).toThrow('scope_closed');
    const hold = notice.holdScope(scope, performance.now() + 25);
    const refreshed = notice.finishScopeHold(hold, { kind: 'authorized', scope });
    if (refreshed.kind !== 'applied') throw new Error('Test refresh failed');
    const next = notice.createHandoff(lease, refreshed.admission, hooks());
    owner.bindQueue(next, {});
    owner.bindPublication(next, {});
    next.tryEnter();
    const nextTicket = notice.transportAdmission(next, lease.resource);
    notice.revokeScope(admission);
    expect(nextTicket.allowed()).toBe(true);
  });

  it('closes every ticket before any loss callback and expires without reviving old admission', () => {
    const { lease } = live();
    const scope = {};
    const first = hooks();
    const second = hooks();
    const one = dispatch(lease, scope, first).handoff;
    const two = dispatch(lease, scope, second).handoff;
    const ticketOne = notice.transportAdmission(one, lease.resource);
    const ticketTwo = notice.transportAdmission(two, lease.resource);
    one.tryEnter();
    two.tryEnter();
    const eligibilityAtLoss: boolean[][] = [];
    first.onLoss.mockImplementation(() => {
      eligibilityAtLoss.push([ticketOne.allowed(), ticketTwo.allowed()]);
      return { kind: 'claimed', committed: first.committed };
    });
    const hold = notice.holdScope(scope, performance.now() + 25);
    expect(eligibilityAtLoss).toEqual([[false, false]]);
    expect(notice.scopeHoldStatus(hold)).toEqual({ state: 'pending' });
    expect(() => notice.captureAdmission(scope)).toThrow('scope_held');
    vi.advanceTimersByTime(25);
    expect(notice.scopeHoldStatus(hold)).toEqual({ state: 'expired', reason: 'hold_deadline_expired' });
    expect(vi.getTimerCount()).toBe(0);
    expect(notice.finishScopeHold(hold, { kind: 'authorized', scope })).toEqual({ kind: 'superseded' });
    expect(() => notice.captureAdmission(scope)).toThrow('scope_closed');
    expect(ticketOne.allowed()).toBe(false);
    expect(one.tryEnter()).toEqual({ kind: 'rejected' });
    expect(first.onLoss).toHaveBeenCalledTimes(1);
    expect(second.onLoss).toHaveBeenCalledTimes(1);
  });

  it('releases only a new admission and never resurrects an old held candidate', () => {
    const { lease } = live();
    const scope = {};
    const attempt = hooks();
    const { handoff } = dispatch(lease, scope, attempt);
    const hold = notice.holdScope(scope, performance.now() + 100);
    const released = notice.finishScopeHold(hold, { kind: 'authorized', scope });
    expect(released.kind).toBe('applied');
    expect(notice.scopeHoldStatus(hold)).toEqual({ state: 'released' });
    expect(vi.getTimerCount()).toBe(0);
    expect(handoff.tryEnter()).toEqual({ kind: 'rejected' });
    expect(attempt.markEntered).not.toHaveBeenCalled();
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unsubmitted');
    if (released.kind !== 'applied') throw new Error('Test release failed');
    const next = notice.createHandoff(lease, released.admission, hooks());
    owner.bindQueue(next, {});
    owner.bindPublication(next, {});
    expect(next.tryEnter()).toEqual({ kind: 'entered' });
  });

  it.each(['denied', 'mismatched'] as const)('cleans a %s authority completion and retains visible failure', (kind) => {
    const scope = {};
    const hold = notice.holdScope(scope, performance.now() + 100);
    const result = notice.finishScopeHold(hold, kind === 'denied'
      ? { kind: 'denied', reason: 'not authorized' }
      : { kind: 'authorized', scope: {} });
    expect(result.kind).toBe('failed');
    expect(notice.scopeHoldStatus(hold).state).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(() => notice.captureAdmission(scope)).toThrow('scope_closed');
  });

  it('a superseded overlapping hold cannot reopen scope, and expiry permits only fresh verification', () => {
    const scope = {};
    const older = notice.holdScope(scope, performance.now() + 50);
    const newer = notice.holdScope(scope, performance.now() + 100);
    expect(notice.finishScopeHold(older, { kind: 'authorized', scope })).toEqual({ kind: 'superseded' });
    expect(notice.scopeHoldStatus(older)).toEqual({ state: 'failed', reason: 'scope_superseded' });
    vi.advanceTimersByTime(100);
    expect(notice.scopeHoldStatus(newer).state).toBe('expired');
    const fresh = notice.holdScope(scope, performance.now() + 20);
    expect(notice.finishScopeHold(fresh, { kind: 'authorized', scope }).kind).toBe('applied');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires abandoned holds without an automatic authority release', () => {
    const scope = {};
    const hold = notice.holdScope(scope, performance.now() + 5);
    vi.advanceTimersByTime(5);
    expect(notice.scopeHoldStatus(hold).state).toBe('expired');
    expect(() => notice.captureAdmission(scope)).toThrow('scope_closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -1, 2 ** 31])('rejects non-bounded deadline %s without scheduling or closing admission', (delay) => {
    const scope = {};
    expect(() => notice.holdScope(scope, performance.now() + delay)).toThrow('invalid_hold_deadline');
    expect(vi.getTimerCount()).toBe(0);
    expect(notice.captureAdmission(scope)).toBeDefined();
  });
});

describe('historical original correlation, with no approved ACK mapper', () => {
  it('separates the historical observer from current publication and loss retirement', async () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff, publication } = dispatch(lease, {}, attempt);
    handoff.tryEnter();
    const observeOriginal = handoff.observe;
    owner.beginTransition(lease, 'reset');
    expect(owner.mayPublish(handoff, publication)).toBe(false);
    const receipt = {
      kind: 'local_handoff' as const,
      dispatchId: handoff.dispatchId,
      resource: lease.resource,
      boundary: 'pty_input' as const,
    };
    await observeOriginal(receipt);
    expect(attempt.onReceipt).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(notice.retireHandoff(handoff).candidateDisposition).toBe('unknown');
    const other = live('other').lease;
    await expect(observeOriginal({ ...receipt, resource: other.resource })).rejects.toThrow('receipt_identity_mismatch');
  });

  it('cannot manufacture approved ACK from a discriminator or driver resolution', async () => {
    const { lease } = live();
    const attempt = hooks();
    const { handoff } = dispatch(lease, {}, attempt);
    handoff.tryEnter();
    const receipt = {
      kind: 'approved_handoff_ack' as const,
      dispatchId: handoff.dispatchId,
      resource: lease.resource,
      request: { [runtimeProviderRequestIdBrand]: true as const },
      provenance: 'codex_rpc' as const,
    };
    await expect(handoff.observe(receipt)).rejects.toThrow('ack_mapper_not_approved');
    expect(attempt.onReceipt).not.toHaveBeenCalled();
    notice.retireHandoff(handoff);
    expect(attempt.onLoss).toHaveBeenCalledExactlyOnceWith('unknown');
  });
});
