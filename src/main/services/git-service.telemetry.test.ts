import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

interface FlowRecord {
  name: string;
  attrs: Array<{ key: string; value: unknown }>;
  classification?: unknown;
}

const rec = vi.hoisted(() => ({
  flows: [] as FlowRecord[],
  counts: [] as Array<{ name: string; value: number; attrs?: Array<{ key: string; value: unknown }> }>,
  replays: [] as Array<{ name: string }>,
  active: true,
}));

vi.mock('../telemetry/facade', () => ({
  tel: {
    flow: async (name: string, opts: { attrs?: FlowRecord['attrs'] }, fn: (s: { set: (...a: FlowRecord['attrs']) => void }) => unknown, extras?: { classify?: (r: unknown) => unknown }) => {
      const record: FlowRecord = { name, attrs: [...(opts.attrs ?? [])] };
      rec.flows.push(record);
      const result = await fn({ set: (...a) => record.attrs.push(...a) });
      record.classification = extras?.classify ? extras.classify(result) : 'ok';
      return result;
    },
    count: (name: string, value: number, attrs?: Array<{ key: string; value: unknown }>) => rec.counts.push({ name, value, attrs }),
  },
  replaySpan: (s: { name: string }) => rec.replays.push(s),
  isTelemetryActive: () => rec.active,
}));

import { execFile } from 'child_process';
import { checkout, commit, getGitInfo, listWorktrees, push } from './git-service';

const DIR = path.join(path.sep, 'test', 'repo');

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function mockGit(handler: (args: string[]) => { stdout?: string; error?: Partial<Error> & Record<string, unknown> }) {
  vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _opts: unknown, cb: ExecCb) => {
    const r = handler(args);
    if (r.error) {
      const err = Object.assign(new Error(String(r.error.message ?? 'failed')), r.error);
      cb(err, '', String(r.error.stderr ?? ''));
    } else {
      cb(null, r.stdout ?? '', '');
    }
    return {} as never;
  }) as never);
}

const attr = (f: FlowRecord, key: string) => f.attrs.find((a) => a.key === key)?.value;

beforeEach(() => {
  rec.active = true;
  rec.flows = [];
  rec.counts = [];
  rec.replays = [];
});

describe('git-service telemetry', () => {
  it('names each user operation and classifies stderr locally, never sending it', async () => {
    mockGit(() => ({ error: { code: 1, stderr: 'error: Your local changes would be overwritten by checkout.\nCONFLICT (content)' } }));
    const result = await checkout(DIR, 'feature/secret-branch');
    expect(result.ok).toBe(false);
    const [flow] = rec.flows;
    expect(flow.name).toBe('clubhouse.git.checkout');
    expect(attr(flow, 'clubhouse.git.op')).toBe('checkout');
    expect(attr(flow, 'process.exit.code')).toBe(1);
    expect(attr(flow, 'clubhouse.git.timed_out')).toBe(false);
    expect(flow.classification).toEqual({ error: 'conflict' });
    expect(JSON.stringify(rec.flows)).not.toMatch(/secret-branch|overwritten/);
  });

  it('classifies validation errors, records them, and rethrows unchanged', async () => {
    mockGit(() => ({ stdout: '' }));
    await expect(checkout(DIR, '--force')).rejects.toThrow("Invalid branch name: must not start with '-'");
    expect(rec.flows[0].classification).toEqual({ error: 'validation' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports a missing remote as no_remote without polling status', async () => {
    mockGit((args) => ({ stdout: args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? 'true' : '' }));
    expect(await push(DIR)).toEqual({ ok: false, message: 'No remote configured' });
    expect(rec.flows[0]).toMatchObject({ name: 'clubhouse.git.push', classification: { error: 'no_remote' } });
    expect(rec.counts.some((c) => c.name === 'clubhouse.git.status.polls')).toBe(false);
  });

  it('classifies timeouts and auth failures', async () => {
    mockGit(() => ({ error: { killed: true, signal: 'SIGTERM' } }));
    await commit(DIR, 'msg');
    expect(rec.flows[0]).toMatchObject({ classification: { error: 'timeout' } });
    expect(attr(rec.flows[0], 'clubhouse.git.timed_out')).toBe(true);

    mockGit(() => ({ error: { code: 128, stderr: 'fatal: Authentication failed for https://github.com/acme/x' } }));
    await commit(DIR, 'msg');
    expect(rec.flows[1]).toMatchObject({ classification: { error: 'auth' } });
  });

  it('records the status poll as a histogram and counter, never a span', async () => {
    mockGit((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { stdout: 'true' };
      if (args[0] === 'status') return { stdout: ' M a.ts\n?? b.ts\n' };
      return { stdout: '' };
    });
    await getGitInfo(DIR);
    expect(rec.flows).toEqual([]);
    expect(rec.counts.find((c) => c.name === 'clubhouse.git.status.polls')).toBeDefined();
    const duration = rec.counts.find((c) => c.name === 'clubhouse.git.status.duration');
    expect(duration?.attrs).toEqual([expect.objectContaining({ key: 'clubhouse.git.status.file_count_bucket', value: '1-9' })]);
    expect(rec.counts.filter((c) => c.name === 'clubhouse.git.subprocess.duration').every((c) => c.attrs?.[0].value === 'status' || c.attrs?.[0].value === 'other')).toBe(true);
    expect(rec.replays).toEqual([]);
  });

  it('rethrows a failed worktree list after classifying it', async () => {
    mockGit(() => ({ error: { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }));
    await expect(listWorktrees(DIR)).rejects.toThrow();
    expect(rec.flows[0]).toMatchObject({ name: 'clubhouse.git.worktree_list', classification: { error: 'not_a_repo' } });
  });

  it('does no metric work for polls while telemetry is off', async () => {
    rec.active = false;
    mockGit((args) => ({ stdout: args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? 'true' : '' }));
    await getGitInfo(DIR);
    expect(rec.counts).toEqual([]);
  });
});
