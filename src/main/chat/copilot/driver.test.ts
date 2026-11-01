/**
 * The driver against the real runtime npm installs (@github/copilot-sdk-<platform>)
 * and a local fake model. Nothing reaches a real model: the session's provider is
 * the fake, the CLI is told not to log in, and tokens and home are throwaways.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { COMPACTION_STARTED, type ChatEventDraft } from '../../../shared/chat/events';
import type { ChatDriverSession, ChatDriverStartOptions } from '../../../shared/chat/runtime';
import { COPILOT_OPTION_ALLOW, COPILOT_OPTION_DENY } from './normalizer';
import { COPILOT_SDK_CAPABILITIES, copilotPlanAction, CopilotSdkChatDriver, toSdkMcpServers } from './driver';
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

  it('steers a running turn: the message reaches the next model request, and the turn ends once', async () => {
    const { session, of, until, endedTurns } = await open({ level: 'full_access' });
    model.script({ hold: true, tools: [{ name: 'no_such_tool' }] }, { text: 'after' });
    await session.send([{ type: 'text', text: 'ORIGINAL' }], 'prompt');
    await until(() => (model.holding() ? true : undefined));
    expect(await session.send([{ type: 'text', text: 'STEER-TEXT' }], 'steer')).toBe('steer');
    model.release();
    await endedTurns(1);
    expect(model.requests.at(-1)?.text).toContain('STEER-TEXT');
    expect(of('turn_started')).toHaveLength(1);
  }, 90_000);

  it('queues natively: the message runs as its own turn after the first', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ hold: true, text: 'one' }, { text: 'two' });
    await session.send([{ type: 'text', text: 'FIRST' }], 'prompt');
    await until(() => (model.holding() ? true : undefined));
    expect(await session.send([{ type: 'text', text: 'QUEUED-TEXT' }], 'queued')).toBe('queued');
    await new Promise((r) => setTimeout(r, 200));
    model.release();
    await endedTurns(2);
    expect(of('turn_started').map((t) => t.data.trigger)).toEqual(['prompt', 'queued']);
    expect(of('turn_ended').map((t) => t.data.stopReason)).toEqual(['end_turn', 'end_turn']);
    expect(model.requests.at(-1)?.text).toContain('QUEUED-TEXT');
    expect(of('agent_message').find((m) => m.data.text === 'two')?.turnId).toBe('turn-2');
  }, 90_000);

  it('asks the user a question and gives the model the answer', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ tools: [{ name: 'ask_user', args: { question: 'Colour?', choices: ['blue', 'red'] } }] }, { text: 'ok' });
    await session.send([{ type: 'text', text: 'ask me' }], 'prompt');
    const question = await until(() => of('question')[0]);
    expect(question.data.questions[0]).toMatchObject({ prompt: 'Colour?', allowFreeText: true, options: [{ id: 'blue', label: 'blue' }, { id: 'red', label: 'red' }] });
    expect(question.data.toolCallId).toBe(of('tool_call')[0].data.toolCallId);
    await session.answerQuestion(question.data.requestId, { [question.data.questions[0].id]: 'red' });
    await endedTurns(1);
    expect(of('question_resolved')[0].data.answers).toEqual({ answer: 'red' });
    expect(model.requests.at(-1)?.text).toContain('red');
  }, 90_000);

  it('cancels an open question when interrupted', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ tools: [{ name: 'ask_user', args: { question: 'Colour?' } }] }, { text: 'after' });
    await session.send([{ type: 'text', text: 'ask me' }], 'prompt');
    await until(() => of('question')[0]);
    await session.interrupt();
    await endedTurns(1);
    expect(of('question_resolved')[0].data.cancelled).toBe(true);
  }, 90_000);

  const PLAN_TOOL = { name: 'exit_plan_mode', args: { summary: 'THE-PLAN', actions: ['interactive'], recommendedAction: 'interactive' } };

  it('shows a plan for approval, and approving returns to the level the user acted at', async () => {
    const { session, of, until, endedTurns } = await open({ level: 'auto_edit' });
    await session.setLevel('plan');
    expect(of('mode_changed').at(-1)?.data.level).toBe('plan');
    model.script({ tools: [PLAN_TOOL] }, { text: 'ok' });
    await session.send([{ type: 'text', text: 'plan it' }], 'prompt');
    const request = await until(() => of('permission_request')[0]);
    expect(request.data.toolName).toBe('exit_plan_mode');
    expect(of('plan_document')[0].data).toMatchObject({ markdown: 'THE-PLAN', status: 'ready', toolCallId: request.data.toolCallId });
    await session.respondPermission(request.data.requestId, 'approve');
    await endedTurns(1);
    expect(of('permission_resolved')[0].data.decision).toBe('allow');
    expect(of('mode_changed').at(-1)?.data).toMatchObject({ level: 'auto_edit', nativeMode: 'interactive' });
  }, 90_000);

  it('keeps planning when a plan is sent back with a reason', async () => {
    const { session, of, until, endedTurns } = await open({ level: 'plan' });
    model.script({ tools: [PLAN_TOOL] }, { text: 'ok' });
    await session.send([{ type: 'text', text: 'plan it' }], 'prompt');
    const request = await until(() => of('permission_request')[0]);
    await session.respondPermission(request.data.requestId, 'reject', { message: 'ADD-TESTS' });
    await endedTurns(1);
    expect(of('permission_resolved')[0].data.decision).toBe('deny');
    expect(of('mode_changed').filter((m) => m.data.level !== 'plan')).toEqual([]);
    expect(model.requests.at(-1)?.text).toContain('ADD-TESTS');
  }, 90_000);

  it('never picks autopilot when approving a plan', () => {
    expect(copilotPlanAction({ actions: ['autopilot', 'interactive', 'exit_only'], recommendedAction: 'autopilot' })).toBe('interactive');
    expect(copilotPlanAction({ actions: ['autopilot', 'exit_only'], recommendedAction: 'autopilot' })).toBe('exit_only');
    expect(copilotPlanAction({ actions: ['autopilot'], recommendedAction: 'autopilot' })).toBeUndefined();
  });

  it('puts a subagent\'s work under it, and its own idle and model don\'t speak for the session', async () => {
    const { session, of, endedTurns } = await open({ level: 'full_access' });
    model.script(
      { tools: [{ name: 'task', args: { description: 'look', prompt: 'SUB', agent_type: 'explore', name: 'scout' } }] },
      { tools: [{ name: 'grep', args: { pattern: 'zzz-no-match' } }] },
      { text: 'sub result' },
      { text: 'done' },
    );
    await session.send([{ type: 'text', text: 'delegate' }], 'prompt');
    await endedTurns(1);
    const task = of('tool_call').find((t) => t.data.toolName === 'task')!;
    const statuses = of('subagent').map((s) => s.data.status);
    expect(statuses[0]).toBe('running');
    expect(statuses.at(-1)).toBe('completed');
    expect(of('subagent')[0].data).toMatchObject({ subagentId: task.data.toolCallId, name: 'scout', description: 'look' });
    expect(of('tool_call').find((t) => t.data.toolName === 'grep')?.data.subagentId).toBe(task.data.toolCallId);
    expect(of('agent_message').find((m) => m.data.text === 'sub result')?.data.subagentId).toBe(task.data.toolCallId);
    expect(of('agent_message').at(-1)?.data).toMatchObject({ text: 'done' });
    expect(of('agent_message').at(-1)?.data.subagentId).toBeUndefined();
    expect(of('turn_ended')).toHaveLength(1);
    expect(of('model_changed')).toEqual([]);
  }, 90_000);

  it('changes model and effort live, and reports what the CLI applied', async () => {
    const { session, of, until, endedTurns } = await open();
    expect(of('session_info')[0].data.model).toBe('fake-model');
    await session.setModel('fake-model-2', 'high');
    await until(() => of('model_changed')[0]);
    expect(of('model_changed')[0].data).toMatchObject({ modelId: 'fake-model-2', effort: 'high' });
    model.script({ text: 'ok' });
    await session.send([{ type: 'text', text: 'hi' }], 'prompt');
    await endedTurns(1);
    expect(model.requests.at(-1)?.model).toBe('fake-model-2');
    expect(model.requests.at(-1)?.effort).toBe('high');
    await expect(session.setModel('fake-model-2', null)).rejects.toThrow(/default/);
  }, 90_000);

  it('applies the agent\'s saved effort at start', async () => {
    const { session, endedTurns } = await open({ effort: 'low' });
    model.script({ text: 'ok' });
    await session.send([{ type: 'text', text: 'hi' }], 'prompt');
    await endedTurns(1);
    expect(model.requests.at(-1)?.effort).toBe('low');
  }, 90_000);

  it('applies the level again after a resume, as the CLI\'s own record can be stale', async () => {
    const first = await open({ level: 'plan' });
    model.script({ text: 'noted' });
    await first.session.send([{ type: 'text', text: 'hi' }], 'prompt');
    await first.endedTurns(1);
    const id = first.session.nativeSessionId;
    await first.session.close();
    sessions.splice(sessions.indexOf(first.session), 1);

    const asks = await open({ resumeNativeSessionId: id, level: 'ask' });
    model.script({ tools: [RUN_TOOL] }, { text: 'done' });
    await asks.session.send([{ type: 'text', text: 'run it' }], 'prompt');
    const request = await asks.until(() => asks.of('permission_request')[0]);
    expect(request.data.toolName).toBe('bash');
    await asks.session.respondPermission(request.data.requestId, COPILOT_OPTION_ALLOW);
    await asks.endedTurns(1);
    await asks.session.close();
    sessions.splice(sessions.indexOf(asks.session), 1);

    const full = await open({ resumeNativeSessionId: id, level: 'full_access' });
    model.script({ tools: [RUN_TOOL] }, { text: 'done' });
    await full.session.send([{ type: 'text', text: 'run it' }], 'prompt');
    await full.endedTurns(1);
    expect(full.of('permission_request')).toEqual([]);
  }, 120_000);

  it('loads a stdio MCP server, and sees a tool it adds mid-session', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mcp-'));
    const script = path.join(dir, 'server.js');
    fs.writeFileSync(script, `
      const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
      let flipped = false;
      require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const m = JSON.parse(line);
        const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1' } });
        if (m.method === 'tools/list') return reply({ tools: [tool('flip'), ...(flipped ? [tool('beta')] : [])] });
        if (m.method === 'tools/call') { flipped = true; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return reply({ content: [{ type: 'text', text: 'flipped' }] }); }
        if (m.id !== undefined) reply({});
      });
    `);
    const { session, of, endedTurns } = await open({ level: 'full_access', mcpServers: { fake: { command: process.execPath, args: [script] } } });
    // The CLI reports its servers as a turn starts, and may still be connecting on the first.
    await new Promise((r) => setTimeout(r, 1_500));
    model.script({ text: 'ready' });
    await session.send([{ type: 'text', text: 'hi' }], 'prompt');
    await endedTurns(1);
    expect(of('session_info').some((i) => i.data.mcpServers?.some((m) => m.name === 'fake'))).toBe(true);
    const flip = model.tools.at(-1)?.find((n) => n.endsWith('flip'));
    expect(flip).toBeDefined();
    model.script({ tools: [{ name: flip! }] }, { text: 'ok' });
    await session.send([{ type: 'text', text: 'flip' }], 'prompt');
    await endedTurns(2);
    expect(of('notice').map((n) => n.data.code)).not.toContain('mcp_servers_unsupported');
    expect(of('tool_call_update').some((u) => JSON.stringify(u.data.content).includes('flipped'))).toBe(true);
    await new Promise((r) => setTimeout(r, 1_000));
    model.script({ text: 'ok' });
    await session.send([{ type: 'text', text: 'next' }], 'prompt');
    await endedTurns(3);
    expect(model.tools.at(-1)?.some((n) => n.endsWith('beta'))).toBe(true);
  }, 120_000);

  it('sends an image, inline or from a file', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const file = path.join(tmp, 'pixel.png');
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    const vision = new CopilotSdkChatDriver({
      sessionOverrides: { model: 'fake-model', provider: { type: 'openai', baseUrl: model.baseUrl, apiKey: 'fake' }, modelCapabilities: { supports: { vision: true } } },
    });
    const session = await vision.start(options());
    sessions.push(session);
    const { endedTurns } = watch(session);
    model.script({ text: 'seen' });
    await session.send([{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: png }], 'prompt');
    await endedTurns(1);
    expect(model.requests.at(-1)?.text).toContain('image_url');
    model.script({ text: 'seen' });
    await session.send([{ type: 'text', text: 'again' }, { type: 'image', mimeType: 'image/png', path: file }], 'prompt');
    await endedTurns(2);
    expect(model.requests.at(-1)?.text.match(/image_url/g)?.length).toBeGreaterThanOrEqual(2);
    await expect(session.send([{ type: 'image', mimeType: 'image/png', uri: 'https://example.com/x.png' }], 'prompt')).rejects.toThrow(/only inline data or local files/);
  }, 90_000);

  it('compacts on request, and says so', async () => {
    const { session, of, until, endedTurns } = await open();
    model.script({ text: 'one' });
    await session.send([{ type: 'text', text: 'hi' }], 'prompt');
    await endedTurns(1);
    await session.compact();
    await until(() => of('notice').find((n) => n.data.code === 'compacted'));
    expect(of('notice').map((n) => n.data.code)).toContain(COMPACTION_STARTED);
  }, 90_000);

  it('launches through a shim and a command prefix', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'shim-'));
    const shim = process.platform === 'win32' ? path.join(dir, 'copilot.cmd') : path.join(dir, 'copilot');
    fs.writeFileSync(shim, process.platform === 'win32' ? `@"${runtime}" %*\r\n` : `#!/bin/sh\nexec "${runtime}" "$@"\n`, { mode: 0o755 });
    const viaShim = await driver.start(options({ binaryPath: shim }));
    sessions.push(viaShim);
    const a = watch(viaShim);
    model.script({ text: 'through the shim' });
    await viaShim.send([{ type: 'text', text: 'hi' }], 'prompt');
    await a.endedTurns(1);
    expect(a.of('agent_message').at(-1)?.data.text).toBe('through the shim');
    expect((await driver.probe(shim, { ...baseEnv, COPILOT_PROVIDER_BASE_URL: model.baseUrl })).handshakeOk).toBe(true);
    expect((await driver.probe(runtime, { ...baseEnv, COPILOT_PROVIDER_BASE_URL: model.baseUrl }, { commandPrefix: process.platform === 'win32' ? 'set CLUBHOUSE_PREFIX_RAN=1' : 'export CLUBHOUSE_PREFIX_RAN=1' })).handshakeOk).toBe(true);
    await viaShim.close();
    sessions.splice(sessions.indexOf(viaShim), 1);
    await a.pumped;
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
