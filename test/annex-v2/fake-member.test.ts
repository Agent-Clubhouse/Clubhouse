import { describe, expect, it } from 'vitest';
import * as https from 'https';
import { X509Certificate } from 'crypto';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { startFakeMember } from '../../e2e/annex-v2/fake-member';
import { generateTestIdentity, withNewCertificate, type TestIdentity } from '../../e2e/annex-v2/tls-test-utils';
import { upgradeOutcome } from '../../e2e/annex-v2/helpers';
import type { NetworkMember } from '../../src/shared/annex-network-protocol';

const JOINED = '2026-11-01T00:00:00.000Z';
function record(identity: TestIdentity, name: string): NetworkMember {
  return {
    fingerprint: identity.fingerprint, publicKey: identity.ed25519PublicKeyBase64,
    certFingerprint: new X509Certificate(identity.certPem).fingerprint256, certPem: identity.certPem,
    name, icon: 'computer', color: 'teal', kind: 'desktop', hosts: ['127.0.0.1'], port: 9443,
    pairingId: `pairing-${name}-0001`, joinedAt: JOINED,
  };
}

describe('the network E2E fake uses authenticated membership', () => {
  it('refuses unknown pins, learns introductions from its paired member, and never echoes a self-claimed epoch', async () => {
    const introducer = generateTestIdentity();
    const other = generateTestIdentity();
    const a = record(introducer, 'introducer');
    const b = record(other, 'other');
    const fake = await startFakeMember();
    const clients = new Set<WebSocket>();
    const wss = new WebSocketServer({ noServer: true });
    const server = https.createServer({ cert: introducer.certPem, key: introducer.keyPem, requestCert: true, rejectUnauthorized: false }, (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        network: 1, fingerprint: a.fingerprint, publicKey: a.publicKey,
        tlsCertificateFingerprint: a.certFingerprint, alias: a.name, icon: a.icon, color: a.color,
        pairing: { id: 'pairing-fake-0001', joinedAt: JOINED }, serverPairing: { id: a.pairingId, joinedAt: a.joinedAt },
      }));
    });
    let accept!: (ws: WebSocket) => void;
    const paired = new Promise<WebSocket>((resolve) => { accept = resolve; });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      ws.send(JSON.stringify({ v: 1, type: 'hello', member: a }));
      ws.send(JSON.stringify({ v: 1, type: 'members', members: [a], removals: [] }));
      accept(ws);
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dial = (identity: TestIdentity, path: string) => {
      const ws = new WebSocket(`wss://127.0.0.1:${fake.port}${path}`, { cert: identity.certPem, key: identity.keyPem, rejectUnauthorized: false });
      clients.add(ws);
      ws.on('error', () => {});
      return ws;
    };
    try {
      await fake.joinVia('127.0.0.1', (server.address() as AddressInfo).port, '123456');
      const channel = await paired;
      for (const path of ['/network', '/ws']) {
        expect(await upgradeOutcome(dial(other, path))).toMatchObject({ status: 401 });
      }
      expect(await upgradeOutcome(dial(withNewCertificate(introducer), '/network'))).toMatchObject({ status: 401 });
      // Only the already-paired introducer can add B to the fake's authoritative view.
      const learned = new Promise<void>((resolve) => channel.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; members?: NetworkMember[] };
        if (msg.type === 'members' && msg.members?.some((m) => m.fingerprint === b.fingerprint)) resolve();
      }));
      channel.send(JSON.stringify({ v: 1, type: 'members', members: [a, b], removals: [] }));
      await learned;

      const ws = dial(other, '/network');
      const views: Array<{ type: string; members?: NetworkMember[] }> = [];
      ws.on('message', (data) => views.push(JSON.parse(data.toString())));
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      await new Promise<void>((resolve) => ws.once('open', resolve));
      ws.send(JSON.stringify({ v: 1, type: 'hello', member: { ...b, pairingId: 'pairing-forged-0001' } }));
      expect(await closed).toBe(4400);
      expect(fake.heardFrom.has(b.fingerprint)).toBe(false);
      expect(views.flatMap((v) => v.members ?? []).filter((m) => m.fingerprint === b.fingerprint)).toEqual([b]);

      const valid = dial(other, '/network');
      const confirmed = new Promise<void>((resolve) => valid.once('message', () => resolve()));
      await new Promise<void>((resolve) => valid.once('open', resolve));
      valid.send(JSON.stringify({ v: 1, type: 'hello', member: b }));
      await confirmed;
      await expect.poll(() => fake.heardFrom.has(b.fingerprint)).toBe(true);
    } finally {
      for (const ws of clients) ws.terminate();
      await fake.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
