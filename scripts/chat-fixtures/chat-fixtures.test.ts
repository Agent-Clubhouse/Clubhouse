import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fillTemplate,
  loadFixture,
  matchClientMessage,
  messageKey,
  parseFixture,
  redactValue,
  remapCliMessage,
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
  await fs.promises.rm(tmp, { recursive: true, force: true });
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

  it('every committed fixture parses and covers the six scenarios per CLI', async () => {
    const scenarios = ['interrupt', 'multi-turn', 'permission-approve-edit', 'permission-deny', 'schema-drift', 'turn-error'];
    for (const [cli, protocol] of [['claude', 'claude-stream-json'], ['codex', 'codex-app-server'], ['copilot', 'acp']]) {
      const names = (await fs.promises.readdir(path.join(FIXTURES, cli))).map((f) => f.replace(/\.jsonl$/, '')).sort();
      expect(names).toEqual(scenarios);
      for (const name of names) {
        const { header: h } = await loadFixture(path.join(FIXTURES, cli, `${name}.jsonl`));
        expect(h.protocol).toBe(protocol);
        expect(h.description).toBeTruthy();
      }
    }
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
      { id: 1, method: 'model/list' },
      { id: 2, method: 'initialize' },
      { method: 'initialized' },
    ]);
    expect(out.code).toBe(0);
    const r = JSON.parse(await fs.promises.readFile(report, 'utf8'));
    expect(r.complete).toBe(true);
    expect(r.unexpected).toEqual([{ id: 1, method: 'model/list' }]);
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
});
