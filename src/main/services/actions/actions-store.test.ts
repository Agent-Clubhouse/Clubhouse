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

import { sanitizeActions, settleInterruptedRuns } from './actions-store';

describe('actions store', () => {
  it('loads persisted last use and keeps older engine state unchanged', () => {
    const migrate = migrations.get('actions.json')!;
    const state = { nextAt: {}, waits: [] };
    expect(migrate({ actions: [], state })).toEqual({ version: 1, actions: [], state });
    expect(migrate({ actions: [], state: { ...state, lastUse: 1234 } })).toEqual({ version: 1, actions: [], state: { ...state, lastUse: 1234 } });
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
