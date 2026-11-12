import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as https from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '', pairing: 'self-epoch', peerPairing: 'peer-epoch' }));
const SELF = Array(16).fill('aa').join(':');
const OTHER = Array(16).fill('bb').join(':');
const THIRD = Array(16).fill('cc').join(':');
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: SELF.toUpperCase() }) }));
vi.mock('./annex-network-membership', () => ({ ownPairing: () => ({ id: state.pairing }) }));
vi.mock('./annex-peers', () => ({ listPeers: () => [
  { fingerprint: OTHER.toUpperCase(), alias: 'Studio', role: 'member', kind: 'desktop', pairingId: state.peerPairing },
  // A one-to-one pairing: not in the network.
  { fingerprint: THIRD.toUpperCase(), alias: 'Old Mac', role: 'satellite' },
], getPeer: () => undefined }));
vi.mock('https', async (original) => ({ ...await original<typeof import('https')>(), request: vi.fn() }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-agent-calls-'));

import {
  AGENT_CALL_VERSION, LOOP_LIMIT, RATE_LIMIT, currentRemoteCaller, forwardAgentCall, receiveAgentCall, receiveDirections,
  remoteAgentName, startAgentCalls, _clearOutboxForTesting, syncDirectionsWith, waitingFor, flushOutbox, isNetworkComputer, getDelivery, type AgentCallTransport, type RemoteCaller,
  agentDeliveryCapabilities, prepareAnnexProtocolCall, forwardPreparedAnnexProtocolCall, type PreparedAnnexProtocolCall,
} from './annex-agent-calls';
import { createAnnexDeliveryStore, deliveryHash, DELIVERY_MAX_AGE_MS } from './annex-delivery-store';
import {
  annexProtocolWireHash, registerAnnexDeliveryProtocol, snapshotAnnexProtocolEnvelope, type AnnexProtocolCall,
  type AnnexDeliveryProtocol, type AnnexProtocolIncoming, type AnnexProtocolOutgoing,
} from './annex-delivery-protocols';
import {
  getConnectionDirection, listAllConnectionDirections, removeConnectionDirections, setConnectionLink, setConnectionTools,
} from './connection-grants-store';
import type { McpToolResult } from './clubhouse-mcp/types';

const ok = (text: string): McpToolResult => ({ content: [{ type: 'text', text }] });
const textOf = (r: McpToolResult) => (r.content[0] as { text: string }).text;

let connected = true;
let posts: Array<{ machine: string; path: string; body: Record<string, unknown> }> = [];
const delivered = (body: Record<string, unknown>, message = 'done there') => ({
  status: 200, body: { result: ok(message), delivery: { callId: body.callId, state: 'delivered', receiptAt: new Date().toISOString() } },
});
let respond: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } = (_path, body) => delivered(body);
let connectedListener: ((machine: string) => void) | null = null;
const seen: Array<{ tool: string; targetId: string; callerId: string; args: Record<string, unknown>; caller?: RemoteCaller }> = [];

const transport: AgentCallTransport = {
  connected: () => connected,
  supportsDurableDelivery: async () => true,
  post: async (machine, urlPath, body) => { posts.push({ machine, path: urlPath, body }); return respond(urlPath, body); },
  machineName: () => 'Studio',
  onConnected: (listener) => { connectedListener = listener; return () => { connectedListener = null; }; },
};

let stop: () => void = () => {};
let now = 1_000_000;

function call(overrides: Record<string, unknown> = {}) {
  return {
    v: AGENT_CALL_VERSION, callId: `c-${Math.random()}`, from: { agentId: 'sender', name: 'Scout', projectName: 'Atlas' },
    to: 'receiver', tool: 'send_message', args: { message: 'hi' }, ...overrides,
  };
}

const inbound = { from: { agentId: 'sender', machineId: OTHER }, to: { agentId: 'receiver' } };

beforeEach(async () => {
  for (const id of ['sender', 'receiver', 'here', 'there']) await removeConnectionDirections(id);
  await _clearOutboxForTesting();
  connected = true;
  state.pairing = 'self-epoch';
  state.peerPairing = 'peer-epoch';
  posts = [];
  seen.length = 0;
  respond = (_path, body) => delivered(body);
  now += 3_600_000;
  stop = startAgentCalls({
    transport,
    authorizeQueuedCall: async () => ({ allowed: true }),
    runTool: async (tool, targetId, callerId, args) => { seen.push({ tool, targetId, callerId, args, caller: currentRemoteCaller() }); return ok('ran here'); },
    describeLocalAgent: async (id) => (id === 'receiver' ? { name: 'Builder' } : id === 'here' ? { name: 'Helper', projectName: 'Atlas' } : undefined),
  });
});
afterEach(() => { stop(); vi.restoreAllMocks(); });

function nextRetry(ms = 3_600_000): void {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);
}

describe('receiving a call from another machine (#3064)', () => {
  it('runs nothing without the person\'s link for that direction, and says the same whether or not the agent exists', async () => {
    const refused = await receiveAgentCall(OTHER, call(), now);
    expect(refused).toMatchObject({ status: 403, error: 'not_connected' });
    // Tools alone (no link) aren't a connection.
    await setConnectionTools(inbound.from, inbound.to, []);
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ status: 403, error: 'not_connected' });
    expect(await receiveAgentCall(OTHER, call({ to: 'nobody' }), now)).toMatchObject({ status: 403, error: 'not_connected' });
    expect(seen).toHaveLength(0);
  });

  it('runs a call the link allows, as the sender on its machine, and refuses a tool turned off on it', async () => {
    await setConnectionLink(inbound.from, inbound.to, true, ['clear_agent']);
    const result = await receiveAgentCall(OTHER, call(), now);
    expect(result).toMatchObject({ result: ok('ran here'), delivery: { state: 'delivered' } });
    expect(seen[0]).toMatchObject({ tool: 'send_message', targetId: 'receiver', callerId: `sender@${OTHER}`, args: { message: 'hi' } });
    expect(seen[0].caller).toMatchObject({ name: 'Scout', projectName: 'Atlas', machineName: 'Studio', targetName: 'Builder', machineId: OTHER, agentId: 'sender' });
    expect(await receiveAgentCall(OTHER, call({ tool: 'clear_agent' }), now)).toMatchObject({ status: 403, error: 'tool_denied' });
  });

  it('wakes an agent here when the link allows it, and not when wake is switched off on it (#3056: message, wake and read)', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: { message: 'start on it' } }), now)).toMatchObject({ result: ok('ran here') });
    expect(seen.at(-1)).toMatchObject({ tool: 'wake_agent', targetId: 'receiver', callerId: `sender@${OTHER}` });
    expect(seen.at(-1)!.caller).toMatchObject({ name: 'Scout', machineName: 'Studio' });
    await setConnectionTools(inbound.from, inbound.to, ['wake_agent']);
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: {} }), now)).toMatchObject({ status: 403, error: 'tool_denied' });
  });

  it('counts wakes with messages for the loop limit', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    let t = now;
    for (let i = 0; i < LOOP_LIMIT.messages; i++) {
      expect(await receiveAgentCall(OTHER, call({ tool: i % 2 ? 'wake_agent' : 'send_message', args: i % 2 ? {} : { message: 'x' } }), t)).toHaveProperty('result');
      t += Math.floor(RATE_LIMIT.windowMs / RATE_LIMIT.calls) + 1;
    }
    expect(await receiveAgentCall(OTHER, call({ tool: 'wake_agent', args: {} }), t)).toMatchObject({ status: 429, error: 'loop_limited' });
  });

  it('takes the sender\'s machine from the connection, not from the call', async () => {
    await setConnectionLink({ agentId: 'sender', machineId: THIRD }, inbound.to, true);
    // A machine can't speak for an agent on a third machine.
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ status: 403, error: 'not_connected' });
  });

  it('refuses tools no connection carries, an agent on another machine, and a call it can\'t read', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ tool: 'change_provider' }), now)).toMatchObject({ status: 403, error: 'tool_not_allowed' });
    expect(await receiveAgentCall(OTHER, call({ to: `receiver@${THIRD}` }), now)).toMatchObject({ status: 404, error: 'wrong_machine' });
    expect(await receiveAgentCall(OTHER, call({ to: `receiver@${SELF}` }), now)).toMatchObject({ result: ok('ran here') });
    expect(await receiveAgentCall(OTHER, call({ from: { agentId: 'x@y', name: 'n' } }), now)).toMatchObject({ status: 400 });
    expect(await receiveAgentCall(OTHER, { ...call(), v: 2 }, now)).toMatchObject({ status: 400 });
    expect(await receiveAgentCall(OTHER, null, now)).toMatchObject({ status: 400 });
  });

  it('limits calls per link, and messages back and forth between one pair', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    for (let i = 0; i < RATE_LIMIT.calls; i++) expect(await receiveAgentCall(OTHER, call({ tool: 'get_status', args: {} }), now)).toHaveProperty('result');
    expect(await receiveAgentCall(OTHER, call({ tool: 'get_status', args: {} }), now)).toMatchObject({ status: 429, error: 'rate_limited' });
    // A minute later the link has room again.
    expect(await receiveAgentCall(OTHER, call({ tool: 'get_status', args: {} }), now + RATE_LIMIT.windowMs)).toHaveProperty('result');

    let t = now + 2 * RATE_LIMIT.windowMs;
    let sent = 0;
    while (sent < LOOP_LIMIT.messages) {
      expect(await receiveAgentCall(OTHER, call(), t)).toHaveProperty('result');
      sent++;
      // Spaced out so only the loop limit applies.
      t += Math.floor(RATE_LIMIT.windowMs / RATE_LIMIT.calls) + 1;
    }
    expect(await receiveAgentCall(OTHER, call(), t)).toMatchObject({ status: 429, error: 'loop_limited' });
  });
});

describe('receiving: repeats, and copies from another machine\'s clock', () => {
  it('runs a call id once: a retry after a lost answer gets the first answer', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const once = call({ callId: 'same' });
    expect(await receiveAgentCall(OTHER, once, now)).toMatchObject({ result: ok('ran here') });
    expect(await receiveAgentCall(OTHER, once, now)).toMatchObject({ result: ok('ran here') });
    expect(seen).toHaveLength(1);
  });

  it('takes a copy dated far ahead as made now, and a link only for an agent here that exists', async () => {
    const ahead = new Date(now + 24 * 3_600_000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [
      { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, updatedAt: ahead },
      { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'nobody', machine: SELF }, disabledTools: [], link: true, updatedAt: ahead },
    ] }, now);
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.updatedAt).toBe(new Date(now).toISOString());
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'nobody' })).toBeUndefined();
    // So an edit here a moment later still wins over it.
    expect(Date.parse(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })!.updatedAt)).toBeLessThan(now + 1000);
  });
});

describe('only computers in the network (D238)', () => {
  it('knows a network computer from a one-to-one pairing or an unknown machine', () => {
    expect(isNetworkComputer(OTHER)).toBe(true);
    expect(isNetworkComputer(THIRD)).toBe(false);
    expect(isNetworkComputer(Array(16).fill('dd').join(':'))).toBe(false);
  });

  it('sends nothing to a machine paired one-to-one', async () => {
    const result = await forwardAgentCall('here', `there@${THIRD}`, 'Far agent', 'send_message', { message: 'hello' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is not in this computer's Annex Network");
    expect(posts).toHaveLength(0);
  });
});

describe('sending a call to another machine', () => {
  it('posts it with the sender\'s name and project, and returns the other machine\'s answer', async () => {
    const result = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'hello' });
    expect(result).toEqual(ok('done there'));
    expect(posts[0]).toMatchObject({ machine: OTHER, path: '/api/v1/network/agent-call' });
    expect(posts[0].body).toMatchObject({ v: 1, to: 'there', tool: 'send_message', args: { message: 'hello' }, from: { agentId: 'here', name: 'Helper', projectName: 'Atlas' } });
  });

  it('says the other machine\'s refusal in its words', async () => {
    respond = () => ({ status: 403, body: { error: 'tool_denied', message: 'send_message is turned off on this connection.' } });
    const result = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'hello' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('send_message is turned off on this connection.');
  });

  it('while the machine is offline: a message waits and goes, in order, when it\'s back; a read says offline; others are refused', async () => {
    connected = false;
    const first = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one', task_id: 't1' });
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toContain('Studio, which is offline');
    expect(textOf(first)).toContain('task_id=t1');
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_file', { content: 'two' });
    expect(JSON.parse(textOf(await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'get_status', {})))).toMatchObject({ status: 'offline' });
    expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'clear_agent', {})).isError).toBe(true);
    // A wake whose moment has passed isn't kept for later.
    expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'wake_agent', {})).isError).toBe(true);
    expect(posts).toHaveLength(0);
    expect(waitingFor(OTHER).map((i) => i.body.tool)).toEqual(['send_message', 'send_file']);

    connected = true;
    connectedListener!(OTHER);
    await vi.waitFor(() => expect(waitingFor(OTHER)).toHaveLength(0));
    const calls = posts.filter((p) => p.path === '/api/v1/network/agent-call');
    expect(calls.map((p) => p.body.tool)).toEqual(['send_message', 'send_file']);
  });

  it('keeps what waited when the other machine is busy or at its limit, and drops one it refuses', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'a' });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'b' });
    connected = true;
    respond = () => ({ status: 429, body: { error: 'rate_limited' } });
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    respond = () => ({ status: 404, body: { error: 'unavailable' } });
    nextRetry(61_000);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    // Not connected there yet, for a message just queued: the link may still be on its way.
    respond = () => ({ status: 403, body: { error: 'not_connected' } });
    nextRetry(121_000);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(2);
    // Any other refusal is final: the tool is off there.
    respond = () => ({ status: 403, body: { error: 'tool_denied' } });
    nextRetry(241_000);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
  });

  it('queues a new message behind ones still waiting, even once the machine is back', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'first' });
    connected = true;
    respond = () => ({ status: 503, body: {} });
    const second = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'second' });
    expect(textOf(second)).toContain('behind messages already on their way');
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(waitingFor(OTHER).map((i) => i.body.args.message)).toEqual(['first', 'second']);
    respond = (_path, body) => delivered(body, 'ok');
    nextRetry();
    await flushOutbox(OTHER);
    expect(posts.filter((p) => p.path === '/api/v1/network/agent-call').slice(-2).map((p) => (p.body.args as { message: string }).message)).toEqual(['first', 'second']);
  });

  it('counts messages to one agent on this side too, so the limit holds both ways', async () => {
    let t = now;
    for (let i = 0; i < LOOP_LIMIT.messages; i++) {
      expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: `m${i}` }, t)).isError).toBeFalsy();
      t += 1000;
    }
    const over = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one more' }, t);
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain('paused');
  });

  it('keeps what waited when the machine fails to answer, for the next connect', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'later' });
    connected = true;
    respond = () => ({ status: 503, body: {} });
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(1);
    respond = (_path, body) => delivered(body, 'ok');
    nextRetry();
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
  });
});

describe('durable receipts and crash boundaries (#3334)', () => {
  function restart(options: Partial<Parameters<typeof startAgentCalls>[0]> = {}): void {
    stop();
    stop = startAgentCalls({
      transport, describeLocalAgent: async () => ({ name: 'Builder' }),
      runTool: async (tool, targetId, callerId, args) => { seen.push({ tool, targetId, callerId, args }); return ok('ran here'); },
      authorizeQueuedCall: async () => ({ allowed: true }),
      deliveryStore: createAnnexDeliveryStore(),
      ...options,
    });
  }

  it('accepts no queued or receiving effect from a raw-null store until explicit repair and restart', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const filename = 'corrupt-recovery.json';
    const filePath = path.join(state.base, filename);
    fs.writeFileSync(filePath, 'null');
    restart({ deliveryStore: createAnnexDeliveryStore(filename) });
    const body = call({ callId: 'after-explicit-recovery' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ status: 503, error: 'delivery_store_unavailable' });
    await expect(forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'not queued into corrupt state' })).rejects.toMatchObject({ code: 'delivery_store_unreadable' });
    expect(seen).toHaveLength(0);
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('null');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, outbox: [], inbox: [], deliveries: [] }));
    restart({ deliveryStore: createAnnexDeliveryStore(filename) });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'delivered' } });
    expect(seen).toHaveLength(1);
    restart();
  });

  it('replays a durable receiver answer after reload without another execution, and rejects changed content', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const body = call({ callId: 'restart-answer' });
    const first = await receiveAgentCall(OTHER, body, now);
    restart();
    expect(await receiveAgentCall(OTHER, body, now)).toEqual(first);
    expect(seen).toHaveLength(1);
    expect(await receiveAgentCall(OTHER, { ...body, args: { message: 'different' } }, now)).toMatchObject({ error: 'idempotency_conflict' });
    await setConnectionTools(inbound.from, inbound.to, ['send_message']);
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ error: 'tool_denied' });
  });

  it('quarantines a receiver crash after the side effect but before receipt persistence', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const store = createAnnexDeliveryStore();
    let writes = 0;
    restart({ deliveryStore: {
      ...store,
      update: async (change, at) => {
        if (++writes === 2) throw new Error('simulated receipt write crash');
        return store.update(change, at);
      },
    } });
    const body = call({ callId: 'crash-after-run' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
    restart();
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate', reason: 'receiver_interrupted' } });
    expect(seen).toHaveLength(1);
  });

  it('persists safe busy/starting retries separately from accepted input and does not cache a failed promise', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    let busy = true;
    const run = vi.fn(async () => busy
      ? { ...ok('starting'), isError: true, annexDelivery: { state: 'retry_later' as const, reason: 'starting' } }
      : ok('accepted by runtime'));
    restart({ runTool: run });
    const body = call({ callId: 'busy-then-ready' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'retry_later', reason: 'starting' } });
    restart({ runTool: run });
    busy = false;
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'delivered' } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not automatically repeat an unclassified throw that may follow a partial side effect', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const run = vi.fn(async () => { throw new Error('lost SDK answer'); });
    restart({ runTool: run });
    const body = call({ callId: 'ambiguous-sdk-answer' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rechecks receiver permission after an awaited lookup and before execution', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    restart({ describeLocalAgent: async () => {
      await setConnectionTools(inbound.from, inbound.to, ['send_message']);
      return { name: 'Builder' };
    } });
    expect(await receiveAgentCall(OTHER, call(), now)).toMatchObject({ delivery: { state: 'refused', reason: 'authorization_revoked' } });
    expect(seen).toHaveLength(0);
  });

  it('dedupes direct sends with a stable caller key after restart and binds that key to the content', async () => {
    const args = { message: 'once', idempotency_key: 'job-1' };
    const first = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args);
    const id = posts.find((p) => p.path.endsWith('agent-call'))!.body.callId as string;
    restart();
    expect(await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args)).toEqual(first);
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
    expect(textOf(await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { ...args, message: 'changed' }))).toContain('idempotency_conflict');
    expect(getDelivery('here', id)).toMatchObject({ state: 'delivered', attempts: 1 });
    expect(getDelivery('someone-else', id)).toBeUndefined();
  });

  it('resends the same id after sender crashes after 200 but before removal, preserving order', async () => {
    connected = false;
    const store = createAnnexDeliveryStore();
    let crash = false;
    restart({ deliveryStore: {
      ...store,
      update: async (change, at) => {
        if (crash) { crash = false; throw new Error('sender crashed before removal'); }
        return store.update(change, at);
      },
    } });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'first' });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'second' });
    const firstId = waitingFor(OTHER)[0].id;
    const receiver = new Map<string, ReturnType<typeof delivered>>();
    let executions = 0;
    respond = (urlPath, body) => {
      if (!urlPath.endsWith('agent-call')) return { status: 200, body: { directions: [] } };
      if (!receiver.has(body.callId as string)) { receiver.set(body.callId as string, delivered(body)); executions++; }
      crash = body.callId === firstId;
      return receiver.get(body.callId as string)!;
    };
    connected = true;
    await expect(flushOutbox(OTHER)).rejects.toThrow('sender crashed before removal');
    expect(waitingFor(OTHER).map((i) => i.id)[0]).toBe(firstId);
    connected = false;
    restart();
    connected = true;
    nextRetry();
    // Let this receiver return the retained receipt without another execution.
    respond = (urlPath, body) => {
      if (!urlPath.endsWith('agent-call')) return { status: 200, body: { directions: [] } };
      if (!receiver.has(body.callId as string)) { receiver.set(body.callId as string, delivered(body)); executions++; }
      return receiver.get(body.callId as string)!;
    };
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(posts.filter((p) => p.path.endsWith('agent-call')).map((p) => (p.body.args as { message: string }).message)).toEqual(['first', 'first', 'second']);
    expect(executions).toBe(2);
  });

  it('retains an explicit safe-to-retry 200 tool error and honors persisted backoff', async () => {
    respond = (_path, body) => ({ status: 200, body: { result: { ...ok('busy'), isError: true }, delivery: { callId: body.callId, state: 'retry_later', reason: 'busy' } } });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'wait' });
    const id = waitingFor(OTHER)[0].id;
    expect(getDelivery('here', id)).toMatchObject({ state: 'retry_later', attempts: 1 });
    const count = posts.length;
    connected = false;
    restart();
    connected = true;
    await flushOutbox(OTHER);
    expect(posts).toHaveLength(count);
    nextRetry();
    respond = (_path, body) => delivered(body);
    await flushOutbox(OTHER);
    expect(getDelivery('here', id)).toMatchObject({ state: 'delivered', attempts: 2 });
  });

  it('never retries a legacy ACK whose receiver cannot prove a durable receipt', async () => {
    respond = () => ({ status: 200, body: { result: ok('legacy accepted input') } });
    const result = await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'do not repeat', idempotency_key: 'old-peer' });
    expect(result.isError).toBe(true);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(textOf(result)).toContain('automatic redelivery is disabled');
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'do not repeat', idempotency_key: 'old-peer' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
  });

  it('refuses old peers before input and waits safely when capability negotiation is unavailable', async () => {
    const support = vi.spyOn(transport, 'supportsDurableDelivery').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false);
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'requires durable receiver' });
    const id = waitingFor(OTHER)[0].id;
    expect(getDelivery('here', id)).toMatchObject({ state: 'retry_later', reason: 'capability_check_unavailable' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
    nextRetry();
    await flushOutbox(OTHER);
    expect(support).toHaveBeenCalledTimes(2);
    expect(getDelivery('here', id)).toMatchObject({ state: 'refused', reason: 'durable_delivery_unsupported', attempts: 0 });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
  });

  it('renegotiates on reconnect and quarantines an uncertain attempt if the peer downgraded', async () => {
    vi.spyOn(transport, 'supportsDurableDelivery').mockResolvedValueOnce(true).mockResolvedValue(false);
    respond = (urlPath) => urlPath.endsWith('/connections') ? { status: 200, body: { directions: [] } } : { status: 503, body: {} };
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'accepted maybe' });
    const id = waitingFor(OTHER)[0].id;
    restart();
    nextRetry();
    await syncDirectionsWith(OTHER);
    await flushOutbox(OTHER);
    expect(getDelivery('here', id)).toMatchObject({ state: 'indeterminate', reason: 'durable_delivery_unsupported' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
  });

  it('binds sender and receiver dedupe to pairing epochs and never sends an old queue under a new pairing', async () => {
    connected = false;
    const args = { message: 'once per pairing', idempotency_key: 'pairing-job' };
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args);
    const oldId = waitingFor(OTHER)[0].id;
    state.peerPairing = 'new-peer-epoch';
    await flushOutbox(OTHER);
    expect(getDelivery('here', oldId)).toMatchObject({ state: 'refused', reason: 'pairing_changed' });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', args);
    expect(waitingFor(OTHER)[0].id).not.toBe(oldId);
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, call({ epoch: { sender: 'peer-epoch', receiver: 'self-epoch' } }), now)).toMatchObject({ error: 'pairing_changed' });
    expect(seen).toHaveLength(0);
  });

  it('makes refusal/expiry durable and notifies the sender, retrying an unacknowledged notice on restart', async () => {
    connected = false;
    const notices = vi.fn(async () => {});
    restart({ onDeliveryFailure: notices });
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'old' });
    const id = waitingFor(OTHER)[0].id;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DELIVERY_MAX_AGE_MS + 1);
    await flushOutbox(OTHER);
    expect(waitingFor(OTHER)).toHaveLength(0);
    expect(getDelivery('here', id)).toMatchObject({ state: 'expired', reason: 'expired' });
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ callId: id, state: 'expired' }));
    restart({ onDeliveryFailure: notices });
    await Promise.resolve();
    expect(notices).toHaveBeenCalledTimes(1);
  });

  it('refuses queued work when sender authorization is revoked without POSTing it', async () => {
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'no longer allowed' });
    const id = waitingFor(OTHER)[0].id;
    restart({ authorizeQueuedCall: async () => ({ allowed: false, reason: 'agent.message was revoked' }) });
    await flushOutbox(OTHER);
    expect(getDelivery('here', id)).toMatchObject({ state: 'refused', reason: 'authorization_revoked' });
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
  });

  it('persists trusted causal context outside agent arguments and enforces the depth bound', async () => {
    connected = false;
    const context = { rootId: 'root', depth: 3, parentId: 'parent' };
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one', idempotency_key: 'context-1' }, now, context);
    restart();
    expect(waitingFor(OTHER)[0].body.context).toEqual(context);
    expect(waitingFor(OTHER)[0].body.args).not.toHaveProperty('context');
    expect((await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'two' }, now, { rootId: 'root', depth: 9 })).isError).toBe(true);
    expect(waitingFor(OTHER)).toHaveLength(1);
  });

  it('routes only fixed controller capabilities before editable directions and never falls through when disabled', async () => {
    let available = true;
    const receive = vi.fn(async () => ok('controller receipt'));
    restart({ remoteDispatcher: { isTarget: (id) => id === 'controller', isAvailable: () => available, receive } });
    const body = call({ callId: 'controller-call', to: 'controller', tool: 'hand_off_request', args: { request: 'triage', context: { rootId: 'forged', depth: 0 } }, context: { rootId: 'real', depth: 2 } });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ result: ok('controller receipt') });
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({
      origin: { machineId: OTHER, machineName: 'Studio', agentId: 'sender', agentName: 'Scout' },
      cause: { rootId: 'real', depth: 2 }, deliveryId: 'controller-call',
    }));
    await setConnectionLink(inbound.from, { agentId: 'controller' }, true);
    for (const tool of ['wake_agent', 'clear_agent', 'read_output']) {
      expect(await receiveAgentCall(OTHER, { ...body, callId: `unsafe-${tool}`, tool }, now)).toMatchObject({ error: 'tool_not_allowed' });
    }
    available = false;
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ error: 'dispatcher_unavailable' });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(await receiveAgentCall(OTHER, { ...body, to: 'receiver' }, now)).toMatchObject({ error: 'tool_not_allowed' });
    expect(await receiveAgentCall(OTHER, { ...body, context: { rootId: 'real', depth: 9 } }, now)).toMatchObject({ error: 'invalid_call' });
  });

  it('rejects changed content even while the original durable call is still running', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => { await gate; return ok('accepted'); });
    restart({ runTool: run });
    const body = call({ callId: 'running-conflict' });
    const first = receiveAgentCall(OTHER, body, now);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await receiveAgentCall(OTHER, { ...body, args: { message: 'changed' } }, now)).toMatchObject({ error: 'idempotency_conflict' });
    release();
    expect(await first).toMatchObject({ delivery: { state: 'delivered' } });
  });

  it('preserves a large first read while bounding its durable replay without repeating the runner', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const output = 'x'.repeat(80 * 1024);
    const run = vi.fn(async () => ok(output));
    restart({ runTool: run });
    const body = call({ callId: 'large-read', tool: 'read_output' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ result: ok(output) });
    restart({ runTool: run });
    const replay = await receiveAgentCall(OTHER, body, now);
    expect(Buffer.byteLength(JSON.stringify(replay))).toBeLessThan(64 * 1024);
    expect(replay).toMatchObject({ delivery: { state: 'delivered' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('quarantines a contradictory success marker on an error instead of retrying an uncertain effect', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const run = vi.fn(async () => ({ ...ok('partial effect'), isError: true, annexDelivery: { state: 'delivered' as const } }));
    restart({ runTool: run });
    const body = call({ callId: 'contradictory' });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    restart({ runTool: run });
    expect(await receiveAgentCall(OTHER, body, now)).toMatchObject({ delivery: { state: 'indeterminate' } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not send from a stopped lifecycle after an awaited capability lookup resumes', async () => {
    let release!: (supported: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const support = vi.spyOn(transport, 'supportsDurableDelivery').mockReturnValueOnce(gate).mockResolvedValue(true);
    const pending = forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'one lifecycle only' });
    await vi.waitFor(() => expect(support).toHaveBeenCalledTimes(1));
    restart();
    release(true);
    await pending;
    await vi.waitFor(() => expect(waitingFor(OTHER)).toHaveLength(0));
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(1);
  });

  it('quarantines migrated legacy work whose prior acceptance cannot be proven', async () => {
    const queuedAt = new Date().toISOString();
    fs.writeFileSync(path.join(state.base, 'recovered-legacy.json'), JSON.stringify({ version: 1, items: [{
      id: 'legacy-call', machine: OTHER, queuedAt,
      body: { ...call({ callId: 'legacy-call', to: 'there' }), from: { agentId: 'here', name: 'Sender' } },
    }] }));
    restart({ deliveryStore: createAnnexDeliveryStore('recovered-legacy.json') });
    await flushOutbox(OTHER);
    await vi.waitFor(() => expect(getDelivery('here', 'legacy-call')).toMatchObject({ state: 'indeterminate', reason: 'legacy_delivery_unverified' }));
    expect(posts.filter((p) => p.path.endsWith('agent-call'))).toHaveLength(0);
  });
});

describe('disabled prepared protocol transport', () => {
  const filename = 'prepared-protocols.json';
  let allowed = true;
  let inboundAllowed = true;
  let unregister: () => void;
  const authorize = vi.fn<AnnexDeliveryProtocol['authorizeOutgoing']>(async () => ({ allowed: true }));
  const check = vi.fn((_request: AnnexProtocolOutgoing) => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'Off now' });
  const incoming = vi.fn((_request: AnnexProtocolIncoming) => inboundAllowed ? { allowed: true as const } : { allowed: false as const, reason: 'Off here' });
  const receive = vi.fn(async (_request: AnnexProtocolIncoming) => ok('protocol accepted'));

  beforeEach(async () => {
    allowed = true;
    inboundAllowed = true;
    authorize.mockReset().mockResolvedValue({ allowed: true });
    check.mockClear();
    incoming.mockClear();
    receive.mockReset().mockResolvedValue(ok('protocol accepted'));
    transport.supportsProtocolDelivery = vi.fn(async () => true);
    unregister = registerAnnexDeliveryProtocol({
      name: 'handoff', tools: { offer: 'durable', snapshot: 'durable', cancel: 'durable', get: 'read', capacity: 'read' },
      authorizeOutgoing: authorize, checkOutgoing: check, authorizeIncoming: incoming, receive,
    });
    await createAnnexDeliveryStore(filename).clearForTesting();
    restartProtocol();
  });
  afterEach(() => { unregister(); delete transport.supportsProtocolDelivery; });

  async function prepare(overrides: Partial<AnnexProtocolCall> = {}): Promise<PreparedAnnexProtocolCall> {
    const result = await prepareAnnexProtocolCall({
      protocol: 'handoff', machine: OTHER, callerId: 'here', targetId: 'there', tool: 'offer',
      args: { request: 'original' }, commandId: 'stable-command',
      sourceCall: { toolName: 'agent__there__offer', callKey: 'call\0here\0agent__there__offer\0original-args-hash' }, ...overrides,
    });
    if (!result.ok) throw new Error(textOf(result.result));
    return result.prepared;
  }

  function restartProtocol(storeFilename = filename): void {
    stop();
    stop = startAgentCalls({
      transport, deliveryStore: createAnnexDeliveryStore(storeFilename), describeLocalAgent: async () => ({ name: 'Helper', projectName: 'Atlas' }),
      runTool: async () => { throw new Error('A protocol must never fall back to the generic runner.'); },
      authorizeQueuedCall: async () => { throw new Error('A protocol must use its actual protocol scope, not generic wire authorization.'); },
    });
  }

  function packet(overrides: Record<string, unknown> = {}) {
    return snapshotAnnexProtocolEnvelope(call({
      callId: 'protocol-receipt', protocol: 'handoff', commandId: 'remote-stable-command', tool: 'offer',
      context: { rootId: 'root', depth: 2, parentId: 'parent' },
      epoch: { sender: state.peerPairing, receiver: state.pairing }, ...overrides,
    }));
  }

  it('advertises only the installed protocol, derives a stable scoped id and hashes every final wire field', async () => {
    expect(agentDeliveryCapabilities().protocolVersions).toEqual({ handoff: 1 });
    const original = await prepare();
    expect((await prepare()).body.callId).toBe(original.body.callId);
    const changed = await prepare({ args: { request: 'different' } });
    expect(changed.body.callId).toBe(original.body.callId);
    expect(changed.wirePayloadHash).not.toBe(original.wirePayloadHash);
    expect(original.wirePayloadHash).toBe(createHash('sha256').update(JSON.stringify(original.body)).digest('hex'));
    state.peerPairing = 'new-epoch';
    expect((await prepare()).body.callId).not.toBe(original.body.callId);
    unregister();
    expect(agentDeliveryCapabilities().protocolVersions).toEqual({});
    expect((await forwardPreparedAnnexProtocolCall(original)).isError).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it('shares one immutable normalized payload and rejects fabricated handles or authority fields', async () => {
    connected = false;
    const args = { request: 'before', nested: { value: 'original' } };
    const prepared = await prepare({ args });
    args.request = 'after';
    args.nested.value = 'changed';
    expect(Reflect.set(prepared.body.args, 'request', 'forged')).toBe(false);
    expect(Reflect.set(prepared.body.from, 'name', 'forged')).toBe(false);
    expect(Reflect.set(prepared.sourceCall, 'callKey', 'forged')).toBe(false);
    expect((await forwardPreparedAnnexProtocolCall(JSON.parse(JSON.stringify(prepared)))).isError).toBe(true);
    expect((await forwardPreparedAnnexProtocolCall(prepared, JSON.parse('{"requestId":"r","approved":true}'))).isError).toBe(true);
    await forwardPreparedAnnexProtocolCall(prepared, { requestId: 'actual-human-request' });
    expect(waitingFor(OTHER)[0]).toMatchObject({
      body: { args: { request: 'before', nested: { value: 'original' } } },
      protocolContext: { sourceCall: prepared.sourceCall, localAuthorization: { requestId: 'actual-human-request' } },
    });
    expect(waitingFor(OTHER)[0].body).not.toHaveProperty('sourceCall');
    expect(waitingFor(OTHER)[0].body).not.toHaveProperty('localAuthorization');
    expect(prepared.retainedByteLength).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(prepared.body)));
  });

  it('never changes content under a queued command identity and enqueues nothing when the real claim refuses', async () => {
    connected = false;
    const original = await prepare();
    authorize.mockResolvedValueOnce({ allowed: false, reason: 'Actual receipt claim refused' });
    expect(textOf(await forwardPreparedAnnexProtocolCall(original))).toContain('Actual receipt claim refused');
    expect(waitingFor(OTHER)).toHaveLength(0);
    await forwardPreparedAnnexProtocolCall(original);
    const changed = await prepare({ args: { request: 'different' } });
    expect(textOf(await forwardPreparedAnnexProtocolCall(changed))).toContain('idempotency_conflict');
    expect(waitingFor(OTHER)).toHaveLength(1);
    expect(waitingFor(OTHER)[0].body.args).toEqual({ request: 'original' });
  });

  it('refuses a pairing change during descriptor lookup and never supplies a missing command identity', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stop();
    stop = startAgentCalls({
      transport, deliveryStore: createAnnexDeliveryStore(filename), runTool: async () => ok('generic'),
      describeLocalAgent: async () => { await gate; return { name: 'Helper' }; },
    });
    const pending = prepare();
    state.peerPairing = 'changed-during-description';
    release();
    await expect(pending).rejects.toThrow('changed during preparation');
    await expect(prepare({ commandId: undefined })).rejects.toThrow();
    expect(waitingFor(OTHER)).toHaveLength(0);
  });

  it('admits exactly 512 KiB of actual escaped UTF-8 envelope bytes and refuses one more byte', async () => {
    const prefix = '"\n\\\u00e9';
    const small = await prepare({ args: { request: prefix } });
    const request = prefix + 'x'.repeat(512 * 1024 - small.wireByteLength);
    const exact = await prepare({ args: { request } });
    expect(Buffer.byteLength(JSON.stringify(exact.body))).toBe(512 * 1024);
    const tooLarge = await prepareAnnexProtocolCall({
      protocol: 'handoff', machine: OTHER, callerId: 'here', targetId: 'there', tool: 'offer',
      args: { request: request + 'x' }, commandId: 'stable-command', sourceCall: small.sourceCall,
    });
    expect(tooLarge).toMatchObject({ ok: false, result: { isError: true } });
    expect(waitingFor(OTHER)).toHaveLength(0);
  });

  it.each(['offer', 'get'])('never posts %s to a generic-v1 peer lacking explicit protocol support', async (tool) => {
    delete transport.supportsProtocolDelivery;
    const prepared = await prepare({ tool });
    expect((await forwardPreparedAnnexProtocolCall(prepared)).isError).toBe(true);
    expect(posts.filter((post) => post.path.endsWith('/agent-call'))).toHaveLength(0);
  });

  it('checks read scope again after capability negotiation without queueing or posting revoked input', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const support = vi.fn(async () => { await gate; return true; });
    transport.supportsProtocolDelivery = support;
    const pending = forwardPreparedAnnexProtocolCall(await prepare({ tool: 'get' }));
    await vi.waitFor(() => expect(support).toHaveBeenCalledOnce());
    allowed = false;
    release();
    expect(textOf(await pending)).toContain('Off now');
    expect(posts.filter((post) => post.path.endsWith('/agent-call'))).toHaveLength(0);
    expect(waitingFor(OTHER)).toHaveLength(0);
  });

  it('checks revocation after async claim and after waiting for the real store lock', async () => {
    connected = false;
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    authorize.mockImplementationOnce(async () => { await claimGate; return { allowed: true }; });
    const prepared = await prepare();
    const pending = forwardPreparedAnnexProtocolCall(prepared, { requestId: 'actual-request' });
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    allowed = false;
    releaseClaim();
    expect((await pending).isError).toBe(true);
    expect(waitingFor(OTHER)).toHaveLength(0);

    allowed = true;
    const filename = 'protocol-serialized-lock.json';
    restartProtocol(filename);
    const store = createAnnexDeliveryStore(filename);
    stop();
    stop = startAgentCalls({ transport, deliveryStore: store, runTool: async () => ok('generic'), describeLocalAgent: async () => ({ name: 'Helper' }) });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const rename = fs.promises.rename;
    const renaming = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => { await saveGate; return rename(from, to); });
    const blocking = store.update(() => {});
    await vi.waitFor(() => expect(renaming).toHaveBeenCalledOnce());
    const second = forwardPreparedAnnexProtocolCall(await prepare({ commandId: 'waiting-lock' }));
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    allowed = false;
    releaseSave();
    await blocking;
    expect((await second).isError).toBe(true);
    expect(createAnnexDeliveryStore(filename).get().outbox).toHaveLength(0);
  });

  it('rechecks synchronous full scope after sending persistence, before any POST', async () => {
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      const saved = fs.readFileSync(from, 'utf8');
      await rename(from, to);
      if (String(to).endsWith(filename) && JSON.parse(saved).deliveries.some((row: { state: string }) => row.state === 'sending')) allowed = false;
    });
    const prepared = await prepare();
    expect((await forwardPreparedAnnexProtocolCall(prepared)).isError).toBe(true);
    expect(posts.filter((post) => post.path.endsWith('/agent-call'))).toHaveLength(0);
    expect(getDelivery('here', prepared.body.callId)).toMatchObject({ state: 'refused', reason: 'authorization_revoked' });
  });

  it('refuses unknown/uninstalled protocols rather than invoking an editable generic direction', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    expect(await receiveAgentCall(OTHER, { ...packet(), protocol: 'unknown' })).toMatchObject({ status: 400 });
    expect(await receiveAgentCall(OTHER, { ...packet(), protocol: 'federation', tool: 'send_message' })).toMatchObject({ error: 'protocol_unavailable' });
    expect(await receiveAgentCall(OTHER, { ...packet(), localAuthorization: { requestId: 'sender-proof' } })).toMatchObject({ status: 400 });
    expect(await receiveAgentCall(OTHER, { ...packet(), tool: 'wake_agent' })).toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
    expect(receive).not.toHaveBeenCalled();
  });

  it('persists receiver claims before effects, checks full-envelope conflicts and denies revoked receipt replay', async () => {
    const body = packet();
    receive.mockImplementationOnce(async (request) => {
      const disk = createAnnexDeliveryStore(filename).get();
      expect(disk.inbox).toContainEqual(expect.objectContaining({ state: 'claimed', payloadHash: request.wirePayloadHash }));
      expect(request.origin).toEqual({ machineId: OTHER, machineName: 'Studio', agentId: 'sender', agentName: 'Scout' });
      expect(request.body.context).toEqual(body.context);
      return ok('accepted once');
    });
    expect(await receiveAgentCall(OTHER, body)).toMatchObject({ delivery: { state: 'delivered' } });
    restartProtocol();
    expect(await receiveAgentCall(OTHER, body)).toMatchObject({ delivery: { state: 'delivered' } });
    expect(await receiveAgentCall(OTHER, { ...body, from: { ...body.from, name: 'changed display' } })).toMatchObject({ error: 'idempotency_conflict' });
    inboundAllowed = false;
    expect(await receiveAgentCall(OTHER, body)).toMatchObject({ error: 'protocol_refused' });
    expect(receive).toHaveBeenCalledOnce();
  });

  it('does not execute a registered protocol after its owning agent-call runtime stops', async () => {
    stop();
    expect(await receiveAgentCall(OTHER, packet())).toMatchObject({ error: 'unavailable' });
    expect(receive).not.toHaveBeenCalled();
  });

  it('never acknowledges an effect whose terminal receipt did not commit, and never reruns its orphaned claim', async () => {
    const body = packet();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(filename) && JSON.parse(fs.readFileSync(from, 'utf8')).inbox.some((row: { state: string }) => row.state === 'delivered')) {
        throw Object.assign(new Error('terminal receipt denied'), { code: 'EACCES' });
      }
      return rename(from, to);
    });
    expect(await receiveAgentCall(OTHER, body)).toMatchObject({ status: 503, error: 'delivery_store_unavailable' });
    expect(receive).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    restartProtocol();
    expect(await receiveAgentCall(OTHER, body)).toMatchObject({ delivery: { state: 'indeterminate', reason: 'receiver_interrupted' } });
    expect(receive).toHaveBeenCalledOnce();
  });

  it('rechecks receiver permission after the actual durable claim and quarantines orphaned claims on restart', async () => {
    const body = packet();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (from, to) => { await rename(from, to); inboundAllowed = false; });
    expect(await receiveAgentCall(OTHER, body)).toMatchObject({ delivery: { state: 'refused', reason: 'authorization_revoked' } });
    expect(receive).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    inboundAllowed = true;
    const orphan = packet({ callId: 'orphaned-protocol' });
    const store = createAnnexDeliveryStore(filename);
    const at = new Date().toISOString();
    await store.update((file) => file.inbox.push({
      key: `${OTHER}/${deliveryHash({ sender: state.pairing, receiver: state.peerPairing })}/${orphan.callId}`,
      payloadHash: annexProtocolWireHash(orphan), state: 'claimed', createdAt: at, updatedAt: at,
    }));
    restartProtocol();
    expect(await receiveAgentCall(OTHER, orphan)).toMatchObject({ delivery: { state: 'indeterminate', reason: 'receiver_interrupted' } });
    expect(receive).not.toHaveBeenCalled();
  });

  it('keeps prepared, persisted, reopened and real client POST bytes identical without Main authority on the wire', async () => {
    connected = false;
    const prepared = await prepare({ args: { request: '"\n\\\u00e9', '10': 10, '2': 2, nested: { z: 1, a: 2 } } });
    const bytes = JSON.stringify(prepared.body);
    await forwardPreparedAnnexProtocolCall(prepared, { requestId: 'original-human-answer' });
    const disk = createAnnexDeliveryStore(filename).get().outbox[0];
    expect(JSON.stringify(disk.body)).toBe(bytes);
    restartProtocol();
    expect((await forwardPreparedAnnexProtocolCall(prepared)).isError).toBe(true);
    expect(JSON.stringify(waitingFor(OTHER)[0].body)).toBe(bytes);

    vi.doMock('../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
    const client = await import('./annex-client');
    client._addConnectedSatelliteForTesting(OTHER);
    const written: string[] = [];
    vi.mocked(https.request).mockImplementation(((_url: unknown, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = Object.assign(new EventEmitter(), {
        write: (chunk: string) => { written.push(chunk); return true; },
        destroy: () => request,
        end: () => {
          expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Length': Buffer.byteLength(bytes) } });
          const response = Object.assign(new EventEmitter(), { statusCode: 200 });
          callback(response as IncomingMessage);
          response.emit('data', Buffer.from(JSON.stringify(delivered(JSON.parse(bytes)).body)));
          response.emit('end');
          return request;
        },
      });
      return request as ClientRequest;
    }) as typeof https.request);
    const post = vi.spyOn(transport, 'post').mockImplementation((machine, route, body) => {
      expect(Reflect.set(body, 'localAuthorization', { requestId: 'forged' })).toBe(false);
      return client.postToMachine(machine, route, body);
    });
    connected = true;
    await flushOutbox(OTHER);
    expect(written).toEqual([bytes]);
    expect(createHash('sha256').update(written[0]).digest('hex')).toBe(prepared.wirePayloadHash);
    expect(JSON.parse(written[0])).not.toHaveProperty('localAuthorization');
    expect(JSON.parse(written[0])).not.toHaveProperty('sourceCall');
    expect(getDelivery('here', prepared.body.callId)).toMatchObject({ state: 'delivered', attempts: 1 });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ sourceCall: prepared.sourceCall }), { requestId: 'original-human-answer' });
    post.mockRestore();
    client.stopClient();
    vi.doUnmock('../util/ipc-broadcast');
  });
});

describe('keeping both machines\' copies of a connection', () => {
  it('takes the other machine\'s share from its answer, so both copies meet when only one can reach the other', async () => {
    const at = new Date(now).toISOString();
    respond = (urlPath) => (urlPath === '/api/v1/network/connections'
      ? { status: 200, body: { applied: 0, directions: [{ from: { agentId: 'there', machine: OTHER, name: 'Far agent' }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, updatedAt: at }] } }
      : { status: 200, body: { result: ok('x') } });
    expect(await syncDirectionsWith(OTHER)).toBe(true);
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeTruthy();
  });

  it('on connect, sends what waited only after the connections got through', async () => {
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: OTHER }, true);
    connected = false;
    await forwardAgentCall('here', `there@${OTHER}`, 'Far agent', 'send_message', { message: 'later' });
    connected = true;
    posts = [];
    respond = (urlPath) => (urlPath === '/api/v1/network/connections' ? { status: 503, body: {} } : { status: 200, body: { result: ok('x') } });
    connectedListener!(OTHER);
    await vi.waitFor(() => expect(posts.some((p) => p.path === '/api/v1/network/connections')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.some((p) => p.path === '/api/v1/network/agent-call')).toBe(false);
    expect(waitingFor(OTHER)).toHaveLength(1);
  });

  it('runs a retry that arrives during the first run only once', async () => {
    await setConnectionLink(inbound.from, inbound.to, true);
    const once = call({ callId: 'slow' });
    const [a, b] = await Promise.all([receiveAgentCall(OTHER, once, now), receiveAgentCall(OTHER, once, now)]);
    expect(a).toEqual(b);
    expect(seen).toHaveLength(1);
  });

  it('sends the other machine its share, with both ends naming their machine', async () => {
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: OTHER }, true);
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: THIRD }, true);
    posts = [];
    await syncDirectionsWith(OTHER);
    // Each machine gets only its own share.
    expect(posts.filter((p) => p.path === '/api/v1/network/connections').every((p) => p.machine === OTHER || p.machine === THIRD)).toBe(true);
    const sent = posts.filter((p) => p.path === '/api/v1/network/connections' && p.machine === OTHER).at(-1)!;
    expect(sent.body.directions).toEqual([expect.objectContaining({
      from: { agentId: 'here', machine: SELF, name: 'Helper' }, to: expect.objectContaining({ agentId: 'there', machine: OTHER }), link: true,
    })]);
  });

  it('a change to a direction with another machine is sent at once', async () => {
    posts = [];
    await setConnectionLink({ agentId: 'here' }, { agentId: 'there', machineId: OTHER }, true);
    await vi.waitFor(() => expect(posts.some((p) => p.path === '/api/v1/network/connections')).toBe(true));
  });

  it('takes the newer copy of a direction between the two machines, learns names, and nothing else', async () => {
    const at = new Date(now).toISOString();
    const result = await receiveDirections(OTHER, { v: 1, directions: [
      { from: { agentId: 'there', machine: OTHER, name: 'Far agent' }, to: { agentId: 'receiver', machine: SELF }, disabledTools: ['clear_agent'], link: true, updatedAt: at },
      // Between the sender and a third machine: not the sender's to say here.
      { from: { agentId: 'there', machine: OTHER }, to: { agentId: 'x', machine: THIRD }, disabledTools: [], link: true, updatedAt: at },
      // Two agents here: not the sender's either.
      { from: { agentId: 'here', machine: SELF }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: true, updatedAt: at },
    ] });
    expect(result).toEqual({ applied: 1 });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })).toMatchObject({ disabledTools: ['clear_agent'], link: expect.anything(), updatedAt: at });
    expect(remoteAgentName(`there@${OTHER}`)).toBe('Far agent');
    expect(listAllConnectionDirections().some((d) => d.to.machineId === THIRD || (d.from.agentId === 'here' && d.to.agentId === 'receiver'))).toBe(false);

    // An older copy loses; a newer one, with the link off, wins.
    const older = new Date(now - 1000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [{ from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: false, updatedAt: older }] });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeTruthy();
    const newer = new Date(now + 1000).toISOString();
    await receiveDirections(OTHER, { v: 1, directions: [{ from: { agentId: 'there', machine: OTHER }, to: { agentId: 'receiver', machine: SELF }, disabledTools: [], link: false, updatedAt: newer }] });
    expect(getConnectionDirection({ agentId: 'there', machineId: OTHER }, { agentId: 'receiver' })?.link).toBeFalsy();
  });

  it('refuses a list it can\'t read', async () => {
    expect(await receiveDirections(OTHER, { v: 2, directions: [] })).toMatchObject({ status: 400 });
    expect(await receiveDirections(OTHER, null)).toMatchObject({ status: 400 });
  });
});
