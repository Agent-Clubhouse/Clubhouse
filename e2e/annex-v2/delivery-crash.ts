import type { LaunchedApp } from '../launch';
import * as fs from 'fs';
import * as path from 'path';
import { ELECTRON_DIST_DIR } from '../e2e-cleanup';
import { assertOwnedMainProcess } from '../owned-process-receipts';
import { expect } from '@playwright/test';
import * as https from 'https';
import { X509Certificate } from 'crypto';
import type { FakeClis } from '../chat-fake-cli';
import type { FakeCliReport } from '../../src/main/orchestrators/adapters/testing/fake-cli';

/** Probe the real capability route as the paired desktop, without sending agent input. */
export async function readDeliveryCapabilities(sender: LaunchedApp, receiver: LaunchedApp) {
  const { port } = await receiver.window.evaluate(() => window.clubhouse.annex.getStatus());
  const local = JSON.parse(await fs.promises.readFile(path.join(sender.userDataDir, 'annex-tls-cert.json'), 'utf8'));
  const peer = JSON.parse(await fs.promises.readFile(path.join(receiver.userDataDir, 'annex-tls-cert.json'), 'utf8'));
  const pin = new X509Certificate(peer.certPem).fingerprint256;
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = https.request(`https://127.0.0.1:${port}/api/v1/network/agent-delivery-capabilities`, {
      method: 'POST', cert: local.certPem, key: local.keyPem, ca: [peer.certPem], rejectUnauthorized: true, agent: false,
      checkServerIdentity: (_host, certificate) => certificate.raw && new X509Certificate(certificate.raw).fingerprint256 === pin
        ? undefined : new Error('Delivery readiness peer certificate changed'),
    }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      response.on('error', (error) => { clearTimeout(timer); reject(error); });
      response.on('end', () => {
        clearTimeout(timer);
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    // Bound the whole probe, including a peer that accepts TLS but never answers.
    const timer = setTimeout(() => request.destroy(new Error('Delivery readiness probe timed out')), 5_000);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
    request.end('{}');
  });
}

export async function waitForDurableDeliveryPath(sender: LaunchedApp, receiver: LaunchedApp, receiverFingerprint: string, timeout = 60_000): Promise<void> {
  await expect.poll(async () => {
    const satellites: Array<{ fingerprint: string; state: string }> = await sender.window.evaluate(() => window.clubhouse.annexClient.getSatellites());
    const state = satellites.find((satellite) => satellite.fingerprint.toLowerCase() === receiverFingerprint)?.state;
    if (state !== 'connected') return { connection: state ?? 'missing' };
    try { return await readDeliveryCapabilities(sender, receiver); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, { timeout, message: 'Paired desktop must be connected and advertise a readable durable delivery store before agent input' }).toEqual({
    status: 200, body: { deliveryVersion: 1, receiptBoundary: 'runtime-accepted' },
  });
}

/** A report on disk can belong to the process killed with the previous desktop. */
export async function waitForFakeCliRegistration(app: LaunchedApp, fakes: FakeClis, agentId: string, previousPid?: number, timeout = 60_000): Promise<FakeCliReport> {
  let registered: FakeCliReport | undefined;
  await expect.poll(async () => {
    const running = await app.window.evaluate((id) => window.clubhouse.agent.getRunningStatuses([id]), agentId);
    if (!running.includes(agentId)) return 'app has not registered a live agent runtime';
    try {
      const report = await fakes.report('claude', agentId);
      if (report.env.CLUBHOUSE_AGENT_ID !== agentId) return 'fake CLI report belongs to a different agent';
      if (!report.pid || report.pid === previousPid) return 'fake CLI report still belongs to the pre-crash process';
      registered = report;
      return 'registered';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'fake CLI has not published its per-agent report';
      throw error;
    }
  }, { timeout, message: `Agent ${agentId} must register a live runtime and a fresh fake Claude CLI process${previousPid ? ` after PID ${previousPid}` : ''}` }).toBe('registered');
  return registered!;
}

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
