/**
 * Dry check of the scripted-turn builder (#2480): every script it builds
 * replays to the end through the real fake CLI, the Claude normalizer gets
 * the tool's image, and Copilot's asset reader finds the journaled bytes.
 * The chat E2E specs that use these scripts only run in CI.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeToolContent } from '../../../chat/claude/driver';
import { ClaudeStreamTransport } from '../../../chat/claude/stream-transport';
import type { ClaudeChatEvent } from '../../../chat/claude/events';
import { sniffMediaType } from '../../../../shared/chat';
import { CopilotAssetReader } from '../copilot-assets';
import { CHAT_MEDIA, buildChatScript, md, writeChatScript, type BuiltChatScript, type ChatScript } from './chat-script';
import { EventLog, NdjsonPeer, createFakeCli, type ChatFixtureCli, type FakeCli } from './fake-cli';

vi.mock('../../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../../util/shell')>();
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

const PNG = { path: CHAT_MEDIA.png, mimeType: 'image/png' };
const CLI_ARGS: Record<ChatFixtureCli, string[]> = { claude: [], codex: ['app-server'], copilot: ['--acp'] };

let tmp: string;
const cleanups: Array<() => unknown> = [];
beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-script-test-'));
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fakeFor(built: BuiltChatScript, name = 'script'): Promise<{ fake: FakeCli; copilotHome?: string }> {
  const written = await writeChatScript(tmp, name, built);
  const fake = await createFakeCli(written.fixture, { cliArgs: CLI_ARGS[built.cli] });
  cleanups.push(() => fake.dispose());
  return { fake, copilotHome: written.copilotHome };
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
  for (const cli of ['claude', 'codex', 'copilot'] as const) {
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

  for (const cli of ['claude', 'codex', 'copilot'] as const) {
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
    expect(() => buildChatScript('copilot', { description: 'x', turns: [{ steps: [], end: 'held', steers: [{}] }] })).toThrow(/copilot has no steer shape/);
    expect(() => buildChatScript('codex', { description: 'x', turns: [{ steps: [], end: 'held', steers: [{ priority: 'later' }] }] })).toThrow(/codex has no later steer shape/);
    expect(() => buildChatScript('claude', { description: 'x', turns: [{ steps: [], steers: [{}] }] })).toThrow(/steers need a held turn/);
    expect(() => buildChatScript('claude', { description: 'x', turns: [{ steps: [], pinPrompt: true }] })).toThrow(/pinPrompt needs a prompt/);
  });

  it('copilot: the binary result names an asset the session journal holds', async () => {
    const built = buildChatScript('copilot', { description: 'one asset', turns: [{ steps: [{ type: 'image-tool', image: PNG }] }] });
    const update = built.lines.find((l) => JSON.stringify(l).includes('binaryResultsForLlm')) as { msg: { params: { update: { rawOutput: { binaryResultsForLlm: Array<{ assetId: string }> } } } } };
    const assetId = update.msg.params.update.rawOutput.binaryResultsForLlm[0].assetId;
    const { copilotHome } = await writeChatScript(tmp, 'copilot-asset', built);
    expect(copilotHome).toBeDefined();
    const result = await new CopilotAssetReader(path.join(copilotHome!, 'session-state'), { retryDelaysMs: [] }).read(built.sessionId, assetId);
    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.from(result.bytes).equals(fs.readFileSync(CHAT_MEDIA.png))).toBe(true);
  });

  it('copilot: inline and omitted images need no journal', () => {
    const built = buildChatScript('copilot', {
      description: 'inline and omitted',
      turns: [{ steps: [{ type: 'image-tool', image: PNG, variant: 'inline' }, { type: 'image-tool', image: PNG, variant: 'omitted' }] }],
    });
    expect(built.copilotJournal).toEqual([]);
    const results = built.lines.flatMap((l) => (l.msg as { params?: { update?: { rawOutput?: { binaryResultsForLlm?: unknown[] } } } } | undefined)?.params?.update?.rawOutput?.binaryResultsForLlm ?? []);
    expect(results).toEqual([
      expect.objectContaining({ type: 'image', data: expect.any(String) }),
      expect.objectContaining({ type: 'image', omittedReason: 'too_large' }),
    ]);
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
    expect(() => buildChatScript('claude', { description: 'x', turns: [{ steps: [{ type: 'image-tool', image: PNG, variant: 'asset' }] }] })).toThrow(/claude has no asset image shape/);
    expect(() => buildChatScript('copilot', { description: 'x', turns: [{ steps: [{ type: 'command', command: 'ls', output: '' }] }] })).toThrow(/copilot has no command shape/);
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
