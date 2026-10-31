import { describe, it, expect } from 'vitest';
import type { DurableAgentConfig } from '../../../../shared/types';
import {
  accessLabel, checkFailureReason, checkLines, checksFailed, hasWorkAtRisk, helperDot, helperState, orphanedDisposed, plainFailure, splitHelpers, workSummary,
} from './helper-model';
import { maxHelpersCeiling, parseHelperCount } from './orchestration-hooks';

const row = (id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig => ({
  id, name: id, color: 'teal', createdAt: '2026-10-18T09:00:00Z', ...extra,
});

describe('helperState', () => {
  it('puts an unfinished creation first, then a hand-off, then running or asleep', () => {
    expect(helperState(row('a', { creation: { state: 'creating', startedAt: '' } }), { status: 'sleeping' })).toBe('starting');
    expect(helperState(row('a'), { status: 'creating' })).toBe('starting');
    expect(helperState(row('a', { creation: { state: 'failed', startedAt: '', reason: 'x' } }), { status: 'error' })).toBe('failed');
    expect(helperState({ ...row('a'), handoff: { how: 'pushed', note: '', at: '2026-10-18T11:00:00Z' } }, { status: 'running' })).toBe('handed-off');
    expect(helperState(row('a'), { status: 'running' })).toBe('running');
    expect(helperState(row('a'), { status: 'waking' })).toBe('running');
    expect(helperState(row('a'), { status: 'sleeping' })).toBe('sleeping');
    expect(helperState(row('a'))).toBe('sleeping');
  });

  it('picks a dot for each state', () => {
    expect(helperDot('starting', undefined)).toBe('starting');
    expect(helperDot('failed', undefined)).toBe('error');
    expect(helperDot('running', 'needs')).toBe('needs');
    expect(helperDot('running', undefined)).toBe('idle');
    expect(helperDot('sleeping', 'working')).toBe('sleeping');
  });
});

describe('splitHelpers and orphanedDisposed', () => {
  const configs = [
    row('lead'),
    row('h1', { parentAgentId: 'lead' }),
    row('d1', { parentAgentId: 'lead', disposedAt: '2026-10-18T10:00:00Z' }),
    row('d2', { parentAgentId: 'gone', disposedAt: '2026-10-18T10:00:00Z' }),
    row('d3', { disposedAt: '2026-10-18T10:00:00Z' }),
  ];
  it('splits direct helpers into live and disposed', () => {
    const { live, disposed } = splitHelpers(configs.map((config) => ({ projectPath: 'p', config })), 'lead');
    expect(live.map((h) => h.config.id)).toEqual(['h1']);
    expect(disposed.map((h) => h.config.id)).toEqual(['d1']);
  });
  it('finds disposed helpers no Helpers card can reach', () => {
    expect(orphanedDisposed(configs).map((c) => c.id)).toEqual(['d2', 'd3']);
  });
  it('counts a helper whose orchestrator is in another project as reachable while that orchestrator is there (#2514)', () => {
    const elsewhere = [
      row('x1', { parentAgentId: 'remote-lead', parentProjectPath: 'other', disposedAt: '2026-10-18T10:00:00Z' }),
      row('x2', { parentAgentId: 'gone', parentProjectPath: 'other', disposedAt: '2026-10-18T10:00:00Z' }),
      // Same id as an agent in this file, but its parent is in the other project.
      row('x3', { parentAgentId: 'lead', parentProjectPath: 'other', disposedAt: '2026-10-18T10:00:00Z' }),
    ];
    const list = [...configs, ...elsewhere];
    expect(orphanedDisposed(list, (c) => c.parentAgentId === 'remote-lead').map((c) => c.id)).toEqual(['d2', 'd3', 'x2', 'x3']);
    // Without a lookup, every cross-project link counts as gone.
    expect(orphanedDisposed(list).map((c) => c.id)).toEqual(['d2', 'd3', 'x1', 'x2', 'x3']);
  });
});

describe('dispose checks', () => {
  it('treats a failed check as blocking, never as work at risk', () => {
    const failed = { dirty: 0, unpushed: 0, unmerged: null, error: 'boom' };
    expect(checksFailed(failed)).toBe(true);
    expect(hasWorkAtRisk(failed)).toBe(false);
    expect(hasWorkAtRisk({ dirty: 1, unpushed: 0, unmerged: 0 })).toBe(true);
    expect(hasWorkAtRisk({ dirty: 0, unpushed: 0, unmerged: 9 })).toBe(false);
  });

  it('summarises a row and lists lines worst first', () => {
    expect(workSummary(undefined)).toBeNull();
    expect(workSummary({ dirty: 0, unpushed: 0, unmerged: 3 })).toBe('clean');
    expect(workSummary({ dirty: 2, unpushed: 150, unmerged: 0 })).toBe('2 uncommitted, 99+ unpushed');
    expect(workSummary({ dirty: 0, unpushed: 0, unmerged: null, error: 'x' })).toBe('couldn’t check');
    expect(checkLines({ dirty: 0, unpushed: 150, unmerged: 2 }).map((l) => [l.kind, l.text])).toEqual([
      ['risk', 'More than 99 commits not pushed'],
      ['info', '2 commits not merged into the base branch'],
      ['ok', 'No uncommitted files'],
    ]);
    expect(checkLines({ dirty: 1, unpushed: 0, unmerged: null }).map((l) => l.text)).toEqual([
      '1 file not committed',
      'Every commit is pushed or on another branch',
    ]);
  });
});

describe('labels and limits', () => {
  it('names access the way the level menu does', () => {
    expect(accessLabel('same', 'epic-lead')).toBe('Same as epic-lead');
    expect(accessLabel('standard', 'x')).toBe('Ask first');
    expect(accessLabel('bypass', 'x')).toBe('Full access');
  });

  it('keeps a helper count whole and within the ceiling', () => {
    expect(parseHelperCount('5', 20)).toEqual({ value: 5 });
    expect(parseHelperCount(' 20 ', 20)).toEqual({ value: 20 });
    expect(parseHelperCount('21', 20)).toHaveProperty('error');
    expect(parseHelperCount('2.5', 20)).toHaveProperty('error');
    expect(parseHelperCount('', 20)).toHaveProperty('error');
    expect(maxHelpersCeiling(500)).toBe(100);
    expect(maxHelpersCeiling(8)).toBe(8);
  });
});

describe('failure text', () => {
  const RAW = "Command failed: git show-ref --verify refs/heads/h1\nfatal: not a git repository (or any of the parent directories): .git";

  it('keeps raw git output out of a failed check line, and in its detail', () => {
    const [line] = checkLines({ dirty: 0, unpushed: 0, unmerged: null, error: `couldn't check, ${RAW}` });
    expect(line).toEqual({ kind: 'failed', text: 'Couldn’t be checked because git couldn’t read its folder', detail: RAW });
    // No doubled "couldn't check" inside "Couldn't be checked".
    expect(line.text).not.toMatch(/check.*couldn.t check/i);
  });

  it('uses a reason that already reads as words', () => {
    expect(checkLines({ dirty: 0, unpushed: 0, unmerged: null, error: 'it is still being created in another Clubhouse window' })[0].text)
      .toBe('Couldn’t be checked because it is still being created in another Clubhouse window');
    expect(checkFailureReason('couldn’t check, its remote has never been fetched.')).toEqual({ text: 'its remote has never been fetched' });
  });

  it('tells raw output from sentences', () => {
    expect(plainFailure(RAW, 'fallback')).toEqual({ text: 'fallback', detail: RAW });
    expect(plainFailure('spawn claude ENOENT', 'fallback')).toEqual({ text: 'fallback', detail: 'spawn claude ENOENT' });
    expect(plainFailure('The branch impl-docs/work already exists', 'fallback')).toEqual({ text: 'The branch impl-docs/work already exists' });
    expect(plainFailure(undefined, 'fallback')).toEqual({ text: 'fallback' });
  });
});
