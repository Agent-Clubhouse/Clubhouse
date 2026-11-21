import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import type { Action, ActionRun } from '../../../shared/actions';
import { ActionsEngine } from './engine';
import { createRunHistory } from './actions-store';
import { resetAllSettingsStoresForTests } from '../settings-store';
import { projectActionDetails } from './details-read';
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: async (_kind: string, work: () => Promise<void>) => work() } }));
afterEach(() => { resetAllSettingsStoresForTests(); });
const at = Date.now();
function action(id: string, agentId: string, owner: Action['owner'] = { kind: 'user' }): Action {
  return { id, name: id, owner, enabled: false, createdAt: at, updatedAt: at, overlap: 'skip', trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId } }, steps: [{ kind: 'message', agentId, text: 'PRIVATE_ACTION_PROMPT' }] };
}
const names = { agent: () => 'Selected', project: () => 'Project' };
it.each(['intact', 'corrupt-primary-with-backup'] as const)('projects selected recorded Actions without refreshing receipts, putting history or changing real persisted storage: %s', async (condition) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-actions-passive-'));
  vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests();
  const history = createRunHistory(() => at);
  const receipt = { callId: 'call', callerId: 'selected', targetId: 'remote', tool: 'send_message', state: 'queued' as const, queuedAt: '1', updatedAt: '1', attempts: 0 };
  const run: ActionRun = { id: 'r', actionId: 'own', owner: { kind: 'agent', agentId: 'selected' }, trigger: { kind: 'manual', at }, chain: ['PRIVATE_CHAIN'], startedAt: at, outcome: 'done', reason: 'PRIVATE_REASON', steps: [{ kind: 'message', outcome: 'done', detail: 'PRIVATE_DETAIL', remoteDelivery: receipt }] };
  history.put(run); await history.flush();
  const remoteDelivery = vi.fn(() => ({ ...receipt, state: 'expired' as const, updatedAt: '2' }));
  const storage = { load: vi.fn(() => ({ actions: [action('own', 'selected', { kind: 'agent', agentId: 'selected' }), action('unrelated', 'other'), action('app-internal', 'selected', { kind: 'app' })], state: { nextAt: {}, waits: [] } })), saveActions: vi.fn(), saveState: vi.fn() };
  const steps = { run: vi.fn(async () => ({ kind: 'notify' as const, outcome: 'done' as const, detail: 'unused' })) };
  const engine = new ActionsEngine({ clock: { now: () => at + 1, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() }, storage, history, steps,
    facts: { remoteDelivery, agentExists: () => true, isRunning: () => false, agentName: () => 'Selected', agentProjectId: () => 'p', projectName: () => 'Project', projectIdForPath: () => 'p', repoOwner: () => ({}) },
    rights: { checkStep: () => null, checkSource: () => null, maxActions: () => null } });
  try {
    engine.start(); storage.load.mockClear(); storage.saveActions.mockClear(); storage.saveState.mockClear(); steps.run.mockClear();
    const put = vi.spyOn(history, 'put'); const list = vi.spyOn(history, 'list');
    if (condition === 'corrupt-primary-with-backup') { await fs.writeFile(path.join(root, 'action-history.json'), 'broken legacy history'); await fs.writeFile(path.join(root, 'action-history.json.bak'), 'PRIVATE_BACKUP'); }
    const before = await fs.readFile(path.join(root, 'action-history.json')); const entries = await fs.readdir(root); const beforeMemory = history.list('own'); list.mockClear();
    const projected = projectActionDetails(engine, 'selected', 'p', false, names);
    expect.soft(projected.summary).toBe('1 related'); expect.soft(projected.rows.map((r) => r.action?.group)).toEqual(['owned', 'targeting', 'triggered-by']);
    expect.soft(projected.rows[0].action?.lastRun).toEqual({ outcome: 'done', startedAt: at }); expect.soft(projected.notes.join(' ')).toContain('recorded history');
    expect.soft(remoteDelivery).not.toHaveBeenCalled(); expect.soft(put).not.toHaveBeenCalled(); expect.soft(list.mock.calls).toEqual([['own']]);
    expect.soft(storage.load).not.toHaveBeenCalled(); expect.soft(storage.saveActions).not.toHaveBeenCalled(); expect.soft(storage.saveState).not.toHaveBeenCalled(); expect.soft(steps.run).not.toHaveBeenCalled();
    await history.flush();
    expect.soft(await fs.readFile(path.join(root, 'action-history.json'))).toEqual(before); expect.soft(await fs.readdir(root)).toEqual(entries); if (condition === 'corrupt-primary-with-backup') expect.soft(await fs.readFile(path.join(root, 'action-history.json.bak'), 'utf8')).toBe('PRIVATE_BACKUP'); expect.soft(history.list('own')).toEqual(beforeMemory);
    expect.soft(JSON.stringify(projected)).not.toContain('PRIVATE_'); expect.soft(JSON.stringify(projected)).not.toContain('unrelated'); expect.soft(JSON.stringify(projected)).not.toContain('app-internal');
  } finally { engine.stop(); await history.flush(); await fs.rm(root, { recursive: true, force: true }); }
});
it('bounds recorded-history reads to displayed selected actions and retains group-row omission counts', () => {
  const all = Array.from({ length: 120 }, (_, i) => action(`own${i}`, 'selected', { kind: 'agent', agentId: 'selected' }));
  const engine = { list: () => [...all, action('unrelated', 'other')], lastRunForDisplay: vi.fn((_id: string) => undefined) };
  const projected = projectActionDetails(engine, 'selected', 'p', false, names);
  expect(projected.summary).toBe('120 related'); expect(projected.rows).toHaveLength(100); expect(projected.omitted).toBe(260);
  expect(engine.lastRunForDisplay).toHaveBeenCalledTimes(100); expect(engine.lastRunForDisplay.mock.calls.every(([id]) => String(id).startsWith('own'))).toBe(true);
});

it('withholds invalid Date-domain run times while retaining the recorded outcome', () => {
  const engine = { list: () => [action('mine', 'selected')], lastRunForDisplay: () => ({ outcome: 'done' as const, startedAt: Number.MAX_SAFE_INTEGER }) };
  const result = projectActionDetails(engine, 'selected', 'p', false, names);
  expect(result.rows[0].action?.lastRun).toEqual({ outcome: 'done' });
});
