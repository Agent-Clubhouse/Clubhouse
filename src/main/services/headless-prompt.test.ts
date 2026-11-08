import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { headlessAnswer, runHeadlessPrompt } from './headless-prompt';
import type { HeadlessOpts, OrchestratorProvider } from '../orchestrators/types';
import type { StreamJsonEvent } from './jsonl-parser';

/**
 * A fake CLI: a node script that prints what a provider's headless run would
 * print. No model is ever called.
 */
let dir: string;
let script: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-prompt-test-'));
  script = path.join(dir, 'fake-cli.js');
  fs.writeFileSync(script, `
    const mode = process.argv[2];
    const prompt = process.argv[3] || '';
    if (mode === 'stream') {
      console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
      console.log('not json at all');
      console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } }));
      console.log(JSON.stringify({ type: 'result', result: 'Answer to: ' + prompt.slice(0, 20) }));
    } else if (mode === 'text') {
      process.stdout.write('  plain answer  \\n');
    } else if (mode === 'fail') {
      process.stderr.write('boom');
      process.exit(3);
    } else if (mode === 'hang') {
      setTimeout(() => {}, 60000);
    }
  `);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(mode: string, seen: HeadlessOpts[] = [], extra: Record<string, unknown> = {}): OrchestratorProvider {
  return {
    id: 'fake',
    getCapabilities: () => ({ headless: true }),
    buildHeadlessCommand: async (opts: HeadlessOpts) => {
      seen.push(opts);
      return { binary: process.execPath, args: [script, mode, opts.mission ?? ''], ...extra };
    },
  } as unknown as OrchestratorProvider;
}

const workDir = () => dir;

describe('runHeadlessPrompt with a fake CLI', () => {
  it('returns the result of a stream-json run, with no session kept and no tools', async () => {
    const seen: HeadlessOpts[] = [];
    const result = await runHeadlessPrompt(
      { provider: 'fake', model: 'small', effort: 'low', prompt: 'Rewrite this please' },
      { provider: () => fakeProvider('stream', seen), workDir },
    );
    expect(result).toEqual({ ok: true, text: 'Answer to: Rewrite this please' });
    expect(seen[0]).toMatchObject({ cwd: dir, model: 'small', effort: 'low', mission: 'Rewrite this please', noSessionPersistence: true });
    expect(seen[0].disallowedTools).toContain('Bash');
  });

  it('returns text output as it stands', async () => {
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x' }, { provider: () => fakeProvider('text', [], { outputKind: 'text' }), workDir });
    expect(result).toEqual({ ok: true, text: 'plain answer' });
  });

  it('fails when the CLI exits with nothing to say', async () => {
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x' }, { provider: () => fakeProvider('fail'), workDir });
    expect(result).toEqual({ ok: false, error: 'It exited with code 3.' });
  });

  it('stops a run that takes too long', async () => {
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x', timeoutMs: 200 }, { provider: () => fakeProvider('hang'), workDir });
    expect(result).toEqual({ ok: false, error: 'It took too long.' });
  });

  it('fails for a provider that has no headless runs', async () => {
    const provider = { id: 'p', getCapabilities: () => ({ headless: false }) } as unknown as OrchestratorProvider;
    expect(await runHeadlessPrompt({ provider: 'p', model: 'm', prompt: 'x' }, { provider: () => provider, workDir })).toEqual({ ok: false, error: "p can't run a one-off prompt." });
    expect((await runHeadlessPrompt({ provider: 'gone', model: 'm', prompt: 'x' }, { provider: () => undefined, workDir })).ok).toBe(false);
  });

  it('fails when the binary is missing', async () => {
    const provider = {
      id: 'fake',
      getCapabilities: () => ({ headless: true }),
      buildHeadlessCommand: async () => ({ binary: path.join(dir, 'no-such-cli'), args: [] }),
    } as unknown as OrchestratorProvider;
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x' }, { provider: () => provider, workDir });
    expect(result.ok).toBe(false);
  });
});

describe('headlessAnswer', () => {
  it('falls back to the last assistant message without a result', () => {
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: 'second' } }),
    ].join('\n');
    expect(headlessAnswer(out, {})).toBe('second');
  });

  it('ignores an error result', () => {
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      JSON.stringify({ type: 'result', result: 'Error: out of credits', is_error: true }),
    ].join('\n');
    expect(headlessAnswer(out, {})).toBe('partial');
  });

  it('reads a provider\'s own events through its normalizer', () => {
    const normalizer = () => (raw: StreamJsonEvent): StreamJsonEvent[] =>
      raw.type === 'item.completed' ? [{ type: 'result', result: String(raw.text) }] : [];
    const out = `${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'item.completed', text: 'from codex' })}`;
    expect(headlessAnswer(out, { createEventNormalizer: normalizer })).toBe('from codex');
  });
});
