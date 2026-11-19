import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { DurableAgentConfig } from '../../shared/types';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, openSync: vi.fn(real.openSync) }; });
vi.mock('./agent-config', () => ({ getDurableConfig: vi.fn(() => { throw new Error('display must not look up a replacement config'); }) }));
vi.mock('./orchestration-policy', () => ({ setOrchestrationPolicy: vi.fn() }));
vi.mock('./grant-requests', () => ({ dropCallApprovalsFor: vi.fn() }));
vi.mock('./grant-telemetry', () => ({ recordGrantChange: vi.fn() }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherAgentId: () => false, resolveDispatcherIdentity: (projectPath: string, agentId: string) => ({ projectPath, agentId }) }));
import { getAgentGrantChanges, readAgentGrantChangesForDisplay } from './agent-grants-store';
import { readAgentHoldsActionForDisplay, readAgentReachForDisplay } from './agent-grants-service';
import { getDurableConfig } from './agent-config';
import { resetAllSettingsStoresForTests } from './settings-store';
let root: string;
const agent = (): DurableAgentConfig => ({ id: 'selected', name: 'Selected', color: '', createdAt: '', orchestration: { orchestrate: false, connectToDispatcher: false } });
const file = () => path.join(root, 'agent-grants.json');
const save = (value: unknown) => fs.writeFileSync(file(), JSON.stringify(value));
const offer = (mode = 'ask') => ({ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode });
const disk = () => Object.fromEntries(fs.readdirSync(root).map((name) => { const file = path.join(root, name), stat = fs.statSync(file); return [name, { bytes: fs.readFileSync(file).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; }));
function temp() { const file = path.join(root, `.agent-grants.json.tmp-${process.pid + 100000}-1`); fs.writeFileSync(file, 'leave alone'); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old); }
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-passive-grants-')); vi.spyOn(app, 'getPath').mockReturnValue(root); resetAllSettingsStoresForTests(); vi.mocked(getDurableConfig).mockClear(); vi.mocked(fs.openSync).mockClear(); });
afterEach(() => { resetAllSettingsStoresForTests(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it.each(['missing', 'empty', 'selected-empty'])('reads verified %s defaults without warming, sweeping or resolving replacement agents', (kind) => {
  if (kind !== 'missing') save({ agents: kind === 'selected-empty' ? { selected: { changes: [] } } : {} }); temp(); const before = disk();
  expect(readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer')).toMatchObject({ state: 'ok', value: false, inputs: [{ source: 'primary' }] });
  expect(readAgentReachForDisplay('selected', agent())).toMatchObject({ state: 'ok', value: expect.any(Array) });
  expect(disk()).toEqual(before); expect(getDurableConfig).not.toHaveBeenCalled();
});
it.each(['broken', 'array-root', 'null-agents', 'array-agents', 'null-selected', 'empty-selected', 'invalid-mode', 'invalid-target', 'invalid-flags', 'string-layer'])('keeps %s selected authority unknown instead of empty/default', (kind) => {
  const values: Record<string, unknown> = { 'array-root': [], 'null-agents': { agents: null }, 'array-agents': { agents: [] }, 'null-selected': { agents: { selected: null } }, 'empty-selected': { agents: { selected: {} } }, 'invalid-mode': { agents: { selected: { changes: [offer('invalid')] } } }, 'invalid-target': { agents: { selected: { changes: [{ ...offer(), target: { kind: 'not-a-target' } }] } } }, 'invalid-flags': { agents: { selected: { changes: [{ action: 'agent.message', mode: 'allow', target: { kind: 'connected', onlyDispatcher: 'yes' } }] } } }, 'string-layer': { agents: { selected: { changes: 'abc' } } } };
  if (kind === 'broken') fs.writeFileSync(file(), '{broken'); else save(values[kind]); temp(); const before = disk();
  expect.soft(readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer').state).toBe('unavailable');
  expect.soft(readAgentReachForDisplay('selected', agent()).state).toBe('unavailable'); expect.soft(disk()).toEqual(before);
});
it('projects only selected fixed reach/eligibility summaries and ignores unrelated malformed records', () => {
  save({ agents: { selected: { changes: [offer(), { action: 'agent.restart', target: { kind: 'any' }, mode: 'allow', by: 'user', at: '2026-11-19' }], PRIVATE_RAW_GRANT: 'not projected' }, PRIVATE_OTHER_AGENT: { privateCredential: 'PRIVATE_CREDENTIAL', changes: 'PRIVATE_INVALID_OTHER' } }, revisions: { selected: 'PRIVATE_REVISION', PRIVATE_OTHER_AGENT: 'PRIVATE_OTHER_REVISION' } });
  const held = readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer'), reach = readAgentReachForDisplay('selected', agent());
  expect(held).toMatchObject({ state: 'ok', value: true }); expect(reach).toMatchObject({ state: 'ok' });
  if (reach.state === 'ok') { expect(reach.value).toHaveLength(10); expect(reach.value.find((row) => row.action === 'agent.restart')).toMatchObject({ mode: 'allow', everyAgent: true }); }
  expect(JSON.stringify([held, reach])).not.toMatch(/PRIVATE_|changes|template|target|revisions|privateCredential/);
  expect(getDurableConfig).not.toHaveBeenCalled();
});
it('keeps established permission memory source distinct from changed primary and makes recovered defaults unavailable', () => {
  save({ agents: { selected: { changes: [offer()] } } }); getAgentGrantChanges('selected'); save({ agents: { selected: { changes: [] } } }); temp(); const before = disk();
  expect(readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer')).toMatchObject({ state: 'ok', value: true, inputs: [{ source: 'host-cache' }] }); expect(disk()).toEqual(before);
  resetAllSettingsStoresForTests(); fs.writeFileSync(file(), '{broken'); getAgentGrantChanges('selected'); temp(); const warm = disk();
  expect(readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer')).toMatchObject({ state: 'unavailable', reason: 'unreadable', inputs: [{ source: 'host-cache' }] }); expect(disk()).toEqual(warm);
});
it.each(['layer', 'entry'])('reports explicit selected %s limits without claiming no permissions', (kind) => {
  save({ agents: { selected: { changes: kind === 'layer' ? Array.from({ length: 101 }, () => offer()) : [{ action: 'project.read', target: { kind: 'project', project: { path: 'x'.repeat(5000) } }, mode: 'allow' }] } } });
  expect(readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer')).toMatchObject({ state: 'unavailable', reason: 'limit' });
});
it('refuses mismatched/disposed supplied agent facts before reading any host grant source', () => {
  save({ agents: { selected: { changes: [offer()] } } }); vi.mocked(fs.openSync).mockClear();
  expect(readAgentHoldsActionForDisplay('selected', { ...agent(), id: 'other' }, 'handoff.offer').state).toBe('unavailable');
  expect(readAgentReachForDisplay('selected', { ...agent(), disposedAt: '2026-11-19' }).state).toBe('unavailable'); expect(fs.openSync).not.toHaveBeenCalled();
});
it('detaches internal selected normalized changes from retained raw evidence and ordinary permission memory', () => {
  save({ agents: { selected: { changes: [offer()] } } }); getAgentGrantChanges('selected'); const selected = readAgentGrantChangesForDisplay('selected');
  expect(selected.state).toBe('ok'); if (selected.state === 'ok') selected.value!.changes[0].mode = 'off';
  expect(readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer')).toMatchObject({ state: 'ok', value: true }); expect(getAgentGrantChanges('selected')?.changes[0].mode).toBe('ask');
});

it('retains private selected eligibility and fixed-row receipts through later real primary changes', () => {
  save({ agents: { selected: { changes: [offer(), { action: 'agent.restart', target: { kind: 'any' }, mode: 'allow' }] } } });
  const eligibility: Array<{ current(): boolean }> = [], reach: Array<{ current(): boolean }> = [];
  const a = readAgentHoldsActionForDisplay('selected', agent(), 'handoff.offer', { receipts: eligibility }), b = readAgentReachForDisplay('selected', agent(), { receipts: reach });
  expect(eligibility[0].current()).toBe(true); expect(reach[0].current()).toBe(true); expect(JSON.stringify([a, b])).not.toMatch(/current|receipts|revisions/);
  save({ agents: { selected: { changes: [] } } }); const before = disk();
  expect(eligibility[0].current()).toBe(false); expect(reach[0].current()).toBe(false); expect(disk()).toEqual(before);
});
