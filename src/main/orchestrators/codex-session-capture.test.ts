/**
 * #2132: Codex terminal runs don't print their session id, so it's resolved
 * from the rollout files in CODEX_HOME. Fixture rollouts only; Codex never runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../util/shell', () => ({ getShellEnvironment: vi.fn(() => ({ PATH: '' })), invalidateShellEnvironmentCache: vi.fn() }));

import { CodexCliProvider } from './codex-cli-provider';

const CWD = '/work/radiant-bobcat';
const RUN_START = Date.parse('2026-10-17T18:17:40Z');
const RUN_END = Date.parse('2026-10-17T18:45:00Z');
// UUIDv7 ids, as Codex 0.163 writes them.
const ID_A = '01a14b15-91f5-7df0-837b-67c1c3ae69c3';
const ID_B = '01a14b2c-0000-7000-8000-000000000002';
const ID_OTHER = '01a14b16-0000-7000-8000-000000000003';
const ID_OLD = '01a0ffff-0000-7000-8000-000000000004';

let home: string;
const provider = new CodexCliProvider();
const env = () => ({ CODEX_HOME: home });

/** Write a rollout like Codex does: `sessions/YYYY/MM/DD/rollout-<local stamp>-<id>.jsonl`, opened by session_meta. */
function rollout(id: string, opts: { cwd: string; started: number; lastWrite: number; pad?: number }): string {
  const day = new Date(opts.started);
  const dir = path.join(home, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(opts.started).toISOString().slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const meta = {
    timestamp: new Date(opts.started + 7_000).toISOString(),
    type: 'session_meta',
    payload: {
      session_id: id, id, timestamp: new Date(opts.started).toISOString(), cwd: opts.cwd,
      originator: 'codex-tui', cli_version: '0.163.0', source: 'cli',
      base_instructions: { text: 'x'.repeat(opts.pad ?? 1_000) },
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
  fs.utimesSync(file, new Date(opts.lastWrite), new Date(opts.lastWrite));
  return file;
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('CodexCliProvider.findRunSession (#2132)', () => {
  const find = (resumedId?: string) => provider.findRunSession({ cwd: CWD, startedAt: RUN_START, endedAt: RUN_END, resumedId, profileEnv: env() });

  it('finds the rollout this run wrote for its cwd', async () => {
    rollout(ID_A, { cwd: CWD, started: RUN_START + 7_000, lastWrite: RUN_END - 1_000 });
    expect(await find()).toBe(ID_A);
  });

  it('ignores rollouts from another cwd and from outside the run', async () => {
    rollout(ID_OTHER, { cwd: '/work/elsewhere', started: RUN_START + 7_000, lastWrite: RUN_END - 1_000 });
    rollout(ID_OLD, { cwd: CWD, started: RUN_START - 86_400_000, lastWrite: RUN_START - 3_600_000 });
    expect(await find()).toBeNull();
  });

  it('takes the earliest session started during the run when two did: the run\'s own starts first', async () => {
    rollout(ID_A, { cwd: CWD, started: RUN_START + 7_000, lastWrite: RUN_START + 60_000 });
    rollout(ID_B, { cwd: CWD, started: RUN_START + 120_000, lastWrite: RUN_END - 1_000 });
    expect(await find()).toBe(ID_A);
  });

  it('never takes another session in the same cwd that was already running before the run', async () => {
    // The user's own codex, or another agent without a worktree, writing the whole time.
    rollout(ID_OTHER, { cwd: CWD, started: RUN_START - 600_000, lastWrite: RUN_END - 500 });
    expect(await find()).toBeNull();
    rollout(ID_A, { cwd: CWD, started: RUN_START + 7_000, lastWrite: RUN_END - 1_000 });
    expect(await find()).toBe(ID_A);
  });

  it('takes the rollout the run resumed and appended to', async () => {
    rollout(ID_OLD, { cwd: CWD, started: RUN_START - 86_400_000, lastWrite: RUN_END - 2_000 });
    rollout(ID_OTHER, { cwd: CWD, started: RUN_START - 600_000, lastWrite: RUN_END - 500 });
    expect(await find(ID_OLD)).toBe(ID_OLD);
  });

  it('does not take a resumed rollout the run never wrote to', async () => {
    rollout(ID_OLD, { cwd: CWD, started: RUN_START - 86_400_000, lastWrite: RUN_START - 3_600_000 });
    expect(await find(ID_OLD)).toBeNull();
  });

  it('reads cwd from a meta line too long to parse from the prefix', async () => {
    rollout(ID_A, { cwd: CWD, started: RUN_START + 7_000, lastWrite: RUN_END - 1_000, pad: 100_000 });
    expect(await find()).toBe(ID_A);
  });

  it('looks in CODEX_HOME, not ~/.codex', async () => {
    rollout(ID_A, { cwd: CWD, started: RUN_START + 7_000, lastWrite: RUN_END - 1_000 });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-empty-'));
    try {
      expect(await provider.findRunSession({ cwd: CWD, startedAt: RUN_START, endedAt: RUN_END, profileEnv: { CODEX_HOME: elsewhere } })).toBeNull();
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('CodexCliProvider.hasSession (#2132)', () => {
  it('is true for a rollout in the store and false for a made-up id', async () => {
    rollout(ID_A, { cwd: CWD, started: RUN_START, lastWrite: RUN_END });
    expect(await provider.hasSession(ID_A, env())).toBe(true);
    expect(await provider.hasSession('fba922a2-0000-4000-8000-000000000000', env())).toBe(false);
  });

  it('is false when CODEX_HOME has no session store at all', async () => {
    expect(await provider.hasSession(ID_A, env())).toBe(false);
  });
});

describe('CodexCliProvider.extractSessionId (#2132)', () => {
  it('reads the exit hint through escape sequences', () => {
    const tui = `\x1b[2mToken usage: 1.2K\x1b[0m\r\n\x1b[2mTo continue this session, run \x1b[0m\x1b[1mcodex resume ${ID_A}\x1b[0m\r\n`;
    expect(provider.extractSessionId(tui)).toBe(ID_A);
  });

  it('takes the last id printed', () => {
    expect(provider.extractSessionId(`Session: ${ID_OLD}\r\n...\r\ncodex resume ${ID_B}\r\n`)).toBe(ID_B);
  });

  it('reads the looser labels only near the end, the exit hint anywhere', () => {
    const filler = '.'.repeat(5_000);
    expect(provider.extractSessionId(`Session: ${ID_OLD}\r\n${filler}`)).toBeNull();
    expect(provider.extractSessionId(`codex resume ${ID_A}\r\n${filler}`)).toBe(ID_A);
  });

  it('returns null when Codex printed no id', () => {
    expect(provider.extractSessionId('\x1b[?25h\x1b[?2026l› Implement {feature}\r\n')).toBeNull();
  });
});
