import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import * as https from 'https';
import type { TLSSocket } from 'tls';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.dir, isPackaged: false, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('bonjour-service', () => ({
  default: class {
    find() { return { stop() {} }; }
    destroy() {}
  },
}));
vi.mock('../../src/main/services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../src/main/util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../src/main/services/annex-network-channel', () => ({
  connectTo: vi.fn(), closeFor: vi.fn(), closeAll: vi.fn(),
}));
vi.mock('../../src/main/services/annex-settings', () => ({
  getSettings: () => ({ enableClient: true, autoReconnect: true, networkEnabled: false, alias: 'Controller', icon: 'computer', color: 'indigo' }),
  networkEnabled: () => false,
}));

import * as client from '../../src/main/services/annex-client';
import * as identity from '../../src/main/services/annex-identity';
import * as tls from '../../src/main/services/annex-tls';
import * as peers from '../../src/main/services/annex-peers';
import { buildPairingUrl } from '../../src/main/services/annex-pairing-url';
import { ANNEX_PROTOCOL_VERSION } from '../../src/shared/types';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  client.stopClient();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  identity.resetForTests();
  tls.resetForTests();
  peers.resetForTests();
});

async function listen(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listening address');
  return address.port;
}

/** No TLS handling: both directions carry exactly the bytes received. */
async function forwardTo(port: number | (() => number)) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((incoming) => {
    const outgoing = net.connect(typeof port === 'function' ? port() : port, '127.0.0.1');
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on('close', () => { sockets.delete(socket); });
    }
    incoming.on('error', () => outgoing.destroy());
    outgoing.on('error', () => incoming.destroy());
    incoming.on('close', () => outgoing.destroy());
    outgoing.on('close', () => incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);
  });
  const localPort = await listen(server);
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  };
  cleanups.push(close);
  return { port: localPort, close, restore: () => listen(server, localPort) };
}

it.each(['link', 'manual'])('pairs, reloads without discovery, and reconnects after a remapped loopback forward returns (%s pairing)', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'annex-forward-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  state.dir = join(root, 'satellite');
  mkdirSync(state.dir);
  const satellite = identity.getOrCreateIdentity();
  const credentials = tls.createTlsServerOptions(satellite);
  const cert = tls.getOrCreateCert(satellite);
  const expectedCertificate = tls.certificateFingerprint(cert.certPem);
  identity.resetForTests();
  tls.resetForTests();
  state.dir = join(root, 'controller');
  mkdirSync(state.dir);

  let pairedClientCertificate = '';
  let pairRequests = 0;
  let connections = 0;
  const clientCertificates: string[] = [];
  // A minimal satellite fixture using real TLS, certificate binding and WebSockets.
  const server = https.createServer(credentials, (req, res) => {
    if (req.url !== '/pair') { res.writeHead(404).end(); return; }
    pairRequests++;
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const body = JSON.parse(text);
      const certificate = (req.socket as TLSSocket).getPeerCertificate();
      if (body.pin !== '123456' || !tls.verifyCertBinding(body.publicKey, certificate.raw, body.certBinding)) {
        res.writeHead(401).end();
        return;
      }
      pairedClientCertificate = certificate.fingerprint256;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        fingerprint: satellite.fingerprint, publicKey: satellite.publicKey, alias: 'Forwarded satellite',
        tlsCertificateFingerprint: expectedCertificate,
      }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const certificate = (req.socket as TLSSocket).getPeerCertificate();
    if (!pairedClientCertificate || certificate.fingerprint256 !== pairedClientCertificate) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    clientCertificates.push(certificate.fingerprint256);
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      ws.send(JSON.stringify({
        type: 'snapshot',
        payload: { protocolVersion: ANNEX_PROTOCOL_VERSION, lastSeq: connections, projects: [], agents: {}, quickAgents: {} },
      }));
    });
  });
  const port = await listen(server);
  cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const forward = await forwardTo(port);
  expect(forward.port).not.toBe(port);
  // This fixture's link address stands in for a remote address unavailable here.
  const link = buildPairingUrl({
    hosts: ['::1'], port, fingerprint: satellite.fingerprint, certFingerprint: expectedCertificate,
    pin: '123456', name: 'Forwarded satellite',
  })!;
  const connected = (count: number) => vi.waitFor(() => {
    expect(connections).toBe(count);
    expect(client.getSatellite(satellite.fingerprint)).toMatchObject({
      state: 'connected', host: '127.0.0.1', mainPort: forward.port, snapshot: { lastSeq: count },
    });
  }, { timeout: 10_000, interval: 20 });

  client.startClient();
  const result = mode === 'link'
    ? await client.pairWithLink(link, `127.0.0.1:${forward.port}`)
    : await client.pairWithEndpoint(`127.0.0.1:${forward.port}`, '123456', expectedCertificate);
  expect(result).toMatchObject({ success: true });
  await connected(1);
  expect(peers.getPeer(satellite.fingerprint)).toMatchObject({
    knownHosts: mode === 'link' ? ['127.0.0.1', '::1'] : ['127.0.0.1'],
    mainPort: mode === 'link' ? port : forward.port,
    hostPorts: mode === 'link' ? { '127.0.0.1': forward.port, '::1': port } : { '127.0.0.1': forward.port },
  });

  client.stopClient();
  peers.resetForTests();
  identity.resetForTests();
  tls.resetForTests();
  expect(client.getSatellites()).toEqual([]);
  client.startClient();
  await connected(2);
  expect(client.getDiscoveredServices()).toEqual([]);
  expect(pairRequests).toBe(1);
  expect(new Set(clientCertificates).size).toBe(1);

  await forward.close();
  await vi.waitFor(() => expect(client.getSatellite(satellite.fingerprint)?.lastError).toMatch(/local forward is running/), {
    timeout: 5_000, interval: 20,
  });
  await forward.restore();
  await connected(3);
  expect(pairRequests).toBe(1);
}, 20_000);

it.each(['link', 'manual'])('rejects a TLS-terminating endpoint before sending any PIN or HTTP request (%s pairing)', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'annex-forward-mismatch-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  state.dir = join(root, 'satellite');
  mkdirSync(state.dir);
  const satellite = identity.getOrCreateIdentity();
  const expectedCertificate = tls.certificateFingerprint(tls.getOrCreateCert(satellite).certPem);
  identity.resetForTests();
  tls.resetForTests();
  state.dir = join(root, 'proxy');
  mkdirSync(state.dir);
  const proxyIdentity = identity.getOrCreateIdentity();
  let requests = 0;
  const server = https.createServer(tls.createTlsServerOptions(proxyIdentity), (_req, res) => {
    requests++;
    res.end();
  });
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  identity.resetForTests();
  tls.resetForTests();
  state.dir = join(root, 'controller');
  mkdirSync(state.dir);
  const link = buildPairingUrl({
    hosts: ['127.0.0.2'], port, fingerprint: satellite.fingerprint, certFingerprint: expectedCertificate,
    pin: '123456', name: 'Satellite',
  })!;
  const result = mode === 'link'
    ? await client.pairWithLink(link, `127.0.0.1:${port}`)
    : await client.pairWithEndpoint(`127.0.0.1:${port}`, '123456', expectedCertificate);
  expect(result).toMatchObject({
    success: false, error: expect.stringMatching(/not the one in the link|code was not sent/),
  });
  expect(requests).toBe(0);
  expect(peers.listPeers()).toEqual([]);
}, 10_000);

it.each([
  ['link', 'certificate change'],
  ['manual', 'certificate change'],
  ['link', 'redirect'],
  ['manual', 'redirect'],
])('does not send a PIN to a replacement endpoint after a %s pairing %s, including retries', async (mode, scenario) => {
  const root = mkdtempSync(join(tmpdir(), 'annex-forward-replacement-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  state.dir = join(root, 'satellite');
  mkdirSync(state.dir);
  const satellite = identity.getOrCreateIdentity();
  const credentials = tls.createTlsServerOptions(satellite);
  const expectedCertificate = tls.certificateFingerprint(tls.getOrCreateCert(satellite).certPem);
  identity.resetForTests();
  tls.resetForTests();
  state.dir = join(root, 'replacement');
  mkdirSync(state.dir);

  let replacementRequests = 0;
  let replacementBytes = 0;
  const replacement = https.createServer(tls.createTlsServerOptions(identity.getOrCreateIdentity()), (_req, res) => {
    replacementRequests++;
    res.end();
  });
  replacement.on('secureConnection', (socket) => {
    socket.on('data', (chunk: Buffer) => { replacementBytes += chunk.length; });
  });
  const replacementPort = await listen(replacement);
  let trustedRequests = 0;
  const server = https.createServer(credentials, (_req, res) => {
    trustedRequests++;
    res.writeHead(307, { Location: `https://127.0.0.1:${replacementPort}/pair` }).end();
  });
  for (const endpoint of [replacement, server]) {
    const sockets = new Set<net.Socket>();
    endpoint.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    });
  }
  const port = await listen(server);
  let connections = 0;
  const forward = await forwardTo(() => {
    connections++;
    // Each attempt probes the expected server, then reconnects for the POST.
    return scenario === 'certificate change' && connections % 2 === 0 ? replacementPort : port;
  });
  identity.resetForTests();
  tls.resetForTests();
  state.dir = join(root, 'controller');
  mkdirSync(state.dir);
  const link = buildPairingUrl({
    hosts: ['127.0.0.1'], port: forward.port, fingerprint: satellite.fingerprint,
    certFingerprint: expectedCertificate, pin: '123456', name: 'Satellite',
  })!;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = mode === 'link'
      ? await client.pairWithLink(link)
      : await client.pairWithEndpoint(`127.0.0.1:${forward.port}`, '123456', expectedCertificate);
    expect(result.success).toBe(false);
    expect(replacementRequests).toBe(0);
    expect(replacementBytes).toBe(0);
    expect(peers.listPeers()).toEqual([]);
  }
  expect(connections).toBe(4);
  expect(trustedRequests).toBe(scenario === 'redirect' ? 2 : 0);
}, 10_000);
