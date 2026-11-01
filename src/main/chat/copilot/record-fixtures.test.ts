/**
 * Records test/chat-fixtures/copilot-sdk/ by running the real driver, through
 * scripts/chat-fixtures/record.mjs, against the runtime npm installs and a local
 * fake model. Nothing reaches a real model: the session's provider is the fake,
 * the CLI doesn't log in, and its home and tokens are throwaways.
 *
 * Skipped unless CLUBHOUSE_RECORD_COPILOT_SDK=1, on macOS or Linux. CI never runs it.
 * Re-run it when the driver's traffic changes or the SDK is bumped, under a
 * sandbox with no outbound network (docs/chat-fixtures.md).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { COPILOT_OPTION_ALLOW, COPILOT_OPTION_DENY } from './normalizer';
import { CopilotSdkChatDriver } from './driver';
import { startFakeModel, type FakeModel } from './__fixtures__/fake-model';

const REPO = path.resolve(__dirname, '../../../..');
const RECORDER = path.join(REPO, 'scripts/chat-fixtures/record.mjs');
const OUT = process.env.CLUBHOUSE_RECORD_COPILOT_SDK_OUT ?? path.join(REPO, 'test/chat-fixtures/copilot-sdk');
const platform = `${process.platform}-${process.arch}`;
const runtime = path.join(REPO, 'node_modules/@github', `copilot-sdk-${platform}`, 'prebuilds', platform, 'copilot-runtime');
const enabled = process.env.CLUBHOUSE_RECORD_COPILOT_SDK === '1' && process.platform !== 'win32';

type Entry = { from: string; t?: number; msg?: any; match?: unknown; raw?: string; stderr?: string; exit?: { code: number } };

const fixtureFile = (name: string) => path.join(OUT, `${name}.jsonl`);

function readFixture(name: string): { header: Record<string, unknown>; entries: Entry[] } {
  const [header, ...entries] = fs.readFileSync(fixtureFile(name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { header, entries };
}

function writeFixture(name: string, header: Record<string, unknown>, entries: Entry[]): void {
  fs.writeFileSync(fixtureFile(name), [header, ...entries].map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const eventType = (e: Entry): string | undefined => e.msg?.params?.event?.type;

/**
 * Cut what only makes a recording large, none of which a driver reads: the CLI's
 * system prompt (twice), its built-in skills, and the tool list in its snapshots.
 * Drop models.list and session.commands.list, which run in the background so can
 * land anywhere: replay answers them as standing queries. Keep the command list
 * in slash-command, where a command waits for it. Pin the decisions these fixtures exist for.
 */
function tidy(name: string): void {
  const { header, entries } = readFixture(name);
  const standing = name === 'slash-command' ? ['models.list'] : ['models.list', 'session.commands.list'];
  const listIds = new Set(entries.filter((e) => e.from === 'client' && standing.includes(e.msg?.method)).map((e) => e.msg.id));
  const kept = entries.filter((e) => !standing.includes(e.msg?.method) && !(e.from === 'cli' && !e.msg?.method && listIds.has(e.msg?.id)));
  for (const entry of kept) {
    const event = entry.msg?.params?.event;
    if (event?.type === 'system.message') event.data = { role: event.data.role, content: '(trimmed)' };
    if (event?.type === 'session.skills_loaded') event.data.skills = event.data.skills.slice(0, 1);
    if (event?.type === 'model.messages_snapshot') event.data = { trimmed: true };
    if (entry.from !== 'client') continue;
    const { method, params } = entry.msg ?? {};
    if (/handlePending/.test(method ?? '')) entry.match = { params: { result: params.result } };
    // An answer to a request the CLI made: a question or a plan.
    if (!method && entry.msg?.result) entry.match = { result: entry.msg.result };
    if (method === 'session.commands.invoke') entry.match = { params: { name: params.name } };
    if (method === 'session.mode.set') entry.match = { params: { mode: params.mode } };
    if (method === 'session.send' && params.mode) entry.match = { params: { mode: params.mode } };
  }
  writeFixture(name, header, kept);
}

const RUN_TOOL = { name: 'bash', args: { command: 'echo hi', description: 'say hi', mode: 'sync', initial_wait: 5 } };

function watch(session: ChatDriverSession) {
  const drafts: ChatEventDraft[] = [];
  void (async () => { for await (const d of session.events) drafts.push(d); })();
  const until = async (fn: () => boolean): Promise<void> => {
    const deadline = Date.now() + 45_000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`Timed out. Saw: ${drafts.map((d) => d.type).join(' ')}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const of = <K extends ChatEventDraft['type']>(type: K) => drafts.filter((d) => d.type === type) as Array<Extract<ChatEventDraft, { type: K }>>;
  return { of, until, turns: (n: number) => until(() => of('turn_ended').length >= n) };
}

describe.skipIf(!enabled)('record the copilot-sdk fixtures', () => {
  let model: FakeModel;
  let tmp: string;
  let env: Record<string, string>;
  let version: string;

  beforeAll(async () => {
    model = await startFakeModel();
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'copilot-sdk-record-'));
    const invalid = 'invalid-test-token';
    env = {
      HOME: tmp, USERPROFILE: tmp, COPILOT_HOME: path.join(tmp, '.copilot'), XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_STATE_HOME: path.join(tmp, 'state'),
      COPILOT_GITHUB_TOKEN: invalid, GH_TOKEN: invalid, GITHUB_TOKEN: invalid,
    };
    const probe = await new CopilotSdkChatDriver().probe(runtime, env);
    version = probe.cliVersion ?? 'unknown';
    fs.mkdirSync(OUT, { recursive: true });
  });
  afterAll(() => {
    model.close();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the CLI can still be flushing logs */ }
  });

  /** A "copilot" that is really the recorder in front of the runtime. */
  function recorder(name: string, description: string): string {
    const shim = path.join(tmp, `record-${name}.sh`);
    const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const args = [
      process.execPath, RECORDER, '--protocol', 'copilot-sdk', '--cli-name', 'copilot', '--cli-version', version,
      '--description', description, '--out', path.join(OUT, `${name}.jsonl`),
      '--redact', `${model.baseUrl}=http://127.0.0.1:0/v1`,
      '--redact', `${REPO}=/workspace/clubhouse`,
      // The CLI's HOME is a throwaway, so the recorder wouldn't know this one.
      '--redact', `${os.homedir()}=/home/user`,
      '--', runtime,
    ];
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${args.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
    return shim;
  }

  const byok = () => ({ ...env, COPILOT_PROVIDER_BASE_URL: model.baseUrl, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'fake-key', COPILOT_MODEL: 'fake-model' });

  /** Run one session through the recorder, then close it so the fixture is written. */
  async function session(name: string, description: string, run: (s: ChatDriverSession, w: ReturnType<typeof watch>) => Promise<void>, overrides: Partial<ChatDriverStartOptions> = {}): Promise<string | undefined> {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    const started = await new CopilotSdkChatDriver().start({
      agentId: 'a1', provider: 'copilot-cli', cwd, binaryPath: recorder(name, description), level: 'ask',
      env: byok(), extraArgs: ['--no-auto-login'], ...overrides,
    });
    const w = watch(started);
    await run(started, w);
    const id = started.nativeSessionId;
    await started.close();
    model.reset();
    tidy(name);
    return id;
  }

  const say = (s: ChatDriverSession, text: string) => s.send([{ type: 'text', text }], 'prompt');

  it('handshake', async () => {
    const probe = await new CopilotSdkChatDriver().probe(recorder('handshake', 'Probe: connect, status and login with no session. Logged out, recorded with no credentials.'), env);
    expect(probe.handshakeOk).toBe(true);
  }, 60_000);

  it('multi-turn', async () => {
    await session('multi-turn', 'Two turns with streamed text and usage, against a local fake model.', async (s, w) => {
      model.script({ text: 'one' }, { text: 'two' });
      await say(s, 'Reply with the word one.');
      await w.turns(1);
      await say(s, 'Now reply with the word two.');
      await w.turns(2);
    });
  }, 90_000);

  it('interrupt', async () => {
    await session('interrupt', 'A held model call stopped by session.abort; the session stays usable.', async (s, w) => {
      model.script({ text: 'partial', hold: true }, { text: 'after' });
      await say(s, 'Take your time.');
      await w.until(() => w.of('agent_message_chunk').length > 0);
      await s.interrupt();
      await w.turns(1);
      model.release();
      await say(s, 'Are you there?');
      await w.turns(2);
    });
  }, 90_000);

  it('permission-approve-edit', async () => {
    await session('permission-approve-edit', 'A file edit the client allows, with the resulting diff.', async (s, w) => {
      model.script({ tools: [{ name: 'create', args: { path: 'note.txt', file_text: 'hello\n' } }] }, { text: 'done' });
      await say(s, 'Write the note.');
      await w.until(() => w.of('permission_request').length > 0);
      await s.respondPermission(w.of('permission_request')[0].data.requestId, COPILOT_OPTION_ALLOW);
      await w.turns(1);
    });
  }, 90_000);

  it('permission-deny', async () => {
    await session('permission-deny', 'A shell command the client denies with a reason, which the model sees before continuing.', async (s, w) => {
      model.script({ tools: [RUN_TOOL] }, { text: 'understood' });
      await say(s, 'Run it.');
      await w.until(() => w.of('permission_request').length > 0);
      await s.respondPermission(w.of('permission_request')[0].data.requestId, COPILOT_OPTION_DENY, { message: 'not that one' });
      await w.turns(1);
    });
  }, 90_000);

  it('turn-error', async () => {
    await session('turn-error', 'The model call fails with a 400 and the turn ends in session.error, then a turn recovers.', async (s, w) => {
      model.script({ status: 400 }, { text: 'recovered' });
      await say(s, 'This one fails.');
      await w.turns(1);
      await say(s, 'This one works.');
      await w.turns(2);
    });
  }, 90_000);

  it('session-info', async () => {
    await session('session-info', 'A model and effort change, seen in session.model_change, then a turn.', async (s, w) => {
      await s.setModel('fake-model-2', 'high');
      await w.until(() => w.of('model_changed').length > 0);
      model.script({ text: 'ok' });
      await say(s, 'Which model?');
      await w.turns(1);
    });
  }, 90_000);

  it('resume', async () => {
    const id = await session('resume-source', 'Scratch: the first half of the resume recording.', async (s, w) => {
      model.script({ text: 'remembered' });
      await say(s, 'Remember this.');
      await w.turns(1);
    });
    fs.rmSync(path.join(OUT, 'resume-source.jsonl'), { force: true });
    await session('resume', 'A second process resumes a stored session without replaying its history, then runs a turn.', async (s, w) => {
      model.script({ text: 'still here' });
      await say(s, 'Do you remember?');
      await w.turns(1);
    }, { resumeNativeSessionId: id });
  }, 120_000);

  it('resume-not-found', async () => {
    await session('resume-not-found', 'Resuming a session the CLI does not have fails at once; the driver starts a new one.', async () => undefined, { resumeNativeSessionId: '00000000-0000-4000-8000-000000000000' });
  }, 90_000);

  it('steer', async () => {
    await session('steer', 'A message steered into a running turn. It reaches the next model call, and the turn ends once.', async (s, w) => {
      model.script({ hold: true, tools: [{ name: 'no_such_tool' }] }, { text: 'after' });
      await say(s, 'ORIGINAL');
      await w.until(() => model.holding());
      await s.send([{ type: 'text', text: 'STEER-TEXT' }], 'steer');
      model.release();
      await w.turns(1);
    });
  }, 90_000);

  it('queue', async () => {
    await session('queue', 'A message queued natively during a turn, which runs as its own turn afterwards.', async (s, w) => {
      model.script({ hold: true, text: 'one' }, { text: 'two' });
      await say(s, 'FIRST');
      await w.until(() => model.holding());
      await s.send([{ type: 'text', text: 'QUEUED-TEXT' }], 'queued');
      await new Promise((r) => setTimeout(r, 200));
      model.release();
      await w.turns(2);
    });
  }, 90_000);

  it('question', async () => {
    await session('question', 'ask_user with choices, answered by the client.', async (s, w) => {
      model.script({ tools: [{ name: 'ask_user', args: { question: 'Colour?', choices: ['blue', 'red'] } }] }, { text: 'ok' });
      await say(s, 'ask me');
      await w.until(() => w.of('question').length > 0);
      const { requestId, questions } = w.of('question')[0].data;
      await s.answerQuestion(requestId, { [questions[0].id]: 'red' });
      await w.turns(1);
    });
  }, 90_000);

  it('slash-command', async () => {
    await session('slash-command', 'A command with text output, then one the CLI refuses. Neither reaches the model.', async (s, w) => {
      await say(s, '/session');
      await w.turns(1);
      await say(s, '/compact');
      await w.turns(2);
    });
  }, 90_000);

  /** A stdio MCP server whose `ask` tool sends a form and reports what came back. */
  function elicitingServer(): Record<string, unknown> {
    const script = path.join(fs.mkdtempSync(path.join(tmp, 'mcp-')), 'server.js');
    const form = { message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' }, age: { type: 'integer', title: 'Age' } }, required: ['name', 'age'] } };
    fs.writeFileSync(script, `
      const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      let done;
      require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const m = JSON.parse(line);
        const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
        if (m.id === 999 && !m.method) return done(m.result ?? m.error);
        if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'asker', version: '1' } });
        if (m.method === 'tools/list') return reply({ tools: [{ name: 'ask', description: 'ask', inputSchema: { type: 'object', properties: {} } }] });
        if (m.method === 'tools/call') {
          done = (r) => reply({ content: [{ type: 'text', text: 'SERVER-GOT ' + JSON.stringify(r) }] });
          return send({ jsonrpc: '2.0', id: 999, method: 'elicitation/create', params: ${JSON.stringify(form)} });
        }
        if (m.id !== undefined) reply({});
      });
    `);
    return { asker: { command: process.execPath, args: [script] } };
  }

  async function askThroughServer(s: ChatDriverSession, w: ReturnType<typeof watch>): Promise<void> {
    await new Promise((r) => setTimeout(r, 1_500));
    model.script({ text: 'ready' });
    await say(s, 'hi');
    await w.turns(1);
    const ask = model.tools.at(-1)?.find((n) => n.startsWith('asker') && n.endsWith('ask'));
    model.script({ tools: [{ name: ask ?? 'missing' }] }, { text: 'after' });
    await say(s, 'ask');
    await w.until(() => w.of('permission_request').length > 0);
  }

  it('elicitation-accept', async () => {
    await session('elicitation-accept', 'A stdio server asks for a form; the client accepts and answers with typed values.', async (s, w) => {
      await askThroughServer(s, w);
      await s.respondPermission(w.of('permission_request')[0].data.requestId, 'accept');
      await w.until(() => w.of('question').length > 0);
      await s.answerQuestion(w.of('question')[0].data.requestId, { name: 'Ann', age: '30' });
      await w.turns(2);
    }, { level: 'full_access', mcpServers: elicitingServer() });
  }, 90_000);

  it('elicitation-decline', async () => {
    await session('elicitation-decline', 'A stdio server asks for a form; the client declines.', async (s, w) => {
      await askThroughServer(s, w);
      await s.respondPermission(w.of('permission_request')[0].data.requestId, 'decline');
      await w.turns(2);
    }, { level: 'full_access', mcpServers: elicitingServer() });
  }, 90_000);

  it('plan-approval', async () => {
    await session('plan-approval', 'The level changes to Plan, exit_plan_mode asks, and approving returns to the earlier level.', async (s, w) => {
      await s.setLevel('plan');
      model.script({ tools: [{ name: 'exit_plan_mode', args: { summary: 'THE-PLAN', actions: ['interactive'], recommendedAction: 'interactive' } }] }, { text: 'ok' });
      await say(s, 'plan it');
      await w.until(() => w.of('permission_request').length > 0);
      await s.respondPermission(w.of('permission_request')[0].data.requestId, 'approve');
      await w.turns(1);
    }, { level: 'auto_edit' });
  }, 90_000);

  it('subagent', async () => {
    await session('subagent', 'A task subagent with its own tool call and message, whose idle does not end the turn.', async (s, w) => {
      model.script(
        { tools: [{ name: 'task', args: { description: 'look', prompt: 'SUB', agent_type: 'explore', name: 'scout' } }] },
        { tools: [{ name: 'grep', args: { pattern: 'zzz-no-match' } }] },
        { text: 'sub result' },
        { text: 'done' },
      );
      await say(s, 'delegate');
      await w.turns(1);
    }, { level: 'full_access' });
  }, 90_000);

  // No real session does these on purpose. Each comes from docs/copilot-sdk-driver.md
  // "Fallback" or from cutting up a recording.
  it('hand-made', () => {
    const handMade = (description: string, extra: Record<string, unknown> = {}) => ({
      kind: 'header', format: 'clubhouse-chat-fixture', version: 1, protocol: 'copilot-sdk', cli: { name: 'copilot', version }, source: 'hand-made', args: ['--headless', '--port', '0'], description, ...extra,
    });
    const { entries: handshake } = readFixture('handshake');
    const { entries: turns } = readFixture('multi-turn');
    const connect = handshake[0];

    writeFixture('protocol-mismatch', handMade('The CLI reports a protocol version the SDK does not support.'), [
      connect, { from: 'cli', msg: { ...handshake[1].msg, result: { ...handshake[1].msg.result, protocolVersion: 99 } } },
    ]);
    writeFixture('exit-at-launch', handMade('The CLI rejects --headless and exits, as 0.0.400 and older do, without opening a port.'), [
      { from: 'cli', stderr: "error: unknown option '--headless'" }, { from: 'cli', exit: { code: 1 } },
    ]);
    writeFixture('hang-at-launch', handMade('The CLI stays up and never opens a port.', { listen: false }), []);
    writeFixture('no-answer', handMade('The CLI opens its port, then never answers connect.'), [connect]);

    const firstDelta = turns.findIndex((e) => eventType(e) === 'assistant.message_delta');
    writeFixture('died-mid-turn', handMade('The CLI crashes while a turn streams. The SDK fires no session event for this.'), [
      ...turns.slice(0, firstDelta + 1), { from: 'cli', stderr: 'fatal: out of memory' }, { from: 'cli', exit: { code: 1 } },
    ]);

    const sessionId = turns.find((e) => e.msg?.method === 'session.create')?.msg.params.sessionId;
    const stray = (type: string, data: unknown) => ({ from: 'cli', msg: { jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, data, id: `drift-${type}`, timestamp: '2026-11-01T00:00:00.000Z', parentId: null } } } });
    const drift: Entry[] = [
      stray('future.event', { anything: true }),
      { from: 'cli', raw: 'WARN a line on stdout that is not part of the protocol' },
      { from: 'cli', msg: { jsonrpc: '2.0', id: 9000, method: 'future.request', params: { sessionId } } },
      { from: 'client', msg: { jsonrpc: '2.0', id: 9000, error: { code: -32601, message: 'Unhandled method future.request' } } },
    ];
    const withField = turns.map((e) => (eventType(e) === 'assistant.message' ? { ...e, msg: { ...e.msg, params: { ...e.msg.params, futureField: 1, event: { ...e.msg.params.event, futureField: 1 } } } } : e));
    const firstIdle = withField.findIndex((e) => eventType(e) === 'session.idle');
    writeFixture('schema-drift', handMade('Unknown event types and fields, an unknown CLI request the client must refuse, and a stray stdout line, in the first turn of multi-turn.'), [
      ...withField.slice(0, firstIdle), ...drift, ...withField.slice(firstIdle),
    ]);
  });
});
