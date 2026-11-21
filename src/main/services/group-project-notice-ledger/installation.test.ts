import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NoticeDirectoryFlusher } from './durability';
import { NOTICE_INSTALLATION_DIRECTORY, NOTICE_INSTALLATION_MARKER, openNoticeInstallation, type NoticeMetadataPoint, type NoticeMetadataPurpose } from './installation';

const homes: string[] = [];
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-installation-')); homes.push(directory); return directory; }
afterEach(async () => { await Promise.all(homes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('local notice installation marker', () => {
  it('creates one matching identity, no baseline/generation, and then reads without rewriting', async () => {
    const directory = await home();
    await fs.writeFile(path.join(directory, 'unrelated-settings.json'), 'synthetic-preserve');
    const first = await openNoticeInstallation(directory);
    expect(first.created).toBe(true);
    expect(first.resumedBootstrap).toBe(false);
    expect(first.directoryDurability).not.toBe('not-observed');
    const marker = await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER));
    const envelope = await fs.readFile(path.join(first.directory, 'installation.json'));
    const markerJson = JSON.parse(marker.toString('utf8'));
    const envelopeJson = JSON.parse(envelope.toString('utf8'));
    expect(markerJson.installationId).toBe(envelopeJson.installationId);
    expect(markerJson).toMatchObject({ minWriterVersion: 2, phase: 'active' });
    expect(envelopeJson).toMatchObject({ minWriterVersion: 2, phase: 'prepared' });
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
  it.each(['{broken', JSON.stringify({ schemaVersion: 1, minWriterVersion: 3, installationId: randomUUID(), future: true }), JSON.stringify({ schemaVersion: 1, minWriterVersion: 1, installationId: 'invalid' })])('preserves corrupt/future marker bytes %s', async (raw) => {
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
  it.each(['markerSynced', 'directoryCreated', 'envelopeSynced', 'beforeMarkerActive', 'markerActive'])('resumes only pristine bootstrap after actual synthetic process exit at %s', async (stage) => {
    const directory = await home();
    await expect(promisify(execFile)(process.execPath, ['test/research/q5-installation-process.cjs', directory, stage], { cwd: process.cwd() })).rejects.toMatchObject({ code: 77 });
    const original = await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER));
    const old = JSON.parse(original.toString('utf8'));
    const recovered = await openNoticeInstallation(directory);
    expect(recovered.created).toBe(false);
    expect(recovered.resumedBootstrap).toBe(stage !== 'markerActive');
    expect(recovered.installationId).toBe(old.installationId);
    const active = await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER));
    expect(JSON.parse(active.toString('utf8'))).toMatchObject({ installationId: old.installationId, phase: 'active' });
    expect((await openNoticeInstallation(directory)).resumedBootstrap).toBe(false);
    expect(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER))).toEqual(active);
  }, 15000);

  it('retries the envelope-to-marker cut idempotently with the same UUID and no record/baseline', async () => {
    const directory = await home();
    for (let retry = 0; retry < 2; retry++) await expect(promisify(execFile)(process.execPath, ['test/research/q5-installation-process.cjs', directory, 'beforeMarkerActive'], { cwd: process.cwd() })).rejects.toMatchObject({ code: 77 });
    const boot = JSON.parse(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER), 'utf8'));
    expect(boot.phase).toBe('bootstrapping');
    await fs.writeFile(path.join(directory, NOTICE_INSTALLATION_MARKER), JSON.stringify({ ...boot, futureOptional: { keep: true } }));
    const result = await openNoticeInstallation(directory);
    expect(result).toMatchObject({ installationId: boot.installationId, created: false, resumedBootstrap: true });
    expect(await fs.readdir(result.directory)).toEqual(['installation.json']);
    expect((await openNoticeInstallation(directory)).resumedBootstrap).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER), 'utf8')).futureOptional).toEqual({ keep: true });
  }, 15000);

  it.each(['journal-0000000000.log', 'unrecognized-user-data', 'installation.json.partial.tmp'])('refuses ambiguous bootstrap with retained %s', async (extra) => {
    const directory = await home();
    await expect(promisify(execFile)(process.execPath, ['test/research/q5-installation-process.cjs', directory, 'beforeMarkerActive'], { cwd: process.cwd() })).rejects.toMatchObject({ code: 77 });
    const markerPath = path.join(directory, NOTICE_INSTALLATION_MARKER);
    const before = await fs.readFile(markerPath);
    const stray = path.join(directory, NOTICE_INSTALLATION_DIRECTORY, extra);
    await fs.writeFile(stray, 'synthetic-retain-exactly');
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_incomplete' });
    expect(await fs.readFile(markerPath)).toEqual(before);
    expect(await fs.readFile(stray, 'utf8')).toBe('synthetic-retain-exactly');
  }, 15000);

  it('treats min-writer1 as active legacy, preserves fields and never reinterprets it as bootstrapping', async () => {
    const directory = await home();
    const legacy = { schemaVersion: 1, minWriterVersion: 1, installationId: randomUUID(), futureOptional: 'preserve' };
    const markerPath = path.join(directory, NOTICE_INSTALLATION_MARKER);
    const owned = path.join(directory, NOTICE_INSTALLATION_DIRECTORY);
    const raw = JSON.stringify(legacy);
    await fs.writeFile(markerPath, raw);
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_incomplete' });
    expect((await fs.readdir(directory)).includes(NOTICE_INSTALLATION_DIRECTORY)).toBe(false);
    await fs.mkdir(owned);
    await fs.writeFile(path.join(owned, 'installation.json'), raw);
    const result = await openNoticeInstallation(directory);
    expect(result).toMatchObject({ installationId: legacy.installationId, created: false, resumedBootstrap: false });
    expect(await fs.readFile(markerPath, 'utf8')).toBe(raw);
    expect(await fs.readFile(path.join(owned, 'installation.json'), 'utf8')).toBe(raw);
    await fs.writeFile(markerPath, JSON.stringify({ ...legacy, phase: 'bootstrapping' }));
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_version' });
  });

  it.each(['markerCreate', 'envelopeCreate', 'markerActivate'] as NoticeMetadataPurpose[])('cleans only its own %s temp after injected ENOSPC and then reopens', async (purpose) => {
    const directory = await home();
    const failure = Object.assign(new Error('synthetic-ENOSPC'), { code: 'ENOSPC', path: '/synthetic/private-path' });
    const error = await openNoticeInstallation(directory, { testMetadataFailure: (point, operation) => { if (point === 'beforeSync' && operation === purpose) throw failure; } }).then(() => undefined, (value) => value);
    expect(error).toMatchObject({ code: 'notice_installation_unavailable' });
    expect(error.cause).toBe(failure);
    expect(JSON.stringify(error)).not.toContain('/synthetic/private-path');
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const owned = path.join(directory, NOTICE_INSTALLATION_DIRECTORY);
    if (purpose !== 'markerCreate') expect((await fs.readdir(owned)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const marker = purpose === 'markerCreate' ? undefined : JSON.parse(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER), 'utf8'));
    const recovered = await openNoticeInstallation(directory);
    if (marker) expect(recovered.installationId).toBe(marker.installationId);
    expect(recovered.created).toBe(purpose === 'markerCreate');
    expect(recovered.resumedBootstrap).toBe(purpose !== 'markerCreate');
  });

  it.each(['beforeWrite', 'beforeRename'] as NoticeMetadataPoint[])('cleans a failed envelope temp at %s and keeps the bootstrap resumable', async (point) => {
    const directory = await home();
    const failure = Object.assign(new Error('synthetic-EIO'), { code: 'EIO' });
    const error = await openNoticeInstallation(directory, { testMetadataFailure: (at, operation) => { if (at === point && operation === 'envelopeCreate') throw failure; } }).then(() => undefined, (value) => value);
    expect(error.cause).toBe(failure);
    expect(await fs.readdir(path.join(directory, NOTICE_INSTALLATION_DIRECTORY))).toEqual([]);
    expect((await openNoticeInstallation(directory)).resumedBootstrap).toBe(true);
  });

  it('preserves the primary ENOSPC when best-effort cleanup also fails, then refuses its residue', async () => {
    const directory = await home();
    const original = Object.assign(new Error('synthetic-original'), { code: 'ENOSPC' });
    const cleanup = Object.assign(new Error('synthetic-cleanup'), { code: 'EACCES' });
    const error = await openNoticeInstallation(directory, { testMetadataFailure: (point, operation) => {
      if (operation !== 'envelopeCreate') return;
      if (point === 'beforeSync') throw original;
      if (point === 'beforeCleanup') throw cleanup;
    } }).then(() => undefined, (value) => value);
    expect(error.cause).toBe(original);
    expect((await fs.readdir(path.join(directory, NOTICE_INSTALLATION_DIRECTORY))).some((name) => name.endsWith('.tmp'))).toBe(true);
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_incomplete' });
  });

  it('cleans the own temp on an actual rename failure without deleting the conflicting directory', async () => {
    const directory = await home();
    const envelope = path.join(directory, NOTICE_INSTALLATION_DIRECTORY, 'installation.json');
    const error = await openNoticeInstallation(directory, { testMetadataFailure: async (point, operation) => {
      if (point === 'beforeRename' && operation === 'envelopeCreate') await fs.mkdir(envelope);
    } }).then(() => undefined, (value) => value);
    expect(error).toMatchObject({ code: 'notice_installation_unavailable' });
    expect(error.cause?.code).toBeTruthy();
    expect((await fs.stat(envelope)).isDirectory()).toBe(true);
    expect(await fs.readdir(path.dirname(envelope))).toEqual(['installation.json']);
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_corrupt' });
  });

  it('fails closed on an actual process exit after envelope temp creation, retaining all bytes', async () => {
    const directory = await home();
    await expect(promisify(execFile)(process.execPath, ['test/research/q5-installation-process.cjs', directory, 'envelopeTempOpened'], { cwd: process.cwd() })).rejects.toMatchObject({ code: 77 });
    const markerPath = path.join(directory, NOTICE_INSTALLATION_MARKER);
    const marker = await fs.readFile(markerPath);
    const owned = path.join(directory, NOTICE_INSTALLATION_DIRECTORY);
    const names = await fs.readdir(owned);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^installation\.json\.[a-f0-9-]+\.tmp$/);
    const temporary = path.join(owned, names[0]);
    const bytes = await fs.readFile(temporary);
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_incomplete' });
    expect(await fs.readFile(markerPath)).toEqual(marker);
    expect(await fs.readFile(temporary)).toEqual(bytes);
    expect(await fs.readdir(owned)).toEqual(names);
  }, 15000);

  it.each([
    { markerVersion: 2, markerPhase: 'prepared', envelopeVersion: 2, envelopePhase: 'prepared', wrongId: false },
    { markerVersion: 2, markerPhase: 'bootstrapping', envelopeVersion: 2, envelopePhase: 'bootstrapping', wrongId: false },
    { markerVersion: 2, markerPhase: 'bootstrapping', envelopeVersion: 2, envelopePhase: 'active', wrongId: false },
    { markerVersion: 2, markerPhase: 'active', envelopeVersion: 1, envelopePhase: undefined, wrongId: false },
    { markerVersion: 1, markerPhase: undefined, envelopeVersion: 2, envelopePhase: 'prepared', wrongId: false },
    { markerVersion: 2, markerPhase: 'bootstrapping', envelopeVersion: 2, envelopePhase: 'prepared', wrongId: true },
  ])('refuses invalid phase/version/UUID pairing %j', async (row) => {
    const directory = await home();
    const installationId = randomUUID();
    const marker = JSON.stringify({ schemaVersion: 1, minWriterVersion: row.markerVersion, phase: row.markerPhase, installationId });
    const envelope = JSON.stringify({ schemaVersion: 1, minWriterVersion: row.envelopeVersion, phase: row.envelopePhase, installationId: row.wrongId ? randomUUID() : installationId });
    const owned = path.join(directory, NOTICE_INSTALLATION_DIRECTORY); await fs.mkdir(owned);
    await fs.writeFile(path.join(directory, NOTICE_INSTALLATION_MARKER), marker); await fs.writeFile(path.join(owned, 'installation.json'), envelope);
    await expect(openNoticeInstallation(directory)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, NOTICE_INSTALLATION_MARKER), 'utf8')).toBe(marker);
    expect(await fs.readFile(path.join(owned, 'installation.json'), 'utf8')).toBe(envelope);
    expect(await fs.readdir(owned)).toEqual(['installation.json']);
  });

  it('refuses a bootstrap envelope symlink without following or rewriting its target', async (context) => {
    const directory = await home();
    const owned = path.join(directory, NOTICE_INSTALLATION_DIRECTORY); await fs.mkdir(owned);
    const installationId = randomUUID();
    await fs.writeFile(path.join(directory, NOTICE_INSTALLATION_MARKER), JSON.stringify({ schemaVersion: 1, minWriterVersion: 2, installationId, phase: 'bootstrapping' }));
    const target = path.join(directory, 'synthetic-target.json');
    const bytes = JSON.stringify({ schemaVersion: 1, minWriterVersion: 2, installationId, phase: 'prepared' });
    await fs.writeFile(target, bytes);
    try { await fs.symlink(target, path.join(owned, 'installation.json'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error; // telemetry-exempt: native fixture capability refusal is explicit; other errors fail the control
    }
    await expect(openNoticeInstallation(directory)).rejects.toMatchObject({ code: 'notice_installation_corrupt' });
    expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    expect((await fs.lstat(path.join(owned, 'installation.json'))).isSymbolicLink()).toBe(true);
  });
});
