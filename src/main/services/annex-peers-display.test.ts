import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync), writeFileSync: vi.fn(real.writeFileSync), chmodSync: vi.fn(real.chmodSync) }; });
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: vi.fn() }));
import { devicesChanged } from './annex-device-signal';
import { readPeerMetadataForDisplay, getPeer, listPeers, PEER_DISPLAY_SCAN_LIMIT, resetForTests } from './annex-peers';
let root: string;
const peer = (extra: Record<string, unknown> = {}) => ({ fingerprint: 'selected-machine', alias: 'Selected computer', lastSeen: '2026-11-19T21:00:00Z', role: 'member', tlsCertificatePem: 'PRIVATE_CREDENTIAL', tlsCertificateFingerprint: 'PRIVATE_CERT_PIN', ...extra });
const put = async (rows: unknown) => fs.promises.writeFile(path.join(root, 'annex-peers.json'), JSON.stringify(rows));
const clearCalls = () => { vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.chmodSync).mockClear(); vi.mocked(devicesChanged).mockClear(); };
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), stat = await fs.promises.stat(f); return [name, { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
const untouched = () => { expect.soft(fs.readFileSync).not.toHaveBeenCalled(); expect.soft(fs.writeFileSync).not.toHaveBeenCalled(); expect.soft(fs.chmodSync).not.toHaveBeenCalled(); expect.soft(devicesChanged).not.toHaveBeenCalled(); };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-peer-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetForTests(); clearCalls(); });
afterEach(async () => { resetForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it.each(['valid', 'corrupt', 'missing', 'backup-only'])('does not load a cold %s credential store or touch actual files merely for display', async (kind) => {
  if (kind === 'valid') await put([peer()]);
  if (kind === 'corrupt') await fs.promises.writeFile(path.join(root, 'annex-peers.json'), '{broken');
  await fs.promises.writeFile(path.join(root, 'annex-peers.json.bak'), JSON.stringify([peer({ alias: 'PRIVATE_BACKUP' })]));
  const temp = path.join(root, `.annex-peers.json.tmp-${process.pid + 100000}-1`); await fs.promises.writeFile(temp, 'retain'); const old = new Date(Date.now() - 3 * 86400000); await fs.promises.utimes(temp, old, old);
  const before = await disk(), receipts: Array<{ current(): boolean }> = [];
  const result = readPeerMetadataForDisplay('selected-machine', { receipts });
  expect.soft(result.state).toBe('unavailable'); expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|Selected computer/); expect.soft(receipts[0].current()).toBe(true); untouched(); expect.soft(await disk()).toEqual(before);
});
it('projects only the selected safe name/time from deliberately warmed memory without credential reads or notification', async () => {
  await put([peer(), peer({ fingerprint: 'other-machine', alias: 'PRIVATE_OTHER_ALIAS', lastSeen: 'PRIVATE_OTHER_TIME' })]); listPeers(); clearCalls();
  const before = await disk(), result = readPeerMetadataForDisplay('SELECTED-MACHINE');
  expect(result).toMatchObject({ state: 'ok', value: { alias: { state: 'ok', value: 'Selected computer' }, lastSeen: { state: 'ok', value: '2026-11-19T21:00:00Z' } }, inputs: [{ source: 'host-cache' }] });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|fingerprint|tls|role|pem|certificate/i); untouched(); expect.soft(await disk()).toEqual(before);
});
it('keeps missing-cache, absent-selected and ambiguous identity unknown rather than verified empty', async () => {
  expect(readPeerMetadataForDisplay('selected-machine').state).toBe('unavailable');
  await put([peer({ fingerprint: 'other-machine' })]); listPeers(); clearCalls(); expect(readPeerMetadataForDisplay('selected-machine').state).toBe('unavailable');
  resetForTests(); await put([peer(), peer({ fingerprint: 'SELECTED-MACHINE', alias: 'PRIVATE_AMBIGUOUS_ALIAS' })]); listPeers(); clearCalls();
  const result = readPeerMetadataForDisplay('selected-machine'); expect.soft(result).toMatchObject({ state: 'unavailable', reason: 'invalid' }); expect.soft(JSON.stringify(result)).not.toContain('PRIVATE_'); untouched();
});
it.each(['missing', 'empty', 'invalid-alias', 'long-alias', 'invalid-time', 'long-time'])('preserves independent known-null and unavailable fields for %s metadata', async (kind) => {
  const extra = kind === 'missing' ? { alias: undefined, lastSeen: undefined } : kind === 'empty' ? { alias: '', lastSeen: '' } : kind === 'invalid-alias' ? { alias: 42 } : kind === 'long-alias' ? { alias: 'x'.repeat(1025) } : kind === 'invalid-time' ? { lastSeen: 'invalid' } : { lastSeen: 'x'.repeat(129) };
  await put([peer(extra)]); listPeers(); clearCalls();
  const result = readPeerMetadataForDisplay('selected-machine'); expect(result.state).toBe('ok');
  if (result.state === 'ok') {
    expect(result.value.alias).toMatchObject(kind === 'missing' || kind === 'empty' ? { state: 'ok', value: null } : kind.includes('alias') ? { state: 'unavailable' } : { state: 'ok', value: 'Selected computer' });
    expect(result.value.lastSeen).toMatchObject(kind === 'missing' || kind === 'empty' ? { state: 'ok', value: null } : kind.includes('time') ? { state: 'unavailable' } : { state: 'ok', value: '2026-11-19T21:00:00Z' });
  } untouched();
});
it('bounds total examined nonmatching cache records before claiming unique selected metadata', async () => {
  await put(Array.from({ length: PEER_DISPLAY_SCAN_LIMIT + 1 }, (_, i) => peer({ fingerprint: i === 0 ? 'selected-machine' : `other-${i}` }))); listPeers(); clearCalls();
  expect(readPeerMetadataForDisplay('selected-machine')).toMatchObject({ state: 'unavailable', reason: 'limit' }); untouched();
});
it.each(['alias', 'lastSeen', 'remove-cache', 'unrelated', 'credentials-only'])('keeps a selected metadata-only private receipt through later %s changes', async (change) => {
  await put([peer(), peer({ fingerprint: 'other-machine', alias: 'Other computer' })]); listPeers();
  const selected = getPeer('selected-machine')!, other = getPeer('other-machine')!; clearCalls();
  const receipts: Array<{ current(): boolean }> = []; const result = readPeerMetadataForDisplay('selected-machine', { receipts }); expect(result.state).toBe('ok'); expect(receipts[0].current()).toBe(true);
  if (change === 'alias') selected.alias = 'New selected name';
  if (change === 'lastSeen') selected.lastSeen = '2026-11-19T22:00:00Z';
  if (change === 'remove-cache') resetForTests();
  if (change === 'unrelated') other.alias = 'PRIVATE_UNRELATED_NEW_NAME';
  if (change === 'credentials-only') selected.tlsCertificatePem = 'PRIVATE_NEW_CREDENTIAL';
  expect(receipts[0].current()).toBe(change === 'unrelated' || change === 'credentials-only'); untouched();
  // This receipt attests display fields, never pairing/credentials/authority.
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|receipts|current|tls/i);
});
it('detaches returned field objects from the ordinary peer cache and later display snapshots', async () => {
  await put([peer()]); listPeers(); const result = readPeerMetadataForDisplay('selected-machine');
  if (result.state === 'ok' && result.value.alias.state === 'ok') result.value.alias.value = 'Changed caller copy';
  expect(readPeerMetadataForDisplay('selected-machine')).toMatchObject({ state: 'ok', value: { alias: { value: 'Selected computer' } } }); expect(getPeer('selected-machine')?.alias).toBe('Selected computer');
});
