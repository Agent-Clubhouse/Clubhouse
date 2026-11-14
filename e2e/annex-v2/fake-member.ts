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
import { sameCertFingerprint, tryPairOverTls } from './helpers';
import { parseNetworkMessage, type NetworkMember } from '../../src/shared/annex-network-protocol';

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
  const channels = new Set<WebSocket>();
  // Only pairing and introductions from an authenticated member populate this
  // view. An unknown desktop's hello never makes it a member here.
  const members = new Map<string, NetworkMember>();
  let pairing = { id: crypto.randomUUID() as string, joinedAt: new Date().toISOString() };
  const server = https.createServer({ cert: identity.certPem, key: identity.keyPem, requestCert: true, rejectUnauthorized: false });
  const wss = new WebSocketServer({ noServer: true });
  let port = 0;

  const self = (): NetworkMember => ({
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
    joinedAt: pairing.joinedAt,
    pairingId: pairing.id,
  });

  const proves = (member: NetworkMember): boolean => {
    try {
      const fp = crypto.createHash('sha256').update(Buffer.from(member.publicKey, 'base64')).digest('hex').slice(0, 32).match(/.{2}/g)!.join(':');
      return fp === member.fingerprint.toLowerCase() && !!member.certPem
        && sameCertFingerprint(new crypto.X509Certificate(member.certPem).fingerprint256, member.certFingerprint);
    } catch { return false; }
  };
  const sendView = (ws: WebSocket) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: 'members', members: [self(), ...members.values()], removals: [] }));
  };
  const speak = (ws: WebSocket, who: string) => {
    const authenticatedPin = members.get(who)?.certFingerprint;
    sockets.add(ws);
    channels.add(ws);
    ws.on('close', () => { sockets.delete(ws); channels.delete(ws); });
    ws.on('error', () => { /* closed by the other side */ });
    let greeted = false;
    ws.on('message', (data) => {
      const parsed = parseNetworkMessage(data.toString());
      if (!parsed.ok) { ws.close(4400, 'membership_only'); return; }
      const message = parsed.message;
      const known = members.get(who);
      if (!known || !sameCertFingerprint(authenticatedPin, known.certFingerprint)) { ws.close(4400, 'peer_not_paired'); return; }
      if (!greeted) {
        if (message.type !== 'hello' || message.member.fingerprint.toLowerCase() !== who
          || !sameCertFingerprint(message.member.certFingerprint, known.certFingerprint)
          || message.member.publicKey !== known.publicKey
          || message.member.pairingId !== known.pairingId || message.member.joinedAt !== known.joinedAt) {
          ws.close(4400, 'hello_mismatch'); return;
        }
        greeted = true;
        heardFrom.add(who);
        return;
      }
      const introduced = message.type === 'members' ? message.members : message.type === 'member-joined' ? [message.member] : [];
      let changed = false;
      for (const member of introduced) {
        const fp = member.fingerprint.toLowerCase();
        if (fp === identity.fingerprint.toLowerCase() || !proves(member)) continue;
        const held = members.get(fp);
        if (!held || (member.pairingId && member.pairingId !== held.pairingId && Date.parse(member.joinedAt) > Date.parse(held.joinedAt))) {
          members.set(fp, { ...member, fingerprint: fp });
          changed = true;
        }
      }
      if (changed) for (const channel of channels) sendView(channel);
    });
    ws.send(JSON.stringify({ v: 1, type: 'hello', member: self() }));
    sendView(ws);
  };

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'https://x').pathname;
    const who = certFingerprintOf(socket as tls.TLSSocket);
    const raw = (socket as tls.TLSSocket).getPeerCertificate()?.raw;
    const known = members.get(who);
    if (!known || !raw || !sameCertFingerprint(new crypto.X509Certificate(raw).fingerprint256, known.certFingerprint)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => { /* closed by the other side */ });
      if (path === '/ws') { if (who) controlledBy.add(who); return; }
      if (path === '/network') speak(ws, who);
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
      const answer = reply.body as {
        fingerprint: string; publicKey: string; tlsCertificateFingerprint: string; alias: string; icon: string; color: string;
        pairing: { id: string; joinedAt: string }; serverPairing: { id: string; joinedAt: string };
      };
      pairing = answer.pairing;
      // Its hello tells the desktop where it can be reached.
      const ws = new WebSocket(`wss://${host}:${desktopPort}/network`, { cert: identity.certPem, key: identity.keyPem, rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => {
        ws.once('upgrade', (res) => {
          const raw = (res.socket as tls.TLSSocket).getPeerCertificate()?.raw;
          const cert = raw && new crypto.X509Certificate(raw);
          const record: NetworkMember | undefined = cert ? {
            fingerprint: answer.fingerprint.toLowerCase(), publicKey: answer.publicKey,
            certFingerprint: cert.fingerprint256, certPem: cert.toString(),
            name: answer.alias, icon: answer.icon, color: answer.color, kind: 'desktop', hosts: [host], port: desktopPort,
            joinedAt: answer.serverPairing.joinedAt, pairingId: answer.serverPairing.id,
          } : undefined;
          if (!record || !proves(record) || !sameCertFingerprint(record.certFingerprint, answer.tlsCertificateFingerprint)) {
            ws.terminate(); reject(new Error('Pairing certificate did not match the membership channel')); return;
          }
          members.set(record.fingerprint, record);
        });
        ws.once('open', () => { speak(ws, answer.fingerprint.toLowerCase()); resolve(); });
        ws.once('error', reject);
      });
    },
    async close() {
      for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
