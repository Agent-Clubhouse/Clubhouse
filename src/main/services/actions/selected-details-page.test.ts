import { afterEach, expect, it, vi } from 'vitest';
import type { Action, ActionRun, ActionNames } from '../../../shared/actions';
import { isRemoteActionRelationshipPage } from '../../../shared/remote-action-page';
import { readSelectedActionRelationshipPage } from './selected-details-page';
import type { DisplayReceipt } from '../display-settings';
import { ActionsEngine } from './engine';
const at = 1_800_000_000_000;
const action = (i: number, related = true): Action => ({ id: `a${String(i).padStart(4, '0')}`, name: `Action ${i}`, createdAt: at + i, updatedAt: at + i, enabled: false, overlap: 'skip', owner: { kind: 'agent', agentId: related ? 'selected' : 'PRIVATE_OTHER' }, trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: related ? 'selected' : 'PRIVATE_OTHER' } }, steps: [{ kind: 'message', agentId: related ? 'selected' : 'PRIVATE_OTHER', text: 'PRIVATE_PROMPT', delivery: 'queue' }] });
const names = (): ActionNames => ({ agent: () => 'Selected name', project: () => 'Selected project' });
const read = (actions: Action[], offset = 0, selection?: string, extra = {}) => {
  const receipts: DisplayReceipt[] = [];
  const lastRunForDisplay = vi.fn((_id: string) => ({ outcome: 'done' as ActionRun['outcome'], startedAt: at }));
  const engine = { list: () => actions, lastRunForDisplay };
  const page = readSelectedActionRelationshipPage(engine, { agentId: 'selected', projectId: 'p', dispatcher: false }, { offset, selection, authorized: () => true, target: { current: () => true }, sourceCurrent: () => true, names, receipts, ...extra });
  return { page, receipts, lastRunForDisplay, engine };
};
afterEach(() => { vi.restoreAllMocks(); });
it('reaches the101st selected relationship and preserves all groups, short descriptions and safe recorded time', () => {
  const actions = Array.from({ length: 101 }, (_, i) => action(i)).reverse(); actions.push(action(999, false), { ...action(1000), owner: { kind: 'app' } });
  const first = read(actions); expect(isRemoteActionRelationshipPage(first.page)).toBe(true); expect(first.page).toMatchObject({ state: 'recorded', totalRelationships: 303, uniqueActions: 101, next: 25 });
  if (first.page.state !== 'recorded') throw new Error('Expected page');
  const page101 = read(actions, 100, first.page.selection); expect(page101.page).toMatchObject({ state: 'recorded', offset: 100 });
  if (page101.page.state !== 'recorded') throw new Error('Expected page');
  expect(page101.page.rows[0]).toMatchObject({ name: 'Action 100', group: 'owned', enabled: false, lastRun: { outcome: 'done', startedAt: at } });
  expect(page101.page.rows[1]).toMatchObject({ name: 'Action 0', group: 'targeting' }); expect(page101.page.rows[0].description).toContain('Message Selected name');
  const last = read(actions, 300, first.page.selection); expect(last.page).toMatchObject({ state: 'recorded', next: null });
  if (last.page.state !== 'recorded') throw new Error('Expected page'); expect(last.page.rows.map((r) => r.name)).toEqual(['Action 98', 'Action 99', 'Action 100']);
  expect(first.lastRunForDisplay).toHaveBeenCalledTimes(25); expect(first.lastRunForDisplay.mock.calls.every(([id]) => !id.includes('999'))).toBe(true);
  expect(JSON.stringify(first.page)).not.toMatch(/PRIVATE_|"(?:steps|trigger|owner|updatedAt|agentId|actionId)"\s*:/); expect(first.receipts.every((r) => r.current())).toBe(true);
});
it('keeps one Action in multiple relationship groups with stable group-qualified keys', () => {
  const result = read([action(0)]); if (result.page.state !== 'recorded') throw new Error('Expected page');
  expect(result.page).toMatchObject({ totalRelationships: 3, uniqueActions: 1 }); expect(result.page.rows.map((r) => r.group)).toEqual(['owned', 'targeting', 'triggered-by']);
  expect(new Set(result.page.rows.map((r) => r.key)).size).toBe(3); expect(result.lastRunForDisplay).toHaveBeenCalledTimes(1);
});
it.each(['name', 'enabled', 'outcome', 'time', 'reference', 'relation', 'order', 'source', 'target', 'revoked'] as const)('invalidates selected source evidence after %s changes and never lets response mutation retarget it', (kind) => {
  const actions = [action(0), action(1)]; let allowed = true, current = true, target = true, label = 'Before';
  const result = read(actions, 0, undefined, { authorized: () => allowed, sourceCurrent: () => current, target: { current: () => target }, names: () => ({ ...names(), agent: () => label }) });
  expect(result.receipts.every((r) => r.current())).toBe(true);
  if (result.page.state !== 'recorded') throw new Error('Expected page'); result.page.rows[0].name = 'Caller edit';
  if (kind === 'name') actions[0].name = 'After'; if (kind === 'enabled') actions[0].enabled = true;
  if (kind === 'outcome') result.lastRunForDisplay.mockReturnValue({ outcome: 'failed', startedAt: at });
  if (kind === 'time') result.lastRunForDisplay.mockReturnValue({ outcome: 'done', startedAt: at + 1 });
  if (kind === 'reference') label = 'After'; if (kind === 'relation') actions[0].steps = [];
  if (kind === 'order') actions[0].createdAt = at + 10; if (kind === 'source') current = false; if (kind === 'target') target = false; if (kind === 'revoked') allowed = false;
  expect(result.receipts.some((r) => !r.current())).toBe(true);
});
it('keeps irrelevant raw prompt and unrelated field changes current, but rejects a changed selection on later pages', () => {
  const actions = Array.from({ length: 30 }, (_, i) => action(i)), other = action(999, false); actions.push(other);
  const first = read(actions); if (first.page.state !== 'recorded') throw new Error('Expected page');
  (actions[0].steps[0] as { text: string }).text = 'OTHER_PRIVATE_PROMPT'; other.name = 'PRIVATE_UNRELATED_EDIT'; expect(first.receipts.every((r) => r.current())).toBe(true);
  actions[29].steps = []; expect(read(actions, 25, first.page.selection).page).toMatchObject({ state: 'unavailable', reason: 'changed' });
});
it('does not read the engine after revocation and keeps unavailable separate from empty', () => {
  const list = vi.fn(() => []), lastRunForDisplay = vi.fn();
  const page = readSelectedActionRelationshipPage({ list, lastRunForDisplay }, { agentId: 'selected', dispatcher: false }, { offset: 0, authorized: () => false, target: { current: () => true }, sourceCurrent: () => true, names, receipts: [] });
  expect(page).toMatchObject({ state: 'unavailable', reason: 'changed' }); expect(page).not.toHaveProperty('rows'); expect(list).not.toHaveBeenCalled();
  expect(read([]).page).toMatchObject({ state: 'recorded', rows: [], uniqueActions: 0, totalRelationships: 0 });
});
it.each([{ offset: 1 }, { offset: -25 }, { offset: 4100 }, { offset: 25 }, { offset: 25, selection: 'private' }])('refuses malformed offset/selection without reading recorded runs %#', (args) => {
  const result = read([action(0)], args.offset, 'selection' in args ? args.selection : undefined); expect(result.page).toMatchObject({ state: 'unavailable', reason: 'invalid' }); expect(result.lastRunForDisplay).not.toHaveBeenCalled();
});
it('projects a real started engine without management/history refresh/storage mutation', () => {
  const remoteDelivery = vi.fn(), run: ActionRun = { id: 'PRIVATE_RUN_ID', actionId: action(0).id, owner: { kind: 'agent', agentId: 'selected' }, trigger: { kind: 'manual', at }, chain: ['PRIVATE_CHAIN'], startedAt: at, outcome: 'done', reason: 'PRIVATE_REASON', steps: [] };
  const history = { list: vi.fn((id?: string) => id === action(0).id ? [run] : []), put: vi.fn(), prune: vi.fn(), remove: vi.fn() };
  const storage = { load: vi.fn(() => ({ actions: [action(0)], state: { nextAt: {}, waits: [] } })), saveActions: vi.fn(), saveState: vi.fn() };
  const steps = { run: vi.fn() };
  const engine = new ActionsEngine({ clock: { now: () => at + 1, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() }, storage, history, steps,
    facts: { remoteDelivery, agentExists: () => true, isRunning: () => false, agentName: () => 'Selected', agentProjectId: () => 'p', projectName: () => 'Project', projectIdForPath: () => 'p', repoOwner: () => ({}) }, rights: { checkStep: () => null, checkSource: () => null, maxActions: () => null } });
  engine.start(); vi.clearAllMocks(); const mutableHistory = vi.spyOn(engine, 'history');
  try {
    const page = readSelectedActionRelationshipPage(engine, { agentId: 'selected', projectId: 'p', dispatcher: false }, { offset: 0, authorized: () => true, target: { current: () => true }, sourceCurrent: () => true, names, receipts: [] });
    expect(page).toMatchObject({ state: 'recorded', rows: [{ lastRun: { outcome: 'done', startedAt: at } }, {}, {}] });
    expect(mutableHistory).not.toHaveBeenCalled(); expect(remoteDelivery).not.toHaveBeenCalled(); expect(history.put).not.toHaveBeenCalled(); expect(storage.load).not.toHaveBeenCalled(); expect(storage.saveActions).not.toHaveBeenCalled(); expect(storage.saveState).not.toHaveBeenCalled(); expect(steps.run).not.toHaveBeenCalled(); expect(JSON.stringify(page)).not.toContain('PRIVATE_');
  } finally { engine.stop(); }
});
it('uses stable identity ordering for equal creation times and redacts before bounding existing display fields', () => {
  const actions = [action(2), action(0), action(1)]; for (const a of actions) a.createdAt = at;
  actions[1].name = 'apiKey="PRIVATE_NAME" ' + 'x'.repeat(400);
  const first = read(actions, 0, undefined, { names: () => ({ ...names(), agent: () => 'password="PRIVATE_REFERENCE"' }) });
  if (first.page.state !== 'recorded') throw new Error('Expected page'); expect(first.page.rows[0].key).toMatch(/^[a-f0-9]{64}$/);
  expect(first.page.rows[1].name).toBe('Action 1'); expect(first.page.rows[2].name).toBe('Action 2'); expect(first.page.rows[0].name.length).toBeLessThanOrEqual(240); expect(JSON.stringify(first.page)).not.toContain('PRIVATE_');
  actions.reverse(); expect(first.receipts.every((r) => r.current())).toBe(true);
});
it('keeps invalid Date-domain run time unknown while preserving the recorded outcome', () => {
  const result = read([action(0)]); result.lastRunForDisplay.mockReturnValue({ outcome: 'done', startedAt: Number.MAX_SAFE_INTEGER });
  const page = readSelectedActionRelationshipPage(result.engine, { agentId: 'selected', projectId: 'p', dispatcher: false }, { offset: 0, authorized: () => true, target: { current: () => true }, sourceCurrent: () => true, names, receipts: [] });
  expect(page).toMatchObject({ state: 'recorded', rows: [{ lastRun: { outcome: 'done' } }, {}, {}] });
  if (page.state !== 'recorded') throw new Error('Expected page'); expect(page.rows[0].lastRun).not.toHaveProperty('startedAt');
});

it('describes the Dispatcher page as its single Dispatcher group, keeping the ordinary three-group note', () => {
  const made = (i: number): Action => ({ ...action(i), owner: { kind: 'dispatcher' } });
  const engine = { list: () => [made(1), made(2), action(3)], lastRunForDisplay: () => undefined };
  const dispatcherPage = readSelectedActionRelationshipPage(engine, { agentId: 'selected', dispatcher: true }, { offset: 0, authorized: () => true, target: { current: () => true }, sourceCurrent: () => true, names, receipts: [] });
  if (dispatcherPage.state !== 'recorded') throw new Error('Expected page');
  expect(isRemoteActionRelationshipPage(dispatcherPage)).toBe(true);
  expect(dispatcherPage.rows.map((r) => r.group)).toEqual(['dispatcher', 'dispatcher']);
  expect(dispatcherPage.notes[0]).toBe('Relationship rows list Actions made by the Dispatcher, ordered by saved creation time and stable identity.');
  expect(dispatcherPage.notes.join(' ')).not.toMatch(/owner, target and trigger|multiple groups/);
  const ordinary = read([action(1)]).page;
  if (ordinary.state !== 'recorded') throw new Error('Expected page');
  expect(ordinary.notes[0]).toBe('Relationship rows are grouped by owner, target and trigger, ordered by saved creation time and stable identity. One Action may appear in multiple groups.');
  expect(dispatcherPage.notes[1]).toBe(ordinary.notes[1]);
});
