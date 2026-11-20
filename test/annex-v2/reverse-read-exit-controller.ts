import * as assert from 'assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import {
  assertAcceptAudit, assertDialAudit, captureOwnedReverseAudit, closeServer, readMainDialAudit,
  rpcPeer, sentinel, transparentForward, type MainDialAudit, type OwnedAuditPeer, type RpcPeer,
} from './reverse-parity-fixture';

interface ProcessRow {
  pid: number;
  ppid: number;
  rssKiB: number;
  cpuPercent: number;
  started: string;
  executable: string;
}

interface Peer {
  role: 'A' | 'B';
  profile: string;
  auditPath: string;
  ipc: net.Server;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  bootstrap?: { pid: number; ppid: number };
  rpc?: RpcPeer;
  info?: Record<string, unknown> & { port: number };
  closing?: Promise<void>;
}

const utilityEvents: Array<Record<string, unknown>> = [];
function utility(executable: string, argv: string[]): string {
  const started = Date.now();
  const result = spawnSync(executable, argv, { encoding: 'utf8', timeout: 5000 });
  utilityEvents.push({
    executable, argv, pid: result.pid, ppid: process.pid, startedUtc: new Date(started).toISOString(),
    elapsedMs: Date.now() - started, status: result.status, signal: result.signal,
    error: result.error && errorDetails(result.error),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) throw new Error(`Owned utility failed: ${executable} ${result.stderr}`);
  return result.stdout;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ErrorDetail { name?: string; message: string; stack?: string; code?: unknown; causes?: ErrorDetail[] }

function errorDetails(error: unknown): ErrorDetail {
  return error instanceof Error
    ? {
      name: error.name, message: error.message, stack: error.stack, code: 'code' in error ? error.code : undefined,
      causes: error instanceof AggregateError ? error.errors.map(errorDetails) : undefined,
    }
    : { message: String(error) };
}

function readArtifact(file: string): string {
  // eslint-disable-next-line no-restricted-syntax -- Read owned generated artifacts and guard metadata, not repository source.
  return fs.readFileSync(file, 'utf8');
}

function processes(): ProcessRow[] {
  return utility('ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,lstart=,comm='])
    .trim().split('\n').map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) throw new Error(`Invalid process sample: ${line}`);
      return {
        pid: Number(fields[0]), ppid: Number(fields[1]), rssKiB: Number(fields[2]), cpuPercent: Number(fields[3]),
        started: fields.slice(4, 9).join(' '), executable: fields.slice(9).join(' '),
      };
    });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This resource calibration requires the authorized macOS guard');
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: controller --out <new owned-exit-* cache directory>');
  const output = path.resolve(args[1]);
  const cache = path.resolve('node_modules/.cache/p8-evidence');
  if (path.dirname(output) !== cache || !path.basename(output).startsWith('owned-exit-')) {
    throw new Error('Calibration output must be a new owned-exit-* directory inside the owned evidence cache');
  }
  if (process.env.COPILOT_CONNECTION_TOKEN !== undefined) throw new Error('COPILOT_CONNECTION_TOKEN must be unset');
  fs.mkdirSync(output, { mode: 0o700 });
  const nonce = randomUUID();
  const started = Date.now();
  const expires = started + 180_000;
  const proofExpires = expires - 70_000;
  const errors: ReturnType<typeof errorDetails>[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals; at: string }> = [];
  const ledger = new Map<number, ProcessRow>();
  const peers: Peer[] = [];
  const samples: Array<Record<string, unknown>> = [];
  const git = (...argv: string[]) => utility('git', argv).trim();
  const launch = {
    utc: new Date().toISOString(), argv: process.argv, controllerPid: process.pid, nonce,
    head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), sourceStatus: git('status', '--porcelain'),
    tokenUnset: true, mode: 'bootstrap-quiesce-exit-only', opener: 'A',
    driverSha256: createHash('sha256').update(readArtifact(__filename)).digest('hex'),
    helperSha256: createHash('sha256').update(readArtifact(path.join(__dirname, 'reverse-parity-fixture.js'))).digest('hex'),
  };
  fs.writeFileSync(path.join(output, 'launch.json'), JSON.stringify(launch, null, 2) + '\n', { flag: 'wx' });
  let forward: Awaited<ReturnType<typeof transparentForward>> | undefined;
  let guard: Awaited<ReturnType<typeof sentinel>> | undefined;
  let capture: Awaited<ReturnType<typeof captureOwnedReverseAudit>> | undefined;
  let sentinelClosed = false;
  let interruption: Error | undefined;
  let proofActive = true;
  let peakNodeProcesses = 0;
  let peakAggregateRssKiB = 0;
  let peakAggregateCpuPercent = 0;
  const swapBaseline = Number(readArtifact('/tmp/clubhouse-desktop-test.swapbase').trim());
  if (!Number.isFinite(swapBaseline)) throw new Error('Invalid resource guard swap baseline');

  function sample(phase: string) {
    const rows = processes();
    const owned = new Set([process.pid, ...ledger.keys()]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
    const current = rows.filter((row) => owned.has(row.pid));
    for (const row of current) {
      const previous = ledger.get(row.pid);
      if (previous && previous.started !== row.started) throw new Error(`Owned PID was reused: ${row.pid}`);
      ledger.set(row.pid, row);
    }
    const nodeRows = current.filter((row) => path.basename(row.executable) === 'node');
    const rssKiB = current.reduce((sum, row) => sum + row.rssKiB, 0);
    const cpuPercent = current.reduce((sum, row) => sum + row.cpuPercent, 0);
    peakNodeProcesses = Math.max(peakNodeProcesses, nodeRows.length);
    peakAggregateRssKiB = Math.max(peakAggregateRssKiB, rssKiB);
    peakAggregateCpuPercent = Math.max(peakAggregateCpuPercent, cpuPercent);
    const vm = utility('vm_stat', []);
    const pressure = utility('memory_pressure', []);
    const swap = utility('sysctl', ['-n', 'vm.swapusage']);
    const top = utility('top', ['-l', '1', '-n', '0']);
    const pages = ['free', 'inactive', 'speculative', 'purgeable'].map((kind) => {
      const match = vm.match(new RegExp(`^Pages ${kind}:\\s+(\\d+)\\.$`, 'm'));
      if (!match) throw new Error(`Missing memory count: ${kind}`);
      return Number(match[1]);
    });
    const free = pressure.match(/free percentage:\s*(\d+)%/);
    const used = swap.match(/used =\s*([\d.]+)M/);
    const compressor = vm.match(/^Pages occupied by compressor:\s+(\d+)\.$/m);
    const idle = top.match(/([\d.]+)% idle/);
    if (!free || !used || !compressor || !idle) throw new Error('Invalid host resource sample');
    const availableMiB = Math.floor(pages.reduce((a, b) => a + b, 0) / 64);
    const compressorMiB = Math.floor(Number(compressor[1]) / 64);
    const swapMiB = Math.floor(Number(used[1]));
    const observation = {
      phase, utc: new Date().toISOString(), elapsedMs: Date.now() - started, processes: current,
      nodeProcesses: nodeRows.length, aggregateRssKiB: rssKiB, aggregateCpuPercent: cpuPercent,
      availableMiB, freePercent: Number(free[1]), compressorMiB, swapMiB, cpuIdlePercent: Number(idle[1]),
    };
    samples.push(observation);
    fs.appendFileSync(path.join(output, 'samples.jsonl'), JSON.stringify(observation) + '\n');
    fs.appendFileSync(path.join(output, 'host-original.log'), `\n${observation.utc} ${phase}\n${vm}${pressure}${swap}${top}`);
    if (nodeRows.length > 5 || availableMiB < 4096 || Number(free[1]) < 25
      || compressorMiB > 12288 || swapMiB > swapBaseline + 128) {
      interruption ??= new Error(`RESOURCE_ABORT ${JSON.stringify(observation)}`);
    }
  }

  async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), Math.max(1, Math.min(ms, expires - Date.now())));
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function checkProof() {
    if (interruption) throw interruption;
    if (!proofActive) throw new Error('Bootstrap proof phase ended');
    if (Date.now() >= proofExpires) throw new Error('Bootstrap deadline reached; teardown budget reserved');
  }

  async function forceStop(peer: Peer) {
    const owned = [...ledger.values()].filter((row) => row.pid !== process.pid && (
      row.pid === peer.child.pid || row.pid === peer.bootstrap?.pid
      || row.ppid === peer.child.pid || row.ppid === peer.bootstrap?.pid
    ));
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const current = processes();
      for (const expected of owned.sort((a, b) => Number(a.pid === peer.child.pid) - Number(b.pid === peer.child.pid))) {
        const row = current.find((item) => item.pid === expected.pid);
        if (!row) continue;
        if (row.started !== expected.started || row.executable !== expected.executable || row.pid <= 0) {
          throw new Error(`Refusing to terminate changed owned PID ${expected.pid}`);
        }
        try { process.kill(row.pid, signal); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') continue;
          throw error;
        }
        signals.push({ pid: row.pid, signal, at: new Date().toISOString() });
      }
      await Promise.race([peer.exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
      if (!processes().some((row) => owned.some((expected) => row.pid === expected.pid && row.started === expected.started))) break;
    }
  }

  function closePeer(peer: Peer): Promise<void> {
    peer.closing ??= (async () => {
      const closeErrors: unknown[] = [];
      if (peer.rpc) {
        try { await bounded(peer.rpc.call('stop'), 15_000, `${peer.role} stop acknowledgment`); }
        catch (error) { closeErrors.push(error); }
      } else { closeErrors.push(new Error(`${peer.role} never established owned IPC`)); }
      try {
        const result = await bounded(peer.exited, 20_000, `${peer.role} actual runner exit`);
        if (result.code !== 0 || result.signal) throw new Error(`${peer.role} runner exit ${JSON.stringify(result)}`);
        if (!peer.bootstrap) throw new Error(`${peer.role} has no actual fork identity`);
        if (processes().some((row) => row.pid === peer.bootstrap?.pid)) throw new Error(`${peer.role} fork remains alive`);
      } catch (error) {
        closeErrors.push(error);
        try { await forceStop(peer); }
        catch (terminationError) { closeErrors.push(terminationError); }
      } finally { peer.rpc?.close(); }
      if (closeErrors.length) throw new AggregateError(closeErrors, `${peer.role} owned peer did not close cleanly`);
    })();
    return peer.closing;
  }

  async function startPeer(role: 'A' | 'B', sentinelPort: number): Promise<Peer> {
    checkProof();
    const profile = path.join(output, `peer-${role}`);
    const auditPath = path.join(output, `${role}-main-exit.json`);
    fs.mkdirSync(profile, { mode: 0o700 });
    const ipcPath = path.join(output, `${role}.sock`);
    const ipc = net.createServer();
    const connected = new Promise<net.Socket>((resolve) => ipc.once('connection', resolve));
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(ipcPath, resolve); });
    const child = spawn(process.execPath, [
      path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--project', 'integration',
      'test/annex-v2/reverse-inventory-worker.test.ts', '--pool=forks', '--maxWorkers=1',
      '--fileParallelism=false', '--disableConsoleIntercept',
    ], {
      env: {
        ...process.env, CLUBHOUSE_ANNEX_INVENTORY_PEER: '1', CLUBHOUSE_ANNEX_INVENTORY_IPC: ipcPath,
        CLUBHOUSE_ANNEX_OWNED_EXIT: '1', CLUBHOUSE_ANNEX_OWNED_ROLE: role, CLUBHOUSE_ANNEX_OWNED_NONCE: nonce,
        CLUBHOUSE_ANNEX_OWNED_AUDIT: auditPath, CLUBHOUSE_ANNEX_OWNED_SENTINEL: String(sentinelPort),
        CLUBHOUSE_ANNEX_OWNED_PROFILE: profile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        fs.writeFileSync(path.join(output, `${role}-runner-exit.json`), JSON.stringify({ pid: child.pid, code, signal, utc: new Date().toISOString() }) + '\n', { flag: 'wx' });
        resolve({ code, signal });
      });
    });
    const peer: Peer = { role, profile, auditPath, ipc, child, exited };
    peers.push(peer);
    let lines = '';
    child.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      fs.appendFileSync(path.join(output, `${role}-stdout.log`), text);
      lines += text;
      let end: number;
      while ((end = lines.indexOf('\n')) >= 0) {
        const line = lines.slice(0, end);
        lines = lines.slice(end + 1);
        if (!line.startsWith('OWNED_PEER_BOOTSTRAP ')) continue;
        try {
          const value: unknown = JSON.parse(line.slice('OWNED_PEER_BOOTSTRAP '.length));
          if (!record(value) || value.role !== role || value.nonce !== nonce || !Number.isInteger(value.pid)
            || value.ppid !== child.pid || value.pid === process.pid || value.pid === child.pid || peer.bootstrap) {
            throw new Error(`Invalid/replaced ${role} fork bootstrap`);
          }
          peer.bootstrap = { pid: Number(value.pid), ppid: Number(value.ppid) };
          sample(`${role}-fork-identity`);
        } catch (error) { interruption ??= new Error(`${role} bootstrap identity failed: ${JSON.stringify(errorDetails(error))}`); }
      }
    });
    child.stderr!.on('data', (data: Buffer) => fs.appendFileSync(path.join(output, `${role}-stderr.log`), data));
    const socket = await bounded(Promise.race([
      connected,
      exited.then((result): never => { throw new Error(`${role} exited before ready: ${JSON.stringify(result)}`); }),
    ]), 30_000, `${role} startup`);
    peer.rpc = rpcPeer(socket, async (method) => { throw new Error(`Unexpected ${role} worker request: ${method}`); });
    const info = await peer.rpc.call<unknown>('info');
    const audit = await peer.rpc.call<unknown>('exitAuditInfo');
    if (!record(info) || !Number.isInteger(info.port) || typeof info.fingerprint !== 'string'
      || !record(audit) || audit.pid !== peer.bootstrap?.pid || audit.profile !== profile || audit.auditPath !== auditPath
      || audit.calibration !== 'ERR_REVERSE_DIAL_BLOCKED') {
      throw new Error(`Invalid ${role} actual peer/audit identity`);
    }
    peer.info = { ...info, port: Number(info.port) };
    fs.writeFileSync(path.join(output, `${role}-identity.json`), JSON.stringify({ bootstrap: peer.bootstrap, info, audit }, null, 2) + '\n', { flag: 'wx' });
    checkProof();
    return peer;
  }

  sample('controller-start');
  const monitor = setInterval(() => {
    try { sample('interval'); }
    catch (error) { interruption ??= new Error(`Resource sampling failed: ${JSON.stringify(errorDetails(error))}`); }
  }, 2000);
  try {
    assert.equal(launch.sourceStatus, '', 'Calibration must start on an exact committed source');
    guard = await sentinel();
    const a = await startPeer('A', guard.port);
    const b = await startPeer('B', guard.port);
    assert.ok(a.info && b.info && a.rpc && b.rpc && a.bootstrap && b.bootstrap);
    assert.notEqual(a.bootstrap.pid, b.bootstrap.pid);
    forward = await transparentForward(b.info.port);
    const aRpc = a.rpc, bRpc = b.rpc, activeForward = forward, activeGuard = guard;
    await b.rpc.call('configure', { peer: a.info, routePort: guard.port, forwardPort: null });
    await a.rpc.call('configure', { peer: b.info, routePort: forward.port, forwardPort: forward.port });
    await bounded((async () => {
      while (true) {
        checkProof();
        const aStatus = await aRpc.call<unknown>('status'), bStatus = await bRpc.call<unknown>('status');
        if (record(aStatus) && record(bStatus) && record(aStatus.readiness) && record(bStatus.readiness)
          && aStatus.readiness.openedHere === true && bStatus.readiness.acceptedHere === true
          && aStatus.direct === true && bStatus.direct === false && aStatus.connected === true && bStatus.connected === true
          && record(aStatus.snapshot) && record(bStatus.snapshot)) {
          fs.writeFileSync(path.join(output, 'ready.json'), JSON.stringify({ a: aStatus, b: bStatus, forward: activeForward.snapshot(), sentinelAccepts: activeGuard.accepts() }, null, 2) + '\n', { flag: 'wx' });
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    })(), 15_000, 'authenticated bidirectional snapshot readiness');
    sample('both-ready');
    assert.equal(peakNodeProcesses, 5, 'All five Node processes must be observed');
    checkProof();
  } catch (error) { errors.push(errorDetails(error)); }
  finally {
    proofActive = false;
    if (forward && peers.length === 2) {
      const ownedPeers = peers.map((peer): OwnedAuditPeer => ({
        quiesce: (ports) => {
          if (!peer.rpc) return Promise.reject(new Error(`${peer.role} has no quiesce IPC`));
          return peer.rpc.call<MainDialAudit>('quiesce', ports);
        },
        close: () => closePeer(peer),
        readFinal: async () => readMainDialAudit(peer.auditPath),
      }));
      capture = await captureOwnedReverseAudit(forward, [ownedPeers[0], ownedPeers[1]]);
      if (capture.status === 'failed') errors.push(...capture.errors.map(errorDetails));
      else {
        try {
          assert.ok(guard && peers[0].info && peers[1].info, 'Missing final peer/sentinel identity');
          assertDialAudit(capture.audits[0].attempts, { host: '127.0.0.1', port: forward.port }, capture.forward.sourcePorts, guard.accepts());
          assertDialAudit(capture.audits[1].attempts, null, [], guard.accepts());
          assertAcceptAudit(capture.audits[0].accepts, peers[0].info.port, []);
          assertAcceptAudit(capture.audits[1].accepts, peers[1].info.port, capture.forward.targetSourcePorts);
          assert.ok(capture.audits.every((audit) => audit.attempts.every((attempt) => !attempt.afterSeal)));
        } catch (error) { errors.push(errorDetails(error)); }
      }
    } else {
      for (const peer of peers) {
        try { await closePeer(peer); }
        catch (error) { errors.push(errorDetails(error)); }
      }
      try { await forward?.close(); }
      catch (error) { errors.push(errorDetails(error)); }
    }
    for (const peer of peers) {
      try { await closeServer(peer.ipc); }
      catch (error) { errors.push(errorDetails(error)); }
    }
    try {
      if (guard) { await guard.close(); sentinelClosed = true; }
    }
    catch (error) { errors.push(errorDetails(error)); }
    const sentinelAccepts = guard?.accepts();
    clearInterval(monitor);
    try { sample('owned-closed'); }
    catch (error) { errors.push(errorDetails(error)); }
    if (interruption) errors.push(errorDetails(interruption));
    if (signals.length) errors.push(errorDetails(new Error('Forced termination occurred; capture is partial')));
    const remaining = processes().filter((row) => ledger.has(row.pid) && row.pid !== process.pid
      && ledger.get(row.pid)?.started === row.started && path.basename(row.executable) === 'node');
    if (remaining.length || peers.some((peer) => fs.existsSync(peer.profile))) {
      errors.push(errorDetails(new Error('Owned process/profile teardown is not clean')));
    }
    const result = {
      status: errors.length === 0 && capture?.status === 'complete' && sentinelClosed && sentinelAccepts === 0 ? 'complete' : 'failed',
      scope: 'one A-opener bootstrap/quiesce/actual-exit calibration; no read-route cases',
      launch, elapsedMs: Date.now() - started, capture,
      sentinel: { accepts: sentinelAccepts, closed: sentinelClosed },
      peakNodeProcesses, peakAggregateRssKiB, peakAggregateCpuPercent,
      rssIncludesSharedMemoryDoubleCounting: true, processLedger: [...ledger.values()], samples: samples.length,
      utilityEvents,
      samplingLimit: 'All controller utility lifetimes are recorded; peer transient children are sampled and very short lifetimes/instantaneous RSS peaks may be missed. No whole-process-tree confinement or exact peak-physical-memory claim.',
      signals, remaining, errors,
    };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.info(JSON.stringify(result));
    process.exitCode = result.status === 'complete' ? 0 : 1;
  }
}

void main().catch((error: unknown) => { console.error(errorDetails(error)); process.exitCode = 1; });
