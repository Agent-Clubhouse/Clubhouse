/**
 * Dry check of the scripted-turn builder (#2480): every script it builds
 * replays to the end through the real fake CLI, and the Claude normalizer
 * gets the tool's image. Copilot's scripts replay through the real Copilot
 * SDK driver, since the SDK protocol is framed TCP. The chat E2E specs that
 * use these scripts only run in CI.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeToolContent } from '../../../chat/claude/driver';
import { ClaudeStreamTransport } from '../../../chat/claude/stream-transport';
import type { ClaudeChatEvent } from '../../../chat/claude/events';
import { permissionRequestFromWire } from '../../../chat/claude/normalizer';
import { sniffMediaType } from '../../../../shared/chat';
import type { ChatEventDraft } from '../../../../shared/chat/events';
import type { ChatDriverSession } from '../../../../shared/chat/runtime';
import { CopilotSdkChatDriver } from '../../../chat/copilot/driver';
import { COPILOT_OPTION_ALLOW } from '../../../chat/copilot/normalizer';
import { fakeCopilotEnv } from '../../../chat/copilot/test-env';
import { CHAT_MEDIA, buildChatScript, md, writeChatScript, type BuiltChatScript, type ChatScript } from './chat-script';
import { EventLog, NdjsonPeer, createFakeCli, writeFakeCliShims, type FakeCli } from './fake-cli';

vi.mock('../../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../../util/shell')>();
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

const PNG = { path: CHAT_MEDIA.png, mimeType: 'image/png' };
const CLI_ARGS: Record<'claude' | 'codex', string[]> = { claude: [], codex: ['app-server'] };

let tmp: string;
const cleanups: Array<() => unknown> = [];
let originalEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-script-test-'));
  originalEnv = process.env;
});
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()?.();
  } finally {
    process.env = originalEnv;
  }
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeFor(built: BuiltChatScript, name = 'script'): Promise<{ fake: FakeCli }> {
  if (built.cli === 'copilot') throw new Error('Copilot scripts replay through the SDK driver: use copilotSession');
  const written = await writeChatScript(tmp, name, built);
  const fake = await createFakeCli(written.fixture, { cliArgs: CLI_ARGS[built.cli] });
  cleanups.push(() => fake.dispose());
  return { fake };
}

// The SDK handshake was recorded logged out, with a provider standing in for the login.
const LOGIN_STAND_IN = { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:0/v1', COPILOT_MODEL: 'fake-model' };

/** The real Copilot SDK driver against the fake replaying `built`, in a home of its own. */
async function copilotSession(built: BuiltChatScript, name = 'script'): Promise<{ fake: FakeCli; session: ChatDriverSession; drafts: EventLog<ChatEventDraft> }> {
  const home = await fs.promises.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), 'chat-script-copilot-home-'));
  cleanups.push(() => fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  process.env = fakeCopilotEnv(originalEnv, home);
  const { fixture } = await writeChatScript(tmp, name, built);
  const fake = await createFakeCli(fixture);
  cleanups.push(() => fake.dispose());
  const shims = await writeFakeCliShims(path.join(tmp, `${name}-bin`), { copilot: { fixture, report: fake.reportPath } });
  const session = await new CopilotSdkChatDriver().start({
    agentId: 'a1', provider: 'copilot-cli', cwd: tmp, binaryPath: shims.copilot, level: 'ask', env: LOGIN_STAND_IN,
  });
  cleanups.push(() => session.close());
  return { fake, session, drafts: EventLog.fromAsyncIterable(session.events) };
}

const say = (session: ChatDriverSession, text: string, delivery: 'prompt' | 'steer' = 'prompt') => session.send([{ type: 'text', text }], delivery);

/** Check the replay, then close: the fake answers the closing session.detach as a standing query. */
async function expectCopilotComplete(session: ChatDriverSession, fake: FakeCli): Promise<void> {
  const report = await fake.waitForReport((r) => r.complete || r.mismatch !== null);
  expect(report.mismatch).toBeNull();
  expect(report.complete).toBe(true);
  await session.close();
  expect((await fake.readReport()).unexpected).toEqual([]);
}

/**
 * Play the client side of `built` against the fake: send each client
 * message once the CLI lines before it have arrived. Ids are sent as
 * recorded, which is what the fake's remapping expects of a client that
 * numbers its own requests the same way.
 */
async function playClientSide(built: BuiltChatScript, fake: FakeCli): Promise<NdjsonPeer> {
  const peer = NdjsonPeer.start(fake.binary, fake.args);
  cleanups.push(() => peer.kill());
  let pending = 0;
  for (const entry of built.lines.slice(1)) {
    if (entry.from === 'cli') { pending++; continue; }
    for (; pending > 0; pending--) await peer.messages.waitFor(() => true);
    peer.send(entry.msg);
  }
  for (; pending > 0; pending--) await peer.messages.waitFor(() => true);
  return peer;
}

async function expectComplete(fake: FakeCli): Promise<void> {
  const report = await fake.waitForReport((r) => r.complete || r.mismatch !== null);
  expect(report.mismatch).toBeNull();
  expect(report.complete).toBe(true);
}

const imageThenHeld: ChatScript = {
  description: 'an image tool, a held turn, then a plain turn',
  turns: [
    { prompt: 'Look at the image.', steps: [{ type: 'image-tool', image: PNG }, { type: 'text', text: `Saw ${md.path('/tmp/a.png', 3, 2)}` }] },
    { prompt: 'Wait.', steps: [{ type: 'text', text: 'Waiting.' }], end: 'held' },
    { prompt: 'Done?', steps: [{ type: 'text', text: 'Done.' }] },
  ],
};

describe('buildChatScript', () => {
  for (const cli of ['claude', 'codex'] as const) {
    it(`${cli}: the built script replays to the end through the fake CLI`, async () => {
      const built = buildChatScript(cli, imageThenHeld);
      const header = built.lines[0] as { kind: string; source: string; description: string; synthesized?: string[] };
      expect(header).toMatchObject({ kind: 'header', source: 'hand-made' });
      expect(header.description).toMatch(/^Built by chat-script\.ts/);
      const { fake } = await fakeFor(built);
      await playClientSide(built, fake);
      await expectComplete(fake);
    });
  }

  it('claude: the Read tool result carries the image to the normalizer, in both shapes', async () => {
    const built = buildChatScript('claude', {
      description: 'two image reads',
      turns: [{ steps: [{ type: 'image-tool', image: PNG }, { type: 'image-tool', image: PNG, variant: 'read-result' }] }],
    });
    const written = await writeChatScript(tmp, 'claude-image', built);
    const fake = await createFakeCli(written.fixture);
    cleanups.push(() => fake.dispose());
    const transport = new ClaudeStreamTransport(
      { binary: 'claude', cwd: os.tmpdir(), permissionMode: 'default' },
      (o) => spawn(fake.binary, [...fake.args, ...o.args], { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    cleanups.push(() => transport.close());
    const events = EventLog.fromAsyncIterable(transport.events);
    await transport.start();
    transport.send({ text: 'Look.' });
    await events.waitFor({ kind: 'turn_ended' } as Partial<ClaudeChatEvent>);
    const updates = events.items.filter((e): e is Extract<ClaudeChatEvent, { kind: 'tool_call_update' }> => e.kind === 'tool_call_update');
    const base64 = fs.readFileSync(CHAT_MEDIA.png).toString('base64');
    expect(updates.map((u) => u.images?.[0])).toEqual([
      { type: 'image', mimeType: 'image/png', data: base64 },
      { type: 'image', mimeType: 'image/png', data: base64 },
    ]);
    await expectComplete(fake);
  });

  it('claude: many questions reach the client as one request, and only the scripted answers complete it', async () => {
    const questions = Array.from({ length: 8 }, (_, i) => ({
      question: `Question ${i + 1}: ${'a long question that wraps over several lines '.repeat(3)}?`,
      header: `Q${i + 1}`,
      multiSelect: i % 2 === 1,
      options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Maybe' }],
    }));
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, i % 2 ? 'Yes, Maybe' : 'No']));
    const built = buildChatScript('claude', { description: 'eight questions', turns: [{ steps: [{ type: 'questions', questions, answers }] }] });
    const ask = built.lines.find((l) => l.from === 'cli' && (l.msg as { type?: string } | undefined)?.type === 'control_request') as { msg: { request: { input: { questions: unknown[] } } } };
    expect(ask.msg.request.input.questions).toHaveLength(8);
    const { fake } = await fakeFor(built);
    await playClientSide(built, fake);
    await expectComplete(fake);

    // A different answer is a mismatch.
    const wrong = structuredClone(built);
    const reply = wrong.lines.find((l) => l.from === 'client' && (l.msg as { type?: string }).type === 'control_response') as { msg: { response: { response: { updatedInput: { answers: Record<string, string> } } } } };
    reply.msg.response.response.updatedInput.answers[questions[0].question] = 'Yes';
    const second = await fakeFor(wrong, 'wrong');
    // The fake exits at the mismatch, so the rest of the client side never plays.
    void playClientSide(wrong, second.fake).catch(() => undefined);
    const report = await second.fake.waitForReport((r) => r.mismatch !== null);
    expect(report.mismatch).not.toBeNull();
  });

  it('claude: a held turn takes its steers in order, and only the scripted ones', async () => {
    const built = buildChatScript('claude', {
      description: 'steers into a held turn',
      turns: [{ steps: [], end: 'held', steers: [{ text: 'Use tabs.' }, { priority: 'later', text: 'Then lint.' }, {}] }],
    });
    const steers = built.lines.filter((l) => l.from === 'client' && (l.msg as { priority?: string }).priority);
    expect(steers.map((l) => l.match)).toEqual([
      { priority: 'next', message: { content: 'Use tabs.' } },
      { priority: 'later', message: { content: 'Then lint.' } },
      { priority: 'next' },
    ]);
    const { fake } = await fakeFor(built);
    await playClientSide(built, fake);
    await expectComplete(fake);

    // Two steers merged into one, or a steer the script didn't expect, is a mismatch.
    const merged = structuredClone(built);
    const first = merged.lines.find((l) => l.from === 'client' && (l.msg as { priority?: string }).priority) as { msg: { message: { content: string } } };
    first.msg.message.content = 'Use tabs.\n\nThen lint.';
    const second = await fakeFor(merged, 'merged');
    void playClientSide(merged, second.fake).catch(() => undefined);
    const report = await second.fake.waitForReport((r) => r.mismatch !== null);
    expect(report.mismatch?.reason).toMatch(/did not contain/);
  });

  it('codex: a held turn takes turn/steer requests, matched on their text', async () => {
    const built = buildChatScript('codex', {
      description: 'steers into a held Codex turn',
      turns: [{ steps: [], end: 'held', steers: [{ text: 'Use tabs.' }, {}] }],
    });
    const steers = built.lines.filter((l) => l.from === 'client' && (l.msg as { method?: string }).method === 'turn/steer');
    expect(steers.map((l) => l.match)).toEqual([{ params: { input: [{ type: 'text', text: 'Use tabs.' }] } }, undefined]);
    const { fake } = await fakeFor(built);
    await playClientSide(built, fake);
    await expectComplete(fake);
  });

  for (const cli of ['claude', 'codex'] as const) {
    it(`${cli}: a pinned prompt completes only with its own text`, async () => {
      const script: ChatScript = { description: 'pinned', turns: [{ prompt: 'Keep me.', pinPrompt: true, steps: [{ type: 'text', text: 'Kept.' }] }] };
      const built = buildChatScript(cli, script);
      const { fake } = await fakeFor(built);
      await playClientSide(built, fake);
      await expectComplete(fake);

      // A client that sends another message's text, against the pinned script.
      const wrong = buildChatScript(cli, { ...script, turns: [{ ...script.turns[0], pinPrompt: false, prompt: 'Removed.' }] });
      const second = await fakeFor(built, 'pinned-again');
      void playClientSide(wrong, second.fake).catch(() => undefined);
      const report = await second.fake.waitForReport((r) => r.mismatch !== null);
      expect(report.mismatch?.reason).toMatch(/did not contain/);
    });
  }

  it('steers need a held turn, and a provider that can take them', () => {
    expect(() => buildChatScript('copilot', { description: 'x', turns: [{ steps: [], end: 'held', steers: [{ priority: 'later' }] }] })).toThrow(/copilot has no later steer shape/);
    expect(() => buildChatScript('codex', { description: 'x', turns: [{ steps: [], end: 'held', steers: [{ priority: 'later' }] }] })).toThrow(/codex has no later steer shape/);
    expect(() => buildChatScript('claude', { description: 'x', turns: [{ steps: [], steers: [{}] }] })).toThrow(/steers need a held turn/);
    expect(() => buildChatScript('claude', { description: 'x', turns: [{ steps: [], pinPrompt: true }] })).toThrow(/pinPrompt needs a prompt/);
  });

  it('claude: an approval reaches the client with its title and description, and only an allow completes it', async () => {
    const approval = { tool: 'Bash', input: { command: 'npm run build', description: 'Build' }, title: 'Run the build?', description: 'It writes to out/.' };
    const built = buildChatScript('claude', { description: 'one approval', turns: [{ steps: [{ type: 'approval', approval }, { type: 'text', text: 'Built.' }] }] });
    const ask = built.lines.find((l) => l.from === 'cli' && (l.msg as { type?: string } | undefined)?.type === 'control_request') as { msg: { request_id: string; request: Record<string, unknown> } };
    expect(ask.msg.request.subtype).toBe('can_use_tool');
    // What the Claude driver reads from it.
    expect(permissionRequestFromWire(ask.msg.request_id, ask.msg.request)).toMatchObject({
      kind: 'permission_request', toolName: 'Bash', input: approval.input, title: approval.title, description: approval.description,
    });
    const { fake } = await fakeFor(built);
    await playClientSide(built, fake);
    await expectComplete(fake);

    const denied = structuredClone(built);
    const reply = denied.lines.find((l) => l.from === 'client' && (l.msg as { type?: string }).type === 'control_response') as { msg: { response: { response: Record<string, unknown> } } };
    reply.msg.response.response = { behavior: 'deny', message: 'No.' };
    const second = await fakeFor(denied, 'denied');
    void playClientSide(denied, second.fake).catch(() => undefined);
    const report = await second.fake.waitForReport((r) => r.mismatch !== null);
    expect(report.mismatch).not.toBeNull();
  });

  for (const cli of ['codex'] as const) {
    it(`${cli}: two command approvals in a script replay to the end with their allows`, async () => {
      const approval = (n: number) => ({ type: 'approval' as const, approval: { tool: 'Bash', input: { command: `echo 'step ${n}'` }, title: `Run step ${n}`, description: `Step ${n} writes to out/.` } });
      const built = buildChatScript(cli, {
        description: 'two approvals over two turns',
        turns: [{ steps: [approval(1), { type: 'text', text: 'One.' }] }, { steps: [approval(2)] }],
      });
      const requests = built.lines.filter((l) => l.from === 'cli' && /requestApproval|request_permission/.test(String((l.msg as { method?: string }).method)));
      expect(requests.map((l) => (l.msg as { id: number }).id)).toEqual([0, 1]);
      expect(JSON.stringify(requests[0])).toContain('Step 1 writes to out/.');
      const { fake } = await fakeFor(built);
      await playClientSide(built, fake);
      await expectComplete(fake);
    });
  }

  describe('copilot, through the SDK driver', () => {
    const approval = (n: number) => ({ type: 'approval' as const, approval: { tool: 'Bash', input: { command: `echo 'step ${n}'` }, title: `Run step ${n}`, description: `Step ${n} writes to out/.` } });

    it('text, two approvals and a held turn with a steer replay to the end', async () => {
      const built = buildChatScript('copilot', {
        description: 'text, approvals, a held turn with a steer, then a plain turn',
        turns: [
          { prompt: 'Run the steps.', steps: [{ type: 'text', text: 'Starting.' }, approval(1), approval(2), { type: 'text', text: 'Both ran.' }] },
          { prompt: 'Wait.', steps: [{ type: 'text', text: 'Waiting.' }], end: 'held', steers: [{ text: 'Use tabs.' }] },
          { prompt: 'Done?', steps: [{ type: 'text', text: 'Done.' }] },
        ],
      });
      expect(built.lines[0]).toMatchObject({ kind: 'header', protocol: 'copilot-sdk', source: 'hand-made' });
      const { fake, session, drafts } = await copilotSession(built);

      await say(session, 'Run the steps.');
      for (const n of [1, 2]) {
        const ask = await drafts.waitFor({ type: 'permission_request' } as Partial<ChatEventDraft>);
        const data = (ask as Extract<ChatEventDraft, { type: 'permission_request' }>).data;
        // The approval card's title, and the command the dock previews from the tool call.
        expect(data).toMatchObject({ title: `Run step ${n}`, description: `echo 'step ${n}'`, toolName: 'bash' });
        const call = drafts.items.find((d) => d.type === 'tool_call' && d.data.toolCallId === data.toolCallId) as Extract<ChatEventDraft, { type: 'tool_call' }>;
        expect(call.data).toMatchObject({ kind: 'execute', rawInput: { command: `echo 'step ${n}'`, description: `Step ${n} writes to out/.` } });
        await session.respondPermission(data.requestId, COPILOT_OPTION_ALLOW);
      }
      await drafts.waitFor({ type: 'turn_ended' } as Partial<ChatEventDraft>);

      await say(session, 'Wait.');
      await drafts.waitFor({ type: 'tool_call', data: { rawInput: { command: 'sleep 600' } } } as Partial<ChatEventDraft>);
      expect(await say(session, 'Use tabs.', 'steer')).toBe('steer');
      await session.interrupt();
      expect(((await drafts.waitFor({ type: 'turn_ended' } as Partial<ChatEventDraft>)) as Extract<ChatEventDraft, { type: 'turn_ended' }>).data.stopReason).toBe('cancelled');

      await say(session, 'Done?');
      await drafts.waitFor({ type: 'turn_ended' } as Partial<ChatEventDraft>);
      await expectCopilotComplete(session, fake);
      const ends = drafts.items.filter((d): d is Extract<ChatEventDraft, { type: 'turn_ended' }> => d.type === 'turn_ended').map((d) => d.data.stopReason);
      expect(ends).toEqual(['end_turn', 'cancelled', 'end_turn']);
    });

    it('a pinned prompt completes only with its own text', async () => {
      const script: ChatScript = { description: 'pinned', turns: [{ prompt: 'Keep me.', pinPrompt: true, steps: [{ type: 'text', text: 'Kept.' }] }] };
      const built = buildChatScript('copilot', script);
      const first = await copilotSession(built);
      await say(first.session, 'Keep me.');
      await first.drafts.waitFor({ type: 'turn_ended' } as Partial<ChatEventDraft>);
      await expectCopilotComplete(first.session, first.fake);

      const second = await copilotSession(built, 'pinned-again');
      void say(second.session, 'Removed.').catch(() => undefined);
      const report = await second.fake.waitForReport((r) => r.mismatch !== null);
      expect(report.mismatch?.reason).toMatch(/did not contain/);
    });

    it('a steer matches on its text and mode', () => {
      const built = buildChatScript('copilot', { description: 'x', turns: [{ steps: [], end: 'held', steers: [{ text: 'Use tabs.' }, {}] }] });
      const steers = built.lines.filter((l) => l.from === 'client' && (l.msg as { params?: { mode?: string } }).params?.mode === 'immediate');
      expect(steers.map((l) => l.match)).toEqual([{ params: { mode: 'immediate', prompt: 'Use tabs.' } }, { params: { mode: 'immediate' } }]);
    });
  });

  for (const cli of ['claude', 'codex'] as const) {
    it(`${cli}: a command step replays, and its output is what the command card shows`, async () => {
      const output = 'Wrote /tmp/out dir/report.txt\nsrc/app.ts:7:3: warning';
      const built = buildChatScript(cli, { description: 'one command', turns: [{ steps: [{ type: 'command', command: 'ls', output }] }] });
      type Msg = {
        type?: string; tool_use_result?: unknown; method?: string;
        message?: { content: Array<{ name: string; input: Record<string, unknown> }> };
        params?: { item: { type: string } };
      };
      const msgs = built.lines.map((l) => l.msg as Msg | undefined);
      if (cli === 'claude') {
        const use = msgs.find((m) => m?.type === 'assistant')!.message!.content[0];
        const result = msgs.find((m) => m?.type === 'user' && m.tool_use_result)!;
        expect(claudeToolContent(use.name, use.input, result.tool_use_result, output, '/w')).toEqual([{ type: 'terminal', command: 'ls', cwd: '/w', output }]);
      } else {
        const done = msgs.find((m) => m?.method === 'item/completed' && m.params?.item.type === 'commandExecution')!;
        expect(done.params!.item).toMatchObject({ status: 'completed', aggregatedOutput: output, exitCode: 0 });
      }
      const { fake } = await fakeFor(built);
      await playClientSide(built, fake);
      await expectComplete(fake);
    });
  }

  it('refuses a step a provider has no shape for', () => {
    const questions = { type: 'questions' as const, questions: [{ question: 'Q?', header: 'Q', options: [{ label: 'A' }] }], answers: { 'Q?': 'A' } };
    expect(() => buildChatScript('codex', { description: 'x', turns: [{ steps: [questions] }] })).toThrow(/codex has no question shape/);
    expect(() => buildChatScript('claude', { description: 'x', turns: [{ steps: [{ type: 'image-tool', image: PNG, variant: 'view' }] }] })).toThrow(/claude has no view image shape/);
    // The SDK driver shows no image from a tool's result, so there is nothing to script.
    expect(() => buildChatScript('copilot', { description: 'x', turns: [{ steps: [{ type: 'image-tool', image: PNG }] }] })).toThrow(/copilot has no image tool shape/);
    expect(() => buildChatScript('copilot', { description: 'x', turns: [{ steps: [{ type: 'command', command: 'ls', output: '' }] }] })).toThrow(/copilot has no command shape/);
    const edit = { type: 'approval' as const, approval: { tool: 'Edit', input: { file_path: '/tmp/a.ts' } } };
    expect(() => buildChatScript('copilot', { description: 'x', turns: [{ steps: [edit] }] })).toThrow(/copilot has no approval without input.command shape/);
  });

  it('md.image writes a file: URL, md.path a code span with its location, md.quotedPath escaped prose', () => {
    expect(md.path('/tmp/a b.ts', 4, 2)).toBe('`/tmp/a b.ts:4:2`');
    expect(md.quotedPath('C:\\a\\_temp\\b c.md')).toBe('"C:\\\\a\\\\\\_temp\\\\b c.md"');
    expect(md.image('chart', path.resolve('/tmp/chart.png'))).toMatch(/^!\[chart\]\(file:\/\/\/.*chart\.png\)$/);
  });
});

describe('committed chat media', () => {
  it('each file is what its name says, and small', () => {
    const bytes = (p: string) => new Uint8Array(fs.readFileSync(p));
    expect(sniffMediaType(bytes(CHAT_MEDIA.png))).toBe('image/png');
    const pdf = fs.readFileSync(CHAT_MEDIA.pdf, 'latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('/Count 2');
    const wav = fs.readFileSync(CHAT_MEDIA.wav);
    expect([wav.toString('ascii', 0, 4), wav.toString('ascii', 8, 12)]).toEqual(['RIFF', 'WAVE']);
    // EBML magic, then the "webm" doctype.
    const webm = fs.readFileSync(CHAT_MEDIA.webm);
    expect(webm.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    expect(webm.subarray(0, 64).toString('latin1')).toContain('webm');
    for (const p of Object.values(CHAT_MEDIA)) expect(fs.statSync(p).size).toBeLessThan(16 * 1024);
  });
});
