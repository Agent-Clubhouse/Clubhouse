// The fake Antigravity CLI (#3788). Its shapes are hand-built from Google's
// public docs and the vendored ACP v1 schema, not recorded from a real `agy`.
// These tests prove the fake does what its docs say. They prove nothing about
// the real CLI.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACP_SESSION_UPDATE_KINDS } from '../../src/main/chat/acp/protocol';
import schemaJson from '../../src/main/chat/acp/schema/schema.v1.json';
import { DEFAULTS, SYNTHESIZED, handlersFor } from './fake-agy.mjs';

const FAKE_AGY = path.join(__dirname, 'fake-agy.mjs');
const SCHEMA = schemaJson as unknown as {
  $defs: Record<string, { 'x-side'?: string; 'x-method'?: string; required?: string[]; oneOf?: Array<{ const?: string }> }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON-RPC traffic from a child process
type Json = Record<string, any>;

let tmp: string;
beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fake-agy-test-'));
});
afterEach(async () => {
  // Windows: a killed hook's process tree can hold the folder for a moment after taskkill.
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 30_000);

async function writeConfig(config: Json): Promise<string> {
  const file = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
  await fs.promises.writeFile(file, JSON.stringify(config));
  return file;
}

const readReport = async (personality?: string): Promise<Json> =>
  JSON.parse(await fs.promises.readFile(path.join(tmp, personality ? `report.json.${personality}.json` : 'report.json'), 'utf8'));

/** Run the fake to completion with `stdin` text. */
function run(agyArgs: string[], opts: { config?: string; stdin?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const fakeArgs = [...(opts.config ? ['--fake-agy-config', opts.config] : []), '--fake-agy-report', path.join(tmp, 'report.json')];
    const child = spawn(process.execPath, [FAKE_AGY, ...fakeArgs, ...agyArgs], { cwd: opts.cwd ?? tmp, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.stdin ?? '');
  });
}

const last = <T>(items: T[]): T => items[items.length - 1];
const ndjson = (text: string): Json[] => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** A JSON-RPC peer on the fake's `agy acp`. Every message the fake writes is kept and checked against the schema. */
class Acp {
  readonly messages: Json[] = [];
  readonly exited: Promise<number | null>;
  private buffer = '';
  private nextId = 1;
  private readonly sentMethods = new Map<unknown, string>();
  private readonly waiters = new Set<() => void>();
  readonly proc;

  constructor(agyArgs: string[] = [], opts: { config?: string; env?: NodeJS.ProcessEnv } = {}) {
    const fakeArgs = [...(opts.config ? ['--fake-agy-config', opts.config] : []), '--fake-agy-report', path.join(tmp, 'report.json')];
    this.proc = spawn(process.execPath, [FAKE_AGY, ...fakeArgs, 'acp', ...agyArgs], { cwd: tmp, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      const parts = (this.buffer + chunk).split('\n');
      this.buffer = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) this.messages.push(JSON.parse(line));
      for (const wake of this.waiters) wake();
    });
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
  }

  send(msg: Json): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  request(method: string, params: Json = {}): number {
    const id = this.nextId++;
    this.sentMethods.set(id, method);
    this.send({ id, method, params });
    return id;
  }

  async call(method: string, params: Json = {}): Promise<Json> {
    const id = this.request(method, params);
    return this.waitFor((m) => m.id === id && !('method' in m));
  }

  async waitFor(predicate: (m: Json) => boolean, timeoutMs = 5000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const done = () => { this.waiters.delete(done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.waiters.add(done);
      });
    }
  }

  updates(sessionId: string): Json[] {
    return this.messages.filter((m) => m.method === 'session/update' && m.params.sessionId === sessionId).map((m) => m.params.update);
  }

  async start(params: Json = {}): Promise<string> {
    await this.call('initialize', { protocolVersion: 1, clientInfo: { name: 'clubhouse', title: 'Clubhouse', version: '0.0.0-test' }, clientCapabilities: params.clientCapabilities ?? {} });
    const created = await this.call('session/new', { cwd: tmp, mcpServers: [] });
    return created.result.sessionId;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await this.exited;
    expectSchemaConformance(this.messages, this.sentMethods);
  }
}

/**
 * Every message the fake wrote names a method the schema has on the right
 * side and carries that definition's required fields; every update kind and
 * stop reason is the schema's.
 */
function expectSchemaConformance(messages: Json[], sentMethods: Map<unknown, string>): void {
  const defs = Object.entries(SCHEMA.$defs);
  const stopReasons = SCHEMA.$defs.StopReason.oneOf!.map((v) => v.const);
  for (const msg of messages) {
    expect(msg.jsonrpc).toBe('2.0');
    if (typeof msg.method === 'string') {
      const def = defs.find(([name, d]) => d['x-side'] === 'client' && d['x-method'] === msg.method && /(Request|Notification)$/.test(name));
      expect(def, `agent→client ${msg.method} is in the schema`).toBeDefined();
      for (const key of def![1].required ?? []) expect(msg.params, `${msg.method} has ${key}`).toHaveProperty(key);
      if (msg.method === 'session/update') expect(ACP_SESSION_UPDATE_KINDS).toContain(msg.params.update.sessionUpdate);
    } else if ('result' in msg) {
      const method = sentMethods.get(msg.id);
      if (!method) continue;
      const def = defs.find(([name, d]) => d['x-side'] === 'agent' && d['x-method'] === method && name.endsWith('Response'));
      expect(def, `response to ${method} is in the schema`).toBeDefined();
      for (const key of def![1].required ?? []) expect(msg.result, `${method} result has ${key}`).toHaveProperty(key);
      if (method === 'session/prompt') expect(stopReasons).toContain(msg.result.stopReason);
    } else {
      expect(msg.error).toMatchObject({ code: expect.any(Number), message: expect.any(String) });
    }
  }
}

describe('fake agy: labels', () => {
  it('marks itself document-derived and lists what it made up, in every session report', async () => {
    const result = await run(['-p', 'hi']);
    expect(result.code).toBe(0);
    const report = await readReport('headless');
    expect(report.source).toBe('document-derived');
    expect(report.source).not.toMatch(/record/i);
    expect(report.synthesized).toEqual(SYNTHESIZED);
    expect(SYNTHESIZED.some((s: string) => s.includes('steer'))).toBe(true);
  });
});

describe('fake agy: version, models, agents', () => {
  it('prints the configured version and leaves the report alone', async () => {
    expect((await run(['--version'])).stdout).toBe(`${DEFAULTS.version}\n`);
    const config = await writeConfig({ version: '1.4.0', versionOutput: 'agy version 1.4.0' });
    expect((await run(['--version'], { config })).stdout).toBe('agy version 1.4.0\n');
    expect(fs.existsSync(path.join(tmp, 'report.json'))).toBe(false);
  });

  it('lists models as the documented padded slug and display name columns', async () => {
    const { stdout, code } = await run(['models']);
    expect(code).toBe(0);
    const rows = stdout.trimEnd().split('\n');
    expect(rows[0]).toMatch(/^gemini-4-neon-high {3,}Gemini 4 Neon \(High\)$/);
    // The name column starts at the same offset on every row.
    const offsets = rows.map((r) => r.indexOf('Gemini'));
    expect(new Set(offsets).size).toBe(1);
    const config = await writeConfig({ models: [['m-a', 'Model A']], agents: ['reviewer', 'builder'] });
    expect((await run(['models'], { config })).stdout).toBe('m-a   Model A\n');
    expect((await run(['agents'], { config })).stdout).toBe('reviewer\nbuilder\n');
  });
});

describe('fake agy: headless', () => {
  it('stream-json: init, user_input, ACTIVE then DONE agent_response, result', async () => {
    const { code, stdout } = await run(['-p', 'hello', '--output-format', 'stream-json']);
    expect(code).toBe(0);
    const events = ndjson(stdout);
    expect(events.map((e) => e.event)).toEqual(['init', 'step_update', 'step_update', 'step_update', 'result']);
    expect(events[0].init).toMatchObject({ cwd: expect.any(String), tools: expect.any(Array), permission_mode: 'request-review' });
    expect(events[0].init).not.toHaveProperty('model');
    expect(events.slice(1, 4).map((e) => [e.step_update.step_type, e.step_update.state])).toEqual([
      ['user_input', 'DONE'], ['agent_response', 'ACTIVE'], ['agent_response', 'DONE'],
    ]);
    expect(events[4].result).toMatchObject({ status: 'SUCCESS', response: 'ok\n', num_turns: 1, usage: { total_tokens: expect.any(Number) } });
  });

  it('json prints one envelope; text prints the response', async () => {
    const json = await run(['-p', 'hello', '--output-format', 'json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: 'SUCCESS', response: 'ok\n', num_turns: 1 });
    expect((await run(['-p', 'hello'])).stdout).toBe('ok\n');
  });

  it('reports --model, --agent and --dangerously-skip-permissions in init', async () => {
    const { stdout } = await run(['-p', 'x', '--output-format', 'stream-json', '--model', 'gemini-4-neon-medium', '--agent', 'reviewer', '--dangerously-skip-permissions']);
    expect(ndjson(stdout)[0].init).toMatchObject({ model: 'gemini-4-neon-medium', agent: 'reviewer', permission_mode: 'always-proceed' });
  });

  it('an unknown model exits 1 with the documented error envelope and no fallback', async () => {
    const { code, stdout, stderr } = await run(['-p', 'hi', '--model', 'does-not-exist-model', '--output-format', 'json']);
    expect(code).toBe(1);
    const env = JSON.parse(stdout);
    expect(env).toMatchObject({ conversation_id: '', status: 'ERROR', response: '', num_turns: 0 });
    expect(env.error).toMatch(/^invalid model selection \(--model "does-not-exist-model" --effort ""\): model does-not-exist-model is not recognized/);
    expect(stderr).toContain('not recognized');
  });

  it('authentication required exits non-zero without hanging', async () => {
    const config = await writeConfig({ headless: { scenario: 'auth-required' } });
    const { code, stdout, stderr } = await run(['-p', 'hi', '--output-format', 'stream-json'], { config });
    expect(code).toBe(1);
    expect(stderr).toContain('authentication required');
    expect(ndjson(stdout)).toEqual([{ event: 'result', result: expect.objectContaining({ status: 'ERROR', error: 'authentication required' }) }]);
  });

  it('a soft-denied tool exits 0 with a stderr notice; skipping permissions runs it', async () => {
    const config = await writeConfig({ headless: { scenario: 'soft-deny' } });
    const denied = await run(['-p', 'hi', '--output-format', 'stream-json'], { config });
    expect(denied.code).toBe(0);
    expect(denied.stderr).toMatch(/run_command.*soft-denied/);
    const tool = ndjson(denied.stdout).find((e) => e.step_update?.step_type === 'tool');
    expect(tool.step_update.tool_info).toMatchObject({ name: 'run_command', error: { type: expect.any(String), message: expect.any(String) } });
    expect((await readReport('headless')).headless.softDenied).toEqual(['run_command']);

    const allowed = await run(['-p', 'hi', '--output-format', 'stream-json', '--dangerously-skip-permissions'], { config });
    expect(allowed.stderr).toBe('');
    expect(ndjson(allowed.stdout).find((e) => e.step_update?.step_type === 'tool').step_update.tool_info).toMatchObject({ output: 'fake\n' });
  });

  it('a turn error exits non-zero with an ERROR result', async () => {
    const config = await writeConfig({ headless: { scenario: 'error' } });
    const { code, stdout } = await run(['-p', 'hi', '--output-format', 'json'], { config });
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: expect.any(String) });
  });

  it('stream-json input: two turns with cumulative counters, both content forms, exit 0 on close', async () => {
    const stdin = [
      { event: 'user', message: { content: 'one' } },
      { event: 'future_thing' },
      { event: 'user', message: { content: [{ type: 'text', text: 'two' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    const { code, stdout, stderr } = await run(['--input-format', 'stream-json', '--output-format', 'stream-json'], { stdin });
    expect(code).toBe(0);
    expect(stderr).toBe('warning: ignoring unsupported stream input message event "future_thing"\n');
    const results = ndjson(stdout).filter((e) => e.event === 'result').map((e) => e.result);
    expect(results.map((r) => r.num_turns)).toEqual([1, 2]);
    expect(results[1].usage.total_tokens).toBe(results[0].usage.total_tokens * 2);
    expect((await readReport('headless')).headless.prompts).toEqual(['one', 'two']);
  });

  it.each([
    ['invalid JSON', '{nope', 1],
    ['a message with no event', JSON.stringify({ message: { content: 'x' } }), 1],
    ['a non-text block', JSON.stringify({ event: 'user', message: { content: [{ type: 'image', data: '' }] } }), 1],
    ['a control_request', JSON.stringify({ event: 'control_request' }), 2],
    ['a CLI slash command', JSON.stringify({ event: 'user', message: { content: '/model' } }), 2],
  ])('stream-json input: %s ends the session with exit %i', async (_what, line, exitCode) => {
    const { code, stdout } = await run(['--input-format', 'stream-json', '--output-format', 'stream-json'], { stdin: `${line}\n` });
    expect(code).toBe(exitCode);
    expect(last(ndjson(stdout))).toMatchObject({ event: 'result', result: { status: 'ERROR' } });
  });
});

describe('fake agy: TUI stub and hooks', () => {
  async function writeHooks(hooks: Json, scripts: Record<string, string> = {}) {
    await fs.promises.mkdir(path.join(tmp, '.agents'), { recursive: true });
    await fs.promises.writeFile(path.join(tmp, '.agents', 'hooks.json'), JSON.stringify(hooks));
    for (const [name, body] of Object.entries(scripts)) await fs.promises.writeFile(path.join(tmp, name), body);
  }
  /** A handler command: node running a script file in tmp. */
  const node = (file: string) => `"${process.execPath}" "${path.join(tmp, file)}"`;
  /** Script that appends its event's stdin payload to payloads.jsonl and prints `out`. */
  const logger = (out: unknown) => `const fs=require('fs');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{fs.appendFileSync(${JSON.stringify(path.join(tmp, 'payloads.jsonl'))},s+'\\n');process.stdout.write(${JSON.stringify(JSON.stringify(out))});});`;
  const payloads = async () => ndjson(await fs.promises.readFile(path.join(tmp, 'payloads.jsonl'), 'utf8'));

  it('prints argv on stderr, echoes input, and exits on /exit or /quit', async () => {
    const a = await run(['--model', 'm', '--mode', 'plan'], { stdin: 'hello\r/exit\r' });
    expect(a.code).toBe(0);
    expect(a.stderr).toBe('fake-agy tui argv=["--model","m","--mode","plan"]\n');
    expect(a.stdout).toContain('fake-agy: hello');
    expect((await readReport('tui')).tui.inputs).toEqual(['hello', '/exit']);
    const b = await run([], { stdin: '/quit\nnever\n' });
    expect(b.code).toBe(0);
    expect(b.stdout).not.toContain('never');
    const config = await writeConfig({ tui: { banner: 'none' } });
    expect((await run([], { config, stdin: '/exit\n' })).stderr).toBe('');
  });

  it('runs the documented named-hook map with camelCase payloads, honouring matcher and enabled', async () => {
    await writeHooks({
      'clubhouse-status': {
        SessionStart: [{ type: 'command', command: node('log.js') }],
        PreInvocation: [{ command: node('log.js') }],
        PreToolUse: [{ matcher: 'run_command|view_file', hooks: [{ type: 'command', command: node('log.js'), timeout: 5 }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ command: node('log.js') }] }],
        PostInvocation: [{ command: node('log.js') }],
        Stop: [{ command: node('log.js') }],
      },
      'other-tool': { PreToolUse: [{ matcher: 'browser_.*', hooks: [{ command: node('log.js') }] }] },
      disabled: { enabled: false, SessionStart: [{ command: node('log.js') }] },
    }, { 'log.js': logger({ decision: 'allow' }) });
    const { code } = await run([], { stdin: 'fix it\n/exit\n' });
    expect(code).toBe(0);
    const report = await readReport('tui');
    expect(report.hooks.map((h: Json) => `${h.name}:${h.event}`)).toEqual([
      'clubhouse-status:SessionStart', 'clubhouse-status:PreInvocation', 'clubhouse-status:PreToolUse',
      'clubhouse-status:PostToolUse', 'clubhouse-status:PostInvocation', 'clubhouse-status:Stop',
    ]);
    const seen = await payloads();
    for (const p of seen) {
      expect(p).toMatchObject({ conversationId: expect.any(String), workspacePaths: [expect.any(String)], transcriptPath: expect.stringMatching(/transcript\.jsonl$/), artifactDirectoryPath: expect.any(String), modelName: expect.any(String) });
    }
    expect(seen[1]).toMatchObject({ invocationNum: 0, initialNumSteps: 0, lastUserInput: 'fix it' });
    expect(seen[2]).toMatchObject({ toolCall: { name: 'run_command', args: expect.any(Object) }, stepIdx: 0 });
    expect(seen[5]).toMatchObject({ executionNum: 1, terminationReason: 'model_stop', fullyIdle: true });
  });

  it('a PreToolUse deny blocks the tool and skips PostToolUse', async () => {
    await writeHooks({ gate: { PreToolUse: [{ matcher: '', hooks: [{ command: node('deny.js') }] }], PostToolUse: [{ matcher: '', hooks: [{ command: node('deny.js') }] }] } }, { 'deny.js': logger({ decision: 'deny', reason: 'no' }) });
    const { stdout } = await run([], { stdin: 'go\n/exit\n' });
    expect(stdout).toContain('tool run_command denied by hook');
    const report = await readReport('tui');
    expect(report.tui.toolDecisions).toEqual([{ tool: 'run_command', decision: 'deny' }]);
    expect(report.hooks.map((h: Json) => h.event)).toEqual(['PreToolUse']);
  });

  it('a Stop "continue" re-enters the loop, bounded', async () => {
    await writeHooks({ more: { Stop: [{ command: node('more.js') }] } }, { 'more.js': logger({ decision: 'continue', reason: 'again' }) });
    await run([], { stdin: 'go\n/exit\n' });
    const stops = (await payloads()).map((p) => p.executionNum);
    expect(stops).toEqual([1, 2]);
  });

  it('a failing handler is ignored by default and denies under hooks.onFailure=deny (both assumptions)', async () => {
    await writeHooks({ broken: { PreToolUse: [{ matcher: '', hooks: [{ command: node('bad.js') }] }] } }, { 'bad.js': 'process.stdout.write("not json"); process.exit(3);' });
    await run([], { stdin: 'go\n/exit\n' });
    let report = await readReport('tui');
    expect(report.hooks[0]).toMatchObject({ exitCode: 3, failed: true, jsonOutput: false, decision: null });
    expect(report.tui.toolDecisions[0].decision).toBe('allow');
    const config = await writeConfig({ hooks: { onFailure: 'deny' } });
    await run([], { config, stdin: 'go\n/exit\n' });
    report = await readReport('tui');
    expect(report.tui.toolDecisions[0].decision).toBe('deny');
  });

  it('a handler past its timeout is killed and reported', async () => {
    // Ends on its own after 2 s, well past the 300 ms timeout under test, so a
    // Windows process tree that survives the kill can't hold the folder for long.
    await writeHooks({ slow: { SessionStart: [{ command: node('slow.js'), timeout: 1 }] } }, { 'slow.js': 'setTimeout(()=>{}, 2000);' });
    const config = await writeConfig({ hooks: { maxTimeoutMs: 300 } });
    const started = Date.now();
    await run([], { config, stdin: '/exit\n' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await readReport('tui')).hooks[0]).toMatchObject({ event: 'SessionStart', timedOut: true, failed: true });
  });

  it('hooks.env=minimal hides the launch environment from handlers; the default inherits it (an assumption)', async () => {
    const probe = `process.stdout.write(JSON.stringify({decision:'allow'})); require('fs').appendFileSync(${JSON.stringify(path.join(tmp, 'env.txt'))}, String('FAKE_AGY_SENTINEL' in process.env)+'\\n');`;
    await writeHooks({ env: { SessionStart: [{ command: node('env.js') }] } }, { 'env.js': probe });
    const env = { ...process.env, FAKE_AGY_SENTINEL: 'synthetic' };
    await run([], { env, stdin: '/exit\n' });
    await run([], { env, config: await writeConfig({ hooks: { env: 'minimal' } }), stdin: '/exit\n' });
    expect(await fs.promises.readFile(path.join(tmp, 'env.txt'), 'utf8')).toBe('true\nfalse\n');
  });

  it('reads hooks only from the working directory, and reports a broken file', async () => {
    await fs.promises.mkdir(path.join(tmp, '.agents'), { recursive: true });
    await fs.promises.writeFile(path.join(tmp, '.agents', 'hooks.json'), '{broken');
    expect((await run([], { stdin: '/exit\n' })).code).toBe(0);
    expect((await readReport('tui')).hooks[0].error).toMatch(/unreadable hooks file/);
  });

  it('handlersFor: matcher semantics and the two documented group shapes', () => {
    const hooks = {
      a: { PreToolUse: [{ matcher: 'run_.*', hooks: [{ command: 'x' }] }, { matcher: '*', hooks: [{ command: 'y' }] }], Stop: [{ command: 'z' }] },
      b: { PreToolUse: [{ matcher: '(', hooks: [{ command: 'bad-regex' }] }, { matcher: 'view_file', hooks: [{ command: 'v' }] }] },
      c: { Stop: [{ type: 'http', command: 'unsupported-type' }] },
    };
    expect(handlersFor(hooks, 'PreToolUse', 'run_command').map((h: Json) => h.handler.command)).toEqual(['x', 'y']);
    expect(handlersFor(hooks, 'PreToolUse', 'view_file').map((h: Json) => h.handler.command)).toEqual(['y', 'v']);
    expect(handlersFor(hooks, 'Stop', undefined).map((h: Json) => h.handler.command)).toEqual(['z']);
  });
});

describe('fake agy: ACP', () => {
  it('initialize: protocol 1, the documented server name and auth methods; terminal-login only with terminal auth', async () => {
    const acp = new Acp();
    const init = (await acp.call('initialize', { protocolVersion: 1, clientCapabilities: {} })).result;
    expect(init).toMatchObject({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server' } });
    expect(init.authMethods.map((m: Json) => m.id)).toEqual(['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform']);
    expect(init.agentCapabilities).toMatchObject({ loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: false }, sessionCapabilities: { resume: {}, list: {}, close: {} } });
    await acp.close();

    const withTerminal = new Acp(['--process-per-session']);
    const init2 = (await withTerminal.call('initialize', { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } })).result;
    expect(last(init2.authMethods as Json[])).toMatchObject({ type: 'terminal', id: 'terminal-login' });
    expect(init2.agentCapabilities.mcpCapabilities.http).toBe(true);
    await withTerminal.close();
  });

  it('auth required: initialize still answers with auth methods, sessions fail with -32000, authenticate is refused and counted', async () => {
    const acp = new Acp([], { config: await writeConfig({ acp: { auth: 'required' } }) });
    expect((await acp.call('initialize', { protocolVersion: 1 })).result.authMethods).toHaveLength(4);
    for (const method of ['session/new', 'session/load', 'session/resume', 'session/list']) {
      const answer = await acp.call(method, { cwd: tmp, mcpServers: [], sessionId: 'agy-session-stored' });
      expect(answer.error, method).toEqual({ code: -32000, message: 'Authentication required' });
    }
    expect((await acp.call('authenticate', { methodId: 'oauth-personal' })).error.code).toBe(-32000);
    await acp.close();
    expect((await readReport('acp')).acp.authenticateCalls).toBe(1);
  });

  it('authenticate can be configured to succeed, after which sessions open', async () => {
    const acp = new Acp([], { config: await writeConfig({ acp: { auth: 'required', authenticate: 'succeed' } }) });
    await acp.call('initialize', { protocolVersion: 1 });
    await acp.call('authenticate', { methodId: 'gemini-api-key' });
    expect((await acp.call('session/new', { cwd: tmp, mcpServers: [] })).result.sessionId).toBe('agy-session-1');
    await acp.close();
  });

  it('answers a different requested protocol version with its own', async () => {
    const acp = new Acp([], { config: await writeConfig({ acp: { protocolVersion: 2 } }) });
    expect((await acp.call('initialize', { protocolVersion: 1 })).result.protocolVersion).toBe(2);
    await acp.close();
  });

  it('session/new: model and thinking-level options by category, modes, and live changes; renamed ids still work', async () => {
    const acp = new Acp([], { config: await writeConfig({ acp: { configOptionIds: { model: 'opt-a', thoughtLevel: 'opt-b' }, autoMode: false, availableCommands: [{ name: 'usage', description: 'synthetic' }] } }) });
    await acp.call('initialize', { protocolVersion: 1 });
    const created = (await acp.call('session/new', { cwd: tmp, mcpServers: [] })).result;
    const byCategory = (opts: Json[], category: string) => opts.find((o) => o.category === category);
    expect(byCategory(created.configOptions, 'model')).toMatchObject({ id: 'opt-a', name: 'Model', type: 'select' });
    expect(byCategory(created.configOptions, 'thought_level').options.map((o: Json) => o.name)).toEqual(['Low', 'Medium', 'High', 'Extra', 'Max']);
    expect(created.modes.availableModes.map((m: Json) => m.id)).toEqual(['default', 'accept-edits', 'plan']);
    await acp.waitFor((m) => m.params?.update?.sessionUpdate === 'available_commands_update');

    const sessionId = created.sessionId;
    const set = (await acp.call('session/set_config_option', { sessionId, configId: 'opt-a', value: 'gemini-3.6-flash-medium' })).result;
    expect(byCategory(set.configOptions, 'model').currentValue).toBe('gemini-3.6-flash-medium');
    const thought = (await acp.call('session/set_config_option', { sessionId, configId: 'opt-b', value: 'max' })).result;
    expect(byCategory(thought.configOptions, 'thought_level').currentValue).toBe('max');
    expect((await acp.call('session/set_config_option', { sessionId, configId: 'model', value: 'x' })).error.code).toBe(-32602);
    expect((await acp.call('session/set_config_option', { sessionId, configId: 'opt-a', value: 'nope' })).error.code).toBe(-32602);
    expect((await acp.call('session/set_mode', { sessionId, modeId: 'plan' })).result).toEqual({});
    expect((await acp.call('session/set_mode', { sessionId, modeId: 'auto' })).error.code).toBe(-32602);
    await acp.close();
  });

  it('records MCP servers by name only: no env or header values reach the report', async () => {
    const acp = new Acp([], { env: { ...process.env, CLUBHOUSE_HOOK_NONCE: 'synthetic-nonce-value', CLUBHOUSE_AGENT_ID: 'agent-1', GEMINI_API_KEY: 'synthetic-key-value' } });
    await acp.call('initialize', { protocolVersion: 1 });
    await acp.call('session/new', {
      cwd: tmp,
      mcpServers: [
        { name: 'clubhouse', command: 'node', args: ['bridge.js'], env: [{ name: 'CLUBHOUSE_HOOK_NONCE', value: 'synthetic-secret-in-mcp' }] },
        { type: 'http', name: 'web', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'synthetic-header-secret' }] },
      ],
    });
    await acp.close();
    const text = await fs.promises.readFile(path.join(tmp, 'report.json.acp.json'), 'utf8');
    for (const secret of ['synthetic-secret-in-mcp', 'synthetic-header-secret', 'synthetic-nonce-value', 'synthetic-key-value']) expect(text).not.toContain(secret);
    const report = JSON.parse(text);
    expect(report.hookNoncePresent).toBe(true);
    expect(report.credentialKeysPresent).toContain('GEMINI_API_KEY');
    expect(report.env.CLUBHOUSE_AGENT_ID).toBe('agent-1');
    expect(report.acp.received[1].params.mcpServers).toEqual([
      { name: 'clubhouse', type: 'stdio', command: 'node', envNames: ['CLUBHOUSE_HOOK_NONCE'], headerNames: [] },
      { name: 'web', type: 'http', envNames: [], headerNames: ['Authorization'] },
    ]);
    // Also scoped per agent, like fake-cli.
    expect(fs.readdirSync(tmp).some((f) => /^report\.json\.agent-[0-9a-f]{64}\.json$/.test(f))).toBe(true);
  });

  it('a plain prompt echoes in two chunks; built-in scripts cover tool diff, usage, title, refusal, max tokens and error', async () => {
    const acp = new Acp();
    const sessionId = await acp.start();
    const prompt = (text: string) => acp.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    expect((await prompt('hello')).result).toEqual({ stopReason: 'end_turn' });
    expect(acp.updates(sessionId).map((u) => u.content?.text)).toEqual(['he', 'llo']);
    expect((await prompt('agy:tool')).result.stopReason).toBe('end_turn');
    expect(acp.updates(sessionId).find((u) => u.sessionUpdate === 'tool_call_update').content[0]).toMatchObject({ type: 'diff', path: 'notes.txt' });
    await prompt('agy:usage');
    expect(acp.updates(sessionId).find((u) => u.sessionUpdate === 'usage_update')).toMatchObject({ used: 1200, size: 1_000_000 });
    await prompt('agy:title');
    expect(acp.updates(sessionId).find((u) => u.sessionUpdate === 'session_info_update')).toMatchObject({ title: 'Fake title' });
    expect((await prompt('agy:refusal')).result.stopReason).toBe('refusal');
    expect((await prompt('agy:max-tokens')).result.stopReason).toBe('max_tokens');
    expect((await prompt('agy:error')).error).toEqual({ code: -32603, message: 'Internal error' });
    expect((await prompt('agy:auth')).error.code).toBe(-32000);
    expect((await prompt('agy:no-such-script')).error.code).toBe(-32602);
    // An error answer leaves the session usable.
    expect((await prompt('again')).result.stopReason).toBe('end_turn');
    await acp.close();
  });

  it('prompts on an unknown session and audio prompts are refused', async () => {
    const acp = new Acp();
    const sessionId = await acp.start();
    expect((await acp.call('session/prompt', { sessionId: 'nope', prompt: [{ type: 'text', text: 'x' }] })).error.code).toBe(-32002);
    expect((await acp.call('session/prompt', { sessionId, prompt: [{ type: 'audio', data: '', mimeType: 'audio/wav' }] })).error.code).toBe(-32602);
    // Images and embedded resources are accepted.
    const ok = await acp.call('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'file:///a.txt', text: 'a' } }, { type: 'text', text: 'see' }] });
    expect(ok.result.stopReason).toBe('end_turn');
    await acp.close();
  });

  it.each([
    ['allow', 'completed', 'ran it'],
    ['deny', 'failed', 'skipped it'],
  ])('permission %s: the turn pauses on request_permission and settles by the chosen option', async (optionId, status, text) => {
    const acp = new Acp();
    const sessionId = await acp.start();
    const promptId = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:permission' }] });
    const ask = await acp.waitFor((m) => m.method === 'session/request_permission');
    expect(ask.params.options.map((o: Json) => [o.optionId, o.name, o.kind])).toEqual([['allow', 'Allow', 'allow_once'], ['deny', 'Deny', 'reject_once']]);
    expect(acp.messages.some((m) => m.id === promptId && 'result' in m)).toBe(false);
    acp.send({ id: ask.id, result: { outcome: { outcome: 'selected', optionId } } });
    expect((await acp.waitFor((m) => m.id === promptId && !('method' in m))).result.stopReason).toBe('end_turn');
    expect(acp.updates(sessionId).find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({ status });
    expect(last(acp.updates(sessionId)).content.text).toBe(text);
    await acp.close();
  });

  it('--dangerously-skip-permissions auto-approves without asking', async () => {
    const acp = new Acp(['--dangerously-skip-permissions']);
    const sessionId = await acp.start();
    expect((await acp.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:permission' }] })).result.stopReason).toBe('end_turn');
    expect(acp.messages.some((m) => m.method === 'session/request_permission')).toBe(false);
    await acp.close();
    expect((await readReport('acp')).acp.autoApproved).toEqual(['call-run']);
  });

  it('cancel: ends open tool calls, abandons the pending permission request, answers cancelled; a late answer is recorded', async () => {
    const acp = new Acp();
    const sessionId = await acp.start();
    const promptId = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:permission' }] });
    const ask = await acp.waitFor((m) => m.method === 'session/request_permission');
    acp.send({ method: 'session/cancel', params: { sessionId } });
    expect((await acp.waitFor((m) => m.id === promptId && !('method' in m))).result).toEqual({ stopReason: 'cancelled' });
    expect(last(acp.updates(sessionId))).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'call-run', status: 'failed' });
    acp.send({ id: ask.id, result: { outcome: { outcome: 'cancelled' } } });
    // The session takes the next prompt.
    expect((await acp.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'next' }] })).result.stopReason).toBe('end_turn');
    await acp.close();
    const report = await readReport('acp');
    expect(report.acp.cancels).toBe(1);
    expect(report.acp.late).toEqual([{ id: ask.id, method: null, result: { outcome: { outcome: 'cancelled' } }, error: null }]);
  });

  it('cancel of a held turn answers cancelled; cancel with no turn is harmless', async () => {
    const acp = new Acp();
    const sessionId = await acp.start();
    acp.send({ method: 'session/cancel', params: { sessionId } });
    const promptId = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:hold' }] });
    await acp.waitFor((m) => m.params?.update?.content?.text === 'working');
    acp.send({ method: 'session/cancel', params: { sessionId } });
    expect((await acp.waitFor((m) => m.id === promptId && !('method' in m))).result.stopReason).toBe('cancelled');
    expect(acp.updates(sessionId).some((u) => u.content?.text === 'done')).toBe(false);
    await acp.close();
  });

  describe('steer (every variant is an assumption; the docs give no wire semantics)', () => {
    async function steer(variant: string) {
      const acp = new Acp([], { config: await writeConfig({ acp: { steer: variant } }) });
      const sessionId = await acp.start();
      const first = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:hold' }] });
      await acp.waitFor((m) => m.params?.update?.content?.text === 'working');
      const second = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'also this' }] });
      return { acp, sessionId, first, second };
    }
    const answerOf = (acp: Acp, id: number) => acp.waitFor((m) => m.id === id && !('method' in m));

    it('both-end: the steering prompt joins the running turn; both answers carry its stop reason, first first', async () => {
      const { acp, sessionId, first, second } = await steer('both-end');
      expect((await answerOf(acp, second)).result.stopReason).toBe('end_turn');
      const order = acp.messages.filter((m) => (m.id === first || m.id === second) && !('method' in m)).map((m) => m.id);
      expect(order).toEqual([first, second]);
      expect(acp.updates(sessionId).map((u) => u.content?.text)).toEqual(['working', 'steered: also this', 'done']);
      await acp.close();
      expect((await readReport('acp')).acp.steers).toEqual([{ sessionId, text: 'also this', variant: 'both-end' }]);
    });

    it('join-first-ends: the steering prompt is answered at once; the first carries the turn end', async () => {
      const { acp, first, second } = await steer('join-first-ends');
      const firstAnswer = await answerOf(acp, first);
      const secondIndex = acp.messages.findIndex((m) => m.id === second && !('method' in m));
      expect(secondIndex).toBeLessThan(acp.messages.indexOf(firstAnswer));
      expect(firstAnswer.result.stopReason).toBe('end_turn');
      await acp.close();
    });

    it('second-rejected: the steering prompt gets an error; the turn is unaffected until cancelled', async () => {
      const { acp, sessionId, first, second } = await steer('second-rejected');
      expect((await answerOf(acp, second)).error.code).toBe(-32602);
      acp.send({ method: 'session/cancel', params: { sessionId } });
      expect((await answerOf(acp, first)).result.stopReason).toBe('cancelled');
      await acp.close();
    });

    it('both-end under cancel: both prompts are answered cancelled', async () => {
      const { acp, sessionId, second } = await steer('both-end');
      // The steer released the hold and the turn finished; start a fresh held one to cancel.
      await answerOf(acp, second);
      const a = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:permission' }] });
      await acp.waitFor((m) => m.method === 'session/request_permission');
      const b = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'steer' }] });
      acp.send({ method: 'session/cancel', params: { sessionId } });
      expect((await answerOf(acp, a)).result.stopReason).toBe('cancelled');
      expect((await answerOf(acp, b)).result.stopReason).toBe('cancelled');
      await acp.close();
    });
  });

  it('questions: an elicitation form when the client advertises it, otherwise the question in chat', async () => {
    const acp = new Acp();
    const sessionId = await acp.start({ clientCapabilities: { elicitation: { form: {} } } });
    const promptId = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:question' }] });
    const ask = await acp.waitFor((m) => m.method === 'elicitation/create');
    expect(ask.params).toMatchObject({ sessionId, mode: 'form', message: 'Which file?', requestedSchema: { type: 'object' } });
    acp.send({ id: ask.id, result: { action: 'accept', content: { file: 'a.txt' } } });
    await acp.waitFor((m) => m.id === promptId && !('method' in m));
    expect(last(acp.updates(sessionId)).content.text).toBe('answer: accept {"file":"a.txt"}');
    await acp.close();

    const plain = new Acp();
    const plainSession = await plain.start();
    await plain.call('session/prompt', { sessionId: plainSession, prompt: [{ type: 'text', text: 'agy:question' }] });
    expect(plain.messages.some((m) => m.method === 'elicitation/create')).toBe(false);
    expect(last(plain.updates(plainSession)).content.text).toBe('Which file?');
    await plain.close();
  });

  it('load replays history before answering; resume does not; list and close', async () => {
    const acp = new Acp();
    await acp.call('initialize', { protocolVersion: 1 });
    const listed = (await acp.call('session/list', {})).result.sessions;
    expect(listed).toEqual([{ sessionId: 'agy-session-stored', cwd: expect.any(String), title: 'Stored fake conversation', updatedAt: expect.any(String) }]);
    const loadId = acp.request('session/load', { sessionId: 'agy-session-stored', cwd: tmp, mcpServers: [] });
    const loaded = await acp.waitFor((m) => m.id === loadId && !('method' in m));
    const replayed = acp.updates('agy-session-stored');
    expect(replayed.map((u) => u.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk']);
    const lastUpdate = acp.messages.map((m) => m.method).lastIndexOf('session/update');
    expect(acp.messages.indexOf(loaded)).toBeGreaterThan(lastUpdate);
    expect(loaded.result.configOptions).toHaveLength(2);

    const before = acp.messages.length;
    expect((await acp.call('session/resume', { sessionId: 'agy-session-stored', cwd: tmp, mcpServers: [] })).result.configOptions).toHaveLength(2);
    expect(acp.messages.slice(before).filter((m) => m.method === 'session/update' && m.params.update.sessionUpdate !== 'available_commands_update')).toEqual([]);
    expect((await acp.call('session/resume', { sessionId: 'gone', cwd: tmp, mcpServers: [] })).error.code).toBe(-32002);
    expect((await acp.call('session/load', { sessionId: 'gone', cwd: tmp, mcpServers: [] })).error.code).toBe(-32002);

    // A new session's turns are kept and replayed on a later load.
    const created = (await acp.call('session/new', { cwd: tmp, mcpServers: [] })).result.sessionId;
    await acp.call('session/prompt', { sessionId: created, prompt: [{ type: 'text', text: 'hi there' }] });
    expect((await acp.call('session/list', { cwd: tmp })).result.sessions.map((s: Json) => s.sessionId)).toContain(created);
    expect((await acp.call('session/close', { sessionId: created })).result).toEqual({});
    expect((await acp.call('session/prompt', { sessionId: created, prompt: [{ type: 'text', text: 'x' }] })).error.code).toBe(-32002);
    const reloadStart = acp.messages.length;
    await acp.call('session/load', { sessionId: created, cwd: tmp, mcpServers: [] });
    const history = acp.messages.slice(reloadStart).filter((m) => m.method === 'session/update').map((m) => m.params.update);
    expect(history.map((u) => [u.sessionUpdate, u.content.text])).toEqual([['user_message_chunk', 'hi there'], ['agent_message_chunk', 'hi'], ['agent_message_chunk', ' there']]);
    await acp.close();
  });

  it('closing a session mid-turn answers its prompt cancelled', async () => {
    const acp = new Acp();
    const sessionId = await acp.start();
    const promptId = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:hold' }] });
    await acp.waitFor((m) => m.params?.update?.content?.text === 'working');
    await acp.call('session/close', { sessionId });
    expect((await acp.waitFor((m) => m.id === promptId && !('method' in m))).result.stopReason).toBe('cancelled');
    await acp.close();
  });

  it('agy:exit:<n> exits mid-turn with no answer; config scripts run by name', async () => {
    const acp = new Acp([], { config: await writeConfig({ acp: { scripts: { mine: [{ chunk: 'custom' }, { end: 'refusal' }] } } }) });
    const sessionId = await acp.start();
    expect((await acp.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:mine' }] })).result.stopReason).toBe('refusal');
    const promptId = acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'agy:exit:7' }] });
    expect(await acp.exited).toBe(7);
    expect(acp.messages.some((m) => m.id === promptId)).toBe(false);
  });

  it('unknown methods get -32601; a non-JSON line gets a parse error', async () => {
    const acp = new Acp();
    await acp.call('initialize', { protocolVersion: 1 });
    expect((await acp.call('session/fork', {})).error.code).toBe(-32601);
    acp.proc.stdin.write('{nope\n');
    expect((await acp.waitFor((m) => m.error?.code === -32700)).id).toBeNull();
    await acp.close();
  });

  it('acp --help answers; an agy without ACP rejects the command; --login is not simulated', async () => {
    expect(await run(['acp', '--help'])).toMatchObject({ code: 0, stdout: expect.stringContaining('agy acp') });
    const old = await run(['acp'], { config: await writeConfig({ acp: { supported: false } }) });
    expect(old).toMatchObject({ code: 1, stderr: expect.stringContaining('unknown command "acp"') });
    expect((await run(['acp', '--login'])).code).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'report.json'))).toBe(false);
  });
});
