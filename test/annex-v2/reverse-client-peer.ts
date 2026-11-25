import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as https from 'https';
import type { TLSSocket } from 'tls';
import type { Duplex } from 'stream';
import { vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { closeServer, installDialPolicy, listen, type DialPolicy } from './reverse-parity-fixture';

const state = vi.hoisted(() => ({
  dir: '',
  events: [] as Array<{ channel: string; payload: unknown }>,
}));
vi.mock('electron', () => ({
  app: { getPath: () => state.dir, isPackaged: false, getVersion: () => '0.0.0-probe', getName: () => 'reverse-probe', on() {} },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));
vi.mock('../../src/main/services/log-service', () => ({ appLog() {} }));
vi.mock('../../src/main/util/ipc-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { state.events.push({ channel, payload }); },
}));
vi.mock('../../src/main/services/annex-network-profile', async (original) => ({
  ...await original<typeof import('../../src/main/services/annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));
vi.mock('../../src/main/services/annex-settings', () => ({
  getSettings: () => ({ enableClient: true, autoReconnect: false, networkEnabled: true, alias: 'Reverse probe', icon: 'computer', color: 'indigo' }),
  networkEnabled: () => true,
}));
vi.mock('../../src/main/services/annex-network-channel', () => ({
  connectTo() {}, closeFor() {}, closeAll() {},
}));

import * as client from '../../src/main/services/annex-client';
import * as control from '../../src/main/services/annex-control';
import * as identity from '../../src/main/services/annex-identity';
import * as annexTls from '../../src/main/services/annex-tls';
import * as peers from '../../src/main/services/annex-peers';
import * as agentCalls from '../../src/main/services/annex-agent-calls';
import { authorize, authorizeControlLink, isRefusal, stillAuthorized, type AnnexPrincipal } from '../../src/main/services/annex-authorizer';
import { setConnectionLink } from '../../src/main/services/connection-grants-store';
import { resetAllSettingsStoresForTests } from '../../src/main/services/settings-store';
import { HandoffCoordinator } from '../../src/main/services/handoff-coordinator';
import { HandoffService } from '../../src/main/services/handoff-service';
import { assertHandoffExtension, type HandoffStorage } from '../../src/main/services/handoff-store';
import { parseHandoff, type Handoff } from '../../src/shared/handoffs';
import { GROUP_PROJECT_WRITE_PATH } from '../../src/shared/group-project-network';
import { decodeControlBody, type ControlHttpRequest } from '../../src/shared/annex-control-protocol';
import { ANNEX_PROTOCOL_VERSION } from '../../src/shared/types';

export interface PeerInfo {
  alias: string;
  fingerprint: string;
  publicKey: string;
  certPem: string;
  pin: string;
  port: number;
}

/**
 * Handoffs are not probed here: this lightweight coordinator lacks production's reverse
 * admission (#3778). R20/R21 in reverse-parity.test.ts run the real handoff host both ways.
 */
export const CONSUMER_FAMILIES = ['history', 'chat send', 'subscription', 'file read', 'terminal', 'git op', 'agent call', 'group-project write'] as const;
export type ConsumerFamily = typeof CONSUMER_FAMILIES[number];

export interface ConfigurePeer {
  peer: PeerInfo;
  routePort: number;
  forwardPort: number | null;
}

/** Real client/control and pinned TLS, with small target handlers, not a full-parity backend. */
export async function createClientPeer(alias: string) {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-reverse-peer-'));
  state.events.length = 0;
  identity.resetForTests();
  annexTls.resetForTests();
  peers.resetForTests();
  resetAllSettingsStoresForTests();
  const self = identity.getOrCreateIdentity();
  const cert = annexTls.getOrCreateCert(self);
  let remote: PeerInfo | undefined;
  let policy: DialPolicy | undefined;
  let stopAgentCalls: (() => void) | undefined;
  const received: Array<{ path: string; caller: string; via: string; body: unknown }> = [];
  const frames: Array<Record<string, unknown>> = [];
  const records = new Map<string, Handoff>();
  const store: HandoffStorage = {
    get: (id) => records.has(id) ? structuredClone(records.get(id)!) : undefined,
    list: () => structuredClone([...records.values()]),
    transact: async (id, change) => {
      const prior = records.get(id);
      const next = parseHandoff(await change(prior && structuredClone(prior)));
      if (prior) assertHandoffExtension(prior, next);
      records.set(id, structuredClone(next));
      return next;
    },
  };
  const handoff = new HandoffCoordinator({
    machine: self.fingerprint, store,
    service: new HandoffService({ machine: self.fingerprint, store, authorize: async () => true, isDispatcher: () => false }),
    commands: { list: () => [], put: async () => {}, remove: async () => {} },
    connected: (machine) => client.isMachineConnected(machine),
    authorizeOutgoing: async () => true,
    post: async (machine, body) => (await client.postToMachine(machine, '/api/v1/network/handoffs', body)).body,
  });
  const deps = { findPeer: peers.getPeer, isSessionOnly: () => false, networkEnabled: () => true };
  const snapshot = () => ({
    protocolVersion: ANNEX_PROTOCOL_VERSION, lastSeq: 0,
    projects: [{ id: 'fixture-project', name: alias, path: state.dir }], agents: {}, quickAgents: {},
  });
  const statusFrame = () => ({
    type: 'agent:status', seq: 1,
    payload: { agentId: 'receiver', projectId: 'fixture-project', status: 'running' },
  });
  const json = (body: unknown, status = 200): control.DispatchResult => ({
    status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), complete: true,
  });
  async function dispatch(principal: AnnexPrincipal, request: Pick<ControlHttpRequest, 'method' | 'path'>, bytes?: Buffer): Promise<control.DispatchResult> {
    const body: unknown = bytes?.length ? JSON.parse(bytes.toString()) : undefined;
    received.push({ path: request.path, caller: principal.fingerprint, via: principal.via, body });
    if (request.path === '/api/v1/status') return json({ alias });
    if (request.path === '/api/v1/mobile/capabilities') return json({ epoch: 'fixture-epoch' });
    if (request.path.endsWith('/chat')) return json({ epoch: 'fixture-epoch', marker: `history:${alias}`, events: [] });
    if (request.path === '/api/v1/mobile/commands') return json({ status: 'applied', marker: `chat:${alias}` });
    if (request.path.includes('/files/read')) return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`file:${alias}`), complete: true };
    if (request.path.endsWith('/git/commit')) return json({ success: true, marker: `git:${alias}` });
    if (request.path === GROUP_PROJECT_WRITE_PATH) return json({ v: 1, results: [{ id: 'probe-write', status: 'applied', seq: 1 }] });
    if (request.path === '/api/v1/network/agent-call') {
      const outcome = await agentCalls.receiveAgentCall(principal.fingerprint, body);
      return 'status' in outcome ? json(outcome, outcome.status) : json(outcome);
    }
    if (request.path === '/api/v1/network/connections') return json({ v: 1, directions: [] });
    if (request.path === '/api/v1/network/handoffs') return json(await handoff.receive(principal.fingerprint, body));
    return json({ error: 'unknown_fixture_route', path: request.path }, 404);
  }
  const server = https.createServer(annexTls.createTlsServerOptions(self), (request, response) => {
    const socket = request.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();
    const result = authorize({
      fingerprint: typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : '',
      pin: certificate.fingerprint256, via: 'direct',
    }, deps);
    if (isRefusal(result)) { response.writeHead(result.status).end(JSON.stringify(result)); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void dispatch(result.principal, { method: request.method as ControlHttpRequest['method'], path: request.url! }, Buffer.concat(chunks)).then((answer) => {
        response.writeHead(answer.status, answer.headers).end(answer.body);
      }, (error: unknown) => response.writeHead(500).end(JSON.stringify({ error: String(error) })));
    });
  });
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  control.setInboundAuthority({
    accept: (socket: TLSSocket) => {
      const certificate = socket.getPeerCertificate();
      const result = authorizeControlLink({
        fingerprint: typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : '',
        pin: certificate.fingerprint256, via: 'direct',
      }, deps);
      if (isRefusal(result)) return result;
      return { ok: true, fingerprint: result.fingerprint, pin: certificate.fingerprint256 };
    },
    stillAllowed: (fingerprint, pin) => authorizeControlLink({ fingerprint, pin, via: 'direct' }, deps).ok,
  });
  control.setControlTarget({
    authorize: (caller) => authorize(caller, deps),
    stillAuthorized: (principal) => stillAuthorized(principal, deps),
    dispatch: (principal, request) => dispatch(principal, request, request.body === undefined ? undefined : decodeControlBody(request.body, request.encoding)),
    subscribe: (_principal, sink) => {
      setImmediate(() => {
        sink.send(JSON.stringify({ type: 'snapshot', payload: snapshot() }));
        sink.send(JSON.stringify(statusFrame()));
      });
      return { receive: (frame) => { frames.push(JSON.parse(frame)); }, close() {} };
    },
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/control') { control.handleControlUpgrade(request, socket, head); return; }
    if (new URL(request.url!, 'https://fixture').pathname !== '/ws') { socket.destroy(); return; }
    const certificate = (request.socket as TLSSocket).getPeerCertificate();
    const decision = authorize({ fingerprint: typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : '', pin: certificate.fingerprint256, via: 'direct' }, deps);
    if (!decision.ok) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'snapshot', payload: snapshot() }));
      ws.send(JSON.stringify(statusFrame()));
      ws.on('message', (data) => { frames.push(JSON.parse(data.toString())); });
    });
  });
  const port = await listen(server);
  const info: PeerInfo = { alias, fingerprint: self.fingerprint, publicKey: self.publicKey, certPem: cert.certPem, pin: annexTls.certificateFingerprint(cert.certPem), port };
  return {
    info,
    async configure(config: ConfigurePeer) {
      remote = config.peer;
      peers.addPeer({
        fingerprint: remote.fingerprint, publicKey: remote.publicKey, alias: remote.alias, icon: 'computer', color: 'indigo',
        pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
        role: 'member', kind: 'desktop', tlsCertificateFingerprint: remote.pin, tlsCertificatePem: remote.certPem,
        knownHosts: ['127.0.0.1'], hostPorts: { '127.0.0.1': config.routePort }, mainPort: config.routePort,
      });
      await setConnectionLink({ agentId: 'sender', machineId: remote.fingerprint }, { agentId: 'receiver' }, true);
      stopAgentCalls = agentCalls.startAgentCalls({
        transport: {
          connected: client.canReachMachine, post: client.postToMachine,
          machineName: client.machineAlias, onConnected: client.onMachineReachable,
          supportsDurableDelivery: async () => false,
        },
        runTool: async () => ({ content: [{ type: 'text', text: `agent:${alias}` }] }),
        describeLocalAgent: async () => ({ name: 'Fixture agent' }), listDirections: () => [],
      });
      policy = installDialPolicy((host, candidate) => config.forwardPort !== null && host === '127.0.0.1' && candidate === config.forwardPort);
      client.startClient();
    },
    status() {
      return {
        readiness: remote && control.getLinkReadiness(remote.fingerprint),
        connected: remote && client.canReachMachine(remote.fingerprint),
        snapshot: remote && client.getSatellite(remote.fingerprint)?.snapshot,
        attempts: policy?.attempts ?? [], received, frames, events: state.events,
      };
    },
    async lowLevel() {
      const answer = await control.request(remote!.fingerprint, { method: 'GET', path: '/api/v1/status' });
      const frame = await vi.waitFor(() => {
        const event = state.events.find(({ channel, payload }) => channel === 'annex-client:satellite-event'
          && typeof payload === 'object' && payload !== null && 'satelliteId' in payload && payload.satelliteId === remote!.fingerprint
          && 'type' in payload && payload.type === 'snapshot');
        if (!event) throw new Error('The consumer-owned subscription did not deliver a snapshot to IPC');
        return event.payload;
      }, { timeout: 5_000 });
      return { status: answer.status, body: JSON.parse(answer.body.toString()), frame };
    },
    async calibrate(endpoints: Array<{ host: string; port: number }>) {
      return Promise.all(endpoints.map(({ host, port: target }) => new Promise<string>((resolve, reject) => {
        const socket = net.connect(target, host);
        socket.once('connect', () => { socket.destroy(); reject(new Error('Forbidden calibration dial connected')); });
        socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      })));
    },
    async probe(family: ConsumerFamily): Promise<unknown> {
      const fingerprint = remote!.fingerprint;
      switch (family) {
        case 'history': return client.requestChatPage(fingerprint, 'receiver');
        case 'chat send': return client.sendChatCommand(fingerprint, { type: 'chat.send', agentId: 'receiver', text: 'fixture prompt, no CLI or model' });
        case 'subscription': return { snapshot: client.getSatellite(fingerprint)?.snapshot, events: state.events };
        case 'file read': return client.requestFileRead(fingerprint, 'fixture-project', 'fixture.txt');
        case 'terminal': return client.sendToSatellite(fingerprint, { type: 'pty:input', payload: { sessionId: 'fixture-shell', data: 'fixture-input' } });
        case 'git op': return client.requestGitOperation(fingerprint, 'fixture-project', { operation: 'commit', message: 'Fixture commit' });
        case 'agent call': return agentCalls.forwardAgentCall('sender', `receiver@${fingerprint}`, 'Receiver', 'get_status', {});
        case 'group-project write': return client.postToMachine(fingerprint, GROUP_PROJECT_WRITE_PATH, {
          v: 1, writes: [{ id: 'probe-write', groupProjectId: 'fixture-board', author: { label: 'Fixture person' }, queuedAt: new Date().toISOString(), write: { op: 'update', fields: { description: 'fixture-write' } } }],
        });
      }
    },
    hasHandoff(id: string) { return records.has(id); },
    async close() {
      client.stopClient();
      stopAgentCalls?.();
      control.resetControlForTests();
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close();
      await closeServer(server);
      policy?.restore();
      resetAllSettingsStoresForTests();
      fs.rmSync(state.dir, { recursive: true, force: true });
    },
  };
}

export type ClientPeer = Awaited<ReturnType<typeof createClientPeer>>;
