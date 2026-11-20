import * as fs from 'fs';
import * as path from 'path';

export interface OwnedResourceIdentity {
  role: 'A' | 'B';
  nonce: string;
  auditPath: string;
}

export const OWNED_DIAGNOSTIC_CONTRACT_VERSION = 2;
const DELAY_MS = 1000;

export type ResourcePhase = 'before-service-quiesce' | 'after-service-quiesce'
  | 'before-service-close' | 'after-service-close' | 'observer-armed'
  | 'before-runtime-stop-ack' | 'after-runtime-stop-ack'
  | 'delayed-callback-entered' | 'delayed-ack-unobserved' | 'delayed-ack-invalid';

export interface StopAck {
  kind: 'runtime-stop-ack';
  role: 'A' | 'B';
  nonce: string;
  cliPid: number;
  utc: string;
  errorFree: boolean;
}

export interface ResourceSample {
  context: 'peer' | 'cli';
  phase: ResourcePhase;
  role: 'A' | 'B';
  nonce: string;
  pid: number;
  ppid: number;
  utc: string;
  monotonicNs: string;
  resourceTypes: string[];
  observer: {
    delayedTimerCreated: boolean;
    delayedTimerHasRef: boolean;
    delayedTimerState: 'absent' | 'armed' | 'running';
    delayedTimerMs: number;
    addedListeners: number;
    addedWatchers: number;
    addedProcesses: number;
    synchronousArtifactIO: boolean;
  };
  ack?: StopAck;
}

const resourcePhases = new Set<string>([
  'before-service-quiesce', 'after-service-quiesce', 'before-service-close', 'after-service-close',
  'observer-armed', 'before-runtime-stop-ack', 'after-runtime-stop-ack', 'delayed-callback-entered',
  'delayed-ack-unobserved', 'delayed-ack-invalid',
]);

export interface OwnedDiagnosticExpected extends OwnedResourceIdentity {
  pid: number;
  cliPid: number;
  controllerPid: number;
}

export interface OwnedCliExit {
  role: 'A' | 'B';
  nonce: string;
  controllerPid: number;
  pid: number;
  code: number | null;
  signal: string | null;
  utc: string;
  clock: 'process.hrtime.bigint';
  monotonicNs: string;
}

type OwnedDiagnosticResult = { contractVersion: number; missing: string[] } & (
  | { kind: 'observed-post-ack'; sampleObserved: true; resourceTypes: string[] }
  | { kind: 'verified-early-exit-without-sample'; sampleObserved: false; resourceTypes: null;
    nominalCutoffNs: string;
    timing: { stopIssuedNs: string; stopReplyObservedNs: string; cliExitObservedNs: string } }
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function artifact(identity: OwnedResourceIdentity, suffix: string): string {
  const output = path.dirname(path.resolve(identity.auditPath));
  if (!identity.nonce || path.dirname(output) !== path.resolve('node_modules/.cache/p8-evidence')
    || !path.basename(output).startsWith('owned-exit-')
    || path.basename(identity.auditPath) !== `${identity.role}-main-exit.json`) {
    throw new Error('Invalid owned resource diagnostic identity');
  }
  return path.join(output, `${identity.role}-${suffix}`);
}

function readArtifact(file: string): string {
  // eslint-disable-next-line no-restricted-syntax -- Read only owned generated diagnostic metadata.
  return fs.readFileSync(file, 'utf8');
}

function stopAck(value: unknown): value is StopAck {
  return record(value) && Object.keys(value).length === 6 && value.kind === 'runtime-stop-ack' && (value.role === 'A' || value.role === 'B')
    && typeof value.nonce === 'string' && typeof value.cliPid === 'number'
    && Number.isInteger(value.cliPid) && value.cliPid > 0 && typeof value.utc === 'string'
    && typeof value.errorFree === 'boolean';
}

function resourceSample(value: unknown): value is ResourceSample {
  return record(value) && (value.context === 'peer' || value.context === 'cli')
    && (value.role === 'A' || value.role === 'B') && typeof value.nonce === 'string'
    && typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.ppid === 'number' && Number.isInteger(value.ppid) && value.ppid > 0
    && typeof value.phase === 'string' && resourcePhases.has(value.phase) && typeof value.utc === 'string'
    && typeof value.monotonicNs === 'string' && /^\d+$/.test(value.monotonicNs)
    && Array.isArray(value.resourceTypes) && value.resourceTypes.every((type) => typeof type === 'string')
    && record(value.observer) && typeof value.observer.delayedTimerCreated === 'boolean'
    && typeof value.observer.delayedTimerHasRef === 'boolean'
    && (value.observer.delayedTimerState === 'absent' || value.observer.delayedTimerState === 'armed'
      || value.observer.delayedTimerState === 'running')
    && typeof value.observer.delayedTimerMs === 'number' && typeof value.observer.addedListeners === 'number'
    && typeof value.observer.addedWatchers === 'number' && typeof value.observer.addedProcesses === 'number'
    && typeof value.observer.synchronousArtifactIO === 'boolean'
    && (value.ack === undefined || stopAck(value.ack));
}

function writeSample(identity: OwnedResourceIdentity, context: 'peer' | 'cli', phase: ResourcePhase,
  timer?: { handle: NodeJS.Timeout; running: boolean }, ack?: StopAck): void {
  const sample: ResourceSample = {
    context, phase, role: identity.role, nonce: identity.nonce, pid: process.pid, ppid: process.ppid,
    utc: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(),
    resourceTypes: process.getActiveResourcesInfo(),
    observer: {
      delayedTimerCreated: !!timer, delayedTimerHasRef: timer?.handle.hasRef() ?? false,
      delayedTimerState: timer ? timer.running ? 'running' : 'armed' : 'absent', delayedTimerMs: timer ? DELAY_MS : 0,
      addedListeners: 0, addedWatchers: 0, addedProcesses: 0, synchronousArtifactIO: true,
    },
    ack,
  };
  fs.appendFileSync(artifact(identity, `${context}-resources.jsonl`), JSON.stringify(sample) + '\n');
}

export function captureCliResources(identity: OwnedResourceIdentity,
  phase: 'before-runtime-stop-ack' | 'after-runtime-stop-ack'): void {
  writeSample(identity, 'cli', phase);
}

export function publishObservedStopAck(identity: OwnedResourceIdentity, errorFree: boolean): void {
  const file = artifact(identity, 'runtime-stop-ack.json');
  if (fs.existsSync(file)) throw new Error('Duplicate owned runtime stop acknowledgment');
  const ack: StopAck = {
    kind: 'runtime-stop-ack', role: identity.role, nonce: identity.nonce, cliPid: process.pid,
    utc: new Date().toISOString(), errorFree,
  };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(ack) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function createPeerResourceDiagnostics(identity: OwnedResourceIdentity) {
  artifact(identity, 'peer-resources.jsonl');
  let timer: { handle: NodeJS.Timeout; running: boolean } | undefined;
  return {
    capture(phase: 'before-service-quiesce' | 'after-service-quiesce' | 'before-service-close' | 'after-service-close') {
      writeSample(identity, 'peer', phase, timer);
    },
    armDelayedSample() {
      if (timer) throw new Error('Owned resource diagnostic timer already armed');
      const handle = setTimeout(() => {
        if (!timer) throw new Error('Owned resource diagnostic timer identity missing');
        timer.running = true;
        writeSample(identity, 'peer', 'delayed-callback-entered', timer);
        const file = artifact(identity, 'runtime-stop-ack.json');
        if (!fs.existsSync(file)) {
          writeSample(identity, 'peer', 'delayed-ack-unobserved', timer);
          return;
        }
        const ack: unknown = JSON.parse(readArtifact(file));
        if (!stopAck(ack) || ack.role !== identity.role || ack.nonce !== identity.nonce
          || ack.cliPid !== process.ppid || !ack.errorFree) {
          writeSample(identity, 'peer', 'delayed-ack-invalid', timer);
          throw new Error('Owned resource sample lacks a valid observed runtime stop acknowledgment');
        }
        // Reading the atomically published marker establishes causality, not a guessed delay.
        writeSample(identity, 'peer', 'after-runtime-stop-ack', timer, ack);
      }, DELAY_MS);
      handle.unref();
      timer = { handle, running: false };
      writeSample(identity, 'peer', 'observer-armed', timer);
    },
  };
}

export function readOwnedResourceDiagnostics(identity: OwnedResourceIdentity,
  expected: { pid: number; cliPid: number; controllerPid: number }) {
  const identityExpected = { ...identity, ...expected };
  const read = (context: 'peer' | 'cli') => validateSamples(identityExpected, context,
    readArtifact(artifact(identity, `${context}-resources.jsonl`)).trim().split('\n').map((line): unknown => JSON.parse(line)));
  const peer = read('peer'), cli = read('cli');
  const ack = validateAck(identityExpected, JSON.parse(readArtifact(artifact(identity, 'runtime-stop-ack.json'))));
  const missing = missingSamples(peer, cli);
  return { role: identity.role, status: missing.length === 0 ? 'captured' : 'partial', missing, peer, cli, ack };
}

function validateExpected(expected: OwnedDiagnosticExpected): void {
  if ((expected.role !== 'A' && expected.role !== 'B') || !expected.nonce
    || ![expected.pid, expected.cliPid, expected.controllerPid].every((pid) => Number.isInteger(pid) && pid > 0)
    || new Set([expected.pid, expected.cliPid, expected.controllerPid]).size !== 3) {
    throw new Error('Invalid owned diagnostic process identity');
  }
  artifact(expected, 'peer-resources.jsonl');
}

function validateAck(expected: OwnedDiagnosticExpected, value: unknown): StopAck {
  if (!stopAck(value) || value.role !== expected.role || value.nonce !== expected.nonce
    || value.cliPid !== expected.cliPid || !value.errorFree) {
    throw new Error('Resource diagnostic sample lacks its genuine stop-ack identity');
  }
  return value;
}

function validateSamples(expected: OwnedDiagnosticExpected, context: 'peer' | 'cli', input: unknown): ResourceSample[] {
  validateExpected(expected);
  if (!Array.isArray(input)) throw new Error(`Missing owned ${context} resource samples`);
  return input.map((value: unknown) => {
    if (!resourceSample(value) || value.context !== context || value.role !== expected.role || value.nonce !== expected.nonce
      || value.pid !== (context === 'peer' ? expected.pid : expected.cliPid)
      || value.ppid !== (context === 'peer' ? expected.cliPid : expected.controllerPid)
      || value.observer.delayedTimerHasRef !== false || value.observer.addedListeners !== 0
      || value.observer.addedWatchers !== 0 || value.observer.addedProcesses !== 0
      || value.observer.synchronousArtifactIO !== true) {
      throw new Error(`Invalid owned ${context} resource diagnostic sample`);
    }
    if (value.ack !== undefined) {
      if (context !== 'peer' || value.phase !== 'after-runtime-stop-ack') throw new Error('Unexpected resource stop acknowledgment');
      validateAck(expected, value.ack);
    }
    return value;
  });
}

function missingSamples(peer: ResourceSample[], cli: ResourceSample[]): string[] {
  const missing = [
    ...['before-service-quiesce', 'after-service-quiesce', 'before-service-close',
      'after-service-close', 'observer-armed', 'after-runtime-stop-ack']
      .filter((phase) => !peer.some((sample) => sample.phase === phase)).map((phase) => `peer:${phase}`),
    ...['before-runtime-stop-ack', 'after-runtime-stop-ack'].filter((phase) => !cli.some((sample) => sample.phase === phase))
      .map((phase) => `cli:${phase}`),
  ];
  return missing;
}

export function validateOwnedNativeTerminal(expected: OwnedDiagnosticExpected, events: unknown, receipt: unknown) {
  validateExpected(expected);
  const ordered = ['pool-created', 'stop-request', 'runtime-stopped', 'native-exit', 'native-close',
    'dead-cleanup-start', 'dead-cleanup-complete'];
  if (!Array.isArray(events) || events.length !== ordered.length) throw new Error('Incomplete owned native event sequence');
  const native = events.map((value: unknown, index) => {
    if (!record(value) || value.role !== expected.role || value.nonce !== expected.nonce
      || value.cliPid !== expected.cliPid || value.kind !== ordered[index]) {
      throw new Error('Owned native event identity/order mismatch');
    }
    return value;
  });
  if (native[0].instances !== 1 || native[1].tagged !== true
    || !record(native[2].response) || native[2].response.type !== 'stopped'
    || native[2].response.__vitest_worker_response__ !== true || native[2].response.error !== undefined
    || native[3].code !== 0 || native[3].signal !== null || native[3].premature !== false
    || native[4].code !== 0 || native[4].signal !== null) {
    throw new Error('Owned native stop/exit/close was not genuine acknowledged0/null');
  }
  if (!record(receipt) || receipt.role !== expected.role || receipt.nonce !== expected.nonce
    || receipt.controllerPid !== expected.controllerPid || receipt.pid !== expected.cliPid
    || receipt.code !== 0 || receipt.signal !== null || receipt.clock !== 'process.hrtime.bigint'
    || typeof receipt.monotonicNs !== 'string' || !/^\d+$/.test(receipt.monotonicNs) || typeof receipt.utc !== 'string') {
    throw new Error('Owned CLI exit identity/clock was not genuine0/null');
  }
  const cliExit: OwnedCliExit = {
    role: expected.role, nonce: expected.nonce, controllerPid: expected.controllerPid, pid: expected.cliPid,
    code: 0, signal: null, clock: 'process.hrtime.bigint', monotonicNs: receipt.monotonicNs, utc: receipt.utc,
  };
  return { events: native, cliExit };
}

function validatePhaseOrder(samples: ResourceSample[], context: 'peer' | 'cli'): void {
  for (let index = 1; index < samples.length; index++) {
    if (BigInt(samples[index].monotonicNs) < BigInt(samples[index - 1].monotonicNs)) {
      throw new Error(`Owned ${context} diagnostic clock/order mismatch`);
    }
  }
  let index = 0;
  if (context === 'peer') {
    while (samples[index]?.phase === 'before-service-quiesce') {
      if (samples[index + 1]?.phase !== 'after-service-quiesce') throw new Error('Unmatched diagnostic quiesce pair');
      index += 2;
    }
    if (index === 0) throw new Error('Missing diagnostic quiesce pair');
  }
  const phases = context === 'peer'
    ? ['before-service-close', 'after-service-close', 'observer-armed']
    : ['before-runtime-stop-ack', 'after-runtime-stop-ack'];
  for (const phase of phases) {
    if (samples[index]?.phase !== phase) throw new Error(`Owned ${context} diagnostic phase order mismatch`);
    index++;
  }
  if (context === 'peer' && samples[index]?.phase === 'delayed-callback-entered') {
    if (samples[index + 1]?.phase !== 'after-runtime-stop-ack') throw new Error('Callback entry lacks a valid post-ack sample');
    index += 2;
  }
  if (index !== samples.length) throw new Error(`Unexpected owned ${context} diagnostic phase or duplicate`);
  for (const sample of samples) {
    const state = sample.phase === 'observer-armed' ? 'armed'
      : sample.phase === 'delayed-callback-entered' || (context === 'peer' && sample.phase === 'after-runtime-stop-ack')
        ? 'running' : 'absent';
    if (sample.observer.delayedTimerState !== state || sample.observer.delayedTimerCreated !== (state !== 'absent')
      || sample.observer.delayedTimerMs !== (state === 'absent' ? 0 : DELAY_MS)) {
      throw new Error('Owned diagnostic timer identity/state/delay mismatch');
    }
  }
}

export function evaluateOwnedResourceDiagnostics(input: {
  contractVersion: number;
  expected: OwnedDiagnosticExpected;
  diagnostics: unknown;
  nativeEvents: unknown;
  cliExit: unknown;
  finalAudit: unknown;
  timing: unknown;
}): OwnedDiagnosticResult {
  if (input.contractVersion !== OWNED_DIAGNOSTIC_CONTRACT_VERSION) throw new Error('Unsupported diagnostic artifact contract version');
  const { expected } = input;
  if (!record(input.diagnostics)) throw new Error('Missing resource diagnostic evidence');
  const peer = validateSamples(expected, 'peer', input.diagnostics.peer);
  const cli = validateSamples(expected, 'cli', input.diagnostics.cli);
  const ack = validateAck(expected, input.diagnostics.ack);
  validatePhaseOrder(peer, 'peer');
  validatePhaseOrder(cli, 'cli');
  const native = validateOwnedNativeTerminal(expected, input.nativeEvents, input.cliExit);
  const audit = input.finalAudit;
  const port = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
  if (!record(audit) || audit.phase !== 'exit' || audit.installed !== true || audit.sealed !== true || audit.pending !== 0
    || !Array.isArray(audit.attempts) || !Array.isArray(audit.accepts)
    || audit.attempts.some((attempt: unknown) => !record(attempt) || typeof attempt.host !== 'string' || !port(attempt.port)
      || typeof attempt.allowed !== 'boolean' || typeof attempt.outcome !== 'string'
      || !['denied', 'pending', 'connected', 'error'].includes(attempt.outcome)
      || attempt.afterSeal !== false || (attempt.localPort !== undefined && !port(attempt.localPort))
      || (attempt.error !== undefined && typeof attempt.error !== 'string'))
    || audit.accepts.some((accept: unknown) => !record(accept) || !port(accept.port) || !port(accept.sourcePort))) {
    throw new Error('Missing intact genuine final phase-exit audit');
  }
  const timing = input.timing;
  if (!record(timing) || timing.kind !== 'owned-close-timing' || timing.contractVersion !== input.contractVersion
    || timing.role !== expected.role || timing.nonce !== expected.nonce || timing.controllerPid !== expected.controllerPid
    || timing.cliPid !== expected.cliPid || timing.peerPid !== expected.pid || timing.clock !== 'process.hrtime.bigint'
    || timing.stopReply !== true
    || typeof timing.stopIssuedNs !== 'string' || !/^\d+$/.test(timing.stopIssuedNs)
    || typeof timing.stopReplyObservedNs !== 'string' || !/^\d+$/.test(timing.stopReplyObservedNs)
    || timing.cliExitObservedNs !== native.cliExit.monotonicNs) {
    throw new Error('Missing same-controller causal timing identity');
  }
  const issued = BigInt(timing.stopIssuedNs), replied = BigInt(timing.stopReplyObservedNs);
  const exited = BigInt(native.cliExit.monotonicNs);
  if (!(issued < replied && replied <= exited)) throw new Error('Owned controller stop/exit causal order mismatch');
  const missing = missingSamples(peer, cli);
  const sample = peer.find((entry) => entry.phase === 'after-runtime-stop-ack');
  if (sample) {
    const observedAck = validateAck(expected, sample.ack);
    if (observedAck.utc !== ack.utc || observedAck.errorFree !== ack.errorFree) throw new Error('Observed stop marker differs from persisted acknowledgment');
    return { contractVersion: input.contractVersion, kind: 'observed-post-ack' as const,
      sampleObserved: true, resourceTypes: sample.resourceTypes, missing };
  }
  if (missing.length !== 1 || missing[0] !== 'peer:after-runtime-stop-ack') throw new Error('Other mandatory diagnostic evidence is missing');
  const cutoff = issued + BigInt(DELAY_MS) * 1_000_000n;
  if (exited >= cutoff) throw new Error('Missing post-ack sample without verified exit before the nominal window');
  return { contractVersion: input.contractVersion, kind: 'verified-early-exit-without-sample' as const,
    sampleObserved: false, resourceTypes: null, missing, nominalCutoffNs: cutoff.toString(),
    timing: { stopIssuedNs: timing.stopIssuedNs, stopReplyObservedNs: timing.stopReplyObservedNs, cliExitObservedNs: native.cliExit.monotonicNs } };
}
