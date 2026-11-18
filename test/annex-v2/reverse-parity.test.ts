import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BULLETIN_MESSAGES, BULLETIN_MESSAGE_BYTES, NATIVE_TRANSCRIPT_EVENTS, NATIVE_TRANSCRIPT_EVENT_BYTES,
  createInventoryPeer, LARGE_DIFF_BYTES, LARGE_TEXT_BYTES, type InventoryPeer, type InventoryPeerInfo, type WireAnswer,
} from './reverse-inventory-peer';
import { assertDialAudit, closeServer, rpcPeer, sentinel, transparentForward, type RpcPeer } from './reverse-parity-fixture';
import type { ChatEventDraft } from '../../src/shared/chat';

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
  const expectSatelliteEvent = (who: 'A' | 'B', type: string, payload: unknown) => vi.waitFor(async () => {
    expect((await status(who)).events).toEqual(expect.arrayContaining([expect.objectContaining({
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

  it.each(['A', 'B'] as const)('R22 %s: server-only status uses the production route table', async (who) => {
    const request = { method: 'GET' as const, path: '/api/v1/status' };
    const answer: WireAnswer = who === 'A' ? await a.wire(request) : await b.call('wire', request);
    expect(answer.status).toBe(200);
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString())).toMatchObject({ deviceName: target(who).alias });
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
  });

  it('audits every app dial independently of the direct-dial sentinel', async () => {
    assertDialAudit((await status('A')).attempts, { host: '127.0.0.1', port: forward.port }, forward.sourcePorts, guard.accepts());
    assertDialAudit((await status('B')).attempts, null, [], guard.accepts());
    expect(forward.targetPorts.every((port) => port === bInfo.port)).toBe(true);
  });
});
