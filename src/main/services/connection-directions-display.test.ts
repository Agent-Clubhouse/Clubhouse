import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { CONNECTION_DISPLAY_BYTES, CONNECTION_DISPLAY_PAGE, CONNECTION_DISPLAY_SCAN, readConnectionDirectionsForDisplay } from './connection-directions-display';
let root: string;
const row = (extra: Record<string, unknown> = {}) => ({ from: { agentId: 'selected' }, to: { agentId: 'other' }, disabledTools: ['read_output'], enabledTools: ['wake_agent'], link: { createdAt: '2026-11-19T21:00:00Z' }, PRIVATE_CONFIG: 'PRIVATE_CREDENTIAL', ...extra });
const put = (directions: unknown, extra: Record<string, unknown> = {}) => fs.writeFile(path.join(root, 'connection-grants.json'), JSON.stringify({ version: 1, directions, ...extra }));
const disk = async () => Object.fromEntries(await Promise.all((await fs.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), s = await fs.stat(f); return [name, { bytes: (await fs.readFile(f)).toString('base64'), ino: s.ino, mtimeMs: s.mtimeMs }]; })));
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-direction-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it.each(['missing', 'empty', 'broken', 'array', 'field', 'future', 'backup-only'])('distinguishes verifiedempty from unavailable %s without recovery or temp cleanup', async (kind) => {
  if (kind === 'empty') await put([]);
  if (kind === 'broken') await fs.writeFile(path.join(root, 'connection-grants.json'), '{broken');
  if (kind === 'array') await fs.writeFile(path.join(root, 'connection-grants.json'), '[]');
  if (kind === 'field') await put('abc'); if (kind === 'future') await put([], { version: 2 });
  if (kind === 'backup-only') await fs.writeFile(path.join(root, 'connection-grants.json.bak'), JSON.stringify({ directions: [row()] }));
  const temp = path.join(root, `.connection-grants.json.tmp-${process.pid + 100000}-1`); await fs.writeFile(temp, 'retain'); const old = new Date(Date.now() - 3 * 86400000); await fs.utimes(temp, old, old);
  const before = await disk(), value = readConnectionDirectionsForDisplay('selected');
  expect.soft(value.state).toBe(kind === 'missing' || kind === 'empty' ? 'ok' : 'unavailable');
  if (value.state === 'ok') expect(value.value).toEqual({ rows: [], total: 0, offset: 0, omitted: 0, nextOffset: null }); expect.soft(await disk()).toEqual(before);
});
it('returns only selected local-end display fields, preserving useful independent sources and safe maker names', async () => {
  await put([row({ agentLinks: [{ agentId: 'maker', machineId: 'machine', createdAt: '2026-11-19', name: 'Selected maker', PRIVATE_ARGS: 'PRIVATE_PROMPT' }, { agentId: 'old-maker', machineId: 'machine', createdAt: '2026-11-18', removedAt: '2026-11-19', name: 'PRIVATE_REMOVED' }] }), row({ from: { agentId: 'other-a' }, to: { agentId: 'other-b' }, disabledTools: 'PRIVATE_UNRELATED' }), row({ from: { agentId: 'selected', machineId: 'remote' }, to: { agentId: 'elsewhere' }, link: { createdAt: 'PRIVATE_WRONG_MACHINE' } })]);
  const value = readConnectionDirectionsForDisplay('selected'); expect(value.state).toBe('ok');
  if (value.state === 'ok') { expect.soft(value.value.total).toBe(1); expect.soft(value.value.rows[0]).toMatchObject({ from: { agentId: 'selected' }, disabledTools: { value: ['read_output'] }, enabledTools: { value: ['wake_agent'] }, userLink: { value: true }, cardLink: { value: false }, makers: { value: [{ agentId: 'maker', name: { value: 'Selected maker' } }] } }); }
  expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_|other-a|other-b|elsewhere|setBy|createdAt|removedAt|updatedAt|agentToolsProtected/);
});
it('retains known tool fields independently of malformed sources/makers instead of defaulting false or empty', async () => {
  await put([row({ enabledTools: 'abc', cardLink: null, agentLinks: [{ agentId: 'maker', machineId: 'machine', createdAt: 'bad' }] })]);
  expect(readConnectionDirectionsForDisplay('selected')).toMatchObject({ state: 'ok', value: { rows: [{ disabledTools: { state: 'ok', value: ['read_output'] }, enabledTools: { state: 'unavailable' }, userLink: { state: 'ok', value: true }, cardLink: { state: 'unavailable' }, makers: { state: 'unavailable' } }] } });
});
it('pages all selected rows within admitted file/scan bounds with explicit total and omissions', async () => {
  await put(Array.from({ length: CONNECTION_DISPLAY_PAGE + 3 }, (_, i) => row({ to: { agentId: `related-${i}` } })));
  const first = readConnectionDirectionsForDisplay('selected'), second = readConnectionDirectionsForDisplay('selected', { offset: CONNECTION_DISPLAY_PAGE });
  expect(first).toMatchObject({ state: 'ok', value: { total: 103, omitted: 3, nextOffset: 100, offset: 0 } });
  expect(second).toMatchObject({ state: 'ok', value: { total: 103, omitted: 100, nextOffset: null, offset: 100 } });
  if (first.state === 'ok' && second.state === 'ok') expect([...first.value.rows, ...second.value.rows].map((r) => r.to.agentId)).toEqual(Array.from({ length: 103 }, (_, i) => `related-${i}`));
});
it.each(['bytes', 'scan', 'duplicate', 'malformed-scope'])('keeps %s uncertainty distinct from verifiedempty', async (kind) => {
  if (kind === 'bytes') await put([], { padding: 'x'.repeat(CONNECTION_DISPLAY_BYTES) });
  if (kind === 'scan') await put(Array.from({ length: CONNECTION_DISPLAY_SCAN + 1 }, (_, i) => ({ from: { agentId: `a${i}` }, to: { agentId: `b${i}` } })));
  if (kind === 'duplicate') await put([row(), row({ PRIVATE_CONFIG: 'PRIVATE_REPLACEMENT' })]);
  if (kind === 'malformed-scope') await put([{ from: null, to: { agentId: 'other' } }]);
  expect(readConnectionDirectionsForDisplay('selected').state).toBe('unavailable');
});
it.each(['tool', 'source', 'maker', 'new-selected', 'unrelated'])('retains private selected page receipts through later actual primary %s edits', async (kind) => {
  const first = row(), other = row({ from: { agentId: 'unrelated' }, to: { agentId: 'elsewhere' } }); await put([first, other]);
  const receipts: Array<{ current(): boolean }> = []; const value = readConnectionDirectionsForDisplay('selected', { receipts }); expect(value.state).toBe('ok'); expect(receipts[0].current()).toBe(true);
  const changed = kind === 'tool' ? row({ disabledTools: ['send_message'] }) : kind === 'source' ? row({ link: undefined }) : kind === 'maker' ? row({ agentLinks: [{ agentId: 'maker', machineId: 'machine', createdAt: '2026-11-19' }] }) : first;
  await put([changed, { ...other, PRIVATE_CONFIG: 'PRIVATE_UNRELATED_EDIT' }, ...(kind === 'new-selected' ? [row({ to: { agentId: 'new' } })] : [])]);
  expect(receipts[0].current()).toBe(kind === 'unrelated'); expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|receipts|current|signature/);
});
it.each(['oversized-key', 'empty-key', 'negative-offset', 'fractional-offset', 'over-offset'] as const)('does not retain invalid selected keys/page objects: %s', (kind) => {
  const key = kind === 'oversized-key' ? 'x'.repeat(10000) : kind === 'empty-key' ? '' : 'selected';
  const offset = kind === 'negative-offset' ? -1 : kind === 'fractional-offset' ? 0.5 : kind === 'over-offset' ? CONNECTION_DISPLAY_SCAN + 1 : 0;
  const receipts: Array<{ current(): boolean }> = [];
  expect(readConnectionDirectionsForDisplay(key, { offset, receipts }).state).toBe('unavailable'); expect(receipts).toHaveLength(0);
});
