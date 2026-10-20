import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real fs, with every *Sync function and readdir spied on, so lookups can be
// checked for blocking calls and full-store scans (#2277).
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const [k, v] of Object.entries(actual)) if (k.endsWith('Sync') && typeof v === 'function') wrapped[k] = vi.fn(v);
  return { ...wrapped, default: wrapped };
});
vi.mock('fs/promises', async (orig) => {
  const actual = await orig<typeof import('fs/promises')>();
  const wrapped = { ...actual, readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) };
  return { ...wrapped, default: wrapped };
});

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  copilotSessionInCwd, cwdKey, findCopilotRunSession, findCopilotTranscript, hasCopilotSession, listCopilotSessions, parseWorkspaceYaml,
} from './copilot-session-store';

let root: string;
let store: string;
let cwd: string;
let otherCwd: string;

const T0 = Date.parse('2026-10-18T07:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A session directory as Copilot 1.0.x writes it. */
function session(id: string, ws: { cwd: string; created: number; updated?: number }, opts: { mtime?: number } = {}) {
  const dir = path.join(store, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), [
    `id: ${id}`,
    `cwd: ${ws.cwd}`,
    'host_type: github',
    'client_name: github/cli',
    `created_at: ${iso(ws.created)}`,
    `updated_at: ${iso(ws.updated ?? ws.created)}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'session.start', data: { sessionId: id } })}\n`);
  const m = (opts.mtime ?? ws.updated ?? ws.created) / 1000;
  fs.utimesSync(dir, m, m);
}

const A = 'aaaaaaaa-1111-4000-8000-000000000001';
const B = 'bbbbbbbb-2222-4000-8000-000000000002';
const C = 'cccccccc-3333-4000-8000-000000000003';
const D = 'dddddddd-4444-4000-8000-000000000004';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-store-'));
  store = path.join(root, 'session-state');
  fs.mkdirSync(store);
  cwd = path.join(root, 'agents', 'lucky-mantis');
  otherCwd = path.join(root, 'agents', 'someone-else');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('parseWorkspaceYaml', () => {
  it('reads id, cwd and timestamps, quoted or not', () => {
    expect(parseWorkspaceYaml(`id: ${A}\ncwd: "/a b/c"\ncreated_at: '2026-10-18T07:34:33.488Z'\nupdated_at: 2026-10-18T07:38:52.225Z\nname: x\n`)).toEqual({
      id: A, cwd: '/a b/c', createdAt: '2026-10-18T07:34:33.488Z', updatedAt: '2026-10-18T07:38:52.225Z',
    });
  });

  it('unescapes double-quoted values (a Windows cwd) and doubled single quotes', () => {
    expect(parseWorkspaceYaml('cwd: "C:\\\\Users\\\\me\\\\my \\"wt\\""\n').cwd).toBe('C:\\Users\\me\\my "wt"');
    expect(parseWorkspaceYaml("cwd: 'C:\\Users\\it''s'\n").cwd).toBe("C:\\Users\\it's");
    expect(parseWorkspaceYaml('cwd: C:\\Users\\me\n').cwd).toBe('C:\\Users\\me');
  });
});

describe('cwdKey', () => {
  it('on Windows ignores case, separator style and a trailing separator', () => {
    const key = cwdKey('C:\\Users\\Me\\wt', 'win32');
    expect(cwdKey('c:\\users\\me\\WT\\', 'win32')).toBe(key);
    expect(cwdKey('C:/Users/Me/wt', 'win32')).toBe(key);
    expect(cwdKey('C:\\Users\\Me\\other\\..\\wt', 'win32')).toBe(key);
    expect(cwdKey('C:\\Users\\Me\\wt2', 'win32')).not.toBe(key);
  });

  it('elsewhere keeps case and drops a trailing slash', () => {
    expect(cwdKey('/a/B/', 'darwin')).toBe('/a/B');
    expect(cwdKey('/a/b', 'linux')).not.toBe(cwdKey('/a/B', 'linux'));
    expect(cwdKey('/', 'linux')).toBe('/');
  });
});

describe('findCopilotRunSession', () => {
  it('finds the session a fresh run created for its cwd', async () => {
    session(A, { cwd: otherCwd, created: T0 + 10_000 }); // another agent, same time
    session(B, { cwd, created: T0 - 3_600_000, updated: T0 - 3_000_000 }); // older session in this cwd
    session(C, { cwd, created: T0 + 2_000, updated: T0 + 60_000 }); // this run's
    expect(await findCopilotRunSession(store, { cwd, startedAt: T0, endedAt: T0 + 90_000 })).toBe(C);
  });

  it('picks the earliest of two sessions created in the run window', async () => {
    session(C, { cwd, created: T0 + 2_000, updated: T0 + 80_000 });
    session(D, { cwd, created: T0 + 40_000, updated: T0 + 85_000 });
    expect(await findCopilotRunSession(store, { cwd, startedAt: T0, endedAt: T0 + 90_000 })).toBe(C);
  });

  it('returns the resumed id when the run was active in it', async () => {
    session(B, { cwd, created: T0 - 3_600_000, updated: T0 + 30_000 });
    expect(await findCopilotRunSession(store, { cwd, startedAt: T0, endedAt: T0 + 90_000, resumedId: B })).toBe(B);
  });

  it('does not return a resumed id that is not in the store (#2156)', async () => {
    expect(await findCopilotRunSession(store, { cwd, startedAt: T0, endedAt: T0 + 90_000, resumedId: A })).toBeNull();
  });

  it('a resumed id untouched during the run falls back to a session the run created', async () => {
    session(B, { cwd, created: T0 - 3_600_000, updated: T0 - 3_000_000 });
    session(C, { cwd, created: T0 + 5_000 });
    expect(await findCopilotRunSession(store, { cwd, startedAt: T0, endedAt: T0 + 90_000, resumedId: B })).toBe(C);
  });

  it('returns null when nothing for this cwd started in the window', async () => {
    session(A, { cwd: otherCwd, created: T0 + 1_000 });
    session(B, { cwd, created: T0 - 3_600_000 }, { mtime: T0 + 1_000 }); // touched, but started before the run
    expect(await findCopilotRunSession(store, { cwd, startedAt: T0, endedAt: T0 + 90_000 })).toBeNull();
  });

  it('matches a cwd recorded through a symlink', async () => {
    const link = path.join(root, 'link-to-agent');
    fs.symlinkSync(cwd, link);
    session(C, { cwd: fs.realpathSync(cwd), created: T0 + 2_000 });
    expect(await findCopilotRunSession(store, { cwd: link, startedAt: T0, endedAt: T0 + 90_000 })).toBe(C);
  });

  it('returns null when there is no store', async () => {
    expect(await findCopilotRunSession(path.join(root, 'nope'), { cwd, startedAt: T0, endedAt: T0 + 1 })).toBeNull();
  });
});

describe('listCopilotSessions', () => {
  it('lists this cwd\'s sessions, newest first, and skips other cwds and non-session entries', async () => {
    session(A, { cwd, created: T0, updated: T0 + 1_000 });
    session(B, { cwd: otherCwd, created: T0 });
    session(C, { cwd, created: T0 + 5_000, updated: T0 + 9_000 });
    fs.mkdirSync(path.join(store, 'not-a-session'));
    fs.writeFileSync(path.join(store, `${D}.jsonl`), '{}\n');
    const list = await listCopilotSessions(store, cwd);
    expect(list.map((s) => s.sessionId)).toEqual([C, A]);
    expect(list[0]).toEqual({ sessionId: C, startedAt: iso(T0 + 5_000), lastActiveAt: iso(T0 + 9_000) });
  });

  it('returns [] with no store', async () => {
    expect(await listCopilotSessions(path.join(root, 'nope'), cwd)).toEqual([]);
  });
});

describe('hasCopilotSession', () => {
  it('finds a session directory, in either case', async () => {
    session(A, { cwd, created: T0 });
    expect(await hasCopilotSession(store, A)).toBe(true);
    expect(await hasCopilotSession(store, A.toUpperCase())).toBe(true);
  });

  it('finds a legacy flat session file', async () => {
    fs.writeFileSync(path.join(store, `${D}.jsonl`), '{}\n');
    expect(await hasCopilotSession(store, D)).toBe(true);
  });

  it('is false for the ids lucky-mantis saved that Copilot never had', async () => {
    session(A, { cwd, created: T0 });
    for (const id of ['5a9287d6-3321-4c0d-b65b-b115bab41f82', '88618d97-9626-47a3-9479-04643a68d3d7', 'a27ef93a-2030-45fd-943e-6e07ac0a811c']) {
      expect(await hasCopilotSession(store, id)).toBe(false);
    }
  });

  it('is false for a non-uuid id', async () => {
    expect(await hasCopilotSession(store, '../etc')).toBe(false);
  });

  it('can\'t tell when there is no store where it looked (COPILOT_HOME elsewhere)', async () => {
    expect(await hasCopilotSession(path.join(root, 'nope'), A)).toBeUndefined();
    const file = path.join(root, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(await hasCopilotSession(file, A)).toBeUndefined();
  });
});

describe('copilotSessionInCwd', () => {
  it('is true for a session recorded for the cwd, also through a symlink', async () => {
    session(A, { cwd: fs.realpathSync(cwd), created: T0 });
    expect(await copilotSessionInCwd(store, A, cwd)).toBe(true);
    const link = path.join(root, 'link');
    fs.symlinkSync(cwd, link);
    expect(await copilotSessionInCwd(store, A, link)).toBe(true);
  });

  it('is false for a real session from another cwd, or a missing one', async () => {
    session(B, { cwd: otherCwd, created: T0 });
    expect(await copilotSessionInCwd(store, B, cwd)).toBe(false);
    expect(await copilotSessionInCwd(store, C, cwd)).toBe(false);
    expect(await copilotSessionInCwd(store, 'not-a-uuid', cwd)).toBe(false);
  });

  it('can\'t tell without a store, for a legacy file, or with no cwd recorded', async () => {
    expect(await copilotSessionInCwd(path.join(root, 'nope'), A, cwd)).toBeUndefined();
    fs.writeFileSync(path.join(store, `${D}.jsonl`), '{}\n');
    expect(await copilotSessionInCwd(store, D, cwd)).toBeUndefined();
    fs.mkdirSync(path.join(store, C));
    fs.writeFileSync(path.join(store, C, 'workspace.yaml'), `id: ${C}\n`);
    expect(await copilotSessionInCwd(store, C, cwd)).toBeUndefined();
  });
});

describe('findCopilotTranscript (#2277)', () => {
  /** Calls to any synchronous fs function since the last clear. */
  const syncCalls = () => Object.entries(fs)
    .filter(([k, v]) => k.endsWith('Sync') && vi.isMockFunction(v) && (v as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    .map(([k]) => k);

  it('finds a session among thousands with a few direct probes, no store scan and no sync fs', async () => {
    for (let i = 0; i < 3000; i++) fs.mkdirSync(path.join(store, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    session(A, { cwd, created: T0 });
    expect(syncCalls()).toContain('mkdirSync'); // the spies see sync calls
    vi.clearAllMocks();

    const counter = { probes: 0 };
    const found = await findCopilotTranscript(store, A, cwd, counter);

    expect(found).toBe(path.join(store, A, 'events.jsonl'));
    expect(counter.probes).toBe(1);
    expect(syncCalls()).toEqual([]);
    expect(fsp.readdir).not.toHaveBeenCalled();
  });

  it('misses in a bounded number of probes regardless of store size', async () => {
    for (let i = 0; i < 3000; i++) fs.mkdirSync(path.join(store, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    vi.clearAllMocks();

    const counter = { probes: 0 };
    expect(await findCopilotTranscript(store, B, cwd, counter)).toBeNull();
    expect(counter.probes).toBeLessThanOrEqual(8);
    expect(vi.mocked(fsp.stat).mock.calls.length + vi.mocked(fsp.readdir).mock.calls.length).toBe(counter.probes);
    expect(vi.mocked(fsp.readdir).mock.calls.map((c) => String(c[0]))).not.toContain(store);
    expect(syncCalls()).toEqual([]);
  });

  it('finds legacy flat transcripts, at the root or under the dash-encoded cwd', async () => {
    fs.writeFileSync(path.join(store, `${A}.jsonl`), '{}\n');
    expect(await findCopilotTranscript(store, A, cwd)).toBe(path.join(store, `${A}.jsonl`));

    // A Windows cwd encodes to `C:-…`, which can't be a directory name there
    if (process.platform === 'win32') return;
    const encoded = path.resolve(cwd).replace(/[/\\]/g, '-');
    fs.mkdirSync(path.join(store, encoded));
    fs.writeFileSync(path.join(store, encoded, `${B}.json`), '{}\n');
    expect(await findCopilotTranscript(store, B, cwd)).toBe(path.join(store, encoded, `${B}.json`));
  });

  it('falls back to another .jsonl in the session directory', async () => {
    fs.mkdirSync(path.join(store, C));
    fs.writeFileSync(path.join(store, C, 'transcript.jsonl'), '{}\n');
    expect(await findCopilotTranscript(store, C, cwd)).toBe(path.join(store, C, 'transcript.jsonl'));
  });

  it('rejects ids that are not a single path segment', async () => {
    fs.writeFileSync(path.join(root, 'outside.jsonl'), '{}\n');
    expect(await findCopilotTranscript(store, '../outside', cwd)).toBeNull();
    expect(await findCopilotTranscript(store, '..', cwd)).toBeNull();
    expect(await findCopilotTranscript(store, '', cwd)).toBeNull();
  });
});
