import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { TranscriptReadStats } from './types';
const m = vi.hoisted(() => ({ env: {} as Record<string, string>, closed: 0 }));
vi.mock('../util/shell', async (original) => ({ ...await original<typeof import('../util/shell')>(), getShellEnvironment: () => m.env }));
vi.mock('fs/promises', async (original) => ({ ...await original<typeof import('fs/promises')>(), opendir: vi.fn(), readdir: vi.fn() }));
import { PassiveSessionLookup, PASSIVE_SESSION_LOOKUP_LIMITS as limits } from './passive-session-lookup';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { CopilotCliProvider } from './copilot-cli-provider';

let root: string;
const selected = '11111111-1111-4111-8111-111111111111';
const cwd = '/host/selected';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-passive-native-')); m.closed = 0;
  m.env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), COPILOT_HOME: path.join(root, 'copilot') };
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  vi.mocked(fs.opendir).mockImplementation(async (...args) => {
    const dir = await actual.opendir(...args); const close = dir.close.bind(dir);
    vi.spyOn(dir, 'close').mockImplementation(async () => { m.closed++; await close(); });
    return dir;
  });
  vi.mocked(fs.readdir).mockImplementation(actual.readdir);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function many(directory: string, kind: 'entries' | 'directories') {
  await fs.mkdir(directory, { recursive: true });
  const count = kind === 'entries' ? limits.entries + 20 : limits.directories + 8;
  for (let i = 0; i < count; i++) {
    const file = path.join(directory, `not-a-session-${i}`);
    if (kind === 'entries') await fs.writeFile(file, 'unrelated'); else await fs.mkdir(file);
  }
}
const raw = (cost: number) => JSON.stringify({ type: 'result', total_cost_usd: cost, duration_ms: 0 }) + '\n';

describe('display-only bounded native lookup', () => {
  it.each(['entries', 'directories'] as const)('charges every nonmatching Codex %s across the whole lookup and closes admitted iterators', async (kind) => {
    await many(path.join(m.env.CODEX_HOME, 'sessions'), kind);
    const provider = new CodexCliProvider(); const stats: TranscriptReadStats = {};
    const result = await provider.readSessionTranscript(selected, cwd, { maxBytes: 8192, stats, passiveLookup: true });
    expect(result).toBeNull(); expect(stats.lookupIncomplete).toBe(true);
    expect(stats.lookupEntries).toBeLessThanOrEqual(limits.entries); expect(stats.lookupDirectories).toBeLessThanOrEqual(limits.directories); expect(stats.lookupProbes).toBeLessThanOrEqual(limits.probes);
    if (kind === 'entries') expect(stats.lookupEntries).toBe(limits.entries); else expect(stats.lookupDirectories).toBe(limits.directories);
    expect(fs.readdir).not.toHaveBeenCalled(); expect(fs.opendir).toHaveBeenCalled();
    expect(vi.mocked(fs.opendir).mock.calls.every(([, options]) => options?.bufferSize === 1)).toBe(true);
    expect(m.closed).toBe(vi.mocked(fs.opendir).mock.calls.length);
    // This opt-in does not replace ordinary native history lookup semantics.
    await provider.readSessionTranscript(selected, cwd, { maxBytes: 8192 }); expect(fs.readdir).toHaveBeenCalled();
  });
  it.each(['claude', 'copilot'] as const)('bounds %s selected-session fallback without materializing a directory array', async (kind) => {
    const directory = kind === 'claude' ? path.join(m.env.CLAUDE_CONFIG_DIR, 'projects', '-host-selected', selected) : path.join(m.env.COPILOT_HOME, 'session-state', selected);
    await many(directory, 'entries');
    const provider = kind === 'claude' ? new ClaudeCodeProvider() : new CopilotCliProvider(); const stats: TranscriptReadStats = {};
    expect(await provider.readSessionTranscript(selected, cwd, { maxBytes: 8192, stats, passiveLookup: true })).toBeNull();
    expect(stats).toMatchObject({ lookupIncomplete: true, lookupEntries: limits.entries, lookupDirectories: 1 }); expect(stats.lookupProbes).toBeLessThanOrEqual(limits.probes);
    expect(fs.readdir).not.toHaveBeenCalled(); expect(fs.opendir).toHaveBeenCalledWith(directory, { bufferSize: 1 }); expect(m.closed).toBe(1);
    await provider.readSessionTranscript(selected, cwd, { maxBytes: 8192 }); expect(fs.readdir).toHaveBeenCalledWith(directory);
  });
  it.each(['claude', 'codex', 'copilot'] as const)('reads only the selected %s native file under the passive option and preserves ordinary success', async (kind) => {
    const directory = kind === 'claude' ? path.join(m.env.CLAUDE_CONFIG_DIR, 'projects', '-host-selected', selected) : kind === 'codex' ? path.join(m.env.CODEX_HOME, 'sessions') : path.join(m.env.COPILOT_HOME, 'session-state', selected);
    await fs.mkdir(directory, { recursive: true });
    const fileName = kind === 'codex' ? `rollout-2026-11-19T00-00-00-${selected}.jsonl` : 'record.jsonl';
    const file = path.join(directory, fileName); await fs.writeFile(file, raw(0)); const before = await fs.stat(file);
    const provider = kind === 'claude' ? new ClaudeCodeProvider() : kind === 'codex' ? new CodexCliProvider() : new CopilotCliProvider(); const stats: TranscriptReadStats = {};
    expect(await provider.readSessionTranscript(selected, cwd, { maxBytes: 8192, stats, passiveLookup: true })).toMatchObject([{ total_cost_usd: 0 }]);
    expect(stats.lookupIncomplete).not.toBe(true); expect(fs.readdir).not.toHaveBeenCalled(); expect(m.closed).toBe(1);
    expect(await provider.readSessionTranscript(selected, cwd, { maxBytes: 8192 })).toMatchObject([{ total_cost_usd: 0 }]);
    expect(await fs.readFile(file, 'utf8')).toBe(raw(0)); const after = await fs.stat(file); expect(after.mtimeMs).toBe(before.mtimeMs); expect(after.ino).toBe(before.ino);
  });
  it('refuses probe admission before opening and distinguishes verified exhaustion from a stopped iterator', async () => {
    const stats: TranscriptReadStats = {}; const lookup = new PassiveSessionLookup(stats); expect(lookup.reserveProbes(limits.probes)).toBe(true);
    expect(await lookup.find(root, () => false)).toBeNull(); expect(stats.lookupIncomplete).toBe(true); expect(fs.opendir).not.toHaveBeenCalled();
    const emptyStats: TranscriptReadStats = {}; expect(await new PassiveSessionLookup(emptyStats).find(root, () => false)).toBeNull(); expect(emptyStats.lookupIncomplete).not.toBe(true); expect(m.closed).toBe(1);
  });
  it('closes a failing iterator and marks unknown rather than claiming a verified empty directory', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(fs.opendir).mockResolvedValue({ read: async () => { throw new Error('read failed'); }, close } as never);
    const stats: TranscriptReadStats = {}; expect(await new PassiveSessionLookup(stats).find(root, () => true)).toBeNull(); expect(stats.lookupIncomplete).toBe(true); expect(close).toHaveBeenCalledTimes(1);
  });
});
