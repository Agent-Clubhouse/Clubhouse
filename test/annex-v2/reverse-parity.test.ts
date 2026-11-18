import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { createHash } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BULLETIN_MESSAGES, BULLETIN_MESSAGE_BYTES, NATIVE_TRANSCRIPT_EVENTS, NATIVE_TRANSCRIPT_EVENT_BYTES, NATIVE_SESSION_ID, SMALL_SESSION_ID,
  createInventoryPeer, LARGE_DIFF_BYTES, LARGE_TEXT_BYTES, type InventoryPeer, type InventoryPeerInfo, type WireAnswer,
} from './reverse-inventory-peer';
import { assertDialAudit, closeServer, rpcPeer, sentinel, sizedPng, transparentForward, type RpcPeer } from './reverse-parity-fixture';
import { CHAT_IMAGE_MAX_BYTES, type ChatEventDraft } from '../../src/shared/chat';
import type { GitOperationParams } from '../../src/main/services/annex-client';
import type { BulletinMessage } from '../../src/shared/group-project-types';
import { CLIPBOARD_IMAGE_MAX_BASE64, MOBILE_CONTENT_MAX_BYTES } from '../../src/shared/annex-binary-limits';

type Status = ReturnType<InventoryPeer['status']>;

describe('full-server audit inventory over one A to B forward', () => {
  let a: InventoryPeer;
  let b: RpcPeer;
  let bInfo: InventoryPeerInfo;
  let child: ChildProcess;
  let childExit: Promise<number | null>;
  let output = '';
  let ipc: net.Server;
  let ipcDir: string;
  let forward: Awaited<ReturnType<typeof transparentForward>>;
  let guard: Awaited<ReturnType<typeof sentinel>>;
  const status = (who: 'A' | 'B'): Promise<Status> => who === 'A' ? Promise.resolve(a.status()) : b.call('status');
  const target = (who: 'A' | 'B') => who === 'A' ? bInfo : a.info;
  const emitOnTarget = (who: 'A' | 'B', event: ChatEventDraft): Promise<number> => who === 'A' ? b.call('emit', event) : a.emit(event);
  const driverOnTarget = (who: 'A' | 'B'): Promise<ReturnType<InventoryPeer['driverState']>> => who === 'A' ? b.call('driverState') : Promise.resolve(a.driverState());
  const chat = (who: 'A' | 'B', command: Record<string, unknown>, commandId?: string) => who === 'A' ? a.chat({ command, commandId }) : b.call('chat', { command, commandId });
  const page = (who: 'A' | 'B', options?: Parameters<InventoryPeer['page']>[0]) => who === 'A' ? a.page(options) : b.call('page', options);
  const send = (who: 'A' | 'B', type: string, payload: Record<string, unknown>) => who === 'A' ? a.send({ type, payload }) : b.call('send', { type, payload });
  const wire = (who: 'A' | 'B', input: Parameters<InventoryPeer['wire']>[0]): Promise<WireAnswer> => who === 'A' ? a.wire(input) : b.call('wire', input);
  const json = (answer: WireAnswer): unknown => JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'));
  const mobile = async (who: 'A' | 'B', command: Record<string, unknown>, commandId: string) => {
    const state = json(await wire(who, { method: 'GET', path: '/api/v1/mobile/agents/state' })) as { epoch: string };
    expect(typeof state.epoch).toBe('string');
    return wire(who, {
      method: 'POST', path: '/api/v1/mobile/commands', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...command, version: 1, epoch: state.epoch, commandId }),
    });
  };
  const expectSatelliteEvent = (who: 'A' | 'B', type: string, payload: unknown) => vi.waitFor(async () => {
    const events = (await status(who)).events.filter(({ payload }) => payload !== null && typeof payload === 'object' && 'type' in payload && payload.type === type);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      channel: 'annex-client:satellite-event',
      payload: expect.objectContaining({ satelliteId: target(who).fingerprint, type, payload: expect.objectContaining(payload) }),
    })]));
  });

  beforeAll(async () => {
    a = await createInventoryPeer('A');
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-ipc-'));
    const ipcPath = process.platform === 'win32' ? `\\\\.\\pipe\\annex-inventory-${path.basename(ipcDir)}` : path.join(ipcDir, 'p');
    ipc = net.createServer();
    const connected = new Promise<net.Socket>((resolve) => ipc.once('connection', resolve));
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(ipcPath, resolve); });
    child = spawn(process.execPath, [
      path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--project', 'integration',
      'test/annex-v2/reverse-inventory-worker.test.ts', '--maxWorkers=1', '--disableConsoleIntercept',
    ], { env: { ...process.env, CLUBHOUSE_ANNEX_INVENTORY_PEER: '1', CLUBHOUSE_ANNEX_INVENTORY_IPC: ipcPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (data) => { output += data.toString(); });
    child.stderr!.on('data', (data) => { output += data.toString(); });
    childExit = new Promise((resolve) => child.once('exit', resolve));
    const socket = await Promise.race([
      connected, childExit.then((code): never => { throw new Error(`Inventory peer exited ${code}: ${output}`); }),
      new Promise<never>((_resolve, reject) => { const t = setTimeout(() => reject(new Error(`Inventory peer startup timed out: ${output}`)), 30_000); t.unref(); }),
    ]);
    b = rpcPeer(socket, async (method) => { throw new Error(`Unexpected inventory child request: ${method}`); });
    bInfo = await b.call('info');
    guard = await sentinel();
    forward = await transparentForward(bInfo.port);
    await b.call('configure', { peer: a.info, routePort: guard.port, forwardPort: null });
    await a.configure({ peer: bInfo, routePort: forward.port, forwardPort: forward.port });
    await vi.waitFor(async () => {
      expect((await status('A')).readiness?.openedHere).toBe(true);
      expect((await status('B')).readiness?.acceptedHere).toBe(true);
      expect((await status('A')).snapshot?.projects[0]).toMatchObject({ id: bInfo.projectId });
      expect((await status('B')).snapshot?.projects[0]).toMatchObject({ id: a.info.projectId });
      expect(a.connections().incoming?.link).toBeTruthy();
      expect((await b.call<ReturnType<InventoryPeer['connections']>>('connections')).incoming?.link).toBeTruthy();
    }, { timeout: 15_000, interval: 25 });
  }, 60_000);

  afterAll(async () => {
    if (b) await b.call('stop');
    if (a) await a.close();
    b?.close();
    await forward?.close();
    await guard?.close();
    if (ipc) await closeServer(ipc);
    if (child) expect(await childExit, output).toBe(0);
    if (ipcDir) fs.rmSync(ipcDir, { recursive: true, force: true });
  }, 30_000);

  it.each(['A', 'B'] as const)('R01 %s: actual chat pages, cursor and saved session listing', async (who) => {
    const first = await emitOnTarget(who, { type: 'agent_message', data: { messageId: 'history-1', text: 'first page message' } });
    const second = await emitOnTarget(who, { type: 'agent_message', data: { messageId: 'history-2', text: 'second page message' } });
    expect(await page(who, { limit: 1 })).toMatchObject({
      sessionId: target(who).sessionId, readOnly: false, nextBeforeSeq: second,
      events: [{ seq: second, type: 'agent_message', data: { text: 'second page message' } }],
    });
    expect(await page(who, { beforeSeq: second, limit: 1 })).toMatchObject({
      events: [{ seq: first, type: 'agent_message', data: { text: 'first page message' } }],
    });
    const sessions = who === 'A' ? await a.chatSessions() : await b.call('chatSessions');
    expect(sessions).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ sessionId: target(who).sessionId })]) });
  });

  it.each(['A', 'B'] as const)('R02/R06 %s: live chat reaches the ordinary satellite event path', async (who) => {
    const data = { messageId: `stream-${who}`, text: 'streamed through the real subscription' };
    const seq = await emitOnTarget(who, { type: 'agent_message_chunk', data });
    await expectSatelliteEvent(who, 'chat:event', {
      agentId: target(who).agentId, event: expect.objectContaining({ seq, type: 'agent_message_chunk', data }),
    });
  });

  it.each(['A', 'B'] as const)('R03 %s: send, steer, removable queue and interrupt execute once', async (who) => {
    const before = await driverOnTarget(who);
    const sentBefore = before.sent.length;
    expect(await chat(who, { type: 'chat.send', text: 'first input', delivery: 'prompt' })).toMatchObject({
      status: 'completed', result: { delivery: 'prompt' },
    });
    await emitOnTarget(who, { type: 'turn_started', data: { trigger: 'prompt' } });
    expect(await chat(who, { type: 'chat.send', text: 'steering input', delivery: 'steer' })).toMatchObject({
      status: 'completed', result: { delivery: 'steer' },
    });
    expect(await chat(who, { type: 'chat.send', text: 'held input', delivery: 'queued' })).toMatchObject({
      status: 'completed', result: { delivery: 'queued' },
    });
    const queued = await driverOnTarget(who);
    expect(queued.queue.queuedMessageIds).toHaveLength(1);
    expect(queued.sent).toHaveLength(sentBefore + 2);
    expect(queued.sent.slice(-2)).toMatchObject([
      { delivery: 'prompt', content: expect.arrayContaining([{ type: 'text', text: 'first input' }]) },
      { delivery: 'steer', content: expect.arrayContaining([{ type: 'text', text: 'steering input' }]) },
    ]);
    expect(await chat(who, { type: 'chat.queue.remove', messageIds: queued.queue.queuedMessageIds })).toMatchObject({
      status: 'completed', result: { removed: queued.queue.queuedMessageIds },
    });
    expect(await chat(who, { type: 'chat.interrupt' })).toMatchObject({ status: 'completed', result: { interrupted: true } });
    const after = await driverOnTarget(who);
    expect(after.queue.queuedMessageIds).toEqual([]);
    expect(after.sent).toHaveLength(sentBefore + 2);
    expect(after.interrupts).toBe(before.interrupts + 1);
    await emitOnTarget(who, { type: 'turn_ended', data: { stopReason: 'end_turn' } });
  });

  it.each(['A', 'B'] as const)('R04 %s: pending permissions and questions use real runtime ownership', async (who) => {
    await emitOnTarget(who, { type: 'turn_started', data: { trigger: 'system' } });
    await emitOnTarget(who, {
      type: 'permission_request', data: { requestId: 'permission', title: 'Run fixture task', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }] },
    });
    expect(await page(who)).toMatchObject({ pendingPermissions: [expect.objectContaining({ data: expect.objectContaining({ requestId: 'permission' }) })] });
    expect(await chat(who, { type: 'chat.permission', requestId: 'permission', optionId: 'allow' })).toMatchObject({
      status: 'completed', result: { answered: true, requestId: 'permission' },
    });
    await emitOnTarget(who, {
      type: 'question', data: { requestId: 'question', questions: [{ id: 'branch', prompt: 'Which branch?', allowFreeText: true }] },
    });
    expect(await page(who)).toMatchObject({ pendingQuestions: [expect.objectContaining({ data: expect.objectContaining({ requestId: 'question' }) })] });
    expect(await chat(who, { type: 'chat.question', requestId: 'question', answers: { branch: 'fixture' } })).toMatchObject({
      status: 'completed', result: { answered: true, requestId: 'question' },
    });
    const actual = await driverOnTarget(who);
    expect(actual.permissions).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: 'permission', optionId: 'allow' })]));
    expect(actual.answers).toEqual(expect.arrayContaining([{ requestId: 'question', answers: { branch: 'fixture' } }]));
    expect(await chat(who, { type: 'chat.permission', requestId: 'foreign-permission', optionId: 'allow' })).toMatchObject({
      status: 'rejected', error: { code: 'pending_request_not_found' },
    });
    await emitOnTarget(who, { type: 'turn_ended', data: { stopReason: 'end_turn' } });
  });

  it.each(['A', 'B'] as const)('R05 %s: model and level changes reach the advertised in-memory provider', async (who) => {
    await emitOnTarget(who, { type: 'session_info', data: { model: 'fixture-old', models: [{ id: 'fixture-new', label: 'New fixture model' }] } });
    expect(await chat(who, { type: 'chat.setModel', model: 'fixture-new' })).toMatchObject({ status: 'completed', result: { changed: true } });
    expect(await chat(who, { type: 'chat.setLevel', level: 'auto_edit' })).toMatchObject({ status: 'completed', result: { changed: true } });
    const actual = await driverOnTarget(who);
    expect(actual.models).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'fixture-new' })]));
    expect(actual.levels).toContain('auto_edit');
    await emitOnTarget(who, { type: 'model_changed', data: { modelId: 'fixture-new' } });
    await emitOnTarget(who, { type: 'mode_changed', data: { level: 'auto_edit' } });
    expect(await page(who)).toMatchObject({ chatControls: expect.objectContaining({ model: 'fixture-new', level: 'auto_edit' }) });
  });

  it.each(['A', 'B'] as const)('R04 %s: a large approval requires its complete reviewed event', async (who) => {
    const content = 'review this complete input\n'.repeat(20_000);
    const seq = await emitOnTarget(who, {
      type: 'permission_request',
      data: { requestId: 'large-permission', title: 'Review complete fixture', rawInput: { content }, options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }] },
    });
    expect(await chat(who, { type: 'chat.permission', requestId: 'large-permission', optionId: 'allow' })).toMatchObject({
      status: 'rejected', error: { code: 'incomplete_representation' },
    });
    const peer = target(who);
    const input = {
      method: 'GET' as const,
      path: `/api/v1/mobile/agents/${encodeURIComponent(peer.agentId)}/chat/events/${seq}?sessionId=${encodeURIComponent(peer.sessionId)}`,
    };
    const reply: WireAnswer = who === 'A' ? await a.wire(input) : await b.call('wire', input);
    expect(reply.status).toBe(200);
    const full: { digest: string; event: { data: { rawInput: { content: string } } } } = JSON.parse(Buffer.from(reply.body, 'base64').toString());
    expect(full.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Buffer.byteLength(full.event.data.rawInput.content)).toBe(Buffer.byteLength(content));
    expect(createHash('sha256').update(full.event.data.rawInput.content).digest('hex')).toBe(createHash('sha256').update(content).digest('hex'));
    expect(await chat(who, { type: 'chat.permission', requestId: 'large-permission', optionId: 'allow', reviewedDigest: full.digest })).toMatchObject({
      status: 'completed', result: { answered: true },
    });
  });

  it.each(['A', 'B'] as const)('R06 %s: sidebar inventory and hook events use the existing subscription', async (who) => {
    const peer = target(who);
    expect((await status(who)).snapshot?.agents[peer.projectId]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: peer.agentId }),
    ]));
    if (who === 'A') await b.call('hook');
    else a.hook();
    await expectSatelliteEvent(who, 'hook:event', {
      agentId: peer.agentId, event: expect.objectContaining({ kind: 'pre_tool', toolName: 'Read', toolInput: { file_path: 'fixture.txt' } }),
    });
  });

  it.each(['A', 'B'] as const)('R07 %s: durable creation, non-worktree status and deletion use their desktop adapters', async (who) => {
    const result = who === 'A' ? await a.durable() : await b.call('durable');
    expect(result).toMatchObject({
      created: { id: expect.any(String), name: 'temporary-member' },
      worktree: { isValid: false, uncommittedFiles: [], unpushedCommits: [] },
      deleted: { ok: true },
    });
  });

  it.each(['A', 'B'] as const)('R08 %s: file adapters reach the production handlers', async (who) => {
    const peer = target(who);
    const tree = who === 'A' ? await a.probe('tree') : await b.call('probe', 'tree');
    expect(tree).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fixture.txt' })]));
    const file = who === 'A' ? await a.probe('file') : await b.call('probe', 'file');
    expect(file).toBe(`file:${peer.alias}:é\n`);
  });

  describe('R08: uncapped UTF-8 reads preserve multibyte chunk boundaries', () => {
    beforeAll(async () => { a.seedLargeText(); await b.call('seedLargeText'); });
    it.each(['A', 'B'] as const)('%s reads complete text above the ordinary response ceiling', async (who) => {
      const result = who === 'A' ? await a.largeText() : await b.call('largeText');
      expect(result).toEqual({
        bytes: LARGE_TEXT_BYTES,
        digest: createHash('sha256').update('é\n'.repeat(LARGE_TEXT_BYTES / 3)).digest('hex'),
      });
    });
  });

  it.each(['A', 'B'] as const)('R13 %s: canvas mutation persists and returns through the existing satellite handler', async (who) => {
    if (who === 'A') a.canvas();
    else await b.call('canvas');
    await expectSatelliteEvent(who, 'canvas:state', {
      projectId: target(who).projectId, state: expect.objectContaining({ canvasId: 'fixture-canvas', name: 'Renamed remotely' }),
    });
    expect((await status(who)).snapshot?.canvasState?.[target(who).projectId]).toMatchObject({
      canvases: expect.arrayContaining([expect.objectContaining({ id: 'fixture-canvas', name: 'Renamed remotely' })]),
    });
  });

  it.each(['A', 'B'] as const)('R10 %s: real PTY buffers, input, resize, sequence stitching and private close', async (who) => {
    const sessionId = `private-shell-${who}`;
    const inspect = (): Promise<ReturnType<InventoryPeer['ptyState']>> => who === 'A' ? b.call('ptyState', sessionId) : Promise.resolve(a.ptyState(sessionId));
    const emit = async (data: string) => { if (who === 'A') await b.call('emitPty', data); else a.emitPty(data); };
    const buffer = (): Promise<Awaited<ReturnType<InventoryPeer['ptyBuffer']>>> => who === 'A' ? a.ptyBuffer(sessionId) : b.call('ptyBuffer', sessionId);
    expect(await send(who, 'pty:spawn-shell', { sessionId, projectId: target(who).projectId })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'pty:spawn-shell:ack', { sessionId, cwd: expect.any(String) });
    expect(await send(who, 'pty:input', { agentId: sessionId, data: 'fixture input\r' })).toEqual({ sent: true });
    expect(await send(who, 'pty:resize', { agentId: sessionId, cols: 91, rows: 27 })).toEqual({ sent: true });
    await vi.waitFor(async () => { expect(await inspect()).toMatchObject({ running: true, writes: ['fixture input\r'], sizes: [[91, 27]] }); });
    await emit('first line\r\n');
    const first = await inspect();
    await expectSatelliteEvent(who, 'pty:data', { agentId: sessionId, data: 'first line\r\n', seq: first.buffer.seq });
    expect(await buffer()).toMatchObject({ data: expect.stringContaining('first line'), seq: first.buffer.seq });
    await emit('after snapshot\r\n');
    const last = await inspect();
    expect(last.buffer.seq).toBe(first.buffer.seq + 'after snapshot\r\n'.length);
    await expectSatelliteEvent(who, 'pty:data', { agentId: sessionId, data: 'after snapshot\r\n', seq: last.buffer.seq });
    const final = await buffer();
    expect(final.seq).toBe(last.buffer.seq);
    expect(final.data.match(/first line/g)).toHaveLength(1);
    expect(final.data.match(/after snapshot/g)).toHaveLength(1);
    const clipboard = sizedPng(65_537);
    expect(await send(who, 'clipboard:image', { agentId: sessionId, base64: clipboard.toString('base64'), mimeType: 'image/jpeg' })).toEqual({ sent: true });
    await vi.waitFor(async () => { expect((await inspect()).writes.some((text) => text.startsWith('\x1b[200~'))).toBe(true); });
    const pasted = who === 'A' ? await b.call('clipboardReceipt') : await a.clipboardReceipt();
    expect(pasted).toEqual({ bytes: clipboard.length, digest: createHash('sha256').update(clipboard).digest('hex') });
    expect(await send(who, 'pty:close', { sessionId })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'pty:close:ack', { sessionId });
    expect(await inspect()).toMatchObject({ running: false, closed: true });
    expect(await send(who, 'pty:close', { sessionId })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'error', { op: 'pty:close', message: 'session_not_found', sessionId });
  });

  it.each(['A', 'B'] as const)('R13 %s: the real theme palette arrives on the existing event path', async (who) => {
    const colors = (await status(who)).snapshot?.theme;
    expect(colors).toBeTruthy();
    if (who === 'A') await b.call('theme');
    else a.theme();
    await expectSatelliteEvent(who, 'theme:changed', colors);
    await expectSatelliteEvent(who, 'theme:changed', { terminalColors: expect.any(Object) });
  });

  it.each(['A', 'B'] as const)('R14/R15 %s: agent calls run the real receiving tool and deliver duplicate messages once', async (who) => {
    const call = (tool: string, args: Record<string, unknown>): ReturnType<InventoryPeer['agentCall']> => who === 'A' ? a.agentCall({ tool, args }) : b.call('agentCall', { tool, args });
    const result = await call('get_status', {});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 'running', running: true, runtime: 'chat' });
    await emitOnTarget(who, { type: 'turn_ended', data: { stopReason: 'end_turn' } });
    const before = (await driverOnTarget(who)).sent.length;
    const args = { message: `agent transport ${who}`, task_id: `parity-${who}` };
    const receipt = await call('send_message', args);
    expect(receipt.isError).not.toBe(true);
    expect(receipt.content[0].text).toContain('Delivered to');
    await vi.waitFor(async () => { expect((await driverOnTarget(who)).sent).toHaveLength(before + 1); });
    expect((await driverOnTarget(who)).sent[before].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining(args.message) }),
    ]));
    expect(await call('send_message', args)).toEqual(receipt);
    expect((await driverOnTarget(who)).sent).toHaveLength(before + 1);
  });

  it.each(['A', 'B'] as const)('R16 %s: connection switches synchronize and the real receiving gate enforces them', async (who) => {
    const set = (disabled: string[]) => who === 'A' ? a.connectionTools(disabled) : b.call('connectionTools', disabled);
    const receiver = (): Promise<ReturnType<InventoryPeer['connections']>> => who === 'A' ? b.call('connections') : Promise.resolve(a.connections());
    await set(['get_status']);
    try {
      await vi.waitFor(async () => { expect((await receiver()).incoming?.disabledTools).toContain('get_status'); });
      const input = { tool: 'get_status', args: {} };
      const refused: Awaited<ReturnType<InventoryPeer['agentCall']>> = who === 'A' ? await a.agentCall(input) : await b.call('agentCall', input);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('turned off');
    } finally { await set([]); }
    await vi.waitFor(async () => { expect((await receiver()).incoming?.disabledTools).toEqual([]); });
  });

  it.each(['A', 'B'] as const)('R22 %s: server-only status uses the production route table', async (who) => {
    const request = { method: 'GET' as const, path: '/api/v1/status' };
    const answer: WireAnswer = who === 'A' ? await a.wire(request) : await b.call('wire', request);
    expect(answer.status).toBe(200);
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString())).toMatchObject({ deviceName: target(who).alias });
  });

  it.each(['A', 'B'] as const)('R17 %s: links, shared Pin and Mark inactive replicate into the real project state', async (who) => {
    const link = (enabled: boolean) => who === 'A' ? a.projectLink(enabled) : b.call('projectLink', enabled);
    await link(true);
    await vi.waitFor(async () => {
      expect((await a.linkedState()).groups).toHaveLength(1);
      expect((await b.call<Awaited<ReturnType<InventoryPeer['linkedState']>>>('linkedState')).groups).toHaveLength(1);
    });
    if (who === 'A') a.projectPin(true); else await b.call('projectPin', true);
    await vi.waitFor(async () => {
      expect((await a.linkedState()).pinned).toBe(true);
      expect((await b.call<Awaited<ReturnType<InventoryPeer['linkedState']>>>('linkedState')).pinned).toBe(true);
    });
    if (who === 'A') a.projectPin(false); else await b.call('projectPin', false);
    await vi.waitFor(async () => {
      expect((await a.linkedState()).pinned).toBe(false);
      expect((await b.call<Awaited<ReturnType<InventoryPeer['linkedState']>>>('linkedState')).pinned).toBe(false);
    });
    const inactive = who === 'A';
    if (who === 'A') a.projectInactive(inactive); else await b.call('projectInactive', inactive);
    await vi.waitFor(async () => {
      expect((await a.linkedState()).inactive).toBe(inactive);
      expect((await b.call<Awaited<ReturnType<InventoryPeer['linkedState']>>>('linkedState')).inactive).toBe(inactive);
    });
    await link(false);
    await vi.waitFor(async () => {
      expect((await a.linkedState()).groups).toHaveLength(0);
      expect((await b.call<Awaited<ReturnType<InventoryPeer['linkedState']>>>('linkedState')).groups).toHaveLength(0);
    });
  });

  it.each(['A', 'B'] as const)('R18/R19 %s: host notices trigger reverse pulls, replica writes reach the host and rosters come from it', async (who) => {
    const id = who === 'A' ? await b.call<string>('createNetworkGroup') : await a.createNetworkGroup();
    const replica = (): ReturnType<InventoryPeer['networkGroup']> => who === 'A' ? a.networkGroup(id) : b.call('networkGroup', id);
    const host = (): ReturnType<InventoryPeer['networkGroup']> => who === 'A' ? b.call('networkGroup', id) : a.networkGroup(id);
    await vi.waitFor(async () => { expect((await replica())?.group.network).toMatchObject({ role: 'replica' }); });
    const input = { id, description: `host changed for ${who}` };
    if (who === 'A') await b.call('networkUpdate', input); else await a.networkUpdate(input);
    await vi.waitFor(async () => { expect((await replica())?.group.description).toBe(input.description); });
    const post = { id, body: `replica write from ${who}` };
    const message = who === 'A' ? await a.networkPost(post) : await b.call<Awaited<ReturnType<InventoryPeer['networkPost']>>>('networkPost', post);
    expect(message.pending).toBeUndefined();
    expect(message.body).toBe(post.body);
    expect((await host())?.messages.filter(({ id }) => id === message.id)).toHaveLength(1);
    expect((await replica())?.messages.filter(({ id }) => id === message.id)).toHaveLength(1);
    const roster = who === 'A' ? await a.networkRoster(id) : await b.call<Awaited<ReturnType<InventoryPeer['networkRoster']>>>('networkRoster', id);
    expect(roster).toMatchObject({ groupProjectId: id, status: 'available', source: 'live', members: [expect.objectContaining({ agentId: target(who).agentId, machine: target(who).fingerprint })] });
  });

  describe('R11: all five Git reads and ten writes use the actual Git service', () => {
    let aGit: Awaited<ReturnType<InventoryPeer['seedGitProject']>>;
    let bGit: typeof aGit;
    beforeAll(async () => { aGit = await a.seedGitProject(); bGit = await b.call('seedGitProject'); });

    it.each(['A', 'B'] as const)('%s performs staged reads, commits, checkout, stash, push and pull', async (who) => {
      const repo = who === 'A' ? bGit : aGit;
      const request = (params: GitOperationParams) => who === 'A' ? a.gitOperation({ projectId: repo.projectId, params }) : b.call('gitOperation', { projectId: repo.projectId, params });
      const inspect = (): Promise<ReturnType<InventoryPeer['gitState']>> => who === 'A' ? b.call('gitState') : Promise.resolve(a.gitState());
      const edit = async (text: string) => { if (who === 'A') await b.call('editGit', text); else a.editGit(text); };

      expect(await request({ operation: 'info' })).toMatchObject({ hasGit: true, branch: 'main', remote: 'origin' });
      expect(await request({ operation: 'log', limit: 1, offset: 0 })).toMatchObject([{ hash: repo.baseline, subject: 'baseline' }]);
      await edit('changed\n');
      expect(await request({ operation: 'diff', file: 'tracked.txt' })).toEqual({ original: 'initial\n', modified: 'changed\n' });
      expect(await request({ operation: 'stage', path: 'tracked.txt' })).toMatchObject({ ok: true });
      expect((await inspect()).staged).toEqual(['tracked.txt']);
      expect(await request({ operation: 'diff', file: 'tracked.txt', staged: true })).toEqual({ original: 'initial\n', modified: 'changed\n' });
      expect(await request({ operation: 'unstage', path: 'tracked.txt' })).toMatchObject({ ok: true });
      expect((await inspect()).staged).toEqual([]);
      expect(await request({ operation: 'stage-all' })).toMatchObject({ ok: true });
      expect((await inspect()).staged).toEqual(['extra.txt', 'tracked.txt']);
      expect(await request({ operation: 'unstage-all' })).toMatchObject({ ok: true });
      expect((await inspect()).staged).toEqual([]);
      expect(await request({ operation: 'stage-all' })).toMatchObject({ ok: true });
      expect(await request({ operation: 'commit', message: 'remote commit' })).toMatchObject({ ok: true });
      const committed = await inspect();
      expect(committed.head).not.toBe(repo.baseline);
      expect(await request({ operation: 'log', limit: 1 })).toMatchObject([{ hash: committed.head, subject: 'remote commit' }]);
      expect(await request({ operation: 'show-commit', hash: committed.head })).toMatchObject({
        hash: committed.head, files: expect.arrayContaining([{ status: 'A', path: 'extra.txt' }, { status: 'M', path: 'tracked.txt' }]),
      });
      expect(await request({ operation: 'commit-diff', hash: committed.head, file: 'tracked.txt' })).toEqual({ original: 'initial\n', modified: 'changed\n' });
      expect(await request({ operation: 'checkout', branch: 'fixture-side' })).toMatchObject({ ok: true });
      expect(await inspect()).toMatchObject({ branch: 'fixture-side', content: 'initial\n' });
      expect(await request({ operation: 'checkout', branch: 'main' })).toMatchObject({ ok: true });
      await edit('stashed\n');
      expect(await request({ operation: 'stash' })).toMatchObject({ ok: true });
      expect(await inspect()).toMatchObject({ content: 'changed\n', stashes: 1 });
      expect(await request({ operation: 'stash-pop' })).toMatchObject({ ok: true });
      expect(await inspect()).toMatchObject({ content: 'stashed\n', stashes: 0 });
      await edit('changed\n');
      expect(await request({ operation: 'push' })).toMatchObject({ ok: true });
      expect((await inspect()).remoteHead).toBe(committed.head);
      const next = who === 'A' ? await b.call('advanceGitRemote') : a.advanceGitRemote();
      expect(next).not.toBe(committed.head);
      expect(await request({ operation: 'pull' })).toMatchObject({ ok: true });
      expect(await inspect()).toMatchObject({ head: next, remoteHead: next, content: 'external\n' });
    }, 20_000);

    it.each(['A', 'B'] as const)('R07 %s creates, inspects and removes a real worktree', async (who) => {
      const input = { projectId: (who === 'A' ? bGit : aGit).projectId, useWorktree: true };
      const result = who === 'A' ? await a.durable(input) : await b.call('durable', input);
      expect(result).toMatchObject({
        created: { id: expect.any(String), worktreePath: expect.any(String) },
        worktree: { isValid: true, uncommittedFiles: [], unpushedCommits: [] },
        deleted: { ok: true },
      });
    }, 20_000);
  });

  describe('R11: uncapped working-tree Git diff', () => {
    let direct: Awaited<ReturnType<InventoryPeer['gitDiff']>>;
    beforeAll(async () => { a.seedLargeDiff(); await b.call('seedLargeDiff'); });

    const expected = () => ({
      originalBytes: 0, modifiedBytes: LARGE_DIFF_BYTES,
      digest: createHash('sha256').update(Buffer.alloc(LARGE_DIFF_BYTES, 'x')).digest('hex'),
    });

    it('A to B: the direct desktop adapter returns the complete large diff through F', async () => {
      expect((await status('A')).direct).toBe(true);
      direct = await a.gitDiff();
      expect(direct).toEqual(expected());
    });

    it('B to A: the reverse-only desktop adapter returns that same complete diff', async () => {
      expect((await status('B')).direct).toBe(false);
      expect((await status('B')).readiness?.acceptedHere).toBe(true);
      expect(direct).toBeDefined();
      expect(await b.call('gitDiff')).toEqual(direct);
    });
  });

  describe('F2/F3: uncapped bulletin and native transcript parity', () => {
    let aGroup: string;
    let bGroup: string;
    const directBulletins = new Map<string, Awaited<ReturnType<InventoryPeer['bulletin']>>>();
    let directTranscript: Awaited<ReturnType<InventoryPeer['transcript']>>;

    beforeAll(async () => {
      expect(await a.seedLargeTranscript()).toEqual({ rawEvents: NATIVE_TRANSCRIPT_EVENTS });
      expect(await b.call('seedLargeTranscript')).toEqual({ rawEvents: NATIVE_TRANSCRIPT_EVENTS });
      aGroup = await a.seedLargeBoard();
      bGroup = await b.call('seedLargeBoard');
    });

    beforeEach(async () => {
      // An oversized bulk offer retires the link, so each probe starts with an explicit retry.
      a.retryControl();
      await vi.waitFor(async () => {
        expect((await status('A')).readiness?.openedHere).toBe(true);
        expect((await status('B')).readiness?.acceptedHere).toBe(true);
      }, { timeout: 10_000, interval: 25 });
    }, 12_000);

    function assertBulletin(result: Awaited<ReturnType<InventoryPeer['bulletin']>>) {
      expect(result).toEqual({
        count: BULLETIN_MESSAGES, bytes: BULLETIN_MESSAGES * BULLETIN_MESSAGE_BYTES,
        digest: createHash('sha256').update(Buffer.alloc(BULLETIN_MESSAGES * BULLETIN_MESSAGE_BYTES, 'b')).digest('hex'),
      });
    }

    for (const kind of ['messages', 'topic'] as const) {
      it(`F2 ${kind}: direct reads a board containing 100 legitimate 100 KiB posts`, async () => {
        const result = await a.bulletin({ groupId: bGroup, kind });
        assertBulletin(result);
        directBulletins.set(kind, result);
      });

      it(`F2 ${kind}: reverse-only reads the same complete board`, async () => {
        expect((await status('B')).direct).toBe(false);
        const result = await b.call<Awaited<ReturnType<InventoryPeer['bulletin']>>>('bulletin', { groupId: aGroup, kind });
        assertBulletin(result);
        expect(result).toEqual(directBulletins.get(kind));
      });
    }

    const expectedTranscript = () => ({
      count: NATIVE_TRANSCRIPT_EVENTS, totalEvents: NATIVE_TRANSCRIPT_EVENTS,
      bytes: NATIVE_TRANSCRIPT_EVENTS * NATIVE_TRANSCRIPT_EVENT_BYTES,
      digest: createHash('sha256').update(Buffer.alloc(NATIVE_TRANSCRIPT_EVENTS * NATIVE_TRANSCRIPT_EVENT_BYTES, 't')).digest('hex'),
    });

    it('F3: the production native session reader and direct adapter return the complete page', async () => {
      directTranscript = await a.transcript();
      expect(directTranscript).toEqual(expectedTranscript());
    });

    it('F3: reverse-only returns that same legitimate native transcript page', async () => {
      expect((await status('B')).direct).toBe(false);
      expect(await b.call('transcript')).toEqual(directTranscript);
    });

    it.each(['A', 'B'] as const)('R12 %s lists native sessions and summarizes actual provider JSONL', async (who) => {
      const sessions = who === 'A' ? await a.nativeSessions() : await b.call('nativeSessions');
      expect(sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: NATIVE_SESSION_ID }),
        expect.objectContaining({ sessionId: SMALL_SESSION_ID }),
      ]));
      const summary = who === 'A' ? await a.nativeSummary() : await b.call('nativeSummary');
      expect(summary).toMatchObject({
        summary: 'Fixture summary complete.', orchestrator: 'claude-code', model: 'fixture-model',
        eventCount: 2, totalDurationMs: 1000, totalInputTokens: 7, totalOutputTokens: 11,
      });
    });
  });

  describe('R20/R21: real handoff agreements and receiver-driven frozen artifact reads', () => {
    beforeAll(async () => { await a.prepareHandoffs(); await b.call('prepareHandoffs'); });
    it.each(['A', 'B'] as const)('%s offers, the receiver accepts and pulls the complete bundle with offset/digest checks', async (who) => {
      const offer = who === 'A' ? await a.handoffOffer() : await b.call<Awaited<ReturnType<InventoryPeer['handoffOffer']>>>('handoffOffer');
      expect(offer.state).toBe('offered');
      const incoming = who === 'A' ? await b.call('handoffRecord', offer.id) : a.handoffRecord(offer.id);
      expect(incoming).toMatchObject({ id: offer.id, state: 'offered', manifest: offer.manifest });
      await expect(who === 'A' ? b.call('handoffPull', offer.id) : a.handoffPull(offer.id)).rejects.toThrow();
      const accepted = who === 'A' ? await b.call('handoffAccept', offer.id) : await a.handoffAccept(offer.id);
      expect(accepted).toMatchObject({ id: offer.id, state: 'accepted' });
      const pulled = who === 'A' ? await b.call<Awaited<ReturnType<InventoryPeer['handoffPull']>>>('handoffPull', offer.id) : await a.handoffPull(offer.id);
      expect(pulled.chunks).toBeGreaterThanOrEqual(3);
      expect(pulled.bytes).toBe(pulled.expected.size);
      expect(pulled.digest).toBe(pulled.expected.sha256);
      const cancelled = who === 'A' ? await a.handoffCancel(offer.id) : await b.call('handoffCancel', offer.id);
      expect(cancelled).toMatchObject({ id: offer.id, state: 'cancelled' });
      await expect(who === 'A' ? b.call('handoffPull', offer.id) : a.handoffPull(offer.id)).rejects.toThrow();
    });
  });

  it.each(['A', 'B'] as const)('R18/R19 %s: controller group-project REST adapters preserve persisted board and roles', async (who) => {
      const groupId = who === 'A' ? await b.call<string>('createNetworkGroup') : await a.createNetworkGroup();
      const call = (operation: Parameters<InventoryPeer['controllerGroup']>[0]['operation'], extra = {}): Promise<unknown> => who === 'A'
        ? a.controllerGroup({ groupId, operation, ...extra })
        : b.call('controllerGroup', { groupId, operation, ...extra });
      expect(await call('get')).toMatchObject({ id: groupId });
      expect(await call('update')).toMatchObject({ id: groupId, description: 'Updated through the controller adapter' });
      expect(await call('get')).toMatchObject({ description: 'Updated through the controller adapter' });
      const post = await call('post') as BulletinMessage;
      expect(post).toMatchObject({ sender: 'Controller', topic: 'controller-fixture', body: 'Controller fixture post' });
      for (const operation of ['all', 'topic'] as const) expect(await call(operation)).toEqual(expect.arrayContaining([expect.objectContaining({ id: post.id, body: post.body })]));
      expect(await call('digest')).toEqual(expect.arrayContaining([expect.objectContaining({ topic: 'controller-fixture' })]));
      expect(await call('protection', { enabled: true })).toEqual({ ok: true });
      expect(await call('protection', { enabled: false })).toEqual({ ok: true });
      expect(await call('set-role', { mode: 'allow' })).toMatchObject({ groupProjectId: groupId });
      expect(await call('roles')).toMatchObject({ groupProjectId: groupId });
      expect(await call('set-role', { mode: 'off' })).toMatchObject({ groupProjectId: groupId });
      expect(await call('polling', { enabled: false })).toBeTruthy();
      expect(await call('tap')).toBeTruthy();
      expect(await call('inject')).toBeTruthy();
      expect(await call('delete-message', { messageId: post.id })).toBeTruthy();
      expect(await call('topic')).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: post.id })]));
      await call('post');
      expect(await call('delete-topic')).toBeTruthy();
      expect(await call('topic')).toEqual([]);
  });

  it.each(['A', 'B'] as const)('R08/R22 %s: actual rich previews, links and server-only read surfaces retain their disposition', async (who) => {
    const peer = target(who);
    for (const [url, expected] of [
      ['/api/v1/identity', { fingerprint: peer.fingerprint }],
      ['/api/v1/status', { version: '1' }],
      ['/api/v1/mobile/agents/state', { version: 1 }],
      [`/api/v1/mobile/projects/${peer.projectId}/create-options`, { version: 1 }],
      [`/api/v1/mobile/agents/${peer.agentId}/settings`, { version: 1 }],
      ['/api/v1/mobile/helper-routing', { version: 1 }],
      ['/api/v1/mobile/network', { version: 1 }],
      [`/api/v1/mobile/agents/${peer.agentId}/content?path=fixture.txt`, { kind: 'text', text: `file:${peer.alias}:é\n` }],
      [`/api/v1/mobile/agents/${peer.agentId}/link?href=fixture.txt`, { version: 1, type: 'file', name: 'fixture.txt', kind: 'text' }],
    ] as const) {
      const answer = await wire(who, { method: 'GET', path: url });
      expect(answer.status, url).toBe(200);
      expect(json(answer), url).toMatchObject(expected);
    }
    for (const url of ['/api/v1/projects', `/api/v1/projects/${peer.projectId}/agents`, '/api/v1/group-projects']) {
      const answer = await wire(who, { method: 'GET', path: url });
      expect(answer.status, url).toBe(200);
      expect(Array.isArray(json(answer)), url).toBe(true);
    }
    for (const [url, error] of [
      ['/api/v1/mobile/dispatcher/settings', 'dispatcher_off'],
      [`/api/v1/projects/${peer.projectId}/files/read?path=../../outside`, 'path_traversal'],
    ] as const) {
      const answer = await wire(who, { method: 'GET', path: url });
      expect(answer.status, url).toBe(error === 'dispatcher_off' ? 404 : 403);
      expect(json(answer)).toMatchObject({ error });
    }
    for (const [index, command] of [
      { type: 'helper.approve', requestId: 'missing-helper-request' },
      { type: 'helper.decline', requestId: 'missing-helper-request' },
      { type: 'grant.answer', requestId: 'missing-grant-request', answer: 'decline' },
      { type: 'app.update.cancel', requestId: 'missing-update-request' },
    ].entries()) {
      const answer = await mobile(who, command, `surface-${who}-${index}`);
      expect(json(answer), command.type).toMatchObject({ status: 'rejected' });
    }
  });

  it.each(['A', 'B'] as const)('R05/R15/R22 %s: actual settings, grant answers and helper decisions keep receipts and store effects', async (who) => {
    const opened = who === 'A' ? await b.call<ReturnType<InventoryPeer['openRequests']>>('openRequests') : a.openRequests();
    const inspect = (): Promise<Awaited<ReturnType<InventoryPeer['requestsState']>>> => who === 'A' ? b.call('requestsState') : a.requestsState();
    await expectSatelliteEvent(who, 'grant_request:opened', { agentId: target(who).agentId, requestId: opened.grantId });
    const input = { requestId: opened.grantId, answer: 'allow_lasting' };
    const answer = who === 'A' ? await a.answerGrant(input) : await b.call('answerGrant', input);
    expect(answer).toMatchObject({ status: 'completed', result: { requestId: opened.grantId, answer: 'allow_lasting' } });
    expect((await inspect()).grants).toEqual([]);
    expect((await inspect()).effective).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'settings.app.write', mode: 'allow', target: { kind: 'app' } })]));
    await expectSatelliteEvent(who, 'grant_request:resolved', { requestIds: [opened.grantId], outcome: 'answered' });
    const decline = await mobile(who, { type: 'helper.decline', requestId: opened.helperId }, `decline-helper-${who}`);
    expect(json(decline)).toMatchObject({ status: 'completed' });
    expect((await inspect()).helpers).toEqual([]);
    const stale = await mobile(who, { type: 'helper.approve', requestId: opened.helperId }, `used-helper-${who}`);
    expect(json(stale)).toMatchObject({ status: 'rejected', error: { code: 'helper_request_not_found' } });
    const change = { type: 'agent.update', agentId: target(who).agentId, idleSleep: 30 };
    const updated = await mobile(who, change, `settings-${who}`);
    expect(json(updated)).toMatchObject({ status: 'completed' });
    expect((await inspect()).idleSleep).toBe(30);
    expect(json(await mobile(who, change, `settings-${who}`))).toEqual(json(updated));
    const conflict = await mobile(who, { ...change, idleSleep: 15 }, `settings-${who}`);
    expect(conflict.status).toBe(409);
    expect(json(conflict)).toMatchObject({ status: 'rejected', error: { code: 'command_conflict' } });
    expect((await inspect()).idleSleep).toBe(30);
    const routing = json(await wire(who, { method: 'GET', path: '/api/v1/mobile/helper-routing' })) as { revision: string };
    const routed = await mobile(who, { type: 'helperRouting.update', revision: routing.revision, scope: 'app', auto: false }, `routing-${who}`);
    expect(json(routed)).toMatchObject({ status: 'completed' });
    expect(json(await wire(who, { method: 'GET', path: '/api/v1/mobile/helper-routing' }))).toMatchObject({ auto: { scopes: { app: { value: false } } } });
  });

  describe.each(['A', 'B'] as const)('R08/B %s: actual rich-content binary limits and digests', (who) => {
    it.each([65_535, 65_536, 65_537, MOBILE_CONTENT_MAX_BYTES - 1, MOBILE_CONTENT_MAX_BYTES, MOBILE_CONTENT_MAX_BYTES + 1])('preserves or explicitly refuses %i bytes at the content cap', async (size) => {
      const expected = who === 'A' ? await b.call('seedContent', size) : a.seedContent(size);
      const answer = await wire(who, { method: 'GET', path: `/api/v1/mobile/agents/${target(who).agentId}/content?path=preview.png` });
      expect(answer.status).toBe(200);
      const content = json(answer);
      expect(content).toMatchObject({ kind: 'image', size, mimeType: 'image/png' });
      if (size > MOBILE_CONTENT_MAX_BYTES) {
        expect(content).toMatchObject({ tooLarge: true });
        expect(content).not.toHaveProperty('base64');
      } else {
        if (!content || typeof content !== 'object' || !('base64' in content) || typeof content.base64 !== 'string') throw new Error('The preview returned no binary data');
        const bytes = Buffer.from(content.base64, 'base64');
        expect({ bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }).toEqual(expected);
      }
      expect(await page(who)).toMatchObject({ agentId: target(who).agentId });
    });
  });

  describe.each(['A', 'B'] as const)('R09/B %s: uploads DEFERRED: blocked by #3715 (strict check on cold durable cache), direct and reverse', (who) => {
    let imageTarget: Awaited<ReturnType<InventoryPeer['prepareImages']>>;
    const upload = (size: number): Promise<WireAnswer> => who === 'A' ? a.imageUpload({ size, ...imageTarget }) : b.call('imageUpload', { size, ...imageTarget });
    const state = (): ReturnType<InventoryPeer['imageState']> => who === 'A' ? b.call('imageState') : a.imageState();
    beforeAll(async () => {
      imageTarget = who === 'A' ? await b.call('prepareImages') : await a.prepareImages();
      expect(await state()).toMatchObject({ configUnchanged: true });
    });
    beforeEach(async () => { expect(await state()).toMatchObject({ configUnchanged: true }); });
    afterEach(async () => { expect(await state()).toMatchObject({ configUnchanged: true }); });
    it.each([0, 1])('rejects invalid %i-byte images with the existing HTTP status', async (size) => {
      const answer = await upload(size);
      expect(answer.status).toBe(size === 0 ? 400 : 415);
      expect(JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'))).toMatchObject({ version: 1, error: size === 0 ? 'empty_body' : 'unsupported_image' });
    });
    it.fails.each([64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1, CHAT_IMAGE_MAX_BYTES - 1, CHAT_IMAGE_MAX_BYTES])('#3715: preserves all %i bytes through the real attachment and chat paths', async (size) => {
      const answer = await upload(size);
      expect(answer.status, JSON.stringify({ body: Buffer.from(answer.body, 'base64').toString('utf8'), ...await state() })).toBe(200);
      const receipt: unknown = JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'));
      expect(receipt).toMatchObject({ version: 1, bytes: size, mimeType: 'image/png', width: 1, height: 1 });
      if (!receipt || typeof receipt !== 'object' || !('attachmentId' in receipt) || typeof receipt.attachmentId !== 'string') throw new Error('The upload returned no attachment id');
      expect(await chat(who, { type: 'chat.send', ...imageTarget, text: 'Image fixture', attachmentIds: [receipt.attachmentId], delivery: 'steer' })).toMatchObject({ status: 'completed' });
      const received = who === 'A' ? await b.call('receivedImage') : await a.receivedImage();
      expect(received).toEqual({ bytes: size, digest: createHash('sha256').update(sizedPng(size)).digest('hex'), mimeType: 'image/png' });
    });
    it('refuses one byte over the image cap without retiring the link or executing a send', async () => {
      const before = (await state()).sent;
      const answer = await upload(CHAT_IMAGE_MAX_BYTES + 1);
      expect(answer.status).toBe(413);
      expect(JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'))).toMatchObject({ version: 1, error: 'too_large' });
      expect((await state()).sent).toBe(before);
      expect(await page(who)).toMatchObject({ agentId: target(who).agentId });
    });
  });

  it.each(['A', 'B'] as const)('R07 %s: actual agent lifecycle wakes, stops, reorders and spawns with only a fake native process', async (who) => {
    const id = who === 'A' ? await b.call<string>('prepareLifecycle') : await a.prepareLifecycle();
    const inspect = (agentId = id): ReturnType<InventoryPeer['lifecycleState']> => who === 'A' ? b.call('lifecycleState', agentId) : a.lifecycleState(agentId);
    expect(await send(who, 'agent:wake', { agentId: id })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'agent:wake:ack', { agentId: id, status: 'starting' });
    expect(await inspect()).toMatchObject({ running: true, runtime: 'pty' });
    expect(await send(who, 'agent:reorder', { projectId: target(who).projectId, orderedIds: [id, target(who).agentId] })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'agent:reorder:ack', { projectId: target(who).projectId });
    expect((await inspect()).order.slice(0, 2)).toEqual([id, target(who).agentId]);
    expect(await send(who, 'agent:kill', { agentId: id })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'agent:kill:ack', { agentId: id });
    expect((await inspect()).running).toBe(false);
    expect(await send(who, 'agent:wake', { agentId: id, resume: true })).toEqual({ sent: true });
    await vi.waitFor(async () => { expect((await inspect()).running).toBe(true); });
    expect(await send(who, 'agent:kill', { agentId: id })).toEqual({ sent: true });
    await vi.waitFor(async () => { expect((await inspect()).running).toBe(false); });
    const previous = (await inspect()).runningIds;
    expect(await send(who, 'agent:spawn', { projectId: target(who).projectId, prompt: 'In-memory lifecycle fixture', orchestrator: 'claude-code' })).toEqual({ sent: true });
    await vi.waitFor(async () => { expect((await inspect()).runningIds.filter((running) => !previous.includes(running))).toHaveLength(1); });
    const quick = (await inspect()).runningIds.find((running) => !previous.includes(running));
    if (!quick) throw new Error('The quick agent was not created');
    await expectSatelliteEvent(who, 'agent:spawn:ack', { id: quick });
    expect(await send(who, 'agent:kill', { agentId: quick })).toEqual({ sent: true });
    await expectSatelliteEvent(who, 'agent:kill:ack', { agentId: quick });
    expect((await inspect(quick)).running).toBe(false);
    if (who === 'A') await a.deleteRemoteAgent(id); else await b.call('deleteRemoteAgent', id);
    expect((await inspect()).order).not.toContain(id);
  });

  describe.each(['A', 'B'] as const)('R09 %s: partial, blocked by #3715 for post-edit config state', (who) => {
    const upload = (): Promise<WireAnswer> => who === 'A' ? a.imageUpload(65_535) : b.call('imageUpload', 65_535);
    beforeAll(async () => {
      if (who === 'A') await b.call('initializeProject'); else await a.initializeProject();
      expect((await upload()).status).toBe(200);
      const config = who === 'A' ? await b.call('externalConfigEdit') : await a.externalConfigEdit();
      expect(config).toEqual({ cachedBefore: true, unchanged: true, registered: true, running: true });
    });
    it.fails('#3715: a config edit must not unregister a running upload target', async () => {
      const answer = await upload();
      const { registered, running, cached } = await driverOnTarget(who);
      expect(answer.status, JSON.stringify({ body: Buffer.from(answer.body, 'base64').toString('utf8'), registered, running, cached })).toBe(200);
    });
  });

  it.each(['A', 'B'] as const)('R09/B %s: clipboard preserves binary digests at chunk and base64 cap boundaries and refuses cap+1', async (who) => {
    const sessionId = `clipboard-boundaries-${who}`;
    const inspect = (): Promise<ReturnType<InventoryPeer['ptyState']>> => who === 'A' ? b.call('ptyState', sessionId) : Promise.resolve(a.ptyState(sessionId));
    await send(who, 'pty:spawn-shell', { sessionId, projectId: target(who).projectId });
    await expectSatelliteEvent(who, 'pty:spawn-shell:ack', { sessionId });
    try {
      for (const size of [65_535, 65_536, 65_537, CLIPBOARD_IMAGE_MAX_BASE64 / 4 * 3 - 1, CLIPBOARD_IMAGE_MAX_BASE64 / 4 * 3]) {
        const bytes = sizedPng(size);
        const base64 = bytes.toString('base64').replace(/=+$/, '');
        if (size > 65_537) expect(base64.length).toBe(size % 3 === 0 ? CLIPBOARD_IMAGE_MAX_BASE64 : CLIPBOARD_IMAGE_MAX_BASE64 - 1);
        const before = (await inspect()).writes.length;
        expect(await send(who, 'clipboard:image', { agentId: sessionId, base64, mimeType: 'image/jpeg' })).toEqual({ sent: true });
        await vi.waitFor(async () => { expect((await inspect()).writes).toHaveLength(before + 1); });
        const received = who === 'A' ? await b.call('clipboardReceipt') : await a.clipboardReceipt();
        expect(received).toEqual({ bytes: size, digest: createHash('sha256').update(bytes).digest('hex') });
      }
      const before = (await inspect()).writes.length;
      await send(who, 'clipboard:image', { agentId: sessionId, base64: 'a'.repeat(CLIPBOARD_IMAGE_MAX_BASE64 + 1), mimeType: 'image/png' });
      await expectSatelliteEvent(who, 'error', { message: 'clipboard:image data exceeds 10MB limit' });
      expect((await inspect()).writes).toHaveLength(before);
      expect(await page(who)).toMatchObject({ agentId: target(who).agentId });
    } finally {
      await send(who, 'pty:close', { sessionId });
      await expectSatelliteEvent(who, 'pty:close:ack', { sessionId });
    }
  }, 15_000);

  it.each(['A', 'B'] as const)('B/fault %s: a dropped in-flight write stays indeterminate without alternate execution and explicitly replays once after reconnect', async (who) => {
    await emitOnTarget(who, { type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await page(who);
    const before = (await driverOnTarget(who)).sent.length;
    const sessionId = `lost-link-${who}`;
    await send(who, 'pty:spawn-shell', { sessionId, projectId: target(who).projectId });
    await expectSatelliteEvent(who, 'pty:spawn-shell:ack', { sessionId });
    if (who === 'A') await b.call('holdProviderSend'); else a.holdProviderSend();
    const command = { type: 'chat.send', text: `execute once despite a lost reply ${who}`, delivery: 'prompt' };
    const commandId = `fault-write-${who}`;
    const pending = who === 'A' ? a.chatOutcome({ command, commandId }) : b.call('chatOutcome', { command, commandId });
    let resume: (() => void) | undefined;
    try {
      await vi.waitFor(async () => { expect((await driverOnTarget(who)).sent).toHaveLength(before + 1); });
      resume = forward.pause(who === 'A' ? 'B-to-A' : 'A-to-B');
      if (who === 'A') await b.call('releaseProviderSend'); else await a.releaseProviderSend();
      forward.cut();
    } finally {
      resume?.();
      if (who === 'A') await b.call('releaseProviderSend'); else await a.releaseProviderSend();
    }
    const outcome = await pending;
    await vi.waitFor(async () => {
      expect((await status('A')).readiness.openedHere).toBe(true);
      expect((await status('B')).readiness.acceptedHere).toBe(true);
      expect((await status('A')).connected).toBe(true);
      expect((await status('B')).connected).toBe(true);
    }, { timeout: 15_000 });
    expect(outcome).toEqual(who === 'A'
      ? { code: 'ECONNRESET', indeterminate: undefined }
      : { code: 'transport_unavailable', indeterminate: true });
    const shell = who === 'A' ? await b.call('ptyState', sessionId) : a.ptyState(sessionId);
    expect(shell).toMatchObject({ running: false, closed: true });
    expect((await driverOnTarget(who)).sent).toHaveLength(before + 1);
    expect(await chat(who, command, commandId)).toMatchObject({ status: 'completed' });
    expect((await driverOnTarget(who)).sent).toHaveLength(before + 1);
    expect(await page(who)).toMatchObject({ agentId: target(who).agentId });
  }, 25_000);

  it.each(['A', 'B'] as const)('B/cancel %s: cancelling an executing write retains uncertainty, one target effect and an explicit same-id receipt', async (who) => {
    await emitOnTarget(who, { type: 'turn_ended', data: { stopReason: 'end_turn' } });
    const before = (await driverOnTarget(who)).sent.length;
    if (who === 'A') await b.call('holdProviderSend'); else a.holdProviderSend();
    const input = { commandId: `cancelled-write-${who}`, text: `cancel after execution ${who}` };
    const pending = who === 'A' ? a.cancellableWrite(input) : b.call('cancellableWrite', input);
    let outcome: unknown;
    try {
      await vi.waitFor(async () => { expect((await driverOnTarget(who)).sent).toHaveLength(before + 1); });
      if (who === 'A') a.cancelWrite(); else await b.call('cancelWrite');
      outcome = await pending;
    } finally {
      if (who === 'A') await b.call('releaseProviderSend'); else await a.releaseProviderSend();
    }
    expect(outcome).toEqual(who === 'A'
      ? { code: 'ABORT_ERR', indeterminate: undefined }
      : { code: 'cancelled', indeterminate: true });
    expect(await chat(who, { type: 'chat.send', text: input.text, delivery: 'prompt' }, input.commandId)).toMatchObject({ status: 'completed' });
    expect((await driverOnTarget(who)).sent).toHaveLength(before + 1);
    expect(await page(who)).toMatchObject({ agentId: target(who).agentId });
  });

  it.each(['A', 'B'] as const)('B/pressure %s: a sustained 2 MiB terminal flood cannot starve approval, chat or agent-call requests', async (who) => {
    await emitOnTarget(who, { type: 'turn_ended', data: { stopReason: 'end_turn' } });
    await emitOnTarget(who, {
      type: 'permission_request', data: { requestId: `pressure-${who}`, title: 'Pressure fixture', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow once' }] },
    });
    const sessionId = `flood-${who}`;
    await send(who, 'pty:spawn-shell', { sessionId, projectId: target(who).projectId });
    await expectSatelliteEvent(who, 'pty:spawn-shell:ack', { sessionId });
    const initial = who === 'A' ? await b.call<ReturnType<InventoryPeer['ptyState']>>('ptyState', sessionId) : a.ptyState(sessionId);
    const flood = who === 'A' ? b.call('floodPty', { chunks: 512, bytes: 4096 }) : a.floodPty({ chunks: 512, bytes: 4096 });
    const timed = async <T>(run: Promise<T>) => {
      const start = performance.now();
      const result = await run;
      return { result, ms: performance.now() - start };
    };
    const [message, approval, call] = await Promise.all([
      timed(chat(who, { type: 'chat.send', text: `pressure input ${who}`, delivery: 'prompt' })),
      timed(chat(who, { type: 'chat.permission', requestId: `pressure-${who}`, optionId: 'allow' })),
      timed(who === 'A' ? a.agentCall({ tool: 'get_status', args: {} }) : b.call<Awaited<ReturnType<InventoryPeer['agentCall']>>>('agentCall', { tool: 'get_status', args: {} })),
    ]);
    expect(message.result).toMatchObject({ status: 'completed' });
    expect(approval.result).toMatchObject({ status: 'completed', result: { answered: true } });
    expect(call.result.isError).not.toBe(true);
    expect(JSON.parse(call.result.content[0].text)).toMatchObject({ runtime: 'chat', running: true });
    for (const request of [message, approval, call]) expect(request.ms).toBeLessThan(2000);
    await flood;
    const shell = who === 'A' ? await b.call<ReturnType<InventoryPeer['ptyState']>>('ptyState', sessionId) : a.ptyState(sessionId);
    expect(shell.buffer.seq - initial.buffer.seq).toBe(512 * 4096);
    await send(who, 'pty:close', { sessionId });
    await expectSatelliteEvent(who, 'pty:close:ack', { sessionId });
    console.info('P8 terminal-pressure request milliseconds', who, { chat: message.ms, approval: approval.ms, agentCall: call.ms });
  });

  it('B/revocation: losing accepted authority stops the reverse consumer and its private shell independently of #3711', async () => {
    const sessionId = 'revoke-B';
    await send('B', 'pty:spawn-shell', { sessionId, projectId: a.info.projectId });
    await expectSatelliteEvent('B', 'pty:spawn-shell:ack', { sessionId });
    expect(a.revokeRemote()).toBe(true);
    await vi.waitFor(async () => {
      expect((await status('B')).connected).toBe(false);
      expect(a.ptyState(sessionId)).toMatchObject({ running: false, closed: true });
    }, { timeout: 3000 });
    const before = await driverOnTarget('B');
    await expect(chat('B', { type: 'chat.send', text: 'must not run after revocation' })).rejects.toThrow();
    expect((await driverOnTarget('B')).sent).toEqual(before.sent);
  }, 10_000);

  it('audits every app dial independently of the direct-dial sentinel', async () => {
    assertDialAudit((await status('A')).attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, guard.accepts());
    assertDialAudit((await status('B')).attempts, null, [], guard.accepts());
    expect(forward.targetPorts.every((port) => port === bInfo.port)).toBe(true);
  });
});
