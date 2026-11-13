import { describe, expect, it } from 'vitest';
import type { Action, ActionRun } from './types';
import { summarizeActionUsage } from './usage';

const DAY = 24 * 60 * 60_000;
const NOW = 10 * DAY;
const action = (id: string, owner: Action['owner']): Action => ({
  id, owner, name: id, trigger: { kind: 'once', at: NOW }, steps: [{ kind: 'notify', text: 'Ready' }],
  enabled: true, overlap: 'skip', createdAt: 1, updatedAt: 1,
});
const run = (actionId: string, age: number, outcome: ActionRun['outcome'] = 'done', owner?: ActionRun['owner']): ActionRun => ({
  id: `${actionId}:${age}:${outcome}`, actionId, owner, startedAt: NOW - age, outcome,
  trigger: { kind: 'manual', at: NOW - age }, steps: [], chain: [],
});

describe('recent Action usage', () => {
  it('keeps separate group projects as separate owners', () => {
    const groups = summarizeActionUsage([action('a', { kind: 'group_project', groupProjectId: 'one' }), action('b', { kind: 'group_project', groupProjectId: 'two' })], [], NOW);
    expect(groups.map((g) => g.owner)).toEqual([{ kind: 'group_project', groupProjectId: 'one' }, { kind: 'group_project', groupProjectId: 'two' }]);
  });
  it('groups saved Actions and retained runs by their owner with exact rolling boundaries', () => {
    const groups = summarizeActionUsage([
      action('yours', { kind: 'user' }), action('agent', { kind: 'agent', agentId: 'lead' }),
      action('dispatcher', { kind: 'dispatcher' }), action('hidden', { kind: 'app' }),
    ], [
      run('yours', 0), run('yours', DAY, 'failed'), run('yours', DAY + 1, 'failed'),
      run('yours', 7 * DAY), run('yours', 7 * DAY + 1), run('yours', -1),
      run('agent', 0, 'running'), run('hidden', 0, 'failed'),
    ], NOW);
    expect(groups).toEqual([
      { owner: { kind: 'user' }, actions: [{ id: 'yours', name: 'yours' }], runs24h: 2, runs7d: 4, failures24h: 1, failures7d: 2 },
      { owner: { kind: 'agent', agentId: 'lead' }, actions: [{ id: 'agent', name: 'agent' }], runs24h: 1, runs7d: 1, failures24h: 0, failures7d: 0 },
      { owner: { kind: 'dispatcher' }, actions: [{ id: 'dispatcher', name: 'dispatcher' }], runs24h: 0, runs7d: 0, failures24h: 0, failures7d: 0 },
    ]);
  });

  it('uses recorded owners for deleted and one-time Actions and keeps unknown older runs separate', () => {
    const groups = summarizeActionUsage([action('saved', { kind: 'user' })], [
      run('gone', 1, 'failed', { kind: 'agent', agentId: 'old-lead' }),
      run('saved', 2, 'done'),
      run('old-deleted', 3, 'cancelled'),
      run('app-deleted', 4, 'failed', { kind: 'app' }),
    ], NOW);
    expect(groups).toMatchObject([
      { owner: { kind: 'user' }, runs24h: 1 },
      { owner: { kind: 'agent', agentId: 'old-lead' }, actions: [], runs24h: 1, failures24h: 1 },
      { actions: [], runs24h: 1 },
    ]);
    expect(groups[2].owner).toBeUndefined();
  });
});
