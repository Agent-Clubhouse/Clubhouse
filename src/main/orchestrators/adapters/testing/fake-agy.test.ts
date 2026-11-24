/**
 * The fake `agy` helper, and Clubhouse's provider-neutral ACP driver (#3796)
 * talking to the fake through its `agy` shim. The fake is built from public
 * docs and the ACP schema, so this proves the two agree with each other, not
 * that either matches the real Antigravity CLI.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatDriverId } from '../../../../shared/chat/capabilities';
import type { ChatEventDraft } from '../../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../../shared/chat/runtime';
import { createAcpChatDriver } from '../../../chat/acp/driver';
import { ANTIGRAVITY_PROVIDER_ID, createFakeAgy, fakeAgyTestBinaries, type FakeAgy, type FakeAgyConfig } from './fake-agy';

const run = promisify(execFile);

// Test-only spec; the real Antigravity launch spec belongs to the provider lane.
const driver = createAcpChatDriver({
  id: 'acp_fake_agy_test' as ChatDriverId,
  provider: ANTIGRAVITY_PROVIDER_ID,
  args: ({ extraArgs }) => ['acp', ...extraArgs],
});

const fakes: FakeAgy[] = [];
const sessions: ChatDriverSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch((): undefined => undefined);
  for (const f of fakes.splice(0)) await f.dispose();
});

async function fake(config: FakeAgyConfig = {}): Promise<{ agy: FakeAgy; shim: string }> {
  const agy = await createFakeAgy(config);
  fakes.push(agy);
  return { agy, shim: await agy.shim() };
}

async function start(shim: string, extra: Partial<ChatDriverStartOptions> = {}) {
  const session = await driver.start({ agentId: 'a1', provider: ANTIGRAVITY_PROVIDER_ID, cwd: process.cwd(), binaryPath: shim, level: 'ask', ...extra });
  sessions.push(session);
  const drafts: ChatEventDraft[] = [];
  void (async () => { for await (const d of session.events) drafts.push(d); })();
  const until = async (type: ChatEventDraft['type'], count = 1) => {
    const deadline = Date.now() + 10_000;
    while (drafts.filter((d) => d.type === type).length < count) {
      if (Date.now() > deadline) throw new Error(`no ${type}: ${JSON.stringify(drafts.map((d) => d.type))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return drafts.filter((d) => d.type === type);
  };
  return { session, drafts, until };
}

describe('fake agy helper', () => {
  it('writes an `agy` shim that answers the version and model probes', async () => {
    const { shim } = await fake({ version: '1.5.99', models: [['m-1', 'Model One']] });
    expect(shim).toMatch(process.platform === 'win32' ? /agy\.cmd$/ : /[\\/]agy$/);
    const shell = process.platform === 'win32';
    expect((await run(shim, ['--version'], { shell })).stdout).toBe('1.5.99\n');
    expect((await run(shim, ['models'], { shell })).stdout).toBe('m-1   Model One\n');
  }, 20_000);

  it('builds the CLUBHOUSE_TEST_CLI_BINARIES entry, keeping other providers', () => {
    expect(JSON.parse(fakeAgyTestBinaries('/x/agy', JSON.stringify({ 'claude-code': '/x/claude' })))).toEqual({ 'claude-code': '/x/claude', 'antigravity-cli': '/x/agy' });
  });

  it('per-personality reports survive a later probe', async () => {
    const { agy, shim } = await fake();
    const shell = process.platform === 'win32';
    await run(shim, ['-p', 'hi'], { shell });
    await run(shim, ['--version'], { shell });
    const report = await agy.readReport('headless');
    expect(report).toMatchObject({ personality: 'headless', source: 'document-derived', argv: ['-p', 'hi'] });
    expect(fs.existsSync(`${agy.reportPath}.version.json`)).toBe(false);
  }, 20_000);
});

describe('neutral ACP driver against the fake agy', () => {
  it('probes the handshake and reads the version from agentInfo', async () => {
    const { shim } = await fake({ version: '1.5.12' });
    expect(await driver.probe(shim)).toMatchObject({ handshakeOk: true, cliVersion: '1.5.12' });
  }, 20_000);

  it('refuses an agent that answers with another protocol version', async () => {
    const { shim } = await fake({ acp: { protocolVersion: 2 } });
    expect(await driver.probe(shim)).toMatchObject({ handshakeOk: false });
  }, 20_000);

  it('runs a turn, and sends Clubhouse as clientInfo', async () => {
    const { agy, shim } = await fake();
    const { session, drafts, until } = await start(shim);
    expect(session.nativeSessionId).toBe('agy-session-1');
    await session.send([{ type: 'text', text: 'hello' }], 'prompt');
    expect((await until('turn_ended'))[0].data).toMatchObject({ stopReason: 'end_turn' });
    expect(drafts.filter((d) => d.type === 'agent_message_chunk').map((d) => (d.data as { text: string }).text).join('')).toBe('hello');
    const report = await agy.readReport('acp');
    expect(report.acp?.initialized?.clientInfo).toMatchObject({ name: 'clubhouse' });
  }, 20_000);

  it('a permission request is answered through the driver', async () => {
    const { shim } = await fake();
    const { session, drafts, until } = await start(shim);
    await session.send([{ type: 'text', text: 'agy:permission' }], 'prompt');
    const [request] = await until('permission_request');
    await session.respondPermission((request.data as { requestId: string }).requestId, 'allow');
    expect((await until('turn_ended'))[0].data).toMatchObject({ stopReason: 'end_turn' });
    expect(drafts.some((d) => d.type === 'tool_call_update')).toBe(true);
  }, 20_000);

  it('interrupt cancels a held turn: the agent answers cancelled', async () => {
    const { agy, shim } = await fake();
    const { session, until } = await start(shim);
    await session.send([{ type: 'text', text: 'agy:hold' }], 'prompt');
    await until('agent_message_chunk');
    await session.interrupt();
    expect((await until('turn_ended'))[0].data).toMatchObject({ stopReason: 'cancelled' });
    expect((await agy.readReport('acp')).acp?.cancels).toBe(1);
  }, 20_000);

  it('resumes a stored session without replaying its history', async () => {
    const { agy, shim } = await fake();
    const { session, drafts } = await start(shim, { resumeNativeSessionId: 'agy-session-stored' });
    expect(session.nativeSessionId).toBe('agy-session-stored');
    expect(drafts.some((d) => d.type === 'agent_message_chunk')).toBe(false);
    const methods = (await agy.readReport('acp')).acp?.received.map((r) => r.method);
    expect(methods).toContain('session/resume');
    expect(methods).not.toContain('session/load');
  }, 20_000);

  it('auth required: the start fails and the driver never calls authenticate', async () => {
    const { agy, shim } = await fake({ acp: { auth: 'required' } });
    await expect(driver.start({ agentId: 'a1', provider: ANTIGRAVITY_PROVIDER_ID, cwd: process.cwd(), binaryPath: shim, level: 'ask' })).rejects.toThrow(/Authentication required/);
    expect((await agy.readReport('acp')).acp?.authenticateCalls).toBe(0);
  }, 20_000);
});
