import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  evaluateOwnedResourceDiagnostics, type OwnedCliExit, type ResourcePhase, type ResourceSample, type StopAck,
} from './owned-resource-diagnostics';

const expected = {
  role: 'A' as const, nonce: 'owned-test-epoch', pid: 33, cliPid: 22, controllerPid: 11,
  auditPath: path.resolve('node_modules/.cache/p8-evidence/owned-exit-unit/A-main-exit.json'),
};

function sample(context: 'peer' | 'cli', phase: ResourcePhase, index: number): ResourceSample {
  const state = phase === 'observer-armed' ? 'armed'
    : phase === 'delayed-callback-entered' || (context === 'peer' && phase === 'after-runtime-stop-ack')
      ? 'running' : 'absent';
  return {
    context, phase, role: expected.role, nonce: expected.nonce,
    pid: context === 'peer' ? expected.pid : expected.cliPid,
    ppid: context === 'peer' ? expected.cliPid : expected.controllerPid,
    utc: '2026-11-20T00:00:00.000Z', monotonicNs: String(800_000 + index),
    resourceTypes: ['PipeWrap', 'FSEventWrap'],
    observer: {
      delayedTimerCreated: state !== 'absent', delayedTimerHasRef: false, delayedTimerState: state,
      delayedTimerMs: state === 'absent' ? 0 : 1000,
      addedListeners: 0, addedWatchers: 0, addedProcesses: 0, synchronousArtifactIO: true,
    },
  };
}

function fixture(observed = false) {
  const ack: StopAck = {
    kind: 'runtime-stop-ack', role: expected.role, nonce: expected.nonce, cliPid: expected.cliPid,
    utc: '2026-11-20T00:00:00.000Z', errorFree: true,
  };
  const phases: ResourcePhase[] = ['before-service-quiesce', 'after-service-quiesce',
    'before-service-close', 'after-service-close', 'observer-armed'];
  if (observed) phases.push('delayed-callback-entered', 'after-runtime-stop-ack');
  const peer = phases.map((phase, index) => ({
    ...sample('peer', phase, index), ...(phase === 'after-runtime-stop-ack' && { ack: { ...ack } }),
  }));
  const nativeEvents: Record<string, unknown>[] = [
    { kind: 'pool-created', instances: 1 },
    { kind: 'stop-request', tagged: true },
    { kind: 'runtime-stopped', response: { type: 'stopped', __vitest_worker_response__: true } },
    { kind: 'native-exit', code: 0, signal: null, premature: false },
    { kind: 'native-close', code: 0, signal: null },
    { kind: 'dead-cleanup-start' },
    { kind: 'dead-cleanup-complete' },
  ].map((entry) => ({ ...entry, role: expected.role, nonce: expected.nonce, cliPid: expected.cliPid }));
  const cliExit: OwnedCliExit = {
    role: expected.role, nonce: expected.nonce, controllerPid: expected.controllerPid, pid: expected.cliPid,
    code: 0, signal: null, clock: 'process.hrtime.bigint', utc: '2026-11-20T00:00:00.000Z', monotonicNs: '1100000000',
  };
  const attempts: Record<string, unknown>[] = [], accepts: Record<string, unknown>[] = [];
  return {
    contractVersion: 2, expected,
    diagnostics: { peer, cli: [sample('cli', 'before-runtime-stop-ack', 0), sample('cli', 'after-runtime-stop-ack', 1)], ack },
    nativeEvents, cliExit,
    finalAudit: { phase: 'exit', installed: true, sealed: true, pending: 0, attempts, accepts },
    timing: {
      kind: 'owned-close-timing', contractVersion: 2, role: expected.role, nonce: expected.nonce,
      controllerPid: expected.controllerPid, cliPid: expected.cliPid, peerPid: expected.pid,
      clock: 'process.hrtime.bigint', stopIssuedNs: '1000000000', stopReplyObservedNs: '1010000000',
      stopReply: true, cliExitObservedNs: cliExit.monotonicNs,
    },
  };
}

describe('owned diagnostic nominal-window evaluator', () => {
  it('retains an actual post-ack sample even when CLI delivery is outside the nominal window', () => {
    const input = fixture(true);
    input.cliExit.monotonicNs = input.timing.cliExitObservedNs = '2100000000';
    expect(evaluateOwnedResourceDiagnostics(input)).toMatchObject({
      kind: 'observed-post-ack', sampleObserved: true, resourceTypes: ['PipeWrap', 'FSEventWrap'], missing: [],
    });
  });

  it('distinguishes verified early exit from a captured or empty resource sample', () => {
    expect(evaluateOwnedResourceDiagnostics(fixture())).toMatchObject({
      kind: 'verified-early-exit-without-sample', sampleObserved: false, resourceTypes: null,
      missing: ['peer:after-runtime-stop-ack'], nominalCutoffNs: '2000000000',
    });
  });

  it('accepts repeated matched quiesce pairs without comparing clocks from different PIDs', () => {
    const input = fixture();
    input.diagnostics.peer = [...input.diagnostics.peer.slice(0, 2), ...input.diagnostics.peer]
      .map((entry, index) => ({ ...entry, monotonicNs: String(900_000 + index) }));
    expect(evaluateOwnedResourceDiagnostics(input).kind).toBe('verified-early-exit-without-sample');
  });

  it('does not use UTC ordering as a fallback or cross-process clock comparison', () => {
    const input = fixture(true);
    input.cliExit.utc = '2000-01-01T00:00:00.000Z';
    input.diagnostics.peer.forEach((entry) => { entry.utc = '2099-01-01T00:00:00.000Z'; });
    expect(evaluateOwnedResourceDiagnostics(input).kind).toBe('observed-post-ack');
  });

  it.each(['2000000000', '2100000000'])('rejects absent samples at/after the strict cutoff %s', (exitNs) => {
    const input = fixture();
    input.cliExit.monotonicNs = input.timing.cliExitObservedNs = exitNs;
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/nominal window/);
  });

  it('rejects absent same-controller timing instead of inferring it from UTC', () => {
    expect(() => evaluateOwnedResourceDiagnostics({ ...fixture(), timing: undefined })).toThrow(/timing identity/);
  });

  it.each(['controllerPid', 'cliPid', 'peerPid'] as const)('rejects mixed timing identity %s', (field) => {
    const input = fixture();
    input.timing[field] = 99;
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/timing identity/);
  });

  it.each(['-1', '1.5', 'NaN'])('rejects invalid monotonic timestamps %s', (value) => {
    const input = fixture();
    input.timing.stopIssuedNs = value;
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/timing identity/);
  });

  it('rejects a different clock domain and a false stop reply', () => {
    const input = fixture();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, timing: { ...input.timing, clock: 'Date.now' } })).toThrow();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, timing: { ...input.timing, stopReply: false } })).toThrow();
  });

  it('rejects a conflicting CLI exit timestamp or reversed controller causal order', () => {
    const input = fixture();
    input.timing.cliExitObservedNs = '1099999999';
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/timing identity/);
    input.timing.cliExitObservedNs = input.cliExit.monotonicNs;
    input.timing.stopReplyObservedNs = '999999999';
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/causal order/);
  });

  it('does not exempt callback entry without a post-ack sample even after early genuine exit', () => {
    const input = fixture();
    input.diagnostics.peer.push(sample('peer', 'delayed-callback-entered', 5));
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/Callback entry/);
  });

  it('requires callback entry for an allegedly observed post-ack sample', () => {
    const input = fixture(true);
    input.diagnostics.peer = input.diagnostics.peer.filter((entry) => entry.phase !== 'delayed-callback-entered');
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/phase/);
  });

  it('rejects a copied or invalid acknowledgment marker', () => {
    const input = fixture(true);
    input.diagnostics.ack.utc = '2026-11-20T00:00:01.000Z';
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/marker differs/);
    input.diagnostics.ack.errorFree = false;
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/stop-ack identity/);
  });

  it.each([
    { role: 'B' }, { pid: 99 }, { ppid: 99 }, { nonce: 'retired-epoch' },
  ])('rejects mixed resource process/epoch identity %j', (change) => {
    const input = fixture();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, diagnostics: { ...input.diagnostics,
      peer: input.diagnostics.peer.map((entry) => ({ ...entry, ...change })) } })).toThrow(/sample/);
  });

  it.each(['before-service-close', 'after-service-quiesce'] as const)('never exempts another missing phase %s', (phase) => {
    const input = fixture();
    input.diagnostics.peer = input.diagnostics.peer.filter((entry) => entry.phase !== phase);
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow();
  });

  it('requires both CLI diagnostic phases', () => {
    const input = fixture();
    input.diagnostics.cli.pop();
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/phase/);
  });

  it('rejects changed peer identity, duplicated phases and reversed peer clocks', () => {
    const input = fixture();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, diagnostics: { ...input.diagnostics,
      peer: input.diagnostics.peer.map((entry) => ({ ...entry, nonce: 'retired-epoch' })) } })).toThrow(/sample/);
    input.diagnostics.peer.push({ ...input.diagnostics.peer[4] });
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/phase|duplicate/);
    input.diagnostics.peer.pop();
    input.diagnostics.peer[3].monotonicNs = '1';
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/clock/);
  });

  const nativeMutations: Array<[string, (events: Record<string, unknown>[]) => Record<string, unknown>[]]> = [
    ['missing exit', (events) => events.filter((entry) => entry.kind !== 'native-exit')],
    ['missing close', (events) => events.filter((entry) => entry.kind !== 'native-close')],
    ['missing dead cleanup', (events) => events.slice(0, -1)],
    ['duplicate event', (events) => [...events, events[3]]],
    ['reversed events', (events) => [...events].reverse()],
    ['signaled exit', (events) => events.map((entry) => entry.kind === 'native-exit' ? { ...entry, code: null, signal: 'SIGTERM' } : entry)],
    ['premature exit', (events) => events.map((entry) => entry.kind === 'native-exit' ? { ...entry, premature: true } : entry)],
    ['replaced pool', (events) => events.map((entry) => entry.kind === 'pool-created' ? { ...entry, instances: 2 } : entry)],
    ['wrong identity', (events) => events.map((entry) => ({ ...entry, cliPid: 99 }))],
  ];
  it.each(nativeMutations)('requires genuine complete native proof: %s', (_name, mutate) => {
    const input = fixture();
    input.nativeEvents = mutate(input.nativeEvents);
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/native/);
  });

  it('does not accept CLI0 alone, a signaled CLI or a bare native-verified boolean', () => {
    const input = fixture();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, nativeEvents: [] })).toThrow(/native/);
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, nativeEvents: true })).toThrow(/native/);
    input.cliExit.signal = 'SIGTERM';
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/CLI exit/);
  });

  it('requires an actual matching CLI exit receipt and real final audit, not absence booleans', () => {
    const input = fixture();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, cliExit: undefined })).toThrow(/CLI exit/);
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, cliExit: { ...input.cliExit, pid: 99 } })).toThrow(/CLI exit/);
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, finalAudit: undefined })).toThrow(/phase-exit/);
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, finalAudit: true })).toThrow(/phase-exit/);
  });

  it.each([
    { phase: 'live' }, { installed: false }, { sealed: false }, { pending: 1 },
    { attempts: [{ afterSeal: true }] }, { accepts: [{ port: 1 }] },
  ])('requires the actual intact phase-exit audit %j', (change) => {
    const input = fixture();
    expect(() => evaluateOwnedResourceDiagnostics({ ...input, finalAudit: { ...input.finalAudit, ...change } })).toThrow(/phase-exit/);
  });

  it('rejects referenced or changed-delay observers and never retrofits version1', () => {
    const input = fixture();
    input.diagnostics.peer[4].observer.delayedTimerHasRef = true;
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/sample/);
    input.diagnostics.peer[4].observer.delayedTimerHasRef = false;
    input.diagnostics.peer[4].observer.delayedTimerMs = 500;
    expect(() => evaluateOwnedResourceDiagnostics(input)).toThrow(/timer/);
    expect(() => evaluateOwnedResourceDiagnostics({ ...fixture(), contractVersion: 1 })).toThrow(/contract version/);
  });
});
