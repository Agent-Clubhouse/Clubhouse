/**
 * The stream-json transport and its normalizer, driven against the fake CLI
 * replaying committed Claude fixtures (test/chat-fixtures/claude): a real
 * child process and real stdio, zero tokens.
 */
import { spawn } from 'child_process';
import * as os from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EventLog,
  chatFixturePath,
  createFakeCli,
  type FakeCli,
} from '../../orchestrators/adapters/testing/fake-cli';
import type { ClaudeChatEvent } from './events';
import { ClaudeStreamTransport } from './stream-transport';

vi.mock('../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../util/shell')>();
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

type EventOf<K extends ClaudeChatEvent['kind']> = Extract<ClaudeChatEvent, { kind: K }>;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startClaude(name: string) {
  const fake: FakeCli = await createFakeCli(chatFixturePath('claude', name));
  cleanups.push(() => fake.dispose());
  const transport = new ClaudeStreamTransport(
    { binary: 'claude', cwd: os.tmpdir(), permissionMode: 'default' },
    // The transport's own args go after the fake's, as they would after a real binary.
    (o) => spawn(fake.binary, [...fake.args, ...o.args], { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }),
  );
  cleanups.push(() => transport.close());
  const events = EventLog.fromAsyncIterable(transport.events);
  await transport.start();
  const of = <K extends ClaudeChatEvent['kind']>(kind: K) =>
    events.items.filter((e): e is EventOf<K> => e.kind === kind);
  const waitFor = <K extends ClaudeChatEvent['kind']>(kind: K, extra: Partial<EventOf<K>> = {}) =>
    events.waitFor({ kind, ...extra } as Partial<ClaudeChatEvent>) as Promise<EventOf<K>>;
  return { fake, transport, events, of, waitFor };
}

async function expectFixtureComplete(fake: FakeCli): Promise<void> {
  const report = await fake.waitForReport((r) => r.complete || r.mismatch !== null);
  expect(report.mismatch).toBeNull();
  expect(report.complete).toBe(true);
}

describe('ClaudeStreamTransport against fake Claude Code', () => {
  it('AskUserQuestion: questions arrive as a permission request and answers go back in updatedInput', async () => {
    const { fake, transport, waitFor } = await startClaude('ask-user-question');
    transport.send({ text: 'Help me set up linting.' });

    const ask = await waitFor('permission_request', { toolName: 'AskUserQuestion' });
    const questions = ask.input.questions as Array<{ question: string; multiSelect: boolean; options: Array<{ label: string }> }>;
    expect(questions.map((q) => q.multiSelect)).toEqual([false, true]);
    expect(questions[1].options.map((o) => o.label)).toEqual(['Recommended', 'TypeScript', 'Import order']);

    // Multi-select answers are the chosen labels joined with ", ", keyed by question text.
    const answers = { [questions[0].question]: 'ESLint', [questions[1].question]: 'Recommended, TypeScript' };
    transport.respondToPermission(ask.requestId, { behavior: 'allow', updatedInput: { ...ask.input, answers } });

    const answered = await waitFor('tool_call_update', { name: 'AskUserQuestion' });
    expect(answered.status).toBe('completed');
    expect((answered.result as { answers: Record<string, string> }).answers).toEqual(answers);
    expect((await waitFor('turn_ended')).isError).toBe(false);
    await expectFixtureComplete(fake);
  });

  it('subagent: task events and the subagent\'s traffic carry the Task tool call as parent', async () => {
    const { fake, transport, of, waitFor } = await startClaude('subagent-task');
    transport.send({ text: 'Find where greet is defined.' });
    await waitFor('turn_ended');

    const taskCall = of('tool_call').find((c) => c.name === 'Task');
    expect(taskCall?.parentToolCallId).toBeUndefined();
    const taskId = taskCall?.toolCallId;

    expect(of('subagent').map((s) => [s.phase, s.taskId])).toEqual([
      ['started', 'task_0001'], ['progress', 'task_0001'], ['notification', 'task_0001'],
    ]);
    const nested = of('tool_call').filter((c) => c.parentToolCallId === taskId).map((c) => c.name);
    expect(nested).toEqual(['Grep']);
    expect(of('tool_call_update').find((u) => u.name === 'Grep')?.parentToolCallId).toBe(taskId);

    const chunkText = (parent?: string) =>
      of('message_chunk').filter((c) => c.parentToolCallId === parent).map((c) => c.text).join('');
    expect(chunkText(taskId)).toBe('Searching for greet.');
    expect(chunkText(undefined)).toBe('It is in src/greet.ts.');
    const subagentMessages = of('message').filter((m) => m.parentToolCallId === taskId).map((m) => m.text);
    expect(subagentMessages).toContain('greet is defined in src/greet.ts.');

    const taskDone = of('tool_call_update').find((u) => u.toolCallId === taskId);
    expect(taskDone).toMatchObject({ status: 'completed', parentToolCallId: undefined });
    await expectFixtureComplete(fake);
  });

  it('session info: system/init follows the first prompt and is re-emitted with the new model', async () => {
    const { fake, transport, of, waitFor } = await startClaude('session-info');
    // Before any prompt there is only the initialize handshake.
    expect(of('session_started')).toHaveLength(0);
    expect(of('initialized')[0]?.models.map((m) => m.value)).toEqual(['haiku', 'sonnet']);

    transport.send({ text: 'Reply with the word one.' });
    const first = await waitFor('session_started');
    expect(first.model).toBe('claude-haiku-5-5');
    await waitFor('turn_ended');
    expect(transport.sessionId).toBe('5e55a000-0000-4000-8000-0000000c1a0d');

    await transport.setModel('sonnet');
    transport.send({ text: 'Now reply with the word two.' });
    const second = await waitFor('session_started');
    expect(second.model).toBe('claude-sonnet-5-5');
    expect(second.sessionId).toBe(first.sessionId);
    expect((await waitFor('turn_ended')).result).toBe('two');
    await expectFixtureComplete(fake);
  });
});
