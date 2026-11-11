import { describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => new Map<string, { atomic?: boolean; onLoad?: (r: { raw: string } | { error: unknown }) => void }>());
const backup = vi.hoisted(() => vi.fn());
const migrations = vi.hoisted(() => new Map<string, (raw: Record<string, unknown>) => unknown>());
vi.mock('../settings-store', () => ({
  createSettingsStore: (f: string, defaults: unknown, migrate: (raw: Record<string, unknown>) => unknown, options: { atomic?: boolean } = {}) => {
    stores.set(f, options);
    migrations.set(f, migrate);
    return { get: () => defaults, save: async () => undefined, update: async () => defaults };
  },
  backupUnreadableSettings: backup,
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createRunHistory, sanitizeActions, settleInterruptedRuns } from './actions-store';

describe('actions store', () => {
  it('retains recorded owners across reload while leaving older ownerless runs unchanged', () => {
    const run = { id: 'r1', actionId: 'deleted', trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, outcome: 'done', steps: [] };
    const migrate = migrations.get('action-history.json')!;
    const runs = [run, { ...run, id: 'r2', owner: { kind: 'agent', agentId: 'lead' } }];
    expect(migrate({ runs: { deleted: runs } })).toEqual({ version: 1, runs: { deleted: runs } });
  });

  it('reads all retained history across actions without losing each action’s trim', async () => {
    const history = createRunHistory(() => 100);
    const run = { id: 'r1', actionId: 'deleted', trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, outcome: 'done', steps: [] } as const;
    history.put({ ...run, chain: [], steps: [] });
    history.put({ ...run, id: 'r2', actionId: 'other', chain: [], steps: [] });
    expect(history.list()).toHaveLength(2);
    expect(history.list('deleted')).toHaveLength(1);
    await history.flush();
  });

  it('loads older quick steps unchanged and retains explicit Auto difficulty', () => {
    const old = {
      id: 'a1', name: 'Review', trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' },
      steps: [{ kind: 'quick', projectId: 'p1', prompt: 'Review' }], overlap: 'skip', owner: { kind: 'user' }, enabled: true, createdAt: 1, updatedAt: 1,
    };
    expect(sanitizeActions([old])).toEqual([old]);
    const auto = { ...old, steps: [{ ...old.steps[0], orchestrator: 'auto', difficulty: 'hard' }] };
    expect(sanitizeActions([auto])).toEqual([auto]);
  });

  it('loads older any-turn actions unchanged alongside a new quick-finish trigger', () => {
    const legacy = { id: 'legacy', name: 'Review', trigger: { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' } }, steps: [{ kind: 'quick', projectId: 'p1', prompt: 'Review' }], overlap: 'skip', owner: { kind: 'user' }, enabled: true, createdAt: 1, updatedAt: 2 };
    const quick = { ...legacy, id: 'quick', trigger: { kind: 'event', event: 'agent.quick_finished', source: { kind: 'project', projectId: 'p1' } } };
    const raw = JSON.parse(JSON.stringify({ version: 1, actions: [legacy, quick], state: { nextAt: {}, waits: [] } }));
    expect(migrations.get('actions.json')!(raw)).toEqual(raw);
  });
  it('loads persisted last use and keeps older engine state unchanged', () => {
    const migrate = migrations.get('actions.json')!;
    const state = { nextAt: {}, waits: [] };
    expect(migrate({ actions: [], state })).toEqual({ version: 1, actions: [], state });
    expect(migrate({ actions: [], state: { ...state, lastUse: 1234 } })).toEqual({ version: 1, actions: [], state: { ...state, lastUse: 1234 } });
  });

  it('preserves quick-source read checks on delayed waits without changing older waits', () => {
    const wait = { actionId: 'review', agentId: 'lead', startedAt: 1, dueAt: 60_001, chain: [], detail: 'A turn finished' };
    const state = { nextAt: {}, waits: [wait, { ...wait, agentId: 'quick', sourceAgentId: 'quick' }] };
    expect(migrations.get('actions.json')!({ actions: [], state })).toEqual({ version: 1, actions: [], state });
  });

  it('keeps valid local-date high-water marks and drops malformed persisted dates', () => {
    const migrate = migrations.get('actions.json')!;
    expect(migrate({ state: { lastFiredDate: { a: '2026-11-09', b: '2026-99-99', c: '2026-02-30', d: 1 } } }))
      .toEqual({ version: 1, actions: [], state: { nextAt: {}, waits: [], lastFiredDate: { a: '2026-11-09' } } });
  });

  it('keeps expired actions and their lifetime counter on reload', () => {
    const a = {
      id: 'expired', name: 'Temporary', trigger: { kind: 'event', event: 'app.started', source: { kind: 'app' } },
      steps: [{ kind: 'notify', text: 'hi' }], overlap: 'skip', owner: { kind: 'user' }, enabled: false,
      endsAt: 1, maxRuns: 100, runsUsed: 37, offReason: 'Ended at the set time', createdAt: 0, updatedAt: 1,
    };
    expect(sanitizeActions([a])).toEqual([a]);
  });

  it('keeps valid actions and drops broken ones', () => {
    const good = { id: 'a1', name: 'Morning', trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' }, steps: [{ kind: 'notify', text: 'x' }], overlap: 'queue', owner: { kind: 'user' }, enabled: false, offReason: 'Turned off: pm was deleted', createdAt: 1, updatedAt: 2 };
    const out = sanitizeActions([good, { id: 'bad' }, { ...good, id: 'a2', owner: { kind: 'agent' } }, { ...good, id: 'a3', steps: [] }, 'junk']);
    expect(out).toEqual([good]);
  });

  it('saves both files through a temp file and a rename', () => {
    expect(stores.get('actions.json')?.atomic).toBe(true);
    expect(stores.get('action-history.json')?.atomic).toBe(true);
  });

  it('keeps a copy of an actions file it can\'t read, and not of a missing one', () => {
    const onLoad = stores.get('actions.json')!.onLoad!;
    onLoad({ raw: '{}' });
    onLoad({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
    expect(backup).not.toHaveBeenCalled();
    onLoad({ error: new SyntaxError('Unexpected end of JSON input') });
    expect(backup).toHaveBeenCalledWith('actions.json');
    backup.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => onLoad({ error: new SyntaxError('x') })).not.toThrow();
  });

  it('settles runs that were going when Clubhouse closed', () => {
    const runs = settleInterruptedRuns([{ id: 'r', actionId: 'a', trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, outcome: 'running', steps: [] }]);
    expect(runs[0]).toMatchObject({ outcome: 'cancelled', endedAt: 5, reason: 'Clubhouse closed before it finished' });
  });
});
