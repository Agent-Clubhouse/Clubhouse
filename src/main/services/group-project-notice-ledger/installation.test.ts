import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NoticeDirectoryFlusher } from './durability';
import { NOTICE_INSTALLATION_DIRECTORY, NOTICE_INSTALLATION_MARKER, openNoticeInstallation } from './installation';

const homes: string[] = [];
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-installation-')); homes.push(directory); return directory; }
afterEach(async () => { await Promise.all(homes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('local notice installation marker', () => {
  it('creates one matching identity, no baseline/generation, and then reads without rewriting', async () => {
    const directory = await home();
    await fs.writeFile(path.join(directory, 'unrelated-settings.json'), 'synthetic-preserve');
    const first = await openNoticeInstallation(directory);
    expect(first.created).toBe(true);
    expect(first.directoryDurability).not.toBe('not-observed');
    const marker = await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER));
    const envelope = await fs.readFile(path.join(first.directory, 'installation.json'));
    expect(marker).toEqual(envelope);
    const second = await openNoticeInstallation(directory);
    expect(second.installationId).toBe(first.installationId);
    expect(second.created).toBe(false);
    expect(second.directoryDurability).toBe('not-observed');
    expect(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER))).toEqual(marker);
    expect(await fs.readdir(first.directory)).toEqual(['installation.json']);
    expect(await fs.readFile(path.join(directory, 'unrelated-settings.json'), 'utf8')).toBe('synthetic-preserve');
  });
  it('single-flights concurrent main-owned creation without competing installation IDs', async () => {
    const directory = await home();
    const all = await Promise.all(Array.from({ length: 12 }, () => openNoticeInstallation(directory)));
    expect(new Set(all.map((v) => v.installationId)).size).toBe(1);
    const marker = JSON.parse(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER), 'utf8'));
    const envelope = JSON.parse(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_DIRECTORY, 'installation.json'), 'utf8'));
    expect(marker.installationId).toBe(envelope.installationId);
  });
  it.each(['marker', 'directory', 'envelope'] as const)('refuses missing required %s without silently recreating it', async (missing) => {
    const directory = await home();
    const created = await openNoticeInstallation(directory);
    const markerPath = path.join(directory, NOTICE_INSTALLATION_MARKER);
    const marker = await fs.readFile(markerPath);
    if (missing === 'marker') await fs.unlink(markerPath);
    else if (missing === 'directory') await fs.rm(created.directory, { recursive: true });
    else await fs.unlink(path.join(created.directory, 'installation.json'));
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_incomplete' });
    if (missing === 'marker') await expect(fs.lstat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await fs.readFile(markerPath)).toEqual(marker);
    if (missing === 'directory') await expect(fs.lstat(created.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['{broken', JSON.stringify({ schemaVersion: 1, minWriterVersion: 2, installationId: randomUUID(), future: true }), JSON.stringify({ schemaVersion: 1, minWriterVersion: 1, installationId: 'invalid' })])('preserves corrupt/future marker bytes %s', async (raw) => {
    const directory = await home();
    const markerPath = path.join(directory, NOTICE_INSTALLATION_MARKER);
    await fs.writeFile(markerPath, raw);
    await expect(openNoticeInstallation(directory)).rejects.toThrow();
    expect(await fs.readFile(markerPath, 'utf8')).toBe(raw);
    expect((await fs.readdir(directory)).includes(NOTICE_INSTALLATION_DIRECTORY)).toBe(false);
  });
  it('refuses mismatched identities and retains supported optional fields byte-for-byte', async () => {
    const directory = await home();
    const created = await openNoticeInstallation(directory);
    const envelopePath = path.join(created.directory, 'installation.json');
    const envelope = JSON.parse(await fs.readFile(envelopePath, 'utf8'));
    const supported = JSON.stringify({ ...envelope, futureOptional: { keep: true } });
    await fs.writeFile(envelopePath, supported);
    await openNoticeInstallation(directory);
    expect(await fs.readFile(envelopePath, 'utf8')).toBe(supported);
    const wrong = JSON.stringify({ ...envelope, installationId: randomUUID() });
    await fs.writeFile(envelopePath, wrong);
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_changed' });
    expect(await fs.readFile(envelopePath, 'utf8')).toBe(wrong);
  });
  it('does not treat installation creation as legacy-receipt migration or permission to baseline', async () => {
    const directory = await home();
    const legacy = path.join(directory, 'group-project-notification-receipts.json');
    await fs.writeFile(legacy, '{synthetic-invalid-legacy');
    const created = await openNoticeInstallation(directory);
    expect(await fs.readFile(legacy, 'utf8')).toBe('{synthetic-invalid-legacy');
    expect(await fs.readdir(created.directory)).toEqual(['installation.json']);
  });
  it('reports a simulated Windows file-sync-only policy without claiming native platform proof', async () => {
    const directory = await home();
    const directoryFlusher = new NoticeDirectoryFlusher('win32', async () => { throw Object.assign(new Error('synthetic'), { code: 'EINVAL' }); });
    expect((await openNoticeInstallation(directory, { directoryFlusher })).directoryDurability).toBe('file-sync-only');
  });
  it.each(['markerSynced', 'directoryCreated', 'envelopeSynced'])('recovers or refuses an actual synthetic process exit at %s', async (stage) => {
    const directory = await home();
    await expect(promisify(execFile)(process.execPath, ['test/research/q5-installation-process.cjs', directory, stage], { cwd: process.cwd() })).rejects.toMatchObject({ code: 77 });
    const original = await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER));
    if (stage === 'envelopeSynced') expect((await openNoticeInstallation(directory)).created).toBe(false);
    else await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_incomplete' });
    expect(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER))).toEqual(original);
  }, 15000);
});
