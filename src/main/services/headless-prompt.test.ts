import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultSpawn, headlessAnswer, runHeadlessPrompt } from './headless-prompt';
import { killStructuredChild } from '../orchestrators/adapters/structured-spawn';

// The real tree kill, watched: a run that stops its CLI must use it (#3151).
vi.mock('../orchestrators/adapters/structured-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrators/adapters/structured-spawn')>();
  return { ...actual, killStructuredChild: vi.fn(actual.killStructuredChild) };
});
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

/**
 * Every fake CLI started, so cleanup can wait for each to exit. A run that
 * times out resolves as soon as it kills the child; on Windows the dying
 * process still holds the folder (its cwd and script) for a moment, and
 * removing it then fails with EBUSY.
 */
const children: ChildProcess[] = [];
const spawn: typeof defaultSpawn = (binary, args, opts) => {
  const child = defaultSpawn(binary, args, opts);
  children.push(child);
  return child;
};

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
    child.kill();
  });
}

afterAll(async () => {
  await Promise.all(children.map(exited));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      { provider: () => fakeProvider('stream', seen), workDir, spawn },
    );
    expect(result).toEqual({ ok: true, text: 'Answer to: Rewrite this please' });
    expect(seen[0]).toMatchObject({ cwd: dir, model: 'small', effort: 'low', mission: 'Rewrite this please', noSessionPersistence: true });
    expect(seen[0].disallowedTools).toContain('Bash');
  });

  it('returns text output as it stands', async () => {
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x' }, { provider: () => fakeProvider('text', [], { outputKind: 'text' }), workDir, spawn });
    expect(result).toEqual({ ok: true, text: 'plain answer' });
  });

  it('fails when the CLI exits with nothing to say', async () => {
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x' }, { provider: () => fakeProvider('fail'), workDir, spawn });
    expect(result).toEqual({ ok: false, error: 'It exited with code 3.' });
  });

  it('stops a run that takes too long, with its whole process tree', async () => {
    vi.mocked(killStructuredChild).mockClear();
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x', timeoutMs: 200 }, { provider: () => fakeProvider('hang'), workDir, spawn });
    expect(result).toEqual({ ok: false, error: 'It took too long.' });
    expect(killStructuredChild).toHaveBeenCalledWith(children[children.length - 1]);
  });

  it('fails for a provider that has no headless runs', async () => {
    const provider = { id: 'p', getCapabilities: () => ({ headless: false }) } as unknown as OrchestratorProvider;
    expect(await runHeadlessPrompt({ provider: 'p', model: 'm', prompt: 'x' }, { provider: () => provider, workDir, spawn })).toEqual({ ok: false, error: "p can't run a one-off prompt." });
    expect((await runHeadlessPrompt({ provider: 'gone', model: 'm', prompt: 'x' }, { provider: () => undefined, workDir, spawn })).ok).toBe(false);
  });

  it('fails when the binary is missing', async () => {
    const provider = {
      id: 'fake',
      getCapabilities: () => ({ headless: true }),
      buildHeadlessCommand: async () => ({ binary: path.join(dir, 'no-such-cli'), args: [] }),
    } as unknown as OrchestratorProvider;
    const result = await runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x' }, { provider: () => provider, workDir, spawn });
    expect(result.ok).toBe(false);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Real processes, Windows only: a `.cmd` shim that isn't an npm node shim runs
// under cmd.exe, and the CLI it starts must die with it when the run stops.
describe.runIf(process.platform === 'win32')('runHeadlessPrompt through a .cmd shim', () => {
  it('stops the CLI under cmd.exe on a timeout, not just cmd.exe (#3151)', async () => {
    const pidFile = path.join(dir, 'shim-cli.pid');
    const cli = path.join(dir, 'shim-cli.js');
    fs.writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    // An absolute node path and no %*: resolveNodeShim can't read it, so it runs through cmd.exe.
    const shim = path.join(dir, 'shim-cli.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${cli}"\r\n`);
    const provider = {
      id: 'fake',
      getCapabilities: () => ({ headless: true }),
      buildHeadlessCommand: async () => ({ binary: shim, args: [] }),
    } as unknown as OrchestratorProvider;

    let pid: number | undefined;
    try {
      const run = runHeadlessPrompt({ provider: 'fake', model: 'm', prompt: 'x', timeoutMs: 8_000 }, { provider: () => provider, workDir, spawn });
      await expect.poll(() => fs.existsSync(pidFile), { timeout: 7_000, interval: 50 }).toBe(true);
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(pid).not.toBe(children[children.length - 1].pid); // the CLI is cmd.exe's child, not ours
      expect(await run).toEqual({ ok: false, error: 'It took too long.' });
      await expect.poll(() => alive(pid!), { timeout: 10_000, interval: 100 }).toBe(false);
    } finally {
      if (pid && alive(pid)) process.kill(pid);
    }
  }, 30_000);
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
