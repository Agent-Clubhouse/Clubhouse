import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
const m = vi.hoisted(() => ({ base: '' }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.base }));
import { readSavedDispatcherLinksForDisplay, SAVED_LINK_DISPLAY_PAGE, SAVED_LINK_DISPLAY_SCAN } from './dispatcher-saved-links-display';
let root: string, project: string;
const at = '2026-11-19T00:00:00Z', store = 'dispatcher-connections.json', pending = 'dispatcher-connections.pending-removals.json';
const link = (extra: Record<string, unknown> = {}) => ({ agentId: 'selected', targetId: 'target', agentProjectPath: project, targetProjectPath: '/other-project', createdAt: at, createdBy: 'controller', PRIVATE_ARGS: 'PRIVATE_CREDENTIAL', ...extra });
const put = (file: string, value: unknown) => fs.writeFile(path.join(m.base, file), JSON.stringify(value));
const putStore = (rows: unknown[], removedByUser: unknown = []) => put(store, { version: 1, connections: rows, removedByUser });
const disk = async () => Object.fromEntries(await Promise.all((await fs.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), s = await fs.stat(f); return [name, { bytes: (await fs.readFile(f)).toString('base64'), ino: s.ino, mtimeMs: s.mtimeMs }]; })));
const read = (offset = 0) => { const receipts: Array<{ current(): boolean }> = []; return { result: readSavedDispatcherLinksForDisplay('selected', project, { offset, receipts }), receipts }; };
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-saved-dispatcher-'))); m.base = root; project = path.join(root, 'selected-project'); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it.each(['missing', 'empty', 'broken', 'array', 'future', 'backup-only'] as const)('keeps %s cold primary evidence distinct without recovery or temporary-file cleanup', async (mode) => {
  if (mode === 'empty') await putStore([]);
  if (mode === 'broken') await fs.writeFile(path.join(root, store), '{broken');
  if (mode === 'array') await put(store, []); if (mode === 'future') await put(store, { version: 2, connections: [] });
  if (mode === 'backup-only') await put(store + '.bak', { version: 1, connections: [link()], removedByUser: [] });
  await fs.writeFile(path.join(root, `.${store}.tmp-${process.pid + 100000}-1`), 'retain');
  const temp = path.join(root, `.${pending}.tmp-${process.pid + 100000}-1`); await fs.writeFile(temp, 'retain'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(temp, old, old);
  const before = await disk(), { result, receipts } = read();
  expect.soft(result.state).toBe(mode === 'missing' || mode === 'empty' ? 'ok' : 'unavailable');
  if (result.state === 'ok') expect.soft(result.value).toMatchObject({ scope: 'committed-dispatcher-links', rows: [], total: 0, omitted: 0, nextOffset: null });
  expect.soft(receipts.every((receipt) => receipt.current())).toBe(true); expect.soft(await disk()).toEqual(before);
});
it('projects only selected native-ID/project-associated safe records and committed removals', async () => {
  await putStore([link(), link({ agentId: 'sender', targetId: 'selected', agentProjectPath: '/sender-project', targetProjectPath: project }), link({ agentProjectPath: '/prior-reused-project', targetId: 'PRIVATE_PRIOR_TARGET' }), link({ agentId: 'PRIVATE_UNRELATED_OWNER', targetId: 'PRIVATE_UNRELATED_TARGET', createdAt: { PRIVATE: 'PRIVATE_INVALID_DATE' } })], [{ agentId: 'selected', targetId: 'target', agentProjectPath: project, targetProjectPath: '/other-project', removedAt: at }]);
  await put(pending, { version: 1, removals: [{ agentId: 'sender', targetId: 'selected', removedAt: at, PRIVATE: 'PRIVATE_PENDING' }] });
  const before = await disk(), { result, receipts } = read();
  expect.soft(result).toMatchObject({ state: 'ok', value: { total: 2, excludedProjectRecords: 1, rows: [{ agentId: 'selected', targetId: 'target', createdBy: 'controller', createdAt: at, removalRecorded: { state: 'ok', value: true } }, { agentId: 'sender', targetId: 'selected', removalRecorded: { value: true } }] } });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|ProjectPath|other-project|sender-project|receipts|current|permission|active/); expect.soft(receipts.every((receipt) => receipt.current())).toBe(true); expect.soft(await disk()).toEqual(before);
});
it.each(['known-false', 'broken', 'backup-only', 'invalid-shape', 'future', 'bad-selected-removal', 'unknown-tombstones'] as const)('preserves useful link fields while distinguishing %s removal evidence', async (mode) => {
  await putStore([link()], mode === 'unknown-tombstones' ? null : []);
  if (mode === 'broken') await fs.writeFile(path.join(root, pending), '{broken');
  if (mode === 'backup-only') await put(pending + '.bak', { version: 1, removals: [] });
  if (mode === 'invalid-shape') await put(pending, { version: 1, removals: 'abc' });
  if (mode === 'future') await put(pending, { version: 2, removals: [] });
  if (mode === 'bad-selected-removal') await put(pending, { version: 1, removals: [{ agentId: 'selected', targetId: 'target', removedAt: 'bad' }] });
  const before = await disk(), { result } = read(); expect(result.state).toBe('ok'); if (result.state !== 'ok') return;
  expect.soft(result.value.rows[0].createdAt).toBe(at); expect.soft(result.value.rows[0].removalRecorded).toMatchObject(mode === 'known-false' ? { state: 'ok', value: false } : { state: 'unavailable' }); expect.soft(await disk()).toEqual(before);
});
it.each(['bytes', 'entries', 'combined-removals', 'duplicate', 'empty-path', 'relative-path', 'invalid-selected-date', 'invalid-scope'] as const)('bounds and validates %s before inferring selected source completeness', async (mode) => {
  if (mode === 'bytes') await put(store, { version: 1, connections: [link()], removedByUser: [], padding: 'x'.repeat(1024 * 1024) });
  else if (mode === 'entries') await putStore(Array.from({ length: SAVED_LINK_DISPLAY_SCAN + 1 }, (_, i) => ({ agentId: `other-${i}`, targetId: 'other-target' })));
  else if (mode === 'combined-removals') await putStore([link()], Array.from({ length: SAVED_LINK_DISPLAY_SCAN }, (_, i) => ({ agentId: `other-${i}`, targetId: 'other-target' })));
  else if (mode === 'duplicate') await putStore([link(), link()]);
  else await putStore([mode === 'invalid-scope' ? { agentId: null, targetId: 'other' } : link(mode === 'empty-path' ? { agentProjectPath: '' } : mode === 'relative-path' ? { targetProjectPath: '../relative' } : { createdAt: 'bad' })]);
  const { result } = read();
  if (mode === 'combined-removals') expect(result).toMatchObject({ state: 'ok', value: { rows: [{ removalRecorded: { state: 'unavailable', reason: 'limit' } }] } });
  else expect(result.state).toBe('unavailable');
});
it('returns bounded pages, explicitly counting prior-page omissions', async () => {
  await putStore(Array.from({ length: SAVED_LINK_DISPLAY_PAGE + 1 }, (_, i) => link({ targetId: `target-${i}` })));
  expect(read().result).toMatchObject({ state: 'ok', value: { total: 51, omitted: 1, nextOffset: 50 } });
  expect(read(50).result).toMatchObject({ state: 'ok', value: { total: 51, rows: [{ targetId: 'target-50' }], offset: 50, omitted: 50, nextOffset: null } });
});
it.each(['selected', 'pending', 'new-selected', 'unrelated', 'caller'] as const)('rechecks selected safe page/currentness after real %s change', async (mode) => {
  await putStore([link(), link({ agentId: 'unrelated', targetId: 'elsewhere' })]); const { result, receipts } = read(); expect(result.state).toBe('ok'); expect(receipts[0].current()).toBe(true);
  if (mode === 'selected') await putStore([link({ createdAt: '2026-11-20T00:00:00Z' })]);
  if (mode === 'pending') await put(pending, { version: 1, removals: [{ agentId: 'selected', targetId: 'target', removedAt: at }] });
  if (mode === 'new-selected') await putStore([link(), link({ targetId: 'new-target' })]);
  if (mode === 'unrelated') await putStore([link(), link({ agentId: 'unrelated', targetId: 'elsewhere', PRIVATE: 'PRIVATE_CHANGED' })]);
  if (mode === 'caller' && result.state === 'ok') { result.value.rows[0].targetId = 'PRIVATE_CALLER_EDIT'; if (result.value.rows[0].removalRecorded.state === 'ok') result.value.rows[0].removalRecorded.value = true; }
  expect(receipts[0].current()).toBe(mode === 'unrelated' || mode === 'caller'); expect(JSON.stringify(read().result)).not.toContain('PRIVATE_');
});
it('pins the host base directory even when another profile has an identical selected page', async () => {
  await putStore([link()]); const { receipts } = read(); const other = await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-other-saved-links-'));
  try { m.base = other; await putStore([link()]); expect(receipts[0].current()).toBe(false); } finally { m.base = root; await fs.rm(other, { recursive: true, force: true }); }
});
it.each(['empty', 'whitespace', 'long', 'relative-project', 'negative-offset', 'fractional-offset', 'over-offset'] as const)('does not retain invalid %s selected admission', (mode) => {
  const receipts: Array<{ current(): boolean }> = [], selected = mode === 'empty' ? '' : mode === 'whitespace' ? ' ' : mode === 'long' ? 'x'.repeat(201) : 'selected';
  const result = readSavedDispatcherLinksForDisplay(selected, mode === 'relative-project' ? '../project' : project, { offset: mode === 'negative-offset' ? -1 : mode === 'fractional-offset' ? 0.5 : mode === 'over-offset' ? SAVED_LINK_DISPLAY_SCAN + 1 : 0, receipts });
  expect(result.state).toBe('unavailable'); expect(receipts).toEqual([]);
});

it('excludes fully valid unrelated native identities and their private attributes', async () => { await putStore([link(), link({ agentId: 'PRIVATE_OTHER_OWNER', targetId: 'PRIVATE_OTHER_TARGET' })]); const { result } = read(); expect.soft(result).toMatchObject({ state: 'ok', value: { total: 1 } }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); });
it('binds only the selected safe page and counts, leaving off-page metadata edits current', async () => { const entries = Array.from({ length: 51 }, (_, i) => link({ targetId: `target-${i}` })); await putStore(entries); const first = read(), last = read(50); entries[50].createdAt = '2026-11-20T00:00:00Z'; await putStore(entries); expect(first.receipts[0].current()).toBe(true); expect(last.receipts[0].current()).toBe(false); });
