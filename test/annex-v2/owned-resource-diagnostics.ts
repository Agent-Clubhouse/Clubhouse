import * as fs from 'fs';
import * as path from 'path';

export interface OwnedResourceIdentity {
  role: 'A' | 'B';
  nonce: string;
  auditPath: string;
}

type ResourcePhase = 'before-service-quiesce' | 'after-service-quiesce'
  | 'before-service-close' | 'after-service-close' | 'observer-armed'
  | 'before-runtime-stop-ack' | 'after-runtime-stop-ack'
  | 'delayed-ack-unobserved' | 'delayed-ack-invalid';

interface StopAck {
  kind: 'runtime-stop-ack';
  role: 'A' | 'B';
  nonce: string;
  cliPid: number;
  utc: string;
  errorFree: boolean;
}

interface ResourceSample {
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
  'observer-armed', 'before-runtime-stop-ack', 'after-runtime-stop-ack', 'delayed-ack-unobserved', 'delayed-ack-invalid',
]);

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
  return record(value) && value.kind === 'runtime-stop-ack' && (value.role === 'A' || value.role === 'B')
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
      delayedTimerState: timer ? timer.running ? 'running' : 'armed' : 'absent', delayedTimerMs: timer ? 1000 : 0,
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
      }, 1000);
      handle.unref();
      timer = { handle, running: false };
      writeSample(identity, 'peer', 'observer-armed', timer);
    },
  };
}

export function readOwnedResourceDiagnostics(identity: OwnedResourceIdentity,
  expected: { pid: number; cliPid: number; controllerPid: number }) {
  const read = (context: 'peer' | 'cli') => readArtifact(artifact(identity, `${context}-resources.jsonl`))
    .trim().split('\n').map((line): ResourceSample => {
      const value: unknown = JSON.parse(line);
      if (!resourceSample(value) || value.context !== context || value.role !== identity.role || value.nonce !== identity.nonce
        || value.pid !== (context === 'peer' ? expected.pid : expected.cliPid)
        || value.ppid !== (context === 'peer' ? expected.cliPid : expected.controllerPid)
        || value.observer.delayedTimerHasRef !== false || value.observer.addedListeners !== 0
        || value.observer.addedWatchers !== 0 || value.observer.addedProcesses !== 0
        || value.observer.synchronousArtifactIO !== true) {
        throw new Error(`Invalid owned ${context} resource diagnostic sample`);
      }
      if (value.phase === 'after-runtime-stop-ack' && context === 'peer'
        && (!stopAck(value.ack) || value.ack.role !== identity.role || value.ack.nonce !== identity.nonce
          || value.ack.cliPid !== expected.cliPid || !value.ack.errorFree)) {
        throw new Error('Resource diagnostic sample lacks its genuine stop-ack identity');
      }
      return value;
    });
  const peer = read('peer'), cli = read('cli');
  const requiredPeer = ['before-service-quiesce', 'after-service-quiesce', 'before-service-close',
    'after-service-close', 'observer-armed', 'after-runtime-stop-ack'];
  const missing = [
    ...requiredPeer.filter((phase) => !peer.some((sample) => sample.phase === phase)).map((phase) => `peer:${phase}`),
    ...['before-runtime-stop-ack', 'after-runtime-stop-ack'].filter((phase) => !cli.some((sample) => sample.phase === phase))
      .map((phase) => `cli:${phase}`),
  ];
  return { role: identity.role, status: missing.length === 0 ? 'captured' : 'partial', missing, peer, cli };
}
