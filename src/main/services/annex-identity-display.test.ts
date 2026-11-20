import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const m = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => m.userData } }));
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync), copyFileSync: vi.fn(actual.copyFileSync) }; });
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('../telemetry/annex-telemetry', () => ({ recordIdentityRegenerated: vi.fn() }));
import { getIdentity, matchLoadedIdentityForDisplay as match, resetForTests } from './annex-identity';
let root: string, originalEphemeral: string | undefined;
const fp = 'aa:'.repeat(15) + 'aa', other = 'bb:'.repeat(15) + 'bb';
const put = (fingerprint = fp) => fsp.writeFile(path.join(root, 'annex-identity.json'), JSON.stringify({ publicKey: 'PRIVATE_PUBLIC_FIXTURE', privateKey: 'PRIVATE_KEY_FIXTURE', fingerprint, createdAt: '2026-11-20' }));
const clear = () => { vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.copyFileSync).mockClear(); };
beforeEach(async () => { root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'clubhouse-identity-display-'))); m.userData = root; originalEphemeral = process.env.CLUBHOUSE_ANNEX_EPHEMERAL; delete process.env.CLUBHOUSE_ANNEX_EPHEMERAL; resetForTests(); clear(); });
afterEach(async () => { resetForTests(); if (originalEphemeral === undefined) delete process.env.CLUBHOUSE_ANNEX_EPHEMERAL; else process.env.CLUBHOUSE_ANNEX_EPHEMERAL = originalEphemeral; await fsp.rm(root, { recursive: true, force: true }); });
it('keeps cold corrupt identity unknown without disk IO, backup, key material, initialization or candidate retention', async () => {
  await fsp.writeFile(path.join(root, 'annex-identity.json'), '{broken'); await fsp.writeFile(path.join(root, 'annex-identity.json.tmp'), 'keep'); const before = await fsp.readdir(root);
  const receipts: Array<{ current(): boolean }> = [], result = match(fp, { receipts }); expect(result).toMatchObject({ state: 'unavailable' }); expect(receipts.every((r) => r.current())).toBe(true); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(fs.copyFileSync).not.toHaveBeenCalled(); expect(await fsp.readdir(root)).toEqual(before); expect(await fsp.readFile(path.join(root, 'annex-identity.json'), 'utf8')).toBe('{broken'); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|aa:|userData|fingerprint|privateKey|publicKey/);
  const invalid: Array<{ current(): boolean }> = []; for (const key of [null, '', 'x'.repeat(100000), fp + 'x']) expect(match(key, { receipts: invalid }).state).toBe('unavailable'); expect(invalid).toHaveLength(0);
});
it('compares only an actually loaded same-profile public fingerprint and keeps private receipts current', async () => {
  await put(); expect(getIdentity()?.fingerprint).toBe(fp); clear(); const receipts: Array<{ current(): boolean }> = [];
  expect(match(fp.toUpperCase(), { receipts })).toMatchObject({ state: 'ok', value: true }); expect(match(other, { receipts })).toMatchObject({ state: 'ok', value: false }); expect(receipts.every((r) => r.current())).toBe(true); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(fs.writeFileSync).not.toHaveBeenCalled(); expect(fs.copyFileSync).not.toHaveBeenCalled();
  resetForTests(); expect(receipts.some((r) => !r.current())).toBe(true); expect(match(fp, { receipts: [] }).state).toBe('unavailable');
});
it('withholds old-profile cache after a profile switch without changing ordinary cached getter behavior', async () => {
  await put(); expect(getIdentity()?.fingerprint).toBe(fp); clear(); const receipts: Array<{ current(): boolean }> = []; expect(match(fp, { receipts }).state).toBe('ok');
  m.userData = path.join(root, 'new-profile'); expect(getIdentity()?.fingerprint).toBe(fp); expect(match(fp, { receipts: [] }).state).toBe('unavailable'); expect(receipts.some((r) => !r.current())).toBe(true); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(fs.writeFileSync).not.toHaveBeenCalled();
});
it('invalidates replacement and ephemeral-profile changes without claiming disk freshness or transport authority', async () => {
  await put(); getIdentity(); const receipts: Array<{ current(): boolean }> = []; expect(match(fp, { receipts })).toMatchObject({ state: 'ok', value: true }); await put(other); resetForTests(); expect(getIdentity()?.fingerprint).toBe(other); clear(); expect(receipts.some((r) => !r.current())).toBe(true); expect(match(fp, { receipts: [] })).toMatchObject({ state: 'ok', value: false });
  process.env.CLUBHOUSE_ANNEX_EPHEMERAL = '1'; expect(match(other, { receipts: [] }).state).toBe('unavailable'); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(fs.writeFileSync).not.toHaveBeenCalled();
});
it('invalidates a reset/reload generation even when profile and fingerprint are unchanged', async () => {
  await put(); getIdentity(); const receipts: Array<{ current(): boolean }> = []; expect(match(fp, { receipts })).toMatchObject({ state: 'ok', value: true }); expect(receipts.every((r) => r.current())).toBe(true);
  resetForTests(); expect(getIdentity()?.fingerprint).toBe(fp); clear(); expect(match(fp, { receipts: [] })).toMatchObject({ state: 'ok', value: true }); expect(receipts.some((r) => !r.current())).toBe(true); expect(fs.readFileSync).not.toHaveBeenCalled();
});
it('binds cache provenance to the actual file producer path when profile changes during the ordinary read', async () => {
  await put(); const actual = await vi.importActual<typeof import('fs')>('fs');
  vi.mocked(fs.readFileSync).mockImplementationOnce(((...args: Parameters<typeof fs.readFileSync>) => { const bytes = actual.readFileSync(...args); m.userData = path.join(root, 'changed-during-read'); return bytes; }) as typeof fs.readFileSync);
  expect(getIdentity()?.fingerprint).toBe(fp); clear(); expect(match(fp, { receipts: [] }).state).toBe('unavailable'); expect(fs.readFileSync).not.toHaveBeenCalled(); expect(fs.writeFileSync).not.toHaveBeenCalled();
});
