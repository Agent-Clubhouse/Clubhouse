import { describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => new Map<string, { atomic?: boolean; onLoad?: (r: { raw: string } | { error: unknown }) => void }>());
const backup = vi.hoisted(() => vi.fn());
const migrations = vi.hoisted(() => new Map<string, (raw: Record<string, unknown>) => unknown>());
const loaded = vi.hoisted(() => new Map<string, unknown>());
const save = vi.hoisted(() => vi.fn());
vi.mock('../settings-store', () => ({
  createSettingsStore: (f: string, defaults: unknown, migrate: (raw: Record<string, unknown>) => unknown, options: { atomic?: boolean } = {}) => {
    stores.set(f, options);
    migrations.set(f, migrate);
    return { get: () => loaded.get(f) ?? defaults, save: async (value: unknown) => { save(f, value); }, update: async (fn: (value: unknown) => unknown) => { const next = fn(loaded.get(f) ?? defaults); loaded.set(f, next); save(f, next); return next; } };
  },
  backupUnreadableSettings: backup,
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { createRunHistory, purgeStoredGroupProjectActions, sanitizeActions, settleInterruptedRuns, storedGroupProjectActions } from './actions-store';

describe('actions store', () => {
  it('purges a group’s Actions and pending state durably, including when replayed before startup', async () => {
    const group = { id: 'a', name: 'Group action', owner: { kind: 'group_project', groupProjectId: 'gp1' } };
    const other = { id: 'b', name: 'Other', owner: { kind: 'group_project', groupProjectId: 'gp2' } };
    loaded.set('actions.json', { version: 1, actions: [group, other], state: { nextAt: { a: 10, b: 20 }, waits: [{ actionId: 'a' }, { actionId: 'b' }], lastFiredDate: { a: 'today' }, throttleStarts: { a: [1] } } });
    loaded.set('action-history.json', { version: 1, runs: { a: [{ owner: group.owner }], b: [{ owner: other.owner }] } });
    try {
      expect(storedGroupProjectActions('gp1')).toEqual([{ id: 'a', name: 'Group action' }]);
      await purgeStoredGroupProjectActions('gp1');
      await purgeStoredGroupProjectActions('gp1');
      expect(loaded.get('actions.json')).toMatchObject({ actions: [other], state: { nextAt: { b: 20 }, waits: [{ actionId: 'b' }], lastFiredDate: {}, throttleStarts: {} } });
      expect(loaded.get('action-history.json')).toEqual({ version: 1, runs: { b: [{ owner: other.owner }] } });
    } finally { loaded.delete('actions.json'); loaded.delete('action-history.json'); }
  });

  it('does not restore group history when an in-flight run finishes after deletion', async () => {
    const history = createRunHistory(() => 100);
    const run = { id: 'r', actionId: 'a', owner: { kind: 'group_project' as const, groupProjectId: 'gp1' }, trigger: { kind: 'manual' as const, at: 90 }, chain: [], startedAt: 90, outcome: 'done' as const, steps: [] };
    history.put(run);
    await history.purgeGroupProject!('gp1');
    history.put(run);
    expect(history.list()).toEqual([]);
  });
  it('retains a group project owner across reload and rejects missing project ids', () => {
    const action = { id: 'a', name: 'Check', trigger: { kind: 'once', at: 100 }, steps: [{ kind: 'notify', text: 'Check' }], owner: { kind: 'group_project', groupProjectId: 'gp1' }, enabled: true, overlap: 'skip', createdAt: 1, updatedAt: 1 };
    expect(sanitizeActions([action, { ...action, id: 'bad', owner: { kind: 'group_project', groupProjectId: '' } }])).toEqual([action]);
    expect(sanitizeActions([{ ...action, quickAccess: 'full_access' }])[0].quickAccess).toBe('full_access');
    expect(sanitizeActions([{ ...action, quickAccess: 'invalid' }])[0].quickAccess).toBeUndefined();
    const run = { id: 'r', actionId: 'a', owner: action.owner, trigger: { kind: 'manual', at: 1 }, chain: [], startedAt: 1, outcome: 'done', steps: [] };
    expect(migrations.get('action-history.json')!({ runs: { a: [run] } })).toEqual({ version: 1, runs: { a: [run] } });
  });
  it('retains message delivery settings and expiry receipts across reload', () => {
    const action = {
      id: 'a', name: 'Check', trigger: { kind: 'event', event: 'app.started', source: { kind: 'app' } },
      steps: [{ kind: 'message', agentId: 'pm', text: 'Check', delivery: 'steer', latestOnly: true, maxWaitMinutes: 5 }],
      owner: { kind: 'user' }, enabled: true, overlap: 'skip', createdAt: 1, updatedAt: 1,
    };
    expect(sanitizeActions([action])).toEqual([action]);
    const run = {
      id: 'r', actionId: 'a', trigger: { kind: 'event', at: 1 }, chain: [], startedAt: 1, endedAt: 2, deliveryUpdatedAt: 300001,
      outcome: 'expired', reason: 'Queued message expired before delivery', steps: [{ kind: 'message', outcome: 'done', detail: 'Queued message expired before delivery', delivery: 'expired' }],
    };
    expect(migrations.get('action-history.json')!({ runs: { a: [run] } })).toEqual({ version: 1, runs: { a: [run] } });
  });
  it('loads legacy minute waits unchanged and retains optional seconds and throttle state', () => {
    const old = {
      id: 'a1', name: 'Wait', trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 5 },
      steps: [{ kind: 'message', agentId: 'pm', text: 'Check' }], overlap: 'skip', owner: { kind: 'user' }, enabled: true, createdAt: 1, updatedAt: 1,
    };
    const wait = { actionId: old.id, agentId: 'lead', startedAt: 1000, dueAt: 301000, chain: [], detail: 'release-lead sleeps' };
    const state = { nextAt: {}, waits: [wait] };
    const migrate = migrations.get('actions.json')!;
    expect(migrate({ actions: [old], state })).toEqual({ version: 1, actions: [old], state });
    const seconds = { ...old, trigger: { ...old.trigger, delayMinutes: undefined, delaySeconds: 30, throttle: { maxRuns: 2, perMinutes: 5 } } };
    expect(sanitizeActions([seconds])[0].trigger).toEqual({ kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delaySeconds: 30, throttle: { maxRuns: 2, perMinutes: 5 } });
    expect(migrate({ state: { ...state, throttleStarts: { a1: [1, 'bad', -1, Infinity, 2] } } }))
      .toEqual({ version: 1, actions: [], state: { ...state, throttleStarts: { a1: [1, 2] } } });
  });
  it('preserves older actions and waits exactly while retaining privacy-safe device waits', () => {
    const old = {
      id: 'old', name: 'Existing', trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 },
      steps: [{ kind: 'notify', text: 'Ready' }], overlap: 'skip', owner: { kind: 'user' }, enabled: true, createdAt: 1, updatedAt: 1,
    };
    const wait = { actionId: 'old', agentId: 'lead', startedAt: 1, dueAt: 2, chain: [], detail: 'Lead goes to sleep' };
    const migrate = migrations.get('actions.json')!;
    expect(migrate({ actions: [old], state: { nextAt: {}, waits: [wait] } })).toEqual({
      version: 1, actions: [old], state: { nextAt: {}, waits: [wait] },
    });
    const device = { id: 'phone', name: 'Pocket', kind: 'phone' };
    const state = { nextAt: {}, waits: [{ ...wait, device: { ...device, address: 'secret', certificate: 'secret', port: 123 } }] };
    expect(migrate({ actions: [], state })).toMatchObject({ state: { waits: [{ ...wait, device }] } });
    expect(JSON.stringify(migrate({ actions: [], state }))).not.toContain('secret');
  });

  it('retains device history privacy tags and strips nested grouped-event transport details', () => {
    const device = { id: 'phone', name: 'Pocket', kind: 'phone' };
    const source = { kind: 'device', deviceId: 'phone', deviceKind: 'phone' };
    const event = { at: 1, event: 'device.online', source, device, detail: 'Pocket comes online' };
    const run = {
      id: 'r', actionId: 'a', trigger: { kind: 'event', at: 1, device, events: [event] },
      chain: [], startedAt: 1, endedAt: 2, outcome: 'done', steps: [],
    };
    const privateDevice = { ...device, address: 'secret', port: 123, certificate: 'secret' };
    const raw = { ...run, trigger: { ...run.trigger, device: privateDevice, events: [null, { ...event, at: 'invalid' }, {
      ...event, device: privateDevice, source: { ...source, address: 'secret' },
    }] } };
    const migrate = migrations.get('action-history.json')!;
    expect(migrate({ runs: { a: [raw] } })).toEqual({ version: 1, runs: { a: [run] } });
    const redacted = { ...run, id: 'redacted', trigger: { kind: 'event', at: 1, device: null, events: [] } };
    expect(migrate({ runs: { a: [redacted] } })).toEqual({ version: 1, runs: { a: [redacted] } });
  });

  it('retains recorded owners across reload while leaving older ownerless runs unchanged', () => {
    const run = { id: 'r1', actionId: 'deleted', trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, outcome: 'done', steps: [] };
    const migrate = migrations.get('action-history.json')!;
    const runs = [run, { ...run, id: 'r2', owner: { kind: 'agent', agentId: 'lead' } }];
    expect(migrate({ runs: { deleted: runs } })).toEqual({ version: 1, runs: { deleted: runs } });
  });

  it('retains external Annex receipt source and deterministic identity across reload', () => {
    const run = {
      id: 'annex-delivery:c1', actionId: 'annex-delivery:c1', externalSource: 'annex_delivery',
      owner: { kind: 'agent', agentId: 'sender' }, trigger: { kind: 'manual', at: 5, detail: 'Annex delivery receipt' },
      chain: [], startedAt: 5, endedAt: 5, outcome: 'expired', reason: 'Delivery expired', steps: [],
    };
    expect(migrations.get('action-history.json')!({ runs: { [run.actionId]: [run] } })).toEqual({ version: 1, runs: { [run.actionId]: [run] } });
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

  it('settles orphaned queued receipts on relaunch without changing delivered steps or prior failures', () => {
    const run = {
      id: 'r', actionId: 'a', trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, endedAt: 6,
      outcome: 'done',
      steps: [
        { kind: 'message', outcome: 'done', detail: 'Queued for pm', delivery: 'queued', agentId: 'pm' },
        { kind: 'message', outcome: 'done', detail: 'Sent to lead', delivery: 'delivered', agentId: 'lead' },
      ],
    };
    const migrate = migrations.get('action-history.json')!;
    expect(migrate({ runs: { a: [run, { ...run, id: 'failed', outcome: 'failed', reason: 'A later step failed' }] } }))
      .toMatchObject({ runs: { a: [
        {
          id: 'r', outcome: 'cancelled', reason: 'Clubhouse closed before queued delivery was confirmed',
          steps: [{ delivery: 'dropped' }, { delivery: 'delivered', detail: 'Sent to lead' }],
        },
        { id: 'failed', outcome: 'failed', reason: 'A later step failed', steps: [{ delivery: 'dropped' }, { delivery: 'delivered' }] },
      ] } });
  });

  it('persists startup queue settlements even if no more actions run', async () => {
    const migrate = migrations.get('action-history.json')!;
    loaded.set('action-history.json', migrate({ runs: { a: [{
      id: 'r', actionId: 'a', trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, endedAt: 6, outcome: 'done',
      steps: [{ kind: 'message', outcome: 'done', detail: 'Queued', delivery: 'queued' }],
    }] } }));
    save.mockClear();
    try {
      const history = createRunHistory();
      await history.flush();
      expect(save).toHaveBeenCalledWith('action-history.json', expect.objectContaining({
        runs: { a: [expect.objectContaining({ outcome: 'cancelled', steps: [expect.objectContaining({ delivery: 'dropped' })] })] },
      }));
    } finally {
      loaded.delete('action-history.json');
    }
  });
});


it('retains the private handoff exception receipt source and paths across history reload', () => {
  const run = { id: 'handoff-secret:confirmation', actionId: 'handoff-secret:confirmation', externalSource: 'handoff_secret', owner: { kind: 'user' }, trigger: { kind: 'manual', at: 5 }, chain: [], startedAt: 5, endedAt: 5, outcome: 'done', steps: [{ kind: 'notify', outcome: 'done', detail: 'fixture.txt' }] };
  expect(migrations.get('action-history.json')!({ runs: { [run.actionId]: [run] } })).toEqual({ version: 1, runs: { [run.actionId]: [run] } });
});
