import type { LaunchedApp } from '../launch';
import * as fs from 'fs';
import * as path from 'path';
import { ELECTRON_DIST_DIR } from '../e2e-cleanup';
import { assertOwnedMainProcess } from '../owned-process-receipts';

export interface DeliveryBoundary {
  pid: number;
  launcherPid: number;
  callId: string;
  status: number;
  receiptAt: string;
  resultHash: string;
  outboxIds: string[];
}

export async function readOwnedSenderIdentity(app: LaunchedApp) {
  const child = app.electronApp.process();
  const launcherPid = child.pid;
  const main = await app.electronApp.evaluate(({ app: electronApp }) => {
    const fs = process.getBuiltinModule('fs');
    return {
      pid: process.pid, ppid: process.ppid, platform: process.platform,
      profile: fs.realpathSync(electronApp.getPath('userData')), executable: fs.realpathSync(process.execPath),
    };
  });
  assertOwnedMainProcess(launcherPid, main);
  const relativeExecutable = path.relative(fs.realpathSync(ELECTRON_DIST_DIR), main.executable);
  if (app.electronApp.process() !== child || child.pid !== launcherPid || main.platform !== process.platform
    || main.profile !== fs.realpathSync(app.userDataDir) || app.userDataDir !== app.profile.userDataDir
    || !relativeExecutable || relativeExecutable.startsWith('..') || path.isAbsolute(relativeExecutable)) {
    throw new Error('Owned sender launcher, profile, or repository Electron executable changed');
  }
  return { ...main, launcherPid };
}

/** Observe actual requests without replacing the receiver's routing, TLS, or authorization. */
export async function observeDeliveryRequests(app: LaunchedApp, artifact: string): Promise<void> {
  await app.electronApp.evaluate(({ app: electronApp }, input) => {
    const fs = process.getBuiltinModule('fs');
    const http = process.getBuiltinModule('http');
    const https = process.getBuiltinModule('https');
    if (fs.realpathSync(electronApp.getPath('userData')) !== fs.realpathSync(input.profile)) throw new Error('Wrong receiver profile');
    const prototype = https.Server.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'emit');
    const original = prototype.emit;
    prototype.emit = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const [event, request, response] = args;
        if (event === 'request' && request instanceof http.IncomingMessage && response instanceof http.ServerResponse
          && request.method === 'POST' && request.url === '/api/v1/network/agent-call') {
          let body = '';
          request.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
            if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Unexpected agent-call request size');
          });
          request.once('end', () => {
            const parsed: unknown = JSON.parse(body);
            if (!parsed || typeof parsed !== 'object' || !('callId' in parsed) || typeof parsed.callId !== 'string') throw new Error('Missing actual call identity');
            fs.appendFileSync(input.artifact, `${JSON.stringify({ callId: parsed.callId })}\n`);
          });
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    (globalThis as typeof globalThis & { __annexE2EDeliveryRestore?: () => void }).__annexE2EDeliveryRestore = () => {
      if (descriptor) Object.defineProperty(prototype, 'emit', descriptor);
      else Reflect.deleteProperty(prototype, 'emit');
    };
  }, { artifact, profile: app.userDataDir });
}

/** Pause only the owned sender's terminal rename, after observing its real successful receipt. */
export async function armDeliveryCommitBarrier(app: LaunchedApp, callId: string, artifact: string) {
  const sender = await readOwnedSenderIdentity(app);
  await app.electronApp.evaluate(({ app: electronApp }, input) => {
    const fs = process.getBuiltinModule('fs');
    const https = process.getBuiltinModule('https');
    const crypto = process.getBuiltinModule('crypto');
    const path = process.getBuiltinModule('path');
    if (process.pid !== input.pid || process.ppid !== input.ppid || fs.realpathSync(process.execPath) !== input.executable
      || fs.realpathSync(electronApp.getPath('userData')) !== input.profile) throw new Error('Wrong owned sender');
    const filename = path.join(electronApp.getPath('userData'), 'annex-agent-outbox.json');
    const originalRequest = https.request;
    const originalRename = fs.promises.rename;
    let receipt: { status: number; receiptAt: string; resultHash: string } | undefined;
    let release: (() => void) | undefined;
    let paused = false;
    https.request = new Proxy(originalRequest, {
      apply(target, receiver, args: unknown[]) {
        const request: import('http').ClientRequest = Reflect.apply(target, receiver, args);
        const url = args[0];
        if ((typeof url === 'string' || url instanceof URL) && new URL(url).pathname === '/api/v1/network/agent-call') {
          request.prependOnceListener('response', (response: import('http').IncomingMessage) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 1024 * 1024) throw new Error('Unexpected agent-call response size');
              chunks.push(chunk);
            });
            response.prependOnceListener('end', () => {
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!parsed || typeof parsed !== 'object' || !('delivery' in parsed)) throw new Error('Missing real durable receipt');
              const delivery = parsed.delivery;
              if (!delivery || typeof delivery !== 'object' || !('callId' in delivery)) throw new Error('Invalid real durable receipt');
              if (delivery.callId !== input.callId) return;
              if (response.statusCode !== 200 || !('state' in delivery) || delivery.state !== 'delivered'
                || !('receiptAt' in delivery) || typeof delivery.receiptAt !== 'string' || !('result' in parsed)) throw new Error('Expected successful durable receipt');
              receipt = { status: response.statusCode, receiptAt: delivery.receiptAt, resultHash: crypto.createHash('sha256').update(JSON.stringify(parsed.result)).digest('hex') };
            });
          });
        }
        return request;
      },
    });
    fs.promises.rename = async (from, to) => {
      if (String(to) === filename && !paused) {
        const candidate: unknown = JSON.parse(fs.readFileSync(from, 'utf8'));
        const current: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const valid = (value: unknown): value is { outbox: Array<{ id: string }>; deliveries: Array<{ callId: string; state: string }> } =>
          !!value && typeof value === 'object' && 'outbox' in value && Array.isArray(value.outbox)
          && value.outbox.every((row: unknown) => !!row && typeof row === 'object' && 'id' in row && typeof row.id === 'string')
          && 'deliveries' in value && Array.isArray(value.deliveries)
          && value.deliveries.every((row: unknown) => !!row && typeof row === 'object' && 'callId' in row && typeof row.callId === 'string' && 'state' in row && typeof row.state === 'string');
        if (!valid(candidate) || !valid(current)) throw new Error('Unexpected owned delivery store shape');
        const terminal = candidate.deliveries.find((row) => row.callId === input.callId);
        if (terminal?.state === 'delivered' && !candidate.outbox.some((row) => row.id === input.callId)) {
          if (!receipt || !current.outbox.some((row) => row.id === input.callId)) throw new Error('Terminal rename was not preceded by a real durable200');
          paused = true;
          fs.writeFileSync(input.artifact, JSON.stringify({
            pid: process.pid, launcherPid: input.launcherPid, callId: input.callId, ...receipt, outboxIds: current.outbox.map((row) => row.id),
          }));
          await new Promise<void>((resolve) => { release = resolve; });
        }
      }
      return originalRename(from, to);
    };
    (globalThis as typeof globalThis & { __annexE2EDeliveryRestore?: () => void }).__annexE2EDeliveryRestore = () => {
      https.request = originalRequest;
      fs.promises.rename = originalRename;
      release?.();
    };
  }, { callId, artifact, ...sender });
  return sender;
}

export async function restoreDeliveryInstrumentation(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __annexE2EDeliveryRestore?: () => void };
    state.__annexE2EDeliveryRestore?.();
    delete state.__annexE2EDeliveryRestore;
  });
}
