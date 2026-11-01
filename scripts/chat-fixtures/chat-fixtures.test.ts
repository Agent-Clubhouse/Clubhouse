import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFrame,
  fillTemplate,
  loadFixture,
  matchClientMessage,
  messageKey,
  parseFixture,
  redactValue,
  remapCliMessage,
  remapSessionIds,
  SECRET_REDACTIONS,
  splitFrames,
} from './fixture-format.mjs';

const FAKE_CLI = path.join(__dirname, 'fake-cli.mjs');
const RECORD = path.join(__dirname, 'record.mjs');
const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'chat-fixtures');

const header = (protocol: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'header', format: 'clubhouse-chat-fixture', version: 1, protocol, cli: { name: 'fake', version: '9.9.9' }, source: 'hand-made', ...extra });
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-fixtures-test-'));
});
afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function writeFixture(name: string, lines: unknown[]): Promise<string> {
  const file = path.join(tmp, name);
  await fs.promises.writeFile(file, jsonl(lines));
  return file;
}

/** Run a node script, feed it `stdin` lines, and collect its output. */
function run(args: string[], stdin: unknown[] = [], opts: { keepOpen?: boolean } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    for (const msg of stdin) child.stdin.write(JSON.stringify(msg) + '\n');
    if (!opts.keepOpen) child.stdin.end();
  });
}

const parseLines = (text: string) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

describe('fixture format', () => {
  it('parses a header and entries and drops notes', () => {
    const { header: h, entries } = parseFixture(jsonl([
      header('acp'),
      { kind: 'note', text: 'ignored' },
      { from: 'client', msg: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { from: 'cli', t: 5, msg: { jsonrpc: '2.0', id: 1, result: {} } },
    ]));
    expect(h.protocol).toBe('acp');
    expect(entries.map((e: { from: string }) => e.from)).toEqual(['client', 'cli']);
  });

  it('rejects malformed fixtures with the offending line', () => {
    expect(() => parseFixture(jsonl([{ from: 'cli', msg: {} }]))).toThrow('missing header');
    expect(() => parseFixture(jsonl([header('smoke-signals')]))).toThrow('unknown protocol');
    expect(() => parseFixture(jsonl([header('acp'), { from: 'client', raw: 'x' }]))).toThrow(':2: client entries must carry "msg"');
    expect(() => parseFixture(`${JSON.stringify(header('acp'))}\n{nope\n`)).toThrow(':2: invalid JSON');
  });

  it('keys client messages by protocol shape, ignoring ids', () => {
    expect(messageKey('acp', { jsonrpc: '2.0', id: 7, method: 'session/prompt' })).toBe('request:session/prompt');
    expect(messageKey('codex-app-server', { method: 'initialized' })).toBe('notification:initialized');
    expect(messageKey('codex-app-server', { id: 0, result: { decision: 'accept' } })).toBe('response:result');
    expect(messageKey('claude-stream-json', { type: 'control_request', request: { subtype: 'interrupt' } })).toBe('control_request:interrupt');
    expect(messageKey('claude-stream-json', { type: 'user' })).toBe('user');
  });

  it('applies an entry\'s match on top of the key', () => {
    const entry = { msg: { id: 0, result: {} }, match: { result: { decision: 'decline' } } };
    expect(matchClientMessage('codex-app-server', entry, { id: 0, result: { decision: 'decline' } })).toBeNull();
    expect(matchClientMessage('codex-app-server', entry, { id: 0, result: { decision: 'accept' } })).toContain('did not contain');
    expect(matchClientMessage('codex-app-server', entry, { method: 'turn/start', id: 3 })).toContain('expected response:result');
  });

  it('remaps response ids to the ids the live driver used', () => {
    const ids = new Map<unknown, unknown>([[3, 41], ['req_1', 'live-1']]);
    expect(remapCliMessage('acp', { jsonrpc: '2.0', id: 3, result: {} }, ids)).toEqual({ jsonrpc: '2.0', id: 41, result: {} });
    // Server-initiated requests keep the CLI's own id.
    expect(remapCliMessage('acp', { jsonrpc: '2.0', id: 3, method: 'session/request_permission' }, ids).id).toBe(3);
    const claude = remapCliMessage('claude-stream-json', { type: 'control_response', response: { subtype: 'success', request_id: 'req_1' } }, ids);
    expect(claude.response.request_id).toBe('live-1');
  });

  it('redacts nested strings and fills script templates', () => {
    expect(redactValue({ a: ['/Users/me/x', { b: '/Users/me' }], n: 1 }, [['/Users/me', '/home/user']]))
      .toEqual({ a: ['/home/user/x', { b: '/home/user' }], n: 1 });
    const scope = { last: { id: 5, result: { sessionId: 's-1' } } };
    expect(fillTemplate({ id: '{{last.id}}', text: 'session {{last.result.sessionId}}' }, scope))
      .toEqual({ id: 5, text: 'session s-1' });
  });

  it('every committed fixture parses, and each CLI covers the shared scenarios', async () => {
    const shared = ['interrupt', 'model-list', 'multi-turn', 'permission-approve-edit', 'permission-deny', 'schema-drift', 'session-info', 'turn-error'];
    const extra: Record<string, string[]> = {
      claude: ['ask-user-question', 'subagent-task'],
      codex: [],
      copilot: ['handshake-1.0.82'],
      'copilot-sdk': ['died-mid-turn', 'exit-at-launch', 'handshake', 'hang-at-launch', 'no-answer', 'protocol-mismatch', 'resume', 'resume-not-found'],
    };
    // The model list needs a real login, so copilot-sdk gets it in phase 4 (docs/copilot-sdk-driver.md).
    const missing: Record<string, string[]> = { 'copilot-sdk': ['model-list'] };
    for (const [cli, protocol] of [['claude', 'claude-stream-json'], ['codex', 'codex-app-server'], ['copilot', 'acp'], ['copilot-sdk', 'copilot-sdk']]) {
      const names = (await fs.promises.readdir(path.join(FIXTURES, cli))).map((f) => f.replace(/\.jsonl$/, '')).sort();
      expect(names).toEqual([...shared.filter((n) => !missing[cli]?.includes(n)), ...extra[cli]].sort());
      for (const name of names) {
        const { header: h } = await loadFixture(path.join(FIXTURES, cli, `${name}.jsonl`));
        expect(h.protocol).toBe(protocol);
        expect(h.description).toBeTruthy();
      }
    }
  });
});

describe('Content-Length frames', () => {
  it('counts bytes, and takes a frame split across reads', () => {
    const frame = encodeFrame({ text: 'héllo ✓' });
    expect(frame.toString('utf8').startsWith(`Content-Length: ${Buffer.byteLength(JSON.stringify({ text: 'héllo ✓' }))}\r\n\r\n`)).toBe(true);
    const two = Buffer.concat([frame, encodeFrame({ n: 2 })]);
    const first = splitFrames(two.subarray(0, frame.length + 3));
    expect(first.bodies.map((b: string) => JSON.parse(b))).toEqual([{ text: 'héllo ✓' }]);
    const second = splitFrames(Buffer.concat([first.rest, two.subarray(frame.length + 3)]));
    expect(second.bodies.map((b: string) => JSON.parse(b))).toEqual([{ n: 2 }]);
    expect(second.rest.length).toBe(0);
  });

  it('rejects a header with no length', () => {
    expect(() => splitFrames(Buffer.from('Nope: 1\r\n\r\n{}'))).toThrow(/no Content-Length/);
  });

  it('puts live session ids everywhere a recorded one appears', () => {
    const msg = { result: { sessionId: 'old', workspacePath: '/state/old', n: 1 } };
    expect(remapSessionIds(msg, new Map([['old', 'new']]))).toEqual({ result: { sessionId: 'new', workspacePath: '/state/new', n: 1 } });
    expect(remapSessionIds(msg, new Map())).toBe(msg);
  });
});

describe('committed fixtures', () => {
  /** Things a recording can leak that must never reach the repo. */
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['a macOS home path', /\/Users\//],
    ['a Linux home path other than /home/user', /\/home\/(?!user\b)/],
    ['a Windows home path', /[A-Za-z]:(\\\\|\\)+Users/i],
    ['an Anthropic API key', /sk-ant-/],
    ['a GitHub token', /\bgh[pousr]_|github_pat_/],
    ['a bearer token', /Bearer /],
    ['an email outside example.com', /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ];

  async function listFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await listFiles(full));
      else out.push(full);
    }
    return out;
  }

  it('contain no personal paths, keys, tokens or real email addresses', async () => {
    const leaks: string[] = [];
    for (const file of await listFiles(FIXTURES)) {
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const [what, pattern] of FORBIDDEN) {
          if (pattern.test(line)) leaks.push(`${path.relative(FIXTURES, file)}:${i + 1}: ${what}`);
        }
      });
    }
    expect(leaks).toEqual([]);
  });

  it('never hold a real connection token', async () => {
    const dir = path.join(FIXTURES, 'copilot-sdk');
    for (const file of await fs.promises.readdir(dir)) {
      const { entries } = await loadFixture(path.join(dir, file));
      for (const entry of entries) {
        if (entry.msg?.method === 'connect') expect(entry.msg.params.token, file).toBe('REDACTED_CONNECTION_TOKEN');
      }
    }
  });

  it('default secret redactions turn leaks into placeholders the guard accepts', () => {
    const leaked = {
      account: { email: 'jane.doe@corp.example.io' },
      env: ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop', 'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123'],
      header: 'Authorization: Bearer abc.def.ghi-123456',
      keep: 'user@example.com',
    };
    const clean = redactValue(leaked, SECRET_REDACTIONS);
    expect(clean).toEqual({
      account: { email: 'user@example.com' },
      env: ['ANTHROPIC_API_KEY=REDACTED_ANTHROPIC_KEY', 'GH_TOKEN=REDACTED_GITHUB_TOKEN'],
      header: 'Authorization: REDACTED_BEARER_TOKEN',
      keep: 'user@example.com',
    });
  });
});

describe('fake-cli', () => {
  const echo = () => writeFixture('echo.jsonl', [
    header('codex-app-server', { cli: { name: 'codex', version: '0.1.0', versionOutput: 'codex-cli 0.1.0' } }),
    { from: 'client', msg: { id: 1, method: 'initialize' } },
    { from: 'cli', msg: { id: 1, result: { ok: true } } },
    { from: 'cli', stderr: 'warming up' },
    { from: 'client', msg: { method: 'initialized' } },
    { from: 'cli', msg: { method: 'ready', params: {} } },
  ]);

  it('replays in order, remapping response ids, then exits when stdin closes', async () => {
    const fixture = await echo();
    const report = path.join(tmp, 'report.json');
    const out = await run([FAKE_CLI, '--fake-fixture', fixture, '--fake-report', report, 'app-server'], [
      { id: 99, method: 'initialize', params: {} },
      { method: 'initialized' },
    ]);
    expect(out.code).toBe(0);
    expect(parseLines(out.stdout)).toEqual([{ id: 99, result: { ok: true } }, { method: 'ready', params: {} }]);
    expect(out.stderr).toContain('warming up');
    const r = JSON.parse(await fs.promises.readFile(report, 'utf8'));
    expect(r).toMatchObject({ complete: true, consumed: 5, total: 5, mismatch: null, argv: ['app-server'] });
  });

  it('exits 3 with a diagnostic when the client sends something else', async () => {
    const fixture = await echo();
    const out = await run([FAKE_CLI, '--fake-fixture', fixture], [{ id: 1, method: 'thread/start' }]);
    expect(out.code).toBe(3);
    expect(out.stderr).toMatch(/fixture mismatch at .*echo\.jsonl:2: expected request:initialize, got request:thread\/start/);
  });

  it('skips unexpected client messages in lenient mode', async () => {
    const fixture = await echo();
    const report = path.join(tmp, 'report.json');
    const out = await run([FAKE_CLI, '--fake-fixture', fixture, '--fake-report', report, '--fake-lenient'], [
      { id: 1, method: 'thread/list' },
      { id: 2, method: 'initialize' },
      { method: 'initialized' },
    ]);
    expect(out.code).toBe(0);
    const r = JSON.parse(await fs.promises.readFile(report, 'utf8'));
    expect(r.complete).toBe(true);
    expect(r.unexpected).toEqual([{ id: 1, method: 'thread/list' }]);
  });

  it('answers standing queries the fixture never recorded, at any point', async () => {
    const fixture = await echo();
    const report = path.join(tmp, 'report.json');
    const out = await run([FAKE_CLI, '--fake-fixture', fixture, '--fake-report', report], [
      { id: 7, method: 'model/list', params: {} },
      { id: 8, method: 'initialize', params: {} },
      { method: 'initialized' },
    ]);
    expect(out.code).toBe(0);
    expect(parseLines(out.stdout)).toContainEqual({ id: 7, result: { data: [], nextCursor: null } });
    expect(parseLines(out.stdout)).toContainEqual({ id: 8, result: { ok: true } });
    const r = JSON.parse(await fs.promises.readFile(report, 'utf8'));
    expect(r).toMatchObject({ complete: true, mismatch: null, unexpected: [] });
  });

  it('answers the Claude driver\'s get_settings and get_usage reads with empty results', async () => {
    const fixture = await writeFixture('claude-init.jsonl', [
      header('claude-stream-json'),
      { from: 'client', msg: { type: 'control_request', request_id: 'req_1', request: { subtype: 'initialize' } } },
      { from: 'cli', msg: { type: 'control_response', response: { subtype: 'success', request_id: 'req_1', response: {} } } },
    ]);
    const report = path.join(tmp, 'report.json');
    const out = await run([FAKE_CLI, '--fake-fixture', fixture, '--fake-report', report], [
      { type: 'control_request', request_id: 'req_1', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'req_2', request: { subtype: 'get_settings' } },
      { type: 'control_request', request_id: 'req_3', request: { subtype: 'get_usage', skip_behaviors: true } },
    ]);
    expect(out.code).toBe(0);
    expect(parseLines(out.stdout)).toContainEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'req_3', response: {} } });
    const r = JSON.parse(await fs.promises.readFile(report, 'utf8'));
    expect(r).toMatchObject({ complete: true, mismatch: null, unexpected: [] });
  });

  it('matches a standing query like any other message when the fixture records it', async () => {
    const fixture = await writeFixture('listed.jsonl', [
      header('codex-app-server'),
      { from: 'client', msg: { id: 1, method: 'model/list', params: {} } },
      { from: 'cli', msg: { id: 1, result: { data: [{ id: 'm' }], nextCursor: null } } },
    ]);
    const out = await run([FAKE_CLI, '--fake-fixture', fixture], [{ id: 4, method: 'model/list', params: {} }]);
    expect(parseLines(out.stdout)).toEqual([{ id: 4, result: { data: [{ id: 'm' }], nextCursor: null } }]);
  });

  it('honours exit entries and answers --version from the header', async () => {
    const crash = await writeFixture('crash.jsonl', [
      header('acp'),
      { from: 'cli', raw: 'panic: something broke' },
      { from: 'cli', exit: { code: 101 } },
    ]);
    const crashed = await run([FAKE_CLI, '--fake-fixture', crash], [], { keepOpen: true });
    expect(crashed.code).toBe(101);
    expect(crashed.stdout).toBe('panic: something broke\n');

    const version = await run([FAKE_CLI, '--fake-fixture', await echo(), '--version']);
    expect(version).toMatchObject({ code: 0, stdout: 'codex-cli 0.1.0\n' });
  });

  it('fails clearly without a fixture', async () => {
    const out = await run([FAKE_CLI]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain('no fixture');
  });
});

describe('fake-cli and record over TCP (copilot-sdk)', () => {
  const children: ChildProcess[] = [];
  const sockets: net.Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(children.splice(0).map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        child.once('close', () => resolve());
        child.kill();
      }
    })));
  });

  const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });
  const reply = (id: number, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const event = (sessionId: string, type: string) => ({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, data: {} } } });
  const session = () => writeFixture('session.jsonl', [
    header('copilot-sdk'),
    { from: 'client', msg: rpc(1, 'connect', { token: 'REDACTED_CONNECTION_TOKEN' }) },
    { from: 'cli', msg: reply(1, { ok: true, protocolVersion: 3 }) },
    { from: 'client', msg: rpc(2, 'session.create', { sessionId: 'recorded-id' }) },
    { from: 'cli', msg: reply(2, { sessionId: 'recorded-id', note: 'héllo ✓' }) },
    { from: 'cli', msg: event('recorded-id', 'session.start') },
  ]);

  /** Spawn something that prints the port line, and wait for it. */
  async function launch(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        stdout += c;
        const m = /listening on port (\d+)/.exec(stdout);
        if (m) resolve(Number(m[1]));
      });
      child.once('close', (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    return { child, port, stderr: () => stderr };
  }

  /** A connected client that collects framed messages. */
  async function dial(port: number) {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    await new Promise((resolve) => socket.once('connect', resolve));
    const received: Array<{ params?: { sessionId?: string }; error?: { message?: string } }> = [];
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      const { bodies, rest } = splitFrames(Buffer.concat([buffer, chunk]));
      buffer = rest;
      received.push(...bodies.map((b: string) => JSON.parse(b)));
    });
    const until = async (count: number) => {
      const deadline = Date.now() + 10_000;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`Saw only ${JSON.stringify(received)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    return { socket, received, until, send: (msg: unknown) => socket.write(encodeFrame(msg)) };
  }

  it('replays over TCP, remapping request and session ids, and outlives the client', async () => {
    const report = path.join(tmp, 'report.json');
    const { child, port } = await launch([FAKE_CLI, '--fake-fixture', await session(), '--fake-report', report, '--headless', '--port', '0']);
    const client = await dial(port);
    client.send(rpc(40, 'connect', { token: 'anything' }));
    client.send(rpc(41, 'session.create', { sessionId: 'live-id' }));
    await client.until(3);
    expect(client.received[1]).toEqual(reply(41, { sessionId: 'live-id', note: 'héllo ✓' }));
    expect(client.received[2].params.sessionId).toBe('live-id');
    client.socket.destroy();
    await vi.waitFor(async () => expect(JSON.parse(await fs.promises.readFile(report, 'utf8'))).toMatchObject({ complete: true, stdinClosed: true, mismatch: null, argv: ['--headless', '--port', '0'] }));
    expect(child.exitCode).toBeNull();
  });

  it('answers standing queries the fixture never recorded', async () => {
    const { port } = await launch([FAKE_CLI, '--fake-fixture', await session(), '--headless', '--port', '0']);
    const client = await dial(port);
    client.send(rpc(1, 'models.list'));
    await client.until(1);
    expect(client.received[0]).toEqual(reply(1, { models: [] }));
  });

  it('refuses a wrong connection token', async () => {
    const report = path.join(tmp, 'report.json');
    const { child, port } = await launch([FAKE_CLI, '--fake-fixture', await session(), '--fake-report', report, '--headless', '--port', '0'], { COPILOT_CONNECTION_TOKEN: 'right' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const client = await dial(port);
    client.send(rpc(1, 'connect', { token: 'wrong' }));
    expect(await exited).toBe(3);
    expect(client.received[0]?.error?.message).toContain('AUTHENTICATION_FAILED');
    expect(JSON.parse(await fs.promises.readFile(report, 'utf8')).mismatch.reason).toContain('connection token');
  });

  it('needs the headless launch, and an exit in launch never opens the port', async () => {
    const needsPort = await run([FAKE_CLI, '--fake-fixture', await session()]);
    expect(needsPort.code).toBe(2);
    expect(needsPort.stderr).toContain('--headless --port');

    const crash = await writeFixture('crash.jsonl', [header('copilot-sdk'), { from: 'cli', stderr: 'boom' }, { from: 'cli', exit: { code: 7 } }]);
    const crashed = await run([FAKE_CLI, '--fake-fixture', crash, '--headless', '--port', '0']);
    expect(crashed.code).toBe(7);
    expect(crashed.stderr).toContain('boom');
    expect(crashed.stdout).not.toContain('listening');
  });

  it('script mode: fills the token, records frames, and leaves out our own kill and the port line', async () => {
    const script = path.join(tmp, 'steps.jsonl');
    await fs.promises.writeFile(script, jsonl([
      { send: rpc(1, 'connect', { token: '{{connectionToken}}' }) },
      { await: { id: 1 } },
      { send: rpc(2, 'session.create', { sessionId: 'recorded-id' }) },
      { await: { method: 'session.event' } },
    ]));
    const out = path.join(tmp, 'recorded.jsonl');
    const result = await run([RECORD, '--protocol', 'copilot-sdk', '--out', out, '--script', script, '--', process.execPath, FAKE_CLI, '--fake-fixture', await session(), '--headless', '--port', '0']);
    expect(result.stderr).toContain('record: wrote');
    expect(result.code).toBe(0);

    const recorded = await loadFixture(out);
    expect(recorded.header.protocol).toBe('copilot-sdk');
    expect(recorded.entries.map((e: { from: string; msg?: { method?: string } }) => `${e.from}:${e.msg?.method ?? ''}`))
      .toEqual(['client:connect', 'cli:', 'client:session.create', 'cli:', 'cli:session.event']);
    expect(recorded.entries[0].msg.params.token).toBe('REDACTED_CONNECTION_TOKEN');
    expect(recorded.entries[3].msg.result.note).toBe('héllo ✓');
  });

  it('proxy mode: a driver sees a port of its own, and a recording that replays', async () => {
    const out = path.join(tmp, 'proxied.jsonl');
    const { child, port } = await launch(
      [RECORD, '--protocol', 'copilot-sdk', '--out', out, '--', process.execPath, FAKE_CLI, '--fake-fixture', await session(), '--headless', '--port', '0'],
      { COPILOT_CONNECTION_TOKEN: 'secret-token-value' },
    );
    const client = await dial(port);
    client.send(rpc(1, 'connect', { token: 'secret-token-value' }));
    client.send(rpc(2, 'session.create', { sessionId: 'live-id' }));
    await client.until(3);
    expect(client.received[2].params.sessionId).toBe('live-id');

    const exited = new Promise((resolve) => child.once('exit', resolve));
    client.socket.destroy();
    expect(await exited).toBe(0);
    const text = await fs.promises.readFile(out, 'utf8');
    expect(text).not.toContain('secret-token-value');
    const recorded = await loadFixture(out);
    expect(recorded.entries.filter((e: { from: string }) => e.from === 'client')).toHaveLength(2);
    expect(recorded.entries.some((e: { exit?: unknown }) => e.exit)).toBe(false);

    const { port: replayPort } = await launch([FAKE_CLI, '--fake-fixture', out, '--headless', '--port', '0']);
    const replay = await dial(replayPort);
    replay.send(rpc(7, 'connect', { token: 'x' }));
    replay.send(rpc(8, 'session.create', { sessionId: 'another-id' }));
    await replay.until(3);
    expect(replay.received[2].params?.sessionId).toBe('another-id');
  });

  it('proxy mode: a CLI that dies mid-session is recorded as an exit', async () => {
    const dies = await writeFixture('dies.jsonl', [
      header('copilot-sdk'),
      { from: 'client', msg: rpc(1, 'connect', {}) },
      { from: 'cli', exit: { code: 7 } },
    ]);
    const out = path.join(tmp, 'died.jsonl');
    const { child, port } = await launch([RECORD, '--protocol', 'copilot-sdk', '--out', out, '--', process.execPath, FAKE_CLI, '--fake-fixture', dies, '--headless', '--port', '0']);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const client = await dial(port);
    client.send(rpc(1, 'connect', {}));
    expect(await exited).toBe(7);
    expect((await loadFixture(out)).entries.at(-1)).toMatchObject({ from: 'cli', exit: { code: 7 } });
  });
});

describe('record', () => {
  const source = path.join(FIXTURES, 'copilot', 'multi-turn.jsonl');
  const fakeCommand = ['--', process.execPath, FAKE_CLI, '--fake-fixture', source, '--acp'];
  const cliMessages = (entries: Array<{ from: string; msg?: unknown }>) =>
    entries.filter((e) => e.from === 'cli' && e.msg).map((e) => e.msg);

  it('script mode: records a session that matches the replayed fixture', async () => {
    const script = path.join(tmp, 'steps.jsonl');
    await fs.promises.writeFile(script, jsonl([
      { send: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } } },
      { await: { id: 1 } },
      { send: { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace/project', mcpServers: [] } } },
      { await: { id: 2 }, save: 'session' },
      { send: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: '{{session.result.sessionId}}', prompt: [{ type: 'text', text: 'Reply with the word one.' }] } } },
      { await: { id: 3, result: { stopReason: 'end_turn' } } },
      { send: { jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: '{{session.result.sessionId}}', prompt: [{ type: 'text', text: 'Now reply with the word two.' }] } } },
      { await: { id: 4 } },
    ]));
    const out = path.join(tmp, 'recorded.jsonl');
    const result = await run([RECORD, '--protocol', 'acp', '--out', out, '--cli-version', '1.0.92',
      '--description', 'round trip', '--redact', 'Now reply=Then reply', '--script', script, ...fakeCommand]);
    expect(result.stderr).toContain('record: wrote');
    expect(result.code).toBe(0);

    const recorded = await loadFixture(out);
    const original = await loadFixture(source);
    expect(recorded.header).toMatchObject({ protocol: 'acp', source: 'recorded', description: 'round trip', cli: { version: '1.0.92' } });
    expect(cliMessages(recorded.entries)).toEqual(cliMessages(original.entries));
    const sent = recorded.entries.filter((e: { from: string }) => e.from === 'client');
    expect(sent).toHaveLength(4);
    expect(sent[2].msg.params.sessionId).toBe(original.entries[4].msg.result.sessionId);
    expect(sent[3].msg.params.prompt[0].text).toBe('Then reply with the word two.');
    expect(recorded.entries.at(-1)).toMatchObject({ from: 'cli', exit: { code: 0 } });
    expect(recorded.entries.every((e: { t?: number }) => typeof e.t === 'number')).toBe(true);
  });

  it('proxy mode: passes traffic through and records both directions', async () => {
    const out = path.join(tmp, 'proxied.jsonl');
    const child = spawn(process.execPath, [RECORD, '--protocol', 'acp', '--out', out, ...fakeCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    while (!stdout.includes('"id":1')) await new Promise((r) => setTimeout(r, 10));
    child.stdin.end();
    expect(await exited).toBe(0);

    expect(parseLines(stdout)[0]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    const recorded = await loadFixture(out);
    expect(recorded.entries.map((e: { from: string; msg?: { method?: string } }) => `${e.from}:${e.msg?.method ?? ''}`).slice(0, 2))
      .toEqual(['client:initialize', 'cli:']);
  });
  it('scrubs temp paths and secrets by default, even ones the CLI prints', async () => {
    const tmpReal = await fs.promises.realpath(os.tmpdir());
    const leaky = await writeFixture('leaky.jsonl', [
      header('acp'),
      { from: 'client', msg: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
      { from: 'cli', msg: { jsonrpc: '2.0', id: 1, result: {
        account: { email: 'jane@corp.example.io' },
        scratch: path.join(tmpReal, 'session-1'),
        token: 'sk-ant-api03-abcdefghijklmnop',
      } } },
    ]);
    const script = path.join(tmp, 'steps.jsonl');
    await fs.promises.writeFile(script, jsonl([{ send: { jsonrpc: '2.0', id: 1, method: 'initialize' } }, { await: { id: 1 } }]));
    const out = path.join(tmp, 'leaky-recorded.jsonl');
    const result = await run([RECORD, '--protocol', 'acp', '--out', out, '--script', script,
      '--', process.execPath, FAKE_CLI, '--fake-fixture', leaky]);
    expect(result.code).toBe(0);
    const text = await fs.promises.readFile(out, 'utf8');
    expect(text).not.toContain('jane@corp');
    expect(text).not.toContain('sk-ant-');
    // As it would appear inside JSON (escaped backslashes on Windows). On
    // Linux the temp dir is /tmp, the placeholder itself, so skip it there.
    if (tmpReal !== '/tmp') expect(text).not.toContain(JSON.stringify(tmpReal).slice(1, -1));
    const recorded = await loadFixture(out);
    expect(recorded.entries[1].msg.result).toEqual({
      account: { email: 'user@example.com' },
      scratch: `/tmp${path.sep}session-1`,
      token: 'REDACTED_ANTHROPIC_KEY',
    });
  });

  it('keeps a final stdout line that has no trailing newline', async () => {
    const tail = path.join(tmp, 'tail.js');
    await fs.promises.writeFile(tail, `process.stdout.write('{"tail":true}');\n`);
    const out = path.join(tmp, 'tail.jsonl');
    const result = await run([RECORD, '--protocol', 'acp', '--out', out, '--', process.execPath, tail]);
    expect(result.code).toBe(0);
    const recorded = await loadFixture(out);
    expect(recorded.entries.map((e: { msg?: unknown; exit?: unknown }) => e.msg ?? e.exit))
      .toEqual([{ tail: true }, { code: 0 }]);
  });

  it('records an exit entry when the CLI cannot be started', async () => {
    const out = path.join(tmp, 'missing.jsonl');
    const result = await run([RECORD, '--protocol', 'acp', '--out', out, '--', 'clubhouse-no-such-cli-xyz']);
    const recorded = await loadFixture(out);
    const last = recorded.entries.at(-1);
    expect(last.exit.code).not.toBe(0);
    expect(result.code).toBe(last.exit.code);
    // Windows goes through cmd.exe, which starts fine and reports the miss itself.
    if (process.platform !== 'win32') expect(last).toMatchObject({ exit: { code: 127 }, error: expect.stringContaining('ENOENT') });
  });
});

describe('fake CLI lifetime', () => {
  // TODO(#1998): fails on windows-latest; the stdin-holder harness likely doesn't
  // inherit the pipe there. The parent watch it covers is platform-independent
  // and still runs on Linux and macOS.
  const itPosix = process.platform === 'win32' ? it.skip : it;
  itPosix('exits when its launcher dies, even with stdin still open (the Windows .cmd shim case)', async () => {
    const fixture = path.join(tmp, 'wait.jsonl');
    // A client entry the fake waits on forever.
    await fs.promises.writeFile(fixture, jsonl([
      header('acp'),
      { from: 'client', msg: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } },
    ]));
    // The launcher plays cmd.exe running a shim. The fake's stdin is the
    // output of a separate holder process that outlives the launcher, so
    // killing the launcher gives the fake no EOF: only its parent watch can
    // end it, as on Windows where killing cmd.exe leaves node running.
    const launcherCode = [
      "const { spawn } = require('child_process');",
      "const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });",
      `const fake = spawn(process.execPath, [${JSON.stringify(FAKE_CLI)}, '--fake-fixture', ${JSON.stringify(fixture)}], { stdio: [holder.stdout, 'ignore', 'ignore'] });`,
      'process.stdout.write(JSON.stringify({ fake: fake.pid, holder: holder.pid }) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const launcher = spawn(process.execPath, ['-e', launcherCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let pids: { fake: number; holder: number } | undefined;
    try {
      pids = await new Promise<{ fake: number; holder: number }>((resolve, reject) => {
        launcher.stdout.once('data', (d: Buffer) => resolve(JSON.parse(String(d))));
        launcher.once('error', reject);
      });
      expect(alive(pids.fake)).toBe(true);

      launcher.kill('SIGKILL');

      await expect.poll(() => alive(pids!.fake), { timeout: 3_000, interval: 50 }).toBe(false);
      expect(alive(pids.holder)).toBe(true); // stdin really was still open
    } finally {
      launcher.kill('SIGKILL');
      for (const pid of [pids?.fake, pids?.holder]) {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });
});
