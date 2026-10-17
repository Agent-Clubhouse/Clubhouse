/**
 * Drives the protocol clients against the fake CLI replaying committed
 * fixtures: real child processes and real stdio, zero tokens. One describe
 * block per protocol, one test per fixture scenario.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient, RpcError } from './acp-client';
import { CodexAppServerClient, textInput } from './codex-app-server-client';
import type { CodexUnrecognizedMessage } from './codex-protocol';
import {
  EventLog,
  NdjsonPeer,
  chatFixturePath,
  createFakeCli,
  type ChatFixtureCli,
  type FakeCli,
} from './testing/fake-cli';

type Notification = { method: string; params: Record<string, unknown> };
type ServerRequest = Notification & { id: number | string };
type LogEntry = { level: string; message: string };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fake(cli: ChatFixtureCli, name: string, cliArgs: string[] = []): Promise<FakeCli> {
  const handle = await createFakeCli(chatFixturePath(cli, name), { cliArgs });
  cleanups.push(() => handle.dispose());
  return handle;
}

/** The fixture was replayed end to end with every client message matching. */
async function expectFixtureComplete(handle: FakeCli): Promise<void> {
  const report = await handle.waitForReport((r) => r.complete || r.mismatch !== null);
  expect(report.mismatch).toBeNull();
  expect(report.complete).toBe(true);
}

// ───────────────────────────── Copilot (ACP) ─────────────────────────────

describe('AcpClient against fake Copilot ACP', () => {
  async function startAcp(name: string) {
    const handle = await fake('copilot', name, ['--acp', '--no-auto-update']);
    const updates = new EventLog<Notification>();
    const requests = new EventLog<ServerRequest>();
    const logs: LogEntry[] = [];
    const client = new AcpClient({
      binary: handle.binary,
      args: handle.args,
      rpcTimeoutMs: 5000,
      onNotification: (method, params) => updates.push({ method, params: params as Record<string, unknown> }),
      onServerRequest: (id, method, params) => requests.push({ id, method, params: params as Record<string, unknown> }),
      onLog: (level, message) => logs.push({ level, message }),
    });
    cleanups.push(() => client.kill());
    await client.start();
    const session = await client.request('session/new', { cwd: '/workspace/project', mcpServers: [] }) as { sessionId: string };
    const prompt = (text: string) =>
      client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }, { timeoutMs: null }) as
        Promise<{ stopReason: string }>;
    const updateKinds = () => updates.items
      .filter((n) => n.method === 'session/update')
      .map((n) => (n.params.update as { sessionUpdate: string }).sessionUpdate);
    return { handle, client, session, prompt, updates, requests, logs, updateKinds };
  }

  it('multi-turn: two prompts stream chunks and end with end_turn', async () => {
    const { handle, prompt, updates, updateKinds } = await startAcp('multi-turn');
    expect((await prompt('Reply with the word one.')).stopReason).toBe('end_turn');
    expect((await prompt('Now reply with the word two.')).stopReason).toBe('end_turn');

    const text = updates.items
      .map((n) => (n.params.update as { sessionUpdate: string; content?: { text: string } }))
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.content?.text)
      .join('');
    expect(text).toBe('onetwo');
    expect(updateKinds()).toContain('agent_thought_chunk');
    const report = await handle.waitForReport();
    expect(report.argv).toEqual(['--acp', '--no-auto-update']);
    await expectFixtureComplete(handle);
  });

  it('interrupt: session/cancel ends the prompt with stopReason cancelled', async () => {
    const { handle, client, session, prompt, updates } = await startAcp('interrupt');
    const pending = prompt('Run the test suite.');
    await updates.waitFor((n) => (n.params.update as { status?: string }).status === 'in_progress');
    client.notify('session/cancel', { sessionId: session.sessionId });
    expect((await pending).stopReason).toBe('cancelled');
    await expectFixtureComplete(handle);
  });

  it('permission approve: allow_once, then the tool call completes with a diff', async () => {
    const { handle, client, prompt, requests, updates } = await startAcp('permission-approve-edit');
    const pending = prompt('Use a template literal in greet.');
    const ask = await requests.waitFor({ method: 'session/request_permission' });
    const options = ask.params.options as Array<{ optionId: string }>;
    expect(options.map((o) => o.optionId)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    client.respond(ask.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect((await pending).stopReason).toBe('end_turn');

    const done = await updates.waitFor((n) => (n.params.update as { status?: string }).status === 'completed');
    const content = (done.params.update as { content: Array<{ type: string; oldText: string; newText: string }> }).content;
    expect(content[0].type).toBe('diff');
    expect(content[0].newText).toContain('`Hello, ${name}!`');
    await expectFixtureComplete(handle);
  });

  it('permission deny: reject_once fails the tool call', async () => {
    const { handle, client, prompt, requests, updates } = await startAcp('permission-deny');
    const pending = prompt('Clean the build output.');
    const ask = await requests.waitFor({ method: 'session/request_permission' });
    client.respond(ask.id, { outcome: { outcome: 'selected', optionId: 'reject_once' } });
    expect((await pending).stopReason).toBe('end_turn');
    await updates.waitFor((n) => (n.params.update as { status?: string }).status === 'failed');
    await expectFixtureComplete(handle);
  });

  it('a wrong permission answer is caught as a fixture mismatch', async () => {
    const { handle, client, prompt, requests } = await startAcp('permission-deny');
    const pending = prompt('Clean the build output.').catch((err: Error) => err);
    const ask = await requests.waitFor({ method: 'session/request_permission' });
    client.respond(ask.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(await pending).toBeInstanceOf(Error);
    const report = await handle.waitForReport((r) => r.mismatch !== null);
    expect(report.mismatch?.reason).toContain('reject_once');
    expect(report.exitCode).toBe(3);
  });

  it('turn error: the prompt rejects with the RPC error and the session recovers', async () => {
    const { handle, client, prompt } = await startAcp('turn-error');
    const err = await prompt('Summarize the repo.').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32603);
    expect(client.getStderr()).toContain('429 Too Many Requests');
    expect((await prompt('Try again.')).stopReason).toBe('end_turn');
    await expectFixtureComplete(handle);
  });

  it('schema drift: unknown updates pass through, unknown requests get method-not-found, stray lines are logged', async () => {
    const { handle, client, prompt, requests, updates, updateKinds, logs } = await startAcp('schema-drift');
    const pending = prompt('Hello.');
    const unknown = await requests.waitFor({ method: '_copilot/confirm_upgrade' });
    client.respondWithError(unknown.id, -32601, 'Method not found');
    expect((await pending).stopReason).toBe('end_turn');

    expect(updateKinds()).toContain('hologram_update');
    expect(updates.items.map((n) => n.method)).toContain('_copilot/quota_snapshot');
    expect(logs.some((l) => l.message.startsWith('Malformed JSON line'))).toBe(true);
    await expectFixtureComplete(handle);
  });
});

// ───────────────────────────── Codex (app-server v2) ─────────────────────────────

describe('CodexAppServerClient against fake codex app-server', () => {
  async function startCodex(name: string, startThread = true) {
    const handle = await fake('codex', name, ['app-server']);
    const notes = new EventLog<Notification>();
    const requests = new EventLog<ServerRequest>();
    const unrecognized = new EventLog<CodexUnrecognizedMessage>();
    const logs: LogEntry[] = [];
    const client = new CodexAppServerClient({
      binary: handle.binary,
      args: handle.args,
      rpcTimeoutMs: 5000,
      onCodexNotification: (n) => notes.push(n as unknown as Notification),
      onCodexServerRequest: (r) => requests.push(r as unknown as ServerRequest),
      onUnrecognizedMessage: (m) => {
        unrecognized.push(m);
        if (m.kind === 'notification') notes.push({ method: m.method, params: m.params as Record<string, unknown> });
      },
      onLog: (level, message) => logs.push({ level, message }),
    });
    cleanups.push(() => client.kill());
    const init = await client.start();
    expect(init.userAgent).toContain('0.159.3');
    let threadId = '';
    if (startThread) {
      const started = await client.threadStart({ cwd: '/workspace/project', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
      threadId = started.thread.id;
    }
    const startTurn = async (text: string, thread = threadId) =>
      (await client.turnStart({ threadId: thread, input: [textInput(text)] })).turn.id;
    const turnCompleted = async () =>
      (await notes.waitFor({ method: 'turn/completed' })).params.turn as { status: string; error: { message: string } | null };
    return { handle, client, notes, requests, unrecognized, logs, startTurn, turnCompleted, threadId };
  }

  it('multi-turn: deltas assemble into each agent message', async () => {
    const { handle, notes, startTurn, turnCompleted } = await startCodex('multi-turn');
    await startTurn('Reply with the word one.');
    expect((await turnCompleted()).status).toBe('completed');
    await startTurn('Now reply with the word two.');
    expect((await turnCompleted()).status).toBe('completed');

    const messages = notes.items
      .filter((n) => n.method === 'item/completed')
      .map((n) => n.params.item as { type: string; text?: string })
      .filter((item) => item.type === 'agentMessage')
      .map((item) => item.text);
    expect(messages).toEqual(['one', 'two']);
    const deltas = notes.items.filter((n) => n.method === 'item/agentMessage/delta').map((n) => n.params.delta);
    expect(deltas.join('')).toBe('onetwo');
    const report = await handle.waitForReport();
    expect(report.argv).toEqual(['app-server']);
    await expectFixtureComplete(handle);
  });

  it('interrupt: turnInterrupt targets the tracked active turn and the turn ends interrupted', async () => {
    const { handle, client, notes, startTurn, turnCompleted, threadId } = await startCodex('interrupt');
    const turnId = await startTurn('Run the test suite.');
    await notes.waitFor({ method: 'item/commandExecution/outputDelta' });
    expect(client.getActiveTurnId(threadId)).toBe(turnId);
    await client.turnInterrupt(threadId);
    expect((await turnCompleted()).status).toBe('interrupted');
    expect(client.getActiveTurnId(threadId)).toBeUndefined();
    await expectFixtureComplete(handle);
  });

  it('permission approve: accepting a fileChange publishes the turn diff', async () => {
    const { handle, client, notes, requests, startTurn, turnCompleted } = await startCodex('permission-approve-edit');
    await startTurn('Use a template literal in greet.');
    const ask = await requests.waitFor({ method: 'item/fileChange/requestApproval' });
    client.respondToFileChangeApproval(ask.id, 'accept');
    const diff = await notes.waitFor({ method: 'turn/diff/updated' });
    expect(diff.params.diff).toContain('+  return `Hello, ${name}!`;');
    expect((await turnCompleted()).status).toBe('completed');
    const patched = notes.items
      .filter((n) => n.method === 'item/completed')
      .map((n) => n.params.item as { type: string; status?: string })
      .find((item) => item.type === 'fileChange');
    expect(patched?.status).toBe('completed');
    expect(client.getOpenServerRequests().size).toBe(0);
    await expectFixtureComplete(handle);
  });

  it('permission deny: declining a command marks the item declined', async () => {
    const { handle, client, notes, requests, startTurn, turnCompleted } = await startCodex('permission-deny');
    await startTurn('Clean the build output.');
    const ask = await requests.waitFor({ method: 'item/commandExecution/requestApproval' });
    expect(ask.params.command).toBe('rm -rf dist');
    client.respondToCommandApproval(ask.id, 'decline');
    expect((await turnCompleted()).status).toBe('completed');
    const command = notes.items
      .filter((n) => n.method === 'item/completed')
      .map((n) => n.params.item as { type: string; status?: string })
      .find((item) => item.type === 'commandExecution');
    expect(command?.status).toBe('declined');
    await expectFixtureComplete(handle);
  });

  it('turn error: a failed resume rejects with RpcError, and a failed turn reports its error', async () => {
    const { handle, client, notes, startTurn, turnCompleted } = await startCodex('turn-error', false);
    const err = await client.threadResume({ threadId: '019a0000-0000-7000-8000-0000000dead0' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32600);
    const started = await client.threadStart({ cwd: '/workspace/project' });
    await startTurn('Summarize the repo.', started.thread.id);
    const turn = await turnCompleted();
    expect(turn.status).toBe('failed');
    expect(turn.error?.message).toContain('rate limit');
    const retries = notes.items.filter((n) => n.method === 'error').map((n) => n.params.willRetry);
    expect(retries).toEqual([true, false]);
    await expectFixtureComplete(handle);
  });

  it('schema drift: unknown items pass through, unknown requests are refused for us, stray lines are logged', async () => {
    const { handle, notes, unrecognized, logs, startTurn, turnCompleted } = await startCodex('schema-drift');
    await startTurn('Hello.');
    // The client answers the unknown request with method-not-found itself;
    // the fixture's `match` checks that reply reached the CLI.
    expect(await unrecognized.waitFor({ kind: 'request' })).toMatchObject({ method: 'item/tool/requestTeleport' });
    expect((await turnCompleted()).status).toBe('completed');
    expect(unrecognized.items.map((m) => m.kind === 'notification' && m.method)).toContain('item/hologram/delta');
    const hologram = notes.items.find((n) => n.method === 'item/started' && (n.params.item as { type: string }).type === 'hologram');
    expect(hologram).toBeDefined();
    expect(logs.some((l) => l.message.startsWith('Malformed JSON line'))).toBe(true);
    await expectFixtureComplete(handle);
  });
});

// ───────────────────────────── Claude (stream-json + control protocol) ─────────────────────────────

describe('stream-json peer against fake Claude Code', () => {
  const CLAUDE_ARGS = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'default',
  ];

  async function startClaude(name: string) {
    const handle = await fake('claude', name, CLAUDE_ARGS);
    const peer = NdjsonPeer.start(handle.binary, handle.args);
    cleanups.push(() => peer.kill());
    // A request id unlike the fixture's: the fake remaps it on the response.
    peer.send({ type: 'control_request', request_id: 'live-init', request: { subtype: 'initialize', hooks: null } });
    const init = await peer.waitFor({ type: 'control_response' });
    expect(init).toMatchObject({ response: { subtype: 'success', request_id: 'live-init' } });
    const user = (text: string) =>
      peer.send({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
    const result = () => peer.waitFor({ type: 'result' }) as Promise<{ subtype: string; is_error: boolean; result: string }>;
    return { handle, peer, user, result };
  }

  it('multi-turn: one result per turn, partials before the final assistant message', async () => {
    const { handle, peer, user, result } = await startClaude('multi-turn');
    user('Reply with the word one.');
    expect((await result()).result).toBe('one');
    user('Now reply with the word two.');
    expect((await result()).result).toBe('two');
    expect(peer.messages.items.filter((m) => m.type === 'stream_event').length).toBeGreaterThan(0);
    expect((await handle.readReport()).argv).toEqual(CLAUDE_ARGS);
    await expectFixtureComplete(handle);
  });

  it('interrupt: the control response arrives and the turn ends as error_during_execution', async () => {
    const { handle, peer, user, result } = await startClaude('interrupt');
    user('Run the test suite.');
    await peer.waitFor((m) => m.type === 'assistant');
    peer.send({ type: 'control_request', request_id: 'live-interrupt', request: { subtype: 'interrupt' } });
    await peer.waitFor({ type: 'control_response', response: { request_id: 'live-interrupt' } });
    expect((await result()).subtype).toBe('error_during_execution');
    await expectFixtureComplete(handle);
  });

  it('permission approve: can_use_tool allow, then a structuredPatch tool result', async () => {
    const { handle, peer, user, result } = await startClaude('permission-approve-edit');
    user('Use a template literal in greet.');
    const ask = await peer.waitFor({ type: 'control_request', request: { subtype: 'can_use_tool' } }) as
      { request_id: string; request: { tool_name: string; input: unknown } };
    expect(ask.request.tool_name).toBe('Edit');
    peer.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: ask.request.input } } });
    const toolResult = await peer.waitFor((m) => m.type === 'user' && 'tool_use_result' in m) as
      { tool_use_result: { structuredPatch: Array<{ lines: string[] }> } };
    expect(toolResult.tool_use_result.structuredPatch[0].lines).toContain('+  return `Hello, ${name}!`;');
    expect((await result()).is_error).toBe(false);
    await expectFixtureComplete(handle);
  });

  it('permission deny: can_use_tool deny is listed in permission_denials', async () => {
    const { handle, peer, user, result } = await startClaude('permission-deny');
    user('Clean the build output.');
    const ask = await peer.waitFor({ type: 'control_request', request: { subtype: 'can_use_tool' } }) as { request_id: string };
    peer.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'deny', message: 'The user denied this tool call.' } } });
    const final = await result() as unknown as { permission_denials: Array<{ tool_name: string }> };
    expect(final.permission_denials.map((d) => d.tool_name)).toEqual(['Bash']);
    await expectFixtureComplete(handle);
  });

  it('turn error: api_retry events and an is_error result, then a successful turn', async () => {
    const { handle, peer, user, result } = await startClaude('turn-error');
    user('Summarize the repo.');
    const failed = await result();
    expect(failed.is_error).toBe(true);
    expect(peer.messages.items.filter((m) => m.subtype === 'api_retry')).toHaveLength(2);
    user('Try again.');
    expect((await result()).is_error).toBe(false);
    await expectFixtureComplete(handle);
  });

  it('schema drift: unknown events arrive intact and unknown control requests can be refused', async () => {
    const { handle, peer, user, result } = await startClaude('schema-drift');
    user('Hello.');
    const unknown = await peer.waitFor({ type: 'control_request', request: { subtype: 'request_teleport' } }) as { request_id: string };
    peer.send({ type: 'control_response', response: { subtype: 'error', request_id: unknown.request_id, error: 'Unsupported control request: request_teleport' } });
    expect((await result()).result).toBe('Hi there.');
    expect(peer.messages.items.map((m) => m.type)).toContain('hologram_event');
    expect(peer.rawLines).toEqual(['Warning: unknown setting "hologram" in settings.json']);
    await expectFixtureComplete(handle);
  });
});
