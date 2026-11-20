import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ base: '', legacy: vi.fn(() => { throw new Error('ordinary reader'); }), side: vi.fn(), enabled: vi.fn(() => true) }));
// Passthrough filesystem mocks make observation/refusal injection explicit;
// native ESM namespace exports cannot be spied on directly.
vi.mock('fs/promises', async (original) => { const actual = await original<typeof import('fs/promises')>(); return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm), mkdir: vi.fn(actual.mkdir) }; });
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
vi.mock('./project-store', () => ({ list: m.legacy, peekProjectsChecked: m.legacy }));
vi.mock('./agent-config', () => ({ listDurable: m.legacy, peekDurableConfigsChecked: m.legacy, onAgentConfigChanged: m.legacy }));
vi.mock('./orchestration-policy', () => ({ resolveOrchestrationPolicies: m.legacy }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherEnabled: m.enabled, isDispatcherPath: () => false, onDispatcherChanged: m.legacy }));
vi.mock('./persisted-bindings', () => ({ isBindingRemovedByUser: () => false, listSoleOwnedPairs: m.legacy, onBindingDrawnByUser: m.legacy, onBindingRemovedByUser: m.legacy }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: m.legacy } }));
vi.mock('./log-service', () => ({ appLog: m.side }));
import { addDispatcherConnections, dispatcherConnectionSource, readDispatcherLinkMemoryForDisplay, recordUserRemoval, settlePendingRemovals, _resetDispatcherConnectionsForTesting } from './dispatcher-connections';
let root: string, project: string;
const at = '2026-11-19T00:00:00Z', store = 'dispatcher-connections.json', pending = 'dispatcher-connections.pending-removals.json';
const pair = () => ({ agentId: 'selected', targetId: 'target' });
const link = (extra: Record<string, unknown> = {}) => ({ ...pair(), agentProjectPath: project, targetProjectPath: '/other-project', createdAt: at, createdBy: 'controller', PRIVATE_ARGS: 'PRIVATE_CONFIG', ...extra });
const put = (version = 1, rows = [link()]) => fs.writeFile(path.join(root, store), JSON.stringify({ version, connections: rows, removedByUser: [] }));
const read = () => { const receipts: Array<{ current(): boolean }> = []; return { result: readDispatcherLinkMemoryForDisplay('selected', project, [pair()], { receipts }), receipts }; };
async function disk(folder = root): Promise<unknown> { return Object.fromEntries(await Promise.all((await fs.readdir(folder)).sort().map(async (name) => { const file = path.join(folder, name), stat = await fs.stat(file); return [name, stat.isDirectory() ? { ino: stat.ino, children: await disk(file) } : { ino: stat.ino, mtimeMs: stat.mtimeMs, bytes: (await fs.readFile(file)).toString('base64') }]; }))); }
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-dispatcher-memory-'))); m.base = root; project = path.join(root, 'selected-project'); _resetDispatcherConnectionsForTesting(); m.legacy.mockClear(); m.side.mockClear(); m.enabled.mockClear(); });
afterEach(async () => { vi.restoreAllMocks(); _resetDispatcherConnectionsForTesting(); await fs.rm(root, { recursive: true, force: true }); });
it('observes cold corrupt/temp primary stores without reading, recovering, probing, locking or arming timers', async () => {
  for (const name of [store, pending]) { await fs.writeFile(path.join(root, name), '{broken'); await fs.writeFile(path.join(root, name + '.bak'), 'PRIVATE_BACKUP'); await fs.writeFile(path.join(root, '.' + name + '.tmp-old'), 'keep'); }
  const before = await disk(), calls = ['readFile', 'writeFile', 'rename', 'rm', 'mkdir'].map((method) => vi.spyOn(fs, method as 'readFile'));
  // Exclude the explicitly awaited fixture writes/snapshot above; observe
  // only the display read and its final receipt, without masking their calls.
  for (const spy of calls) spy.mockClear();
  const timer = vi.spyOn(globalThis, 'setTimeout'); const { result, receipts } = read();
  expect.soft(result).toMatchObject({ state: 'ok', value: { scope: 'process-known-dispatcher-links', storeWrites: 'unobserved', rows: [{ pendingRemoval: { state: 'ok', value: false }, removalSaved: { value: null } }] } });
  expect.soft(receipts[0].current()).toBe(true); for (const spy of calls) expect.soft(spy).not.toHaveBeenCalled(); expect.soft(timer).not.toHaveBeenCalled(); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(m.enabled).not.toHaveBeenCalled(); expect.soft(m.side).not.toHaveBeenCalled();
  for (const spy of calls) spy.mockRestore(); timer.mockRestore(); expect.soft(await disk()).toEqual(before);
});
it.each(['saved', 'unsaved'] as const)('projects an actual owner pending removal with %s persistence, excluding unrelated pending records', async (mode) => {
  await put(2, [link(), link({ agentId: 'PRIVATE_OTHER_OWNER', targetId: 'PRIVATE_OTHER_TARGET' })]);
  let restore = () => {};
  if (mode === 'unsaved') { const fail = vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('fixture rejects pending write')); restore = () => fail.mockRestore(); }
  expect(await recordUserRemoval(pair())).toBe(true); expect(await recordUserRemoval({ agentId: 'PRIVATE_OTHER_OWNER', targetId: 'PRIVATE_OTHER_TARGET' })).toBe(true); restore();
  m.side.mockClear(); m.legacy.mockClear(); m.enabled.mockClear(); const before = await disk(), { result, receipts } = read();
  expect.soft(result).toMatchObject({ state: 'ok', value: { storeWrites: 'unobserved', rows: [{ agentId: 'selected', targetId: 'target', pendingRemoval: { value: true }, removalSaved: { value: mode === 'saved' } }] } });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|ProjectPath|createdAt|removedAt|controller|receipt|current/); expect.soft(receipts[0].current()).toBe(true); expect.soft(m.side).not.toHaveBeenCalled(); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(m.enabled).not.toHaveBeenCalled(); expect.soft(await disk()).toEqual(before);
});
it.each(['prior-project', 'unknown-project'] as const)('keeps %s pending association unknown rather than adopting it for this selected project', async (mode) => {
  if (mode === 'prior-project') await put(2, [link({ agentProjectPath: '/prior-project' })]);
  else await fs.mkdir(path.join(root, store)); // Real EISDIR; the owner cannot recover the original entry's paths.
  expect(await recordUserRemoval(pair())).toBe(true);
  const { result } = read(); expect(result).toMatchObject({ state: 'ok', value: { rows: [{ pendingRemoval: { state: 'unavailable' }, removalSaved: { state: 'unavailable' } }] } });
});
it.each(['writable', 'blocked'] as const)('shows %s only as recorded owner evidence, never a display-triggered probe', async (mode) => {
  if (mode === 'writable') { await put(1, []); expect(await addDispatcherConnections([link()])).toHaveLength(1); }
  else { await put(); const fail = vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('fixture rejects write probe')); await dispatcherConnectionSource.collect(); fail.mockRestore(); }
  m.side.mockClear(); m.legacy.mockClear(); m.enabled.mockClear(); const before = await disk(), { result, receipts } = read();
  expect.soft(result).toMatchObject({ state: 'ok', value: { storeWrites: mode === 'writable' ? 'recorded-writable' : 'recorded-blocked' } }); expect.soft(receipts[0].current()).toBe(true); expect.soft(await disk()).toEqual(before); expect.soft(m.legacy).not.toHaveBeenCalled(); expect.soft(m.enabled).not.toHaveBeenCalled(); expect.soft(m.side).not.toHaveBeenCalled();
});
it.each(['new-removal', 'saved-transition', 'write-observation', 'reset', 'unrelated'] as const)('retains private selected owner receipts after actual %s operations', async (mode) => {
  await put(2, [link(), link({ agentId: 'other', targetId: 'elsewhere' })]);
  if (mode === 'saved-transition' || mode === 'reset') { const fail = vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('fixture refuses pending save')); expect(await recordUserRemoval(pair())).toBe(true); fail.mockRestore(); }
  const { result, receipts } = read(); expect(result.state).toBe('ok'); expect(receipts[0].current()).toBe(true);
  if (mode === 'new-removal') expect(await recordUserRemoval(pair())).toBe(true);
  if (mode === 'saved-transition') await settlePendingRemovals();
  if (mode === 'write-observation') { await put(1, []); await addDispatcherConnections([link()]); }
  if (mode === 'reset') _resetDispatcherConnectionsForTesting();
  if (mode === 'unrelated') expect(await recordUserRemoval({ agentId: 'other', targetId: 'elsewhere' })).toBe(true);
  if (mode === 'new-removal') expect(read().result).toMatchObject({ state: 'ok', value: { rows: [{ pendingRemoval: { value: true } }] } });
  if (mode === 'saved-transition') expect(read().result).toMatchObject({ state: 'ok', value: { rows: [{ removalSaved: { value: true } }] } });
  if (mode === 'write-observation') expect(read().result).toMatchObject({ state: 'ok', value: { storeWrites: 'recorded-writable' } });
  if (mode === 'reset' || mode === 'unrelated') expect(read().result).toMatchObject({ state: 'ok', value: { rows: [{ pendingRemoval: { value: false } }] } });
  expect(receipts[0].current()).toBe(mode === 'unrelated');
});
it('detaches returned state and caller pair objects from the private receipt and owner cache', async () => {
  await put(2); expect(await recordUserRemoval(pair())).toBe(true); const pairs = [pair()], receipts: Array<{ current(): boolean }> = [], result = readDispatcherLinkMemoryForDisplay('selected', project, pairs, { receipts });
  expect(result.state).toBe('ok'); if (result.state !== 'ok') return;
  pairs[0].targetId = 'PRIVATE_CALLER'; result.value.rows[0].agentId = 'PRIVATE_EDIT'; const pendingValue = result.value.rows[0].pendingRemoval; if (pendingValue.state === 'ok') pendingValue.value = false;
  expect.soft(read().result).toMatchObject({ state: 'ok', value: { rows: [{ agentId: 'selected', targetId: 'target', pendingRemoval: { value: true } }] } }); expect.soft(receipts[0].current()).toBe(true);
});
it.each(['null-selected', 'long-selected', 'relative-project', 'long-project', 'too-many', 'duplicate', 'unrelated', 'null-pair', 'long-pair', 'self'] as const)('rejects invalid %s admission before retaining any selected receipt', (mode) => {
  const receipts: Array<{ current(): boolean }> = [], selected = mode === 'null-selected' ? null as never : mode === 'long-selected' ? 'x'.repeat(201) : 'selected';
  const pairs = mode === 'too-many' ? Array.from({ length: 101 }, (_, i) => ({ agentId: 'selected', targetId: `target-${i}` })) : mode === 'duplicate' ? [pair(), pair()] : mode === 'unrelated' ? [{ agentId: 'PRIVATE_OTHER', targetId: 'PRIVATE_TARGET' }] : mode === 'null-pair' ? [null as never] : mode === 'long-pair' ? [{ agentId: 'selected', targetId: 'x'.repeat(201) }] : mode === 'self' ? [{ agentId: 'selected', targetId: 'selected' }] : [pair()];
  expect(readDispatcherLinkMemoryForDisplay(selected, mode === 'relative-project' ? '../project' : mode === 'long-project' ? '/' + 'x'.repeat(4096) : project, pairs, { receipts }).state).toBe('unavailable'); expect(receipts).toEqual([]);
});

it('invalidates an admitted process-known receipt if the host base profile changes', () => { const { receipts } = read(); m.base = path.join(root, 'other-profile'); expect(receipts[0].current()).toBe(false); });
