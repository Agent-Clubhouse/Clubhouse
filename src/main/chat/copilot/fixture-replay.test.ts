/**
 * The real Copilot SDK driver and the real SDK against the fake CLI replaying
 * committed fixtures: real child processes, a real TCP connection, zero tokens.
 * record-fixtures.test.ts writes these fixtures.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { EventLog, chatFixturePath, createFakeCli, writeFakeCliShims, type FakeCli } from '../../orchestrators/adapters/testing/fake-cli';
import { CopilotSdkChatDriver } from './driver';
import { COPILOT_OPTION_ALLOW, COPILOT_OPTION_DENY } from './normalizer';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** A `copilot` on disk that replays a fixture. */
async function fakeCopilot(name: string): Promise<{ fake: FakeCli; binary: string }> {
  const fake = await createFakeCli(chatFixturePath('copilot-sdk', name));
  cleanups.push(() => fake.dispose());
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copilot-sdk-replay-'));
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const shims = await writeFakeCliShims(dir, { copilot: { fixture: chatFixturePath('copilot-sdk', name), report: fake.reportPath } });
  return { fake, binary: shims.copilot };
}

// The fixtures were recorded logged out, with BYOK standing in for a login.
const LOGIN_STAND_IN = { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:0/v1' };

async function start(name: string, overrides: Partial<ChatDriverStartOptions> = {}) {
  const { fake, binary } = await fakeCopilot(name);
  const session = await new CopilotSdkChatDriver().start({
    agentId: 'a1', provider: 'copilot-cli', cwd: os.tmpdir(), binaryPath: binary, level: 'ask', env: LOGIN_STAND_IN, ...overrides,
  });
  cleanups.push(() => session.close());
  return { fake, session, drafts: EventLog.fromAsyncIterable(session.events) };
}

/** Close, then check every fixture line was replayed with no mismatch. */
async function expectComplete(session: ChatDriverSession, fake: FakeCli): Promise<void> {
  await session.close();
  const report = await fake.waitForReport((r) => r.complete || r.mismatch !== null);
  expect(report.mismatch).toBeNull();
  expect(report.complete).toBe(true);
  expect(report.unexpected).toEqual([]);
}

const say = (session: ChatDriverSession, text: string) => session.send([{ type: 'text', text }], 'prompt');

describe('CopilotSdkChatDriver probe against fake Copilot', () => {
  const probe = async (name: string, env: Record<string, string> = {}, probeTimeoutMs?: number) => {
    const { fake, binary } = await fakeCopilot(name);
    return { fake, result: await new CopilotSdkChatDriver({ probeTimeoutMs }).probe(binary, env) };
  };

  it('launches --headless --port 0, reads status and login, and opens no session', async () => {
    const { fake, result } = await probe('handshake');
    expect(result).toMatchObject({ handshakeOk: true, cliVersion: '1.0.105', needsLogin: true });
    const report = await fake.waitForReport();
    expect(report.mismatch).toBeNull();
    expect(report.argv).toEqual(['--headless', '--port', '0']);
  });

  it('a model key stands in for the login', async () => {
    const { result } = await probe('handshake', LOGIN_STAND_IN);
    expect(result.handshakeOk).toBe(true);
    expect(result.needsLogin).toBeUndefined();
  });

  it('falls back on a protocol mismatch', async () => {
    const { result } = await probe('protocol-mismatch');
    expect(result).toMatchObject({ handshakeOk: false, errorCode: 'protocol_error' });
  });

  it('falls back when the CLI exits at launch, with its stderr', async () => {
    const { result } = await probe('exit-at-launch');
    expect(result).toMatchObject({ handshakeOk: false, errorCode: 'process_exited' });
    expect(result.error).toContain("unknown option '--headless'");
  });

  it('falls back when the CLI never opens its port', async () => {
    const { result } = await probe('hang-at-launch', {}, 1_000);
    expect(result).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout' });
  });

  it('falls back when the CLI never answers connect', async () => {
    const { result } = await probe('no-answer', {}, 2_000);
    expect(result).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout' });
  });
});

describe('CopilotSdkChatDriver sessions against fake Copilot', () => {
  it('refuses to start logged out', async () => {
    const { binary } = await fakeCopilot('handshake');
    await expect(new CopilotSdkChatDriver().start({ agentId: 'a1', provider: 'copilot-cli', cwd: os.tmpdir(), binaryPath: binary, level: 'ask', env: {} }))
      .rejects.toThrow(/not logged in/i);
  });

  it('multi-turn: two turns stream text and usage, on the session id the client chose', async () => {
    const { fake, session, drafts } = await start('multi-turn');
    await say(session, 'Reply with the word one.');
    const first = await drafts.waitFor({ type: 'turn_ended' });
    expect(first).toMatchObject({ turnId: 'turn-1', data: { stopReason: 'end_turn' } });
    await say(session, 'Now reply with the word two.');
    await drafts.waitFor({ type: 'turn_ended' });
    const texts = drafts.items.filter((d) => d.type === 'agent_message').map((d) => (d.data as { text: string }).text);
    expect(texts).toEqual(['one', 'two']);
    expect(drafts.items.some((d) => d.type === 'agent_message_chunk')).toBe(true);
    expect(drafts.items.some((d) => d.type === 'usage' && (d.data as { tokens?: { total?: number } }).tokens?.total)).toBe(true);
    const info = drafts.items.find((d) => d.type === 'session_info' && (d.data as { nativeSessionId?: string }).nativeSessionId);
    expect(info?.data).toMatchObject({ nativeSessionId: session.nativeSessionId, cliVersion: '1.0.105' });
    await expectComplete(session, fake);
  });

  it('interrupt: a running turn ends cancelled, and the session stays usable', async () => {
    const { fake, session, drafts } = await start('interrupt');
    await say(session, 'Take your time.');
    await drafts.waitFor({ type: 'agent_message_chunk' });
    await session.interrupt();
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'cancelled' } });
    await say(session, 'Are you there?');
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'end_turn' } });
    await expectComplete(session, fake);
  });

  it('permission-approve-edit: the answer reaches the CLI, and the tool completes', async () => {
    const { fake, session, drafts } = await start('permission-approve-edit');
    await say(session, 'Write the note.');
    const request = await drafts.waitFor({ type: 'permission_request' });
    await session.respondPermission((request.data as { requestId: string }).requestId, COPILOT_OPTION_ALLOW);
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'end_turn' } });
    expect(drafts.items.filter((d) => d.type === 'tool_call_update').map((d) => (d.data as { status?: string }).status)).toContain('completed');
    await expectComplete(session, fake);
  });

  it('permission-deny: the reason reaches the CLI, and the tool fails', async () => {
    const { fake, session, drafts } = await start('permission-deny');
    await say(session, 'Run it.');
    const request = await drafts.waitFor({ type: 'permission_request' });
    await session.respondPermission((request.data as { requestId: string }).requestId, COPILOT_OPTION_DENY, { message: 'not that one' });
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'end_turn' } });
    expect(drafts.items.filter((d) => d.type === 'tool_call_update').map((d) => (d.data as { status?: string }).status)).toContain('failed');
    await expectComplete(session, fake);
  });

  it('a different permission answer than the fixture recorded is a mismatch', async () => {
    const { fake, session, drafts } = await start('permission-deny');
    await say(session, 'Run it.');
    const request = await drafts.waitFor({ type: 'permission_request' });
    await session.respondPermission((request.data as { requestId: string }).requestId, COPILOT_OPTION_ALLOW);
    const report = await fake.waitForReport((r) => r.mismatch !== null);
    expect(report.mismatch?.reason).toContain('handlePendingPermissionRequest');
  });

  it('turn-error: a failed model call ends the turn in error, and the next turn recovers', async () => {
    const { fake, session, drafts } = await start('turn-error');
    await say(session, 'This one fails.');
    await drafts.waitFor({ type: 'error' });
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'error' } });
    await say(session, 'This one works.');
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'end_turn' } });
    await expectComplete(session, fake);
  });

  it('session-info: a model and effort change reaches the UI', async () => {
    const { fake, session, drafts } = await start('session-info');
    await session.setModel('fake-model-2', 'high');
    expect(await drafts.waitFor({ type: 'model_changed' })).toMatchObject({ data: { modelId: 'fake-model-2', effort: 'high' } });
    await say(session, 'Which model?');
    await drafts.waitFor({ type: 'turn_ended' });
    expect(drafts.items.some((d) => d.type === 'session_info' && (d.data as { title?: string }).title === 'Which model?')).toBe(true);
    await expectComplete(session, fake);
  });

  it('resume: a stored session continues on the id the client asked for', async () => {
    const resumeNativeSessionId = 'b6a3a5a4-37a5-4b6e-9e59-4f8e0c1d2a33';
    const { fake, session, drafts } = await start('resume', { resumeNativeSessionId });
    expect(session.nativeSessionId).toBe(resumeNativeSessionId);
    expect(session.resumeFallback).toBeUndefined();
    await say(session, 'Do you remember?');
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'end_turn' } });
    await expectComplete(session, fake);
  });

  it('resume-not-found: starts a new session and says so', async () => {
    const resumeNativeSessionId = 'b6a3a5a4-37a5-4b6e-9e59-4f8e0c1d2a33';
    const { fake, session, drafts } = await start('resume-not-found', { resumeNativeSessionId });
    expect(session.resumeFallback).toBe('not_found');
    expect(session.nativeSessionId).not.toBe(resumeNativeSessionId);
    expect(drafts.items.some((d) => d.type === 'notice' && (d.data as { code?: string }).code === 'resume_unavailable')).toBe(true);
    await expectComplete(session, fake);
  });

  it('died-mid-turn: the driver ends the session itself', async () => {
    const { session, drafts } = await start('died-mid-turn');
    await say(session, 'Reply with the word one.');
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'error' } });
  });

  it('schema-drift: unknown events, fields and requests are tolerated, and the unknown request is refused', async () => {
    const { fake, session, drafts } = await start('schema-drift');
    await say(session, 'Reply with the word one.');
    expect(await drafts.waitFor({ type: 'turn_ended' })).toMatchObject({ data: { stopReason: 'end_turn' } });
    await say(session, 'Now reply with the word two.');
    await drafts.waitFor({ type: 'turn_ended' });
    expect(drafts.items.some((d) => d.type === 'error')).toBe(false);
    await expectComplete(session, fake);
  });
});
