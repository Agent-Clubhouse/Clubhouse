import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const logged = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));
vi.mock('./agent-runtime/usage-attribution-log', () => ({ logTerminalRunUsage: (run: Record<string, unknown>) => logged.lines.push(run) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import type { OrchestratorProvider } from '../orchestrators/types';
import { appLog } from './log-service';
import { readTerminalRunUsage, recordTerminalRunUsage } from './terminal-usage';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-usage-'));
  logged.lines = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, lines: unknown[]): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

const claude = (at: number, id: string, usage: Record<string, number>, text = 'private words') => ({
  type: 'assistant', timestamp: iso(at), effort: 'high',
  message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage },
});
const codexRecord = (at: number, response: string, usage: Record<string, number>) => ({ timestamp: iso(at), type: 'token_usage_record', payload: { response_id: response, usage, thread_token_usage: { input_tokens: 9_999_999 } } });
const codexContext = (at: number, model: string, effort: string) => ({ timestamp: iso(at), type: 'turn_context', payload: { model, effort, cwd: '/x' } });

describe('readTerminalRunUsage', () => {
  it('Claude: only this run, once per message id, cache reads and writes joined to input', async () => {
    const file = write('c.jsonl', [
      claude(T0 - 3_600_000, 'old', { input_tokens: 1000, output_tokens: 1000 }), // an earlier run of the resumed session
      { type: 'user', timestamp: iso(T0 + 1000), message: { content: 'a prompt with "usage" in it' } },
      claude(T0 + 2000, 'm1', { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 3 }),
      claude(T0 + 2001, 'm1', { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 7 }),
      claude(T0 + 5000, 'm2', { input_tokens: 1, output_tokens: 1 }),
    ]);
    const usage = await readTerminalRunUsage(file, 'claude', { startedAt: T0, endedAt: T0 + 10_000 });
    expect(usage).toEqual({ tokens: { input: 1001, cachedInput: 900, cacheWrite: 90, output: 8 }, source: 'summed_calls', dedup: 'message_id', model: 'claude-opus-5-5', effort: 'high', records: 2, partial: false });
  });

  it('Codex: response records once each, model and effort from the run, never the thread total', async () => {
    const file = write('r.jsonl', [
      codexRecord(T0 - 60_000, 'old', { input_tokens: 500, output_tokens: 5 }),
      codexContext(T0 + 1000, 'gpt-x', 'xhigh'),
      codexRecord(T0 + 2000, 'r1', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20, reasoning_output_tokens: 8 }),
      codexRecord(T0 + 2000, 'r1', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20, reasoning_output_tokens: 8 }),
      codexRecord(T0 + 3000, 'r2', { input_tokens: 0, output_tokens: 0 }),
    ]);
    const usage = await readTerminalRunUsage(file, 'codex', { startedAt: T0, endedAt: T0 + 10_000 });
    expect(usage).toMatchObject({ tokens: { input: 1000, cachedInput: 800, output: 20, reasoning: 8 }, model: 'gpt-x', effort: 'xhigh', records: 2, partial: false });
  });

  it('reads lines split across read chunks and says partial when the run is bigger than the limit', async () => {
    const pad = 'x'.repeat(900);
    const lines: unknown[] = [];
    for (let i = 0; i < 1500; i++) lines.push(codexRecord(T0 + 1000 + i, `r${i}`, { input_tokens: 1, output_tokens: 1, pad: pad.length } as never), `{"pad":"${pad}"}`);
    const file = write('big.jsonl', lines);
    const whole = await readTerminalRunUsage(file, 'codex', { startedAt: T0, endedAt: T0 + 10_000 });
    expect(whole).toMatchObject({ records: 1500, tokens: { input: 1500, output: 1500 }, partial: false });
    const cut = await readTerminalRunUsage(file, 'codex', { startedAt: T0, endedAt: T0 + 10_000 }, 100_000);
    expect(cut?.partial).toBe(true);
    expect(cut!.records).toBeLessThan(1500);
  });

  it('a run that recorded nothing has no usage, not zeros', async () => {
    const file = write('none.jsonl', [claude(T0 - 60_000, 'old', { input_tokens: 5, output_tokens: 5 })]);
    expect(await readTerminalRunUsage(file, 'claude', { startedAt: T0, endedAt: T0 + 1000 })).toBeUndefined();
  });
});

describe('recordTerminalRunUsage', () => {
  const provider = (id: string, file: string | null) => ({
    id,
    getCapabilities: () => ({ sessionResume: true }),
    listSessions: async () => [], readSessionTranscript: async () => null, extractSessionId: () => null,
    transcriptPath: async () => file,
  }) as unknown as OrchestratorProvider;
  const run = { agentId: 'a1', cwd: '/w', nativeSessionId: 's1', startedAt: T0, endedAt: T0 + 10_000, exitCode: 0 };

  it('logs the run read from the CLI file, with no text from it', async () => {
    const file = write('c.jsonl', [claude(T0 + 100, 'm1', { input_tokens: 4, output_tokens: 2 })]);
    await recordTerminalRunUsage({ ...run, provider: provider('claude-code', file) });
    expect(logged.lines).toEqual([expect.objectContaining({ agentId: 'a1', provider: 'claude-code', nativeSessionId: 's1', model: 'claude-opus-5-5', effort: 'high', usage: { tokens: { input: 4, output: 2 }, source: 'summed_calls', dedup: 'message_id' } })]);
    expect(JSON.stringify(logged.lines)).not.toContain('private words');
    expect(JSON.stringify(logged.lines)).not.toContain(tmp);
  });

  it('says not_supported for a CLI whose files are not read, and no_session when the run has none', async () => {
    await recordTerminalRunUsage({ ...run, provider: provider('copilot-cli', '/should/not/read') });
    await recordTerminalRunUsage({ ...run, nativeSessionId: undefined, provider: provider('codex-cli', null) });
    expect(logged.lines.map((l) => [l.provider, l.coverage, l.usage])).toEqual([['copilot-cli', 'not_supported', undefined], ['codex-cli', 'no_session', undefined]]);
  });

  it('a file it cannot read is a read_failed line, not an exception', async () => {
    await recordTerminalRunUsage({ ...run, provider: provider('codex-cli', path.join(tmp, 'missing.jsonl')) });
    expect(logged.lines).toEqual([expect.objectContaining({ coverage: 'read_failed', usage: undefined })]);
    // The warning names the error code only, never the file.
    expect(vi.mocked(appLog).mock.calls.at(-1)?.[3]?.meta).toEqual({ agentId: 'a1', provider: 'codex-cli', code: 'ENOENT' });
  });
});
