/**
 * A fake Annex Network member for E2E (#3061): a test identity with its own
 * small TLS server, so real desktops can pair with it, learn of it from each
 * other, and connect to it. It speaks only the membership channel; `/ws` is
 * accepted and left quiet.
 */
import * as https from 'https';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type * as tls from 'tls';
import WebSocket, { WebSocketServer } from 'ws';
import { generateTestIdentity, type TestIdentity } from './tls-test-utils';
import { tryPairOverTls } from './helpers';

export interface FakeMember {
  identity: TestIdentity;
  port: number;
  /** Fingerprints (from their certificates) of desktops that opened `/ws` to it. */
  controlledBy: Set<string>;
  /** Fingerprints that said hello on its `/network`. */
  heardFrom: Set<string>;
  /** Pairs with a desktop as a network member, then opens the membership channel to it. */
  joinVia(host: string, port: number, pin: string): Promise<void>;
  close(): Promise<void>;
}

function certFingerprintOf(socket: tls.TLSSocket): string {
  const cert = socket.getPeerCertificate();
  return (cert?.subject?.CN as string | undefined)?.toLowerCase() ?? '';
}

export async function startFakeMember(name = 'Fake member'): Promise<FakeMember> {
  const identity = generateTestIdentity();
  const controlledBy = new Set<string>();
  const heardFrom = new Set<string>();
  const sockets = new Set<WebSocket>();
  const server = https.createServer({ cert: identity.certPem, key: identity.keyPem, requestCert: true, rejectUnauthorized: false });
  const wss = new WebSocketServer({ noServer: true });
  let port = 0;

  const self = () => ({
    fingerprint: identity.fingerprint,
    publicKey: identity.ed25519PublicKeyBase64,
    certFingerprint: new crypto.X509Certificate(identity.certPem).fingerprint256,
    certPem: identity.certPem,
    name,
    icon: 'computer',
    color: 'teal',
    kind: 'desktop',
    hosts: ['127.0.0.1'],
    port,
    joinedAt: new Date().toISOString(),
  });

  const speak = (ws: WebSocket) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => { /* closed by the other side */ });
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string; member?: { fingerprint?: string } };
        if (message.type === 'hello' && message.member?.fingerprint) heardFrom.add(message.member.fingerprint.toLowerCase());
      } catch { /* not ours to judge */ }
    });
    ws.send(JSON.stringify({ v: 1, type: 'hello', member: self() }));
    ws.send(JSON.stringify({ v: 1, type: 'members', members: [self()], removals: [] }));
  };

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'https://x').pathname;
    const who = certFingerprintOf(socket as tls.TLSSocket);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => { /* closed by the other side */ });
      if (path === '/ws') { if (who) controlledBy.add(who); return; }
      if (path === '/network') speak(ws);
      else ws.close();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;

  return {
    identity,
    port,
    controlledBy,
    heardFrom,
    async joinVia(host, desktopPort, pin) {
      const reply = await tryPairOverTls(host, desktopPort, pin, identity, { network: 1, alias: name, icon: 'computer', color: 'teal' });
      if (reply.status !== 200 || (reply.body as { network?: number }).network !== 1) {
        throw new Error(`Fake member did not join (${reply.status}): ${JSON.stringify(reply.body)}`);
      }
      // Its hello tells the desktop where it can be reached.
      const ws = new WebSocket(`wss://${host}:${desktopPort}/network`, { cert: identity.certPem, key: identity.keyPem, rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      speak(ws);
    },
    async close() {
      for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
