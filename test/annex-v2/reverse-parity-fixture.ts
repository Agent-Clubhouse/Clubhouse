import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import * as net from 'net';

export interface DialAttempt {
  host: string;
  port: number;
  allowed: boolean;
  outcome: 'denied' | 'pending' | 'connected' | 'error';
  localPort?: number;
  error?: string;
}

export interface DialPolicy {
  attempts: DialAttempt[];
  restore(): void;
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
    if (permitted && attempt.outcome === 'connected' && !forwardSourcePorts.includes(attempt.localPort!)) {
      throw new Error('Successful app dial is missing from the forward audit');
    }
  }
  for (const port of forwardSourcePorts) {
    if (!attempts.some((attempt) => attempt.outcome === 'connected' && attempt.localPort === port)) {
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
  const fixtureConnect = net.Socket.prototype.connect;
  const sockets = new Set<net.Socket>();
  const sourcePorts: number[] = [];
  const targetPorts: number[] = [];
  const server = net.createServer((incoming) => {
    sourcePorts.push(incoming.remotePort!);
    const outgoing = new net.Socket();
    Reflect.apply(fixtureConnect, outgoing, [targetPort, '127.0.0.1']);
    outgoing.once('connect', () => { targetPorts.push(outgoing.remotePort!); });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.once('close', () => { sockets.delete(socket); });
    }
    incoming.on('error', () => outgoing.destroy());
    outgoing.on('error', () => incoming.destroy());
    incoming.on('close', () => outgoing.destroy());
    outgoing.on('close', () => incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);
  });
  const port = await listen(server);
  return {
    port, sourcePorts, targetPorts,
    cut() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
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
