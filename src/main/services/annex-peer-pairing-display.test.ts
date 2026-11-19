import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
vi.mock('fs', async (original) => { const real = await original<typeof import('fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync), writeFileSync: vi.fn(real.writeFileSync), chmodSync: vi.fn(real.chmodSync) }; });
vi.mock('./annex-network-profile', () => ({ annexEphemeralSession: () => false }));
vi.mock('./annex-device-signal', () => ({ devicesChanged: vi.fn() }));
import { devicesChanged } from './annex-device-signal';
import { capturePeerPairingForDisplay, getPeer, listPeers, PEER_DISPLAY_SCAN_LIMIT, resetForTests } from './annex-peers';
let root: string;
const peer = (extra: Record<string, unknown> = {}) => ({ fingerprint: 'selected-machine', alias: 'Selected computer', lastSeen: '2026-11-19T21:00:00Z', role: 'member', tlsCertificatePem: 'PRIVATE_CREDENTIAL', tlsCertificateFingerprint: 'PRIVATE_CERT_PIN', ...extra });
const put = async (rows: unknown) => fs.promises.writeFile(path.join(root, 'annex-peers.json'), JSON.stringify(rows));
const clearCalls = () => { vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.chmodSync).mockClear(); vi.mocked(devicesChanged).mockClear(); };
const disk = async () => Object.fromEntries(await Promise.all((await fs.promises.readdir(root)).sort().map(async (name) => { const f = path.join(root, name), stat = await fs.promises.stat(f); return [name, { bytes: (await fs.promises.readFile(f)).toString('base64'), ino: stat.ino, mtimeMs: stat.mtimeMs }]; })));
const untouched = () => { expect.soft(fs.readFileSync).not.toHaveBeenCalled(); expect.soft(fs.writeFileSync).not.toHaveBeenCalled(); expect.soft(fs.chmodSync).not.toHaveBeenCalled(); expect.soft(devicesChanged).not.toHaveBeenCalled(); };
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-peer-display-'))); vi.spyOn(app, 'getPath').mockReturnValue(root); resetForTests(); clearCalls(); });
afterEach(async () => { resetForTests(); vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
const modern = (extra: Record<string, unknown> = {}) => peer({ kind: 'desktop', pairedAt: '2026-11-19T21:00:00Z', pairingId: 'pairing-selected', ...extra });
const observe = (key = 'selected-machine') => { const receipts: Array<{ current(): boolean }> = []; const value = capturePeerPairingForDisplay(key, { receipts }); return { value, receipts }; };
it.each(['valid', 'corrupt', 'missing', 'backup-only'])('does not initialize cold %s pairing or credentials for display', async (kind) => {
  if (kind === 'valid') await put([modern()]);
  if (kind === 'corrupt') await fs.promises.writeFile(path.join(root, 'annex-peers.json'), '{broken');
  await fs.promises.writeFile(path.join(root, 'annex-peers.json.bak'), JSON.stringify([modern()]));
  const temp = path.join(root, `.annex-peers.json.tmp-${process.pid + 100000}-1`); await fs.promises.writeFile(temp, 'retain'); const old = new Date(Date.now() - 3 * 86400000); await fs.promises.utimes(temp, old, old);
  const before = await disk(), { value, receipts } = observe();
  expect.soft(value.state).toBe('unavailable'); expect.soft(value.matches('pairing-selected')).toBeUndefined(); expect.soft(receipts[0].current()).toBe(true);
  expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_|pairing-selected|Selected computer/); untouched(); expect.soft(await disk()).toEqual(before);
});
it('matches only the selected modern desktop association from warm memory without exposing identities or authority', async () => {
  await put([modern(), modern({ fingerprint: 'other-machine', pairingId: 'PRIVATE_OTHER_PAIRING', alias: 'PRIVATE_OTHER_ALIAS' })]); listPeers(); clearCalls();
  const before = await disk(), { value, receipts } = observe('SELECTED-MACHINE');
  expect.soft(value.state).toBe('ok'); expect.soft(value.matches('pairing-selected')).toBe(true); expect.soft(value.matches('PRIVATE_OTHER_PAIRING')).toBe(false); expect.soft(value.matches('legacy')).toBe(false); expect.soft(value.matches(undefined)).toBe(false); expect.soft(value.matches('x'.repeat(65))).toBe(false);
  expect.soft(receipts[0].current()).toBe(true); expect.soft(JSON.stringify(value)).not.toMatch(/PRIVATE_|pairing-selected|selected-machine|fingerprint|member|desktop|receipts|publicKey|credential/i);
  untouched(); expect.soft(await disk()).toEqual(before);
});
it.each([
  ['missing-role', { role: undefined }], ['invalid-role', { role: 'unexpected' }], ['missing-kind', { kind: undefined }], ['invalid-kind', { kind: 'unknown' }], ['invalid-pending', { networkPending: 'false' }],
  ['missing-pairing', { pairingId: undefined }], ['legacy', { pairingId: 'legacy' }], ['invalid-pairing', { pairingId: {} }], ['long-pairing', { pairingId: 'x'.repeat(65) }],
  ['missing-time', { pairedAt: undefined }], ['invalid-time', { pairedAt: 'invalid' }], ['long-time', { pairedAt: 'x'.repeat(129) }],
  ['missing-pin', { tlsCertificateFingerprint: undefined }], ['empty-pin', { tlsCertificateFingerprint: '' }], ['invalid-pin', { tlsCertificateFingerprint: {} }], ['long-pin', { tlsCertificateFingerprint: 'x'.repeat(257) }],
] as const)('keeps %s retained association unknown rather than inferring a desktop or legacy match', async (_label, extra) => {
  await put([modern(extra)]); listPeers(); clearCalls(); const { value } = observe();
  expect.soft(value.state).toBe('unavailable'); expect.soft(value.matches('pairing-selected')).toBeUndefined(); expect.soft(value.matches('legacy')).toBeUndefined(); untouched();
});
it.each([{ role: 'controller' }, { role: 'satellite' }, { kind: 'phone' }, { networkPending: true }])('preserves known inapplicable selected association %j', async (extra) => {
  await put([modern(extra)]); listPeers(); clearCalls(); const { value } = observe(); expect.soft(value.state).toBe('ok'); expect.soft(value.matches('pairing-selected')).toBe(false); untouched();
});
it.each(['absent', 'ambiguous', 'scan-limit'])('refuses %s selected association without adopting another record', async (kind) => {
  await put(kind === 'absent' ? [modern({ fingerprint: 'other-machine' })] : kind === 'ambiguous' ? [modern(), modern({ fingerprint: 'SELECTED-MACHINE' })] : Array.from({ length: PEER_DISPLAY_SCAN_LIMIT + 1 }, (_, i) => modern({ fingerprint: i === 0 ? 'selected-machine' : `other-${i}` })));
  listPeers(); clearCalls(); const { value } = observe(); expect.soft(value.state).toBe('unavailable'); expect.soft(value.matches('pairing-selected')).toBeUndefined(); untouched();
});
it.each(['pairing', 'time', 'pin', 'role', 'kind', 'pending', 'duplicate', 'reset', 'unrelated', 'alias', 'credential', 'primary-only'])('rechecks selected retained association after %s changes', async (change) => {
  await put([modern(), modern({ fingerprint: 'other-machine' })]); const rows = listPeers(), selected = getPeer('selected-machine')!, other = getPeer('other-machine')!; clearCalls();
  const { value, receipts } = observe(); expect(value.matches('pairing-selected')).toBe(true); expect(receipts[0].current()).toBe(true);
  if (change === 'pairing') selected.pairingId = 'pairing-replaced';
  if (change === 'time') selected.pairedAt = '2026-11-19T22:00:00Z';
  if (change === 'pin') selected.tlsCertificateFingerprint = 'PRIVATE_NEW_CERT_PIN';
  if (change === 'role') selected.role = 'satellite';
  if (change === 'kind') selected.kind = 'phone';
  if (change === 'pending') selected.networkPending = true;
  if (change === 'duplicate') { /* The ordinary array copy is detached; replace via deliberate lifecycle write below. */ const { addPeer } = await import('./annex-peers'); addPeer(modern({ fingerprint: 'SELECTED-MACHINE' }) as never); clearCalls(); }
  if (change === 'reset') resetForTests();
  if (change === 'unrelated') other.pairingId = 'PRIVATE_OTHER_NEW_PAIRING';
  if (change === 'alias') selected.alias = 'New alias';
  if (change === 'credential') selected.tlsCertificatePem = 'PRIVATE_NEW_PEM';
  if (change === 'primary-only') await put([modern({ pairingId: 'pairing-new-on-disk' })]);
  const current = ['unrelated', 'alias', 'credential', 'primary-only'].includes(change);
  expect.soft(receipts[0].current()).toBe(current); expect.soft(value.matches('pairing-selected')).toBe(current ? true : undefined); untouched();
  expect(rows.length).toBe(2); // Only modeled lifecycle/cache edits; not proof of revocation or a live transport.
});
it.each(['', 'x'.repeat(257), null])('does not retain an invalid selected key %s', (key) => {
  const { value, receipts } = observe(key as string); expect(value.state).toBe('unavailable'); expect(value.matches('pairing-selected')).toBeUndefined(); expect(receipts).toHaveLength(0); untouched();
});
it('supports a bounded maximum key and keeps caller edits detached from private matcher state', async () => {
  const key = 'x'.repeat(256); await put([modern({ fingerprint: key })]); listPeers(); clearCalls(); const { value, receipts } = observe(key);
  expect(value.matches('pairing-selected')).toBe(true); value.state = 'unavailable'; value.inputs[0].field = 'Caller edit'; expect(value.matches('pairing-selected')).toBe(true); expect(receipts[0].current()).toBe(true); expect(observe(key).value.state).toBe('ok'); untouched();
});
