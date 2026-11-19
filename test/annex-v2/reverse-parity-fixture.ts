import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import * as fs from 'fs';
import * as net from 'net';
import { crc32 } from 'zlib';

const fixtureConnect = net.Socket.prototype.connect;

export function sizedPng(size: number): Buffer {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
  if (!Number.isSafeInteger(size) || size < png.length + 12) throw new Error('PNG fixture size is too small');
  const body = Buffer.alloc(size - png.length - 8);
  body.write('raNd', 'ascii');
  for (let i = 4; i < body.length; i++) body[i] = (i - 4) & 0xff;
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(body.length - 4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([png.subarray(0, 33), length, body, crc, png.subarray(33)]);
}

export interface DialAttempt {
  host: string;
  port: number;
  allowed: boolean;
  outcome: 'denied' | 'pending' | 'connected' | 'error';
  localPort?: number;
  error?: string;
  afterSeal?: boolean;
}

export interface DialPolicy {
  attempts: DialAttempt[];
  restore(): void;
}

export interface ListenerAccept {
  port: number;
  sourcePort: number;
}

export interface MainDialAudit {
  phase: 'live' | 'exit';
  installed: boolean;
  sealed: boolean;
  pending: number;
  attempts: DialAttempt[];
  accepts: ListenerAccept[];
}

export interface ForwardAudit {
  sealed: boolean;
  closed: boolean;
  pending: number;
  sockets: number;
  sourcePorts: number[];
  targetPorts: number[];
  targetSourcePorts: number[];
  lateSourcePorts: number[];
}

export interface OwnedAuditPeer {
  quiesce(expectedSourcePorts?: readonly number[]): Promise<MainDialAudit>;
  close(): Promise<void>;
  readFinal(): Promise<MainDialAudit>;
}

export type OwnedAuditCapture =
  | { status: 'complete'; audits: MainDialAudit[]; forward: ForwardAudit }
  | { status: 'failed'; audits: Array<MainDialAudit | null>; forward: ForwardAudit; errors: unknown[] };

export interface MainGuard {
  read(): MainDialAudit;
  setForward(port: number): void;
  seal(expected?: { port: number; sourcePorts: readonly number[] }): Promise<MainDialAudit>;
}

export type GuardGlobal = typeof globalThis & { __reverseP8?: MainGuard };

/** Self-contained so Electron.evaluate and the Node calibration exercise the same guard. */
export async function installMainGuard(
  { app }: { app: { getPath(name: 'userData'): string } },
  input: { profile: string; sentinelPort: number; auditPath: string },
): Promise<string> {
  const fs = process.getBuiltinModule('fs');
  const net = process.getBuiltinModule('net');
  if (fs.realpathSync(app.getPath('userData')) !== fs.realpathSync(input.profile)) throw new Error('Wrong reverse fixture profile');
  const state = globalThis as GuardGlobal;
  if (state.__reverseP8) throw new Error('Reverse dial guard already installed');
  const original = net.Socket.prototype.connect;
  const originalEmit = net.Server.prototype.emit;
  const originalProcessEmit = process.emit;
  const attempts: DialAttempt[] = [];
  const accepts: ListenerAccept[] = [];
  const pending = new Set<Promise<void>>();
  const acceptProgress = new Set<() => void>();
  let forward: number | null = null;
  let sealed = false;
  const audit: typeof originalEmit = function (this: net.Server, event: string | symbol, ...args: unknown[]) {
    const socket = args[0];
    if (event === 'connection' && socket instanceof net.Socket && socket.localPort && socket.remotePort) {
      accepts.push({ port: socket.localPort, sourcePort: socket.remotePort });
      for (const notify of acceptProgress) notify();
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  const patched: typeof original = function (this: net.Socket, ...args: unknown[]) {
    const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host: string, port: number;
    if (first && typeof first === 'object') {
      if ('path' in first && first.path && !('port' in first)) return Reflect.apply(original, this, args);
      if (!('port' in first)) throw new Error('Unrecognized reverse fixture dial');
      port = Number(first.port);
      host = 'host' in first && typeof first.host === 'string' ? first.host : 'localhost';
    } else if (typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first)) {
      port = Number(first);
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof first === 'string') {
      return Reflect.apply(original, this, args);
    } else {
      throw new Error('Unrecognized reverse fixture dial');
    }
    const allowed = forward !== null && host === '127.0.0.1' && port === forward;
    const attempt: DialAttempt = { host, port, allowed, outcome: allowed ? 'pending' : 'denied', afterSeal: sealed };
    attempts.push(attempt);
    if (!allowed || sealed) {
      const code = allowed ? 'ERR_REVERSE_TRANSPORT_SEALED' : 'ERR_REVERSE_DIAL_BLOCKED';
      attempt.outcome = allowed ? 'error' : 'denied';
      attempt.error = code;
      process.nextTick(() => this.destroy(Object.assign(new Error(code), { code })));
      return this;
    }
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => { settle = resolve; });
    pending.add(finished);
    const finish = () => { pending.delete(finished); settle(); };
    this.once('connect', () => { attempt.outcome = 'connected'; attempt.localPort = this.localPort; finish(); });
    this.once('error', (error: NodeJS.ErrnoException) => { attempt.outcome = 'error'; attempt.error = error.code; finish(); });
    this.once('close', finish);
    try { return Reflect.apply(original, this, args); }
    catch (error) {
      attempt.outcome = 'error';
      attempt.error = error instanceof Error ? error.message : String(error);
      finish();
      throw error;
    }
  };
  const read = (): MainDialAudit => ({
    phase: 'live', installed: net.Socket.prototype.connect === patched && net.Server.prototype.emit === audit
      && process.emit === exitEmit && state.__reverseP8 === guard,
    sealed, pending: pending.size, attempts, accepts,
  });
  const guard: MainGuard = {
    read,
    setForward(port) {
      if (forward !== null || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid reverse fixture forward');
      forward = port;
    },
    async seal(expected) {
      sealed = true;
      let timeout: NodeJS.Timeout | undefined;
      let accepted: (() => void) | undefined;
      try {
        await Promise.race([
          Promise.all([
            ...pending,
            new Promise<void>((resolve) => {
              accepted = () => {
                if (!expected || expected.sourcePorts.every((sourcePort) =>
                  accepts.some((entry) => entry.port === expected.port && entry.sourcePort === sourcePort))) resolve();
              };
              acceptProgress.add(accepted);
              accepted();
            }),
          ]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Reverse main dials/accepts did not settle before capture')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        if (accepted) acceptProgress.delete(accepted);
      }
      return read();
    },
  };
  const exitEmit: typeof process.emit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]) {
    if (event !== 'exit') return Reflect.apply(originalProcessEmit, this, [event, ...args]);
    // Write after every exit listener, including listeners installed after this guard.
    try { return Reflect.apply(originalProcessEmit, this, [event, ...args]); }
    finally { fs.writeFileSync(input.auditPath, JSON.stringify({ ...read(), phase: 'exit' }), { flag: 'wx', mode: 0o600 }); }
  };
  net.Socket.prototype.connect = patched;
  net.Server.prototype.emit = audit;
  process.emit = exitEmit;
  state.__reverseP8 = guard;
  return new Promise<string>((resolve) => {
    const socket = net.connect(input.sentinelPort, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve('escaped'); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
  });
}

export function readMainDialAudit(file: string): MainDialAudit {
  // eslint-disable-next-line no-restricted-syntax -- Read the generated exit receipt, not repository source.
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const record = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null;
  const attempt = (item: unknown): item is DialAttempt => record(item)
    && typeof item.host === 'string' && Number.isInteger(item.port) && typeof item.allowed === 'boolean'
    && typeof item.outcome === 'string' && ['denied', 'pending', 'connected', 'error'].includes(item.outcome)
    && (item.localPort === undefined || typeof item.localPort === 'number')
    && (item.error === undefined || typeof item.error === 'string')
    && (item.afterSeal === undefined || typeof item.afterSeal === 'boolean');
  const accepted = (item: unknown): item is ListenerAccept => record(item)
    && typeof item.port === 'number' && typeof item.sourcePort === 'number';
  if (!record(value) || value.phase !== 'exit' || typeof value.installed !== 'boolean'
    || typeof value.sealed !== 'boolean' || typeof value.pending !== 'number'
    || !Array.isArray(value.attempts) || !value.attempts.every(attempt)
    || !Array.isArray(value.accepts) || !value.accepts.every(accepted)) {
    throw new Error(`Missing or invalid final reverse audit: ${file}`);
  }
  return {
    phase: value.phase, installed: value.installed, sealed: value.sealed, pending: value.pending,
    attempts: value.attempts, accepts: value.accepts,
  };
}

/** Target-side evidence also sees child/native clients that bypass Socket.connect in this process. */
export function installAcceptAudit() {
  const original = net.Server.prototype.emit;
  const accepts: ListenerAccept[] = [];
  const patched: typeof original = function (this: net.Server, event: string | symbol, ...args: unknown[]) {
    const socket = args[0];
    if (event === 'connection' && socket instanceof net.Socket && socket.localPort && socket.remotePort) {
      accepts.push({ port: socket.localPort, sourcePort: socket.remotePort });
    }
    return Reflect.apply(original, this, [event, ...args]);
  };
  net.Server.prototype.emit = patched;
  return {
    accepts,
    restore() {
      if (net.Server.prototype.emit !== patched) throw new Error('Reverse listener audit was replaced without being restored');
      net.Server.prototype.emit = original;
    },
  };
}

export function assertAcceptAudit(accepts: ListenerAccept[], port: number, forwardPorts: number[]): void {
  const targetAccepts = accepts.filter((accepted) => accepted.port === port);
  if (targetAccepts.some((accepted) => !forwardPorts.includes(accepted.sourcePort))) {
    throw new Error('Target listener accepted traffic outside the forward');
  }
  if (forwardPorts.some((sourcePort) => !targetAccepts.some((accepted) => accepted.sourcePort === sourcePort))) {
    throw new Error('Forward connection is missing from the target listener audit');
  }
}

function destination(args: unknown[]): { host: string; port: number } | null {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    if ('path' in first && first.path && !('port' in first)) return null;
    if ('port' in first) {
      return { host: 'host' in first && typeof first.host === 'string' ? first.host : 'localhost', port: Number(first.port) };
    }
  }
  if (typeof first === 'number' || typeof first === 'string' && /^\d+$/.test(first)) {
    return { port: Number(first), host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  }
  if (typeof first === 'string') return null;
  throw new Error('Unrecognized Socket.connect arguments in reverse dial audit');
}

/** Installed only inside disposable Node test processes, before starting the client. */
export function installDialPolicy(allow: (host: string, port: number) => boolean): DialPolicy {
  const original = net.Socket.prototype.connect;
  const attempts: DialAttempt[] = [];
  const patched: typeof original = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const endpoint = destination(args);
    if (!endpoint) return Reflect.apply(original, this, args);
    const allowed = allow(endpoint.host, endpoint.port);
    const attempt: DialAttempt = { ...endpoint, allowed, outcome: allowed ? 'pending' : 'denied' };
    attempts.push(attempt);
    if (!allowed) {
      const error = Object.assign(new Error(`Reverse fixture denied TCP dial to ${endpoint.host}:${endpoint.port}`), { code: 'ERR_REVERSE_DIAL_BLOCKED' });
      attempt.error = error.code;
      process.nextTick(() => this.destroy(error));
      return this;
    }
    this.once('connect', () => { attempt.outcome = 'connected'; attempt.localPort = this.localPort; });
    this.once('error', (error: NodeJS.ErrnoException) => {
      attempt.outcome = 'error';
      attempt.error = error.code ?? error.message;
    });
    return Reflect.apply(original, this, args);
  };
  net.Socket.prototype.connect = patched;
  return {
    attempts,
    restore() {
      if (net.Socket.prototype.connect !== patched) throw new Error('Reverse dial policy was replaced without being restored');
      net.Socket.prototype.connect = original;
    },
  };
}

export function assertDialAudit(
  attempts: DialAttempt[],
  allowed: { host: string; port: number } | null,
  forwardSourcePorts: number[],
  sentinelAccepts: number,
): void {
  if (sentinelAccepts !== 0) throw new Error('Reverse direct-dial sentinel accepted traffic');
  for (const attempt of attempts) {
    const permitted = !!allowed && attempt.host === allowed.host && attempt.port === allowed.port;
    if (attempt.allowed !== permitted) throw new Error(`Dial policy allowed an unapproved endpoint: ${attempt.host}:${attempt.port}`);
    if (!permitted && attempt.outcome !== 'denied') throw new Error('A forbidden direct dial escaped enforcement');
    if (permitted && attempt.localPort !== undefined && !forwardSourcePorts.includes(attempt.localPort)) {
      throw new Error('Successful app dial is missing from the forward audit');
    }
  }
  for (const port of forwardSourcePorts) {
    if (!attempts.some((attempt) => attempt.allowed && attempt.localPort === port)) {
      throw new Error('Forward accepted an unaudited app dial');
    }
  }
}

export async function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an INET listener');
  return address.port;
}

export async function closeServer(server: net.Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function transparentForward(targetPort: number) {
  const sockets = new Set<net.Socket>();
  const toB = new Set<net.Socket>();
  const toA = new Set<net.Socket>();
  const sourcePorts: number[] = [];
  const targetPorts: number[] = [];
  const targetSourcePorts: number[] = [];
  const lateSourcePorts: number[] = [];
  const pending = new Set<net.Socket>();
  const progress = new Set<() => void>();
  const changed = () => { for (const notify of progress) notify(); };
  let sealed = false, closed = false;
  let sealing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const waitUntil = (ready: () => boolean, message: string): Promise<void> => {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const notify = () => {
        if (!ready()) return;
        clearTimeout(timeout);
        progress.delete(notify);
        resolve();
      };
      const timeout = setTimeout(() => { progress.delete(notify); reject(new Error(message)); }, 5000);
      progress.add(notify);
      notify();
    });
  };
  const server = net.createServer((incoming) => {
    sourcePorts.push(incoming.remotePort!);
    sockets.add(incoming);
    toB.add(incoming);
    incoming.once('close', () => { sockets.delete(incoming); toB.delete(incoming); changed(); });
    incoming.on('error', () => incoming.destroy());
    if (sealed) {
      lateSourcePorts.push(incoming.remotePort!);
      incoming.destroy();
      changed();
      return;
    }
    const outgoing = new net.Socket();
    sockets.add(outgoing);
    toA.add(outgoing);
    pending.add(outgoing);
    outgoing.once('close', () => { sockets.delete(outgoing); toA.delete(outgoing); pending.delete(outgoing); changed(); });
    outgoing.once('connect', () => {
      targetPorts.push(outgoing.remotePort!);
      targetSourcePorts.push(outgoing.localPort!);
      pending.delete(outgoing);
      changed();
    });
    incoming.on('error', () => outgoing.destroy());
    outgoing.on('error', () => { pending.delete(outgoing); incoming.destroy(); changed(); });
    incoming.on('close', () => outgoing.destroy());
    outgoing.on('close', () => incoming.destroy());
    Reflect.apply(fixtureConnect, outgoing, [targetPort, '127.0.0.1']);
    incoming.pipe(outgoing).pipe(incoming);
    changed();
  });
  server.once('close', () => { closed = true; changed(); });
  const port = await listen(server);
  return {
    port, sourcePorts, targetPorts, targetSourcePorts,
    snapshot(): ForwardAudit {
      return {
        sealed, closed, pending: pending.size, sockets: sockets.size,
        sourcePorts: [...sourcePorts], targetPorts: [...targetPorts], targetSourcePorts: [...targetSourcePorts], lateSourcePorts: [...lateSourcePorts],
      };
    },
    sealAndDrain(expectedSourcePorts: readonly number[]) {
      sealing ??= (async () => {
        await waitUntil(() => expectedSourcePorts.every((sourcePort) => sourcePorts.includes(sourcePort)) && pending.size === 0,
          'Reverse forward did not observe all quiesced dials and target callbacks');
        sealed = true;
        for (const socket of sockets) socket.destroy();
        await waitUntil(() => sockets.size === 0 && pending.size === 0, 'Reverse forward sockets did not drain');
      })();
      return sealing;
    },
    pause(direction: 'A-to-B' | 'B-to-A') {
      const paused = [...(direction === 'A-to-B' ? toB : toA)];
      for (const socket of paused) socket.pause();
      return () => { for (const socket of paused) socket.resume(); };
    },
    cut() { for (const socket of sockets) socket.destroy(); },
    close() {
      closing ??= (async () => {
        sealed = true;
        const stopped = closeServer(server);
        for (const socket of sockets) socket.destroy();
        await stopped;
        await waitUntil(() => sockets.size === 0 && pending.size === 0, 'Reverse forward close did not drain');
      })();
      return closing;
    },
  };
}

/**
 * Quiesce guarded producers, then settle and seal F without closing its listener:
 * late native/child accepts are still recorded and fail capture. Drain owned
 * sockets, wait for the target's accept callbacks, close peers with recorders
 * installed, and read only their exit receipts.
 * Close/drain F last; no live array is compared with an earlier IPC snapshot.
 * Every failure still attempts both peer closes and F close, returning explicit partial evidence.
 */
export async function captureOwnedReverseAudit(
  forward: Awaited<ReturnType<typeof transparentForward>>,
  peers: readonly [OwnedAuditPeer, OwnedAuditPeer],
): Promise<OwnedAuditCapture> {
  const errors: unknown[] = [];
  const quiesced = await Promise.allSettled(peers.map((peer) => Promise.resolve().then(() => peer.quiesce())));
  for (const result of quiesced) if (result.status === 'rejected') errors.push(result.reason);
  if (errors.length === 0 && quiesced[0].status === 'fulfilled') {
    try {
      await forward.sealAndDrain(quiesced[0].value.attempts.flatMap((attempt) => attempt.localPort === undefined ? [] : [attempt.localPort]));
      await peers[1].quiesce(forward.snapshot().targetSourcePorts);
    } catch (error) { errors.push(error); }
  }
  const closed = await Promise.allSettled(peers.map((peer) => Promise.resolve().then(() => peer.close())));
  for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
  try { await forward.close(); }
  catch (error) { errors.push(error); }
  const final = await Promise.allSettled(peers.map((peer) => Promise.resolve().then(() => peer.readFinal())));
  for (const result of final) {
    if (result.status === 'rejected') errors.push(result.reason);
    else if (result.value.phase !== 'exit' || !result.value.installed || !result.value.sealed || result.value.pending !== 0) {
      errors.push(new Error('Reverse desktop exited without an intact, quiesced final audit'));
    }
  }
  const captured = forward.snapshot();
  if (captured.lateSourcePorts.length) errors.push(new Error('Reverse forward accepted traffic after sealing'));
  if (!captured.closed || captured.pending || captured.sockets) errors.push(new Error('Reverse forward capture was not fully drained'));
  if (errors.length) return {
    status: 'failed', errors, forward: captured,
    audits: final.map((result) => result.status === 'fulfilled' ? result.value : null),
  };
  return { status: 'complete', audits: final.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []), forward: captured };
}

export async function sentinel() {
  let accepts = 0;
  const server = net.createServer((socket) => { accepts++; socket.destroy(); });
  const port = await listen(server);
  return { port, accepts: () => accepts, close: () => closeServer(server) };
}

export interface RpcPeer {
  call<T>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export function rpcPeer(socket: net.Socket, handle: (method: string, params: unknown) => Promise<unknown>): RpcPeer {
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const lines = createInterface({ input: socket });
  const failPending = () => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('Reverse fixture IPC closed')); }
    waiting.clear();
  };
  socket.on('error', failPending);
  socket.on('close', failPending);
  lines.on('line', (line) => {
    const message = JSON.parse(line) as { id: string; method?: string; params?: unknown; result?: unknown; error?: string };
    if (message.method) {
      void handle(message.method, message.params).then(
        (result) => socket.write(`${JSON.stringify({ id: message.id, result })}\n`),
        (error: unknown) => socket.write(`${JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : String(error) })}\n`),
      );
    } else {
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  });
  return {
    call<T>(method: string, params?: unknown): Promise<T> {
      const id = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Reverse fixture IPC timed out: ${method}`)); }, 15_000);
        waiting.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() { lines.close(); socket.destroy(); failPending(); },
  };
}
