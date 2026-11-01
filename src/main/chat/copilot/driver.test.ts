/**
 * The driver against the real runtime npm installs (@github/copilot-sdk-<platform>)
 * and a local fake model. Nothing reaches a real model: the session's provider is
 * the fake, the CLI is told not to log in, and tokens and home are throwaways.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { COPILOT_OPTION_ALLOW, COPILOT_OPTION_DENY } from './normalizer';
import { COPILOT_SDK_CAPABILITIES, CopilotSdkChatDriver, toSdkMcpServers } from './driver';
import { startFakeModel, type FakeModel } from './__fixtures__/fake-model';

const platform = `${process.platform}-${process.arch}`;
const runtime = path.resolve(__dirname, '../../../../node_modules/@github', `copilot-sdk-${platform}`, 'prebuilds', platform, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime');
const BASH = process.platform === 'win32' ? 'powershell' : 'bash';
const hello = process.platform === 'win32' ? 'Write-Output hi' : 'echo hi';
const RUN_TOOL = { name: BASH, args: { command: hello, description: 'say hi', mode: 'sync', initial_wait: 5 } };

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copilot-sdk-driver-'));
const invalid = 'invalid-test-token';
const baseEnv: Record<string, string> = {
  HOME: tmp, USERPROFILE: tmp, COPILOT_HOME: path.join(tmp, '.copilot'), XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_STATE_HOME: path.join(tmp, 'state'),
  COPILOT_GITHUB_TOKEN: invalid, GH_TOKEN: invalid, GITHUB_TOKEN: invalid,
};

/** Collects a session's drafts and waits for one to show up. */
function watch(session: ChatDriverSession) {
  const drafts: ChatEventDraft[] = [];
  const waiters = new Set<() => void>();
  const pumped = (async () => {
    for await (const d of session.events) {
      drafts.push(d);
      for (const w of waiters) w();
    }
    for (const w of waiters) w();
  })();
  const until = async <T>(fn: () => T | undefined, ms = 45_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`Timed out. Saw: ${drafts.map((d) => d.type).join(' ')}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 200); waiters.add(() => { clearTimeout(t); r(); }); });
    }
  };
  const of = <K extends ChatEventDraft['type']>(type: K) => drafts.filter((d) => d.type === type) as Array<Extract<ChatEventDraft, { type: K }>>;
  const endedTurns = (n: number) => until(() => (of('turn_ended').length >= n ? of('turn_ended') : undefined));
  return { drafts, of, until, endedTurns, pumped };
}

describe.skipIf(!fs.existsSync(runtime))('CopilotSdkChatDriver on the real runtime', () => {
  let model: FakeModel;
  let driver: CopilotSdkChatDriver;
  const sessions: ChatDriverSession[] = [];

  beforeAll(async () => {
    model = await startFakeModel();
    driver = new CopilotSdkChatDriver({ sessionOverrides: { model: 'fake-model', provider: { type: 'openai', baseUrl: model.baseUrl, apiKey: 'fake' } } });
  });
  afterEach(async () => {
    model.reset();
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  });
  afterAll(() => {
    model.close();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the CLI can still be flushing logs */ }
  });

  // The BYOK variable stands in for a login, so the driver gets past its login check.
  const options = (overrides: Partial<ChatDriverStartOptions> = {}): ChatDriverStartOptions => ({
    agentId: 'a1', provider: 'copilot-cli', cwd: tmp, binaryPath: runtime, level: 'ask',
    env: { ...baseEnv, COPILOT_PROVIDER_BASE_URL: model.baseUrl }, extraArgs: ['--no-auto-login'], ...overrides,
  });
  const open = async (overrides?: Partial<ChatDriverStartOptions>) => {
    const session = await driver.start(options(overrides));
    sessions.push(session);
    return { session, ...watch(session) };
  };

  it('probes with no session and no model request, and reports the login', async () => {
    const before = model.requests.length;
    const loggedOut = await driver.probe(runtime, baseEnv);
    expect(loggedOut).toMatchObject({ handshakeOk: true, needsLogin: true, capabilities: COPILOT_SDK_CAPABILITIES });
    expect(loggedOut.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect((await driver.probe(runtime, { ...baseEnv, COPILOT_PROVIDER_BASE_URL: model.baseUrl })).needsLogin).toBeUndefined();
    expect(model.requests.length).toBe(before);
  }, 60_000);

  it('refuses to start logged out, in the words the fallback code reads as a login', async () => {
    await expect(driver.start(options({ env: baseEnv }))).rejects.toThrow(/not logged in/i);
  }, 60_000);

  it('runs a text turn: says which driver runs, streams, reports usage and ends on idle', async () => {
    const { session, of, endedTurns } = await open();
    model.script({ text: 'hello there' });
    expect(await session.send([{ type: 'text', text: 'hi' }], 'prompt')).toBe('prompt');
    const [ended] = await endedTurns(1);
    expect(ended.data.stopReason).toBe('end_turn');
    expect(ended.turnId).toBe('turn-1');
    expect(of('notice').map((n) => n.data.code)).toContain('copilot_sdk_active');
    expect(of('session_info')[0].data.nativeSessionId).toBe(session.nativeSessionId);
    expect(of('agent_message').at(-1)?.data.text).toBe('hello there');
    expect(of('usage').some((u) => u.data.scope === 'turn' && u.data.tokens?.total)).toBe(true);
    expect(model.requests.at(-1)?.text).toContain('hi');
  }, 90_000);

  it('asks before a tool runs, and runs it once allowed', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ tools: [RUN_TOOL] }, { text: 'done' });
    await session.send([{ type: 'text', text: 'run it' }], 'prompt');
    const request = await until(() => of('permission_request')[0]);
    expect(request.data.options.map((o) => o.optionId)).toContain(COPILOT_OPTION_ALLOW);
    expect(request.data.toolCallId).toBe(of('tool_call')[0].data.toolCallId);
    await session.respondPermission(request.data.requestId, COPILOT_OPTION_ALLOW);
    const [ended] = await endedTurns(1);
    expect(ended.data.stopReason).toBe('end_turn');
    expect(of('permission_resolved')[0].data.decision).toBe('allow');
    const update = of('tool_call_update').find((u) => u.data.status === 'completed');
    expect(JSON.stringify(update?.data.content)).toContain('hi');
    expect(of('tool_call')[0].data.title).toBe('say hi');
  }, 90_000);

  it('carries a denial\'s reason to the model, which continues', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ tools: [RUN_TOOL] }, { text: 'understood' });
    await session.send([{ type: 'text', text: 'run it' }], 'prompt');
    const request = await until(() => of('permission_request')[0]);
    await session.respondPermission(request.data.requestId, COPILOT_OPTION_DENY, { message: 'USE-THE-OTHER-ONE' });
    await endedTurns(1);
    expect(of('tool_call_update').some((u) => u.data.status === 'failed')).toBe(true);
    expect(model.requests.at(-1)?.text).toContain('USE-THE-OTHER-ONE');
  }, 90_000);

  it('skips the prompt at Full access', async () => {
    const { session, of, endedTurns } = await open({ level: 'full_access' });
    model.script({ tools: [RUN_TOOL] }, { text: 'done' });
    await session.send([{ type: 'text', text: 'run it' }], 'prompt');
    await endedTurns(1);
    expect(of('permission_request')).toEqual([]);
    expect(of('tool_call_update').some((u) => u.data.status === 'completed')).toBe(true);
  }, 90_000);

  it('asks first when given a level it doesn\'t have yet, and says so', async () => {
    const { session, of, until } = await open({ level: 'auto' });
    expect(of('mode_changed')[0]?.data.level ?? (await until(() => of('mode_changed')[0])).data.level).toBe('ask');
    model.script({ tools: [RUN_TOOL] }, { text: 'done' });
    await session.send([{ type: 'text', text: 'run it' }], 'prompt');
    await until(() => of('permission_request')[0]);
    expect(of('notice').map((n) => n.data.code)).toContain('level_unavailable');
  }, 90_000);

  it('interrupts a running turn and stays usable', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ hold: true, text: 'partial' });
    await session.send([{ type: 'text', text: 'slow' }], 'prompt');
    await until(() => (model.holding() ? true : undefined));
    await session.interrupt();
    const [ended] = await endedTurns(1);
    expect(ended.data.stopReason).toBe('cancelled');
    model.release();
    model.script({ text: 'again' });
    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    await endedTurns(2);
    expect(of('turn_ended')[1].data.stopReason).toBe('end_turn');
  }, 90_000);

  it('cancels an open approval when interrupted', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ tools: [RUN_TOOL] }, { text: 'after' });
    await session.send([{ type: 'text', text: 'run it' }], 'prompt');
    await until(() => of('permission_request')[0]);
    await session.interrupt();
    await endedTurns(1);
    expect(of('permission_resolved')[0].data.decision).toBe('cancelled');
  }, 90_000);

  it('reports a failed model call as an error and ends the turn', async () => {
    const { session, of, endedTurns } = await open();
    model.script({ status: 400 });
    await session.send([{ type: 'text', text: 'fail' }], 'prompt');
    const [ended] = await endedTurns(1);
    expect(ended.data.stopReason).toBe('error');
    expect(of('error')[0].data.fatal).toBe(false);
    model.script({ text: 'fine' });
    await session.send([{ type: 'text', text: 'again' }], 'prompt');
    await endedTurns(2);
  }, 90_000);

  it('resumes a session with its history, and starts fresh with a notice when it is gone', async () => {
    const first = await open();
    model.script({ text: 'noted' });
    await first.session.send([{ type: 'text', text: 'REMEMBER-THIS' }], 'prompt');
    await first.endedTurns(1);
    const id = first.session.nativeSessionId;
    await first.session.close();
    sessions.splice(sessions.indexOf(first.session), 1);

    const resumed = await open({ resumeNativeSessionId: id });
    expect(resumed.session.nativeSessionId).toBe(id);
    expect(resumed.session.resumeFallback).toBeUndefined();
    expect(resumed.of('agent_message')).toEqual([]);
    model.script({ text: 'yes' });
    await resumed.session.send([{ type: 'text', text: 'recall' }], 'prompt');
    await resumed.endedTurns(1);
    expect(model.requests.at(-1)?.text).toContain('REMEMBER-THIS');

    const missing = await open({ resumeNativeSessionId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.session.resumeFallback).toBe('not_found');
    expect(missing.session.nativeSessionId).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(missing.of('notice').map((n) => n.data.code)).toContain('resume_unavailable');
  }, 120_000);

  it('passes an HTTP MCP server with its header from the environment', () => {
    const { servers, skipped } = toSdkMcpServers(
      { clubhouse: { command: 'node', args: ['bridge.js'] }, local: { command: 'tool', args: ['-x'], env: { A: 1 }, env_vars: ['FORWARD'] }, remote: { url: 'https://x', type: 'sse', headers: { H: 'v' } }, broken: {} },
      { NONCE: 'n', FORWARD: 'f' },
      { clubhouse: { url: 'http://127.0.0.1:9/mcp', headersFromEnv: { 'X-Clubhouse-Nonce': 'NONCE' } } },
    );
    expect(servers.clubhouse).toEqual({ type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Clubhouse-Nonce': 'n' }, tools: ['*'] });
    expect(servers.local).toEqual({ type: 'stdio', command: 'tool', args: ['-x'], env: { A: '1', FORWARD: 'f' }, tools: ['*'] });
    expect(servers.remote).toEqual({ type: 'sse', url: 'https://x', headers: { H: 'v' }, tools: ['*'] });
    expect(skipped).toEqual(['broken']);
    // Without the header's value the bridge keeps its stdio command.
    expect(toSdkMcpServers({ b: { command: 'node' } }, {}, { b: { url: 'http://x', headersFromEnv: { H: 'MISSING' } } }).servers.b).toMatchObject({ type: 'stdio' });
  });
});

/** A `copilot` that runs `script` under Node, on any platform. */
function fakeCli(dir: string, script: string): string {
  const js = path.join(dir, 'fake.js');
  fs.writeFileSync(js, script);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'copilot.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, 'copilot');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return bin;
}

describe('CopilotSdkChatDriver handshake failures, which fall back to ACP', () => {
  const driver = new CopilotSdkChatDriver({ probeTimeoutMs: 3_000 });
  const dirs: string[] = [];
  const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-fake-')); dirs.push(d); return d; };
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it('reports a CLI that exits at launch', async () => {
    const probe = await driver.probe(fakeCli(dir(), 'console.error("unknown option --headless"); process.exit(1);'));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'process_exited' });
    expect(probe.error).toContain('unknown option');
  }, 30_000);

  it('times out on a CLI that never listens, and leaves nothing running', async () => {
    const pidFile = path.join(dir(), 'pid');
    const probe = await driver.probe(fakeCli(dir(), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(false);
  }, 30_000);

  // Answers every request with the wrong protocol version, over the CLI's Content-Length framing.
  const server = (reply: string) => `
    const net = require('net');
    const s = net.createServer((c) => {
      let buf = Buffer.alloc(0);
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const end = buf.indexOf('\\r\\n\\r\\n');
          if (end < 0) return;
          const len = Number(/Content-Length: (\\d+)/i.exec(buf.slice(0, end).toString())[1]);
          if (buf.length < end + 4 + len) return;
          const msg = JSON.parse(buf.slice(end + 4, end + 4 + len).toString());
          buf = buf.slice(end + 4 + len);
          ${reply}
        }
      });
    });
    s.listen(0, '127.0.0.1', () => console.log('CLI server listening on port ' + s.address().port));
  `;

  it('reports a protocol mismatch', async () => {
    const probe = await driver.probe(fakeCli(dir(), server(`
      const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 99, version: '1.0.105', message: '', timestamp: 0 } });
      c.write('Content-Length: ' + Buffer.byteLength(out) + '\\r\\n\\r\\n' + out);
    `)));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'protocol_error' });
  }, 30_000);

  it('times out on a CLI that listens and never answers', async () => {
    const probe = await driver.probe(fakeCli(dir(), server('')));
    expect(probe).toMatchObject({ handshakeOk: false, errorCode: 'rpc_timeout' });
  }, 30_000);
});
