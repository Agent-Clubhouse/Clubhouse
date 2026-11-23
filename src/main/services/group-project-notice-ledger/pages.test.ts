import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { constants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NOTICE_INDEX_PAGE_BYTES, NoticePageIndex, type NoticePageRoot, type NoticePageFailurePoint } from './pages';

import { FixtureObservationSelection, observeCleanupBatch, type FixtureObservation } from '../../../../test/two-fixture-observation';

const pageObservation = new FixtureObservationSelection('pages-large');
const homes: string[] = [];
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'q5-pages-')); homes.push(directory); return directory; }
afterEach(async (context) => {
  const batch = homes.splice(0); const remove = fs.rm; const receiver = fs;
  let task: object | undefined;
  try { task = context.task; } catch { pageObservation.selected?.noteFault(); }
  await observeCleanupBatch(pageObservation, task, batch, (directory) => {
    const options = { recursive: true, force: true };
    return () => Reflect.apply(remove, receiver, [directory, options]);
  });
});
const key = (index: number) => `synthetic-${String(index).padStart(8, '0')}`;
async function temps(directory: string) {
  const result: string[] = [];
  for (const prefix of await fs.readdir(directory)) for (const name of await fs.readdir(path.join(directory, prefix))) {
    if (name.endsWith('.tmp')) result.push(path.join(directory, prefix, name));
  }
  return result.sort();
}
async function immutableFiles(directory: string) {
  const result: Array<{ file: string; sha256: string }> = [];
  for (const prefix of await fs.readdir(directory)) for (const file of await fs.readdir(path.join(directory, prefix))) {
    result.push({ file: `${prefix}/${file}`, sha256: createHash('sha256').update(await fs.readFile(path.join(directory, prefix, file))).digest('hex') });
  }
  return result.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
async function child(directory: string, mode: string) {
  return promisify(execFile)(process.execPath, ['test/research/q5-index-process.cjs', directory, mode], { cwd: process.cwd() }).then(
    (value) => ({ code: 0, stdout: value.stdout, stderr: value.stderr }),
    (error: Error & { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
}

describe('lazy immutable notice index', () => {
  async function originalLargeBody(scope?: FixtureObservation): Promise<void> {
    scope?.setPhase('home');
    const directory = await home();
    scope?.bindDirectory(directory);
    scope?.completePhase();
    scope?.setPhase('open');
    let index = await NoticePageIndex.open(directory);
    scope?.completePhase();
    let root: NoticePageRoot | undefined;
    scope?.setPhase('updates');
    for (let n = 0; n < 1024; n++) {
      scope?.updateStarted(n + 1);
      root = await index.set(root, key(n), { postId: `${key(n)}-${'x'.repeat(180)}`, status: 'uncertain' });
      scope?.updateCompleted(n + 1);
    }
    scope?.completePhase();
    scope?.setPhase('pre-flush-check');
    expect(index.cacheStats.pendingDirectoryCount).toBeLessThanOrEqual(258);
    scope?.completePhase();
    scope?.setPhase('flush');
    await index.flush();
    scope?.completePhase();
    scope?.setPhase('post-flush-checks');
    expect(root?.count).toBe(1024);
    expect(index.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect(index.cacheStats.leafPages).toBeLessThanOrEqual(4);
    expect(index.cacheStats.indexPages).toBeLessThanOrEqual(16);
    scope?.completePhase();
    scope?.setPhase('manifest-check');
    expect((await fs.readdir(directory)).some((name) => name === 'manifest.json')).toBe(false);
    scope?.completePhase();
    scope?.setPhase('reopen');
    index = await NoticePageIndex.open(directory);
    scope?.completePhase();
    scope?.setPhase('cold-cache-check');
    expect(index.cacheStats.leafEntries).toBe(0);
    scope?.completePhase();
    scope?.setPhase('cold-get');
    expect(await index.get(root, key(700))).toMatchObject({ postId: `${key(700)}-${'x'.repeat(180)}` });
    scope?.completePhase();
    scope?.setPhase('cold-get-budget');
    expect(index.cacheStats.diskReads).toBeLessThanOrEqual(4);
    scope?.completePhase();
    scope?.setPhase('cold-list');
    const page = await index.list(root, { after: key(699), limit: 200 });
    scope?.completePhase();
    scope?.setPhase('cold-list-checks');
    expect(page.entries).toHaveLength(200);
    expect(page.entries[0].key).toBe(key(700));
    expect(page.entries[199].key).toBe(key(899));
    expect(index.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect(index.cacheStats.diskReads).toBeLessThan(20);
    scope?.completePhase();
    scope?.setPhase('cold-miss');
    expect(await index.get(root, key(1024))).toBeUndefined();
    scope?.completePhase();
    scope?.setPhase('size-checks');
    for (const prefix of await fs.readdir(directory)) for (const name of await fs.readdir(path.join(directory, prefix))) {
      if (name.endsWith('.json')) {
        expect((await fs.stat(path.join(directory, prefix, name))).size).toBeLessThanOrEqual(NOTICE_INDEX_PAGE_BYTES);
        scope?.fileChecked();
      }
    }
    scope?.completePhase();
    scope?.setPhase('body-complete');
  }
  it('keeps >64KiB of exact ID data paged and bounds detail cache to256 rows on write and cold reads', (context) => {
    const scope = pageObservation.claim();
    if (scope) {
      try { scope.bindTask(context.task, () => context.signal.aborted); } catch { scope.noteFault(); }
    }
    return scope ? scope.call('body', () => originalLargeBody(scope)) : originalLargeBody();
  }, 30000);

  it('preserves old roots through update/delete and returns no mutable cached details', async () => {
    const index = await NoticePageIndex.open(await home());
    let root: NoticePageRoot | undefined;
    for (let n = 0; n < 100; n++) root = await index.set(root, key(n), { value: n });
    const original = root!;
    const changed = await index.set(root, key(50), { value: 5000 });
    expect(await index.get(original, key(50))).toEqual({ value: 50 });
    expect(await index.get(changed, key(50))).toEqual({ value: 5000 });
    const result = await index.get(changed, key(50)) as { value: number };
    result.value = -1;
    expect(await index.get(changed, key(50))).toEqual({ value: 5000 });
    root = await index.delete(changed, key(50));
    expect(await index.get(root, key(50))).toBeUndefined();
    expect(await index.get(changed, key(50))).toEqual({ value: 5000 });
    expect(root?.count).toBe(99);
    for (let n = 0; n < 100; n++) root = await index.delete(root, key(n));
    expect(root).toBeUndefined();
    expect(await index.get(original, key(0))).toEqual({ value: 0 });
  }, 15000);

  it('splits by bytes for adjacent large values rather than rejecting valid later work', async () => {
    const index = await NoticePageIndex.open(await home());
    let root = await index.set(undefined, 'a', 'x'.repeat(180000));
    for (let n = 0; n < 20; n++) root = await index.set(root, `b${String(n).padStart(2, '0')}`, 'small');
    root = await index.set(root, 'a1', 'y'.repeat(180000));
    expect(root.count).toBe(22);
    expect(await index.get(root, 'a1')).toHaveLength(180000);
    expect(await index.get(root, 'a')).toHaveLength(180000);
    const prior = root;
    await expect(index.set(root, 'oversized', 'z'.repeat(NOTICE_INDEX_PAGE_BYTES))).rejects.toThrow('bound');
    expect(await index.get(prior, 'oversized')).toBeUndefined();
  }, 15000);

  it('refuses damaged referenced bytes and invalid reference metadata without replacement', async () => {
    const directory = await home();
    const index = await NoticePageIndex.open(directory);
    const root = await index.set(undefined, 'stable-id', { state: 'uncertain' });
    await index.flush();
    index.clearCache();
    await expect(index.get({ ...root, count: 2 }, 'stable-id')).rejects.toThrow('metadata mismatch');
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`);
    await fs.writeFile(file, 'damaged');
    index.clearCache();
    await expect(index.get(root, 'stable-id')).rejects.toThrow('checksum');
    expect(await fs.readFile(file, 'utf8')).toBe('damaged');
  });

  it('refuses oversized immutable files before reading contents on cold load and page reuse', async () => {
    const directory = await home();
    let index = await NoticePageIndex.open(directory);
    const root = await index.set(undefined, 'stable-id', { state: 'uncertain' });
    await index.flush();
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`);
    const oversized = Buffer.alloc(NOTICE_INDEX_PAGE_BYTES + 1, 120);
    await fs.writeFile(file, oversized);
    index = await NoticePageIndex.open(directory);
    await expect(index.get(root, 'stable-id')).rejects.toThrow('byte bound');
    await expect(index.set(undefined, 'stable-id', { state: 'uncertain' })).rejects.toThrow('byte bound');
    expect(index.cacheStats.pageReadBytes).toBe(0);
    expect(await fs.readFile(file)).toEqual(oversized);
  });

  it('refuses directory or symlink page replacements without following or replacing them', async ({ skip }) => {
    const directory = await home();
    let index = await NoticePageIndex.open(directory);
    const root = await index.set(undefined, 'stable-id', true);
    await index.flush();
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`);
    const saved = file + '.saved'; await fs.rename(file, saved);
    await fs.mkdir(file);
    index = await NoticePageIndex.open(directory);
    await expect(index.get(root, 'stable-id')).rejects.toThrow('type');
    await fs.rmdir(file);
    try { await fs.symlink(saved, file); }
    catch (error) {
      // telemetry-exempt: skip only actual unsupported native fixture creation
      if (process.platform === 'win32' && ['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; }
      throw error;
    }
    await expect(index.get(root, 'stable-id')).rejects.toThrow('type');
    await expect(index.set(undefined, 'stable-id', true)).rejects.toThrow('type');
    expect(index.cacheStats.pageReadBytes).toBe(0);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(file)).toBe(saved);
  });

  it('earns reused file/prefix barriers across an actual unflushed-process exit and kills the skip-dirty mutant', async () => {
    const guarded = await child(await home(), 'reuse-guarded');
    console.info('Q5 reused-page guarded control', JSON.stringify(guarded));
    expect(guarded).toMatchObject({ code: 0, stdout: expect.stringContaining('PASS: reused orphan earned file and prefix barriers') });
    const mutant = await child(await home(), 'skip-reuse-dirty');
    console.info('Q5 skipped-reuse-dirty mutant', JSON.stringify(mutant));
    expect(mutant).toMatchObject({ code: 2, stdout: expect.stringContaining('SAFETY ASSERTION FAILED: reused orphan prefix barrier missing') });
  }, 15000);

  it('refuses failed reused-file sync and retains a failed prefix flush for retry', async () => {
    const directory = await home();
    const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true); // intentionally no flush
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`);
    const before = await fs.readFile(file);
    const original = Object.assign(new Error('synthetic-reused-sync'), { code: 'EIO' });
    const refused = await NoticePageIndex.open(directory, { testFailure: (point) => { if (point === 'beforeReusedSync') throw original; } });
    await expect(refused.set(undefined, 'stable-id', true)).rejects.toBe(original);
    const events: string[] = []; let failPrefix = true;
    const prefix = path.dirname(file);
    const retry = await NoticePageIndex.open(directory, { testFailure: (point, location) => {
      if (point === 'reusedPageSynced') events.push('file-synced');
      if (point === 'beforeDirectoryFlush' && location === prefix) {
        events.push('prefix-requested');
        if (failPrefix) throw original;
      }
    } });
    expect(await retry.set(undefined, 'stable-id', true)).toEqual(root);
    await expect(retry.flush()).rejects.toBe(original);
    expect(retry.cacheStats.pendingDirectoryCount).toBe(3);
    expect(events).toEqual(['file-synced', 'prefix-requested']);
    failPrefix = false; await retry.flush();
    expect(retry.cacheStats.pendingDirectoryCount).toBe(0);
    expect(events).toEqual(['file-synced', 'prefix-requested', 'prefix-requested']);
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('uses one non-truncating write-capable descriptor for simulated Windows reuse, but ordinary reads stay read-only', async () => {
    const directory = await home();
    const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true);
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`);
    const before = await fs.readFile(file); const flags: number[] = []; let syncs = 0;
    const options = { testPlatform: 'win32' as const, testOpenPage: async (location: string, mode: number) => {
      flags.push(mode); const handle = await fs.open(location, mode); const sync = handle.sync.bind(handle);
      handle.sync = async () => { syncs++; await sync(); }; return handle;
    } };
    const reuse = await NoticePageIndex.open(directory, options);
    expect(await reuse.set(undefined, 'stable-id', true)).toEqual(root);
    expect(flags).toHaveLength(1); expect(flags[0] & constants.O_RDWR).toBe(constants.O_RDWR);
    expect(flags[0] & (constants.O_TRUNC | constants.O_CREAT | constants.O_APPEND)).toBe(0);
    expect(syncs).toBe(1);
    const reader = await NoticePageIndex.open(directory, options);
    expect(await reader.get(root, 'stable-id')).toBe(true);
    expect(flags).toHaveLength(2); expect(flags[1] & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
    expect(syncs).toBe(1); expect(await fs.readFile(file)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')('preserves native POSIX read-only reuse and actual sync', async () => {
    const directory = await home(); const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true); const flags: number[] = [];
    const index = await NoticePageIndex.open(directory, { testOpenPage: async (location, mode) => { flags.push(mode); return fs.open(location, mode); } });
    expect(await index.set(undefined, 'stable-id', true)).toEqual(root);
    expect(flags).toHaveLength(1); expect(flags[0] & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ENOENT'])('refuses simulated Windows descriptor sync %s without durability downgrade or replacement', async (code) => {
    const directory = await home(); const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true);
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`); const before = await fs.readFile(file);
    const original = Object.assign(new Error('synthetic-descriptor-sync'), { code });
    const handles: import('fs/promises').FileHandle[] = [];
    const index = await NoticePageIndex.open(directory, { testPlatform: 'win32', testOpenPage: async (location, mode) => {
      expect(mode & constants.O_RDWR).toBe(constants.O_RDWR);
      const handle = await fs.open(location, mode); handles.push(handle);
      handle.sync = async () => { throw original; }; return handle;
    } });
    await expect(index.set(undefined, 'stable-id', true)).rejects.toBe(original);
    expect(handles).toHaveLength(1); expect(handles[0].fd).toBe(-1);
    expect(index.directoryDurability).toBe('not-observed'); expect(index.cacheStats.pendingDirectoryCount).toBe(2);
    expect(await fs.readFile(file)).toEqual(before);
  });

  it.each(['beforePageOpen', 'beforeReusedSync'] as NoticePageFailurePoint[])('refuses a same-content different-inode replacement at %s in simulated Windows reuse', async (point) => {
    const directory = await home(); const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true);
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`); const before = await fs.readFile(file);
    const index = await NoticePageIndex.open(directory, { testPlatform: 'win32', testFailure: async (seen, location) => {
      if (seen === point) { await fs.rename(location, location + '.saved'); await fs.copyFile(location + '.saved', location); }
    } });
    await expect(index.set(undefined, 'stable-id', true)).rejects.toThrow('changed');
    expect(await fs.readFile(file)).toEqual(before); expect(await fs.readFile(file + '.saved')).toEqual(before);
    expect(index.cacheStats.pendingDirectoryCount).toBe(2);
  });

  it('refuses a symlink swap to the original validated inode in simulated Windows reuse', async ({ skip }) => {
    const directory = await home(); const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true);
    const file = path.join(directory, root.digest.slice(0, 2), `${root.digest}.json`); const before = await fs.readFile(file);
    const link = file + '.prepared-link';
    try { await fs.symlink(file + '.saved', link); }
    catch (error) {
      // telemetry-exempt: only actual unsupported native fixture creation skips
      if (process.platform === 'win32' && ['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; }
      throw error;
    }
    let syncs = 0;
    const index = await NoticePageIndex.open(directory, { testPlatform: 'win32', testFailure: async (point, location) => {
      if (point === 'beforePageOpen') { await fs.rename(location, location + '.saved'); await fs.rename(link, location); }
    }, testOpenPage: async (location, mode) => {
      const handle = await fs.open(location, mode); const sync = handle.sync.bind(handle);
      handle.sync = async () => { syncs++; await sync(); }; return handle;
    } });
    await expect(index.set(undefined, 'stable-id', true)).rejects.toThrow();
    expect(syncs).toBe(0); expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(file + '.saved')).toEqual(before);
  });

  it('follows a swapped final symlink without O_NOFOLLOW and refuses after actual content read', async ({ skip }) => {
    const directory = await home(); const initial = await NoticePageIndex.open(directory);
    const root = await initial.set(undefined, 'stable-id', true);
    const prefix = path.join(directory, root.digest.slice(0, 2)); const savedPrefix = prefix + '.saved';
    const file = path.join(prefix, `${root.digest}.json`); const saved = path.join(savedPrefix, path.basename(file));
    const before = await fs.readFile(file); const originalIdentity = await fs.lstat(file);
    const preparedLink = path.join(directory, 'prepared-final-link');
    try { await fs.symlink(saved, preparedLink); }
    catch (error) {
      // telemetry-exempt: only actual unsupported native fixture creation skips
      if (process.platform === 'win32' && ['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; }
      throw error;
    }
    let syncs = 0; let effectiveFlags!: number;
    const index = await NoticePageIndex.open(directory, { testPlatform: 'win32', testFailure: async (point) => {
      if (point === 'beforePageOpen') {
        // Moving the directory preserves the target file's inode/mtime/ctime;
        // this reaches the final lstat check without fabricating stat results.
        await fs.rename(prefix, savedPrefix); await fs.mkdir(prefix); await fs.rename(preparedLink, file);
      }
    }, testOpenPage: async (location, flags) => {
      effectiveFlags = flags & ~(constants.O_NOFOLLOW ?? 0);
      const handle = await fs.open(location, effectiveFlags); const sync = handle.sync.bind(handle);
      handle.sync = async () => { syncs++; await sync(); }; return handle;
    } });
    await expect(index.set(undefined, 'stable-id', true)).rejects.toThrow('changed while reading');
    expect(effectiveFlags & (constants.O_NOFOLLOW ?? 0)).toBe(0);
    expect(index.cacheStats.pageReadBytes).toBe(before.length); expect(syncs).toBe(0);
    const targetIdentity = await fs.lstat(saved);
    expect(targetIdentity.ino).toBe(originalIdentity.ino); expect(targetIdentity.dev).toBe(originalIdentity.dev);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true); expect(await fs.readFile(saved)).toEqual(before);
  });

  it.skipIf(process.platform !== 'win32')('native Windows reuse sync succeeds without platform or descriptor overrides', async () => {
    const directory = await home(); const first = await NoticePageIndex.open(directory);
    const root = await first.set(undefined, 'stable-id', true);
    const reopened = await NoticePageIndex.open(directory);
    expect(await reopened.set(undefined, 'stable-id', true)).toEqual(root);
    await reopened.flush(); expect(await reopened.get(root, 'stable-id')).toBe(true);
  });

  it('retains a concurrent reuse barrier rather than deleting a newer dirty mark', async () => {
    const directory = await home();
    let blocked = false; let arrived!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const index = await NoticePageIndex.open(directory, { testFailure: async (point, location) => {
      if (point === 'beforeDirectoryFlush' && path.dirname(location) === directory && !blocked) {
        blocked = true; arrived(); await pause;
      }
    } });
    const root = await index.set(undefined, 'stable-id', true);
    const flushing = index.flush();
    await waiting;
    expect(await index.set(undefined, 'stable-id', true)).toEqual(root);
    release();
    await expect(flushing).rejects.toThrow('changed during flush');
    expect(index.cacheStats.pendingDirectoryCount).toBe(2);
    await index.flush(); expect(index.cacheStats.pendingDirectoryCount).toBe(0);
  });

  it.each(['beforePageWrite', 'beforePageSync', 'beforePageRename'] as NoticePageFailurePoint[])('cleans only current-own temp after %s failure and then prepares successfully', async (point) => {
    const directory = await home();
    const original = Object.assign(new Error('synthetic-page-ENOSPC'), { code: 'ENOSPC' });
    const failed = await NoticePageIndex.open(directory, { testFailure: (seen) => { if (seen === point) throw original; } });
    await expect(failed.set(undefined, 'stable-id', true)).rejects.toBe(original);
    expect(await temps(directory)).toEqual([]);
    const reopened = await NoticePageIndex.open(directory);
    const root = await reopened.set(undefined, 'stable-id', true); await reopened.flush();
    expect(await reopened.get(root, 'stable-id')).toBe(true);
  });

  it('preserves primary failure when cleanup fails and never deletes that earlier residue on reopen', async () => {
    const directory = await home();
    const original = Object.assign(new Error('synthetic-original-page-ENOSPC'), { code: 'ENOSPC' });
    const failed = await NoticePageIndex.open(directory, { testFailure: (point) => {
      if (point === 'beforePageWrite') throw original;
      if (point === 'beforeTempCleanup') throw new Error('synthetic-secondary-cleanup');
    } });
    await expect(failed.set(undefined, 'stable-id', true)).rejects.toBe(original);
    const residue = await temps(directory); expect(residue).toHaveLength(1);
    const before = await fs.readFile(residue[0]);
    const reopened = await NoticePageIndex.open(directory); await reopened.set(undefined, 'stable-id', true);
    expect(await temps(directory)).toEqual(residue);
    expect(await fs.readFile(residue[0])).toEqual(before);
  });

  it('preserves an ambiguous replacement of its own temp and the original error', async () => {
    const directory = await home(); let replacement!: string;
    const original = new Error('synthetic-after-temp-replacement');
    const index = await NoticePageIndex.open(directory, { testFailure: async (point, location) => {
      if (point === 'beforePageRename') {
        await fs.rename(location, location + '.owned-backup');
        await fs.writeFile(location, 'foreign-replacement'); replacement = location;
        throw original;
      }
    } });
    await expect(index.set(undefined, 'stable-id', true)).rejects.toBe(original);
    expect(await fs.readFile(replacement, 'utf8')).toBe('foreign-replacement');
    const reopened = await NoticePageIndex.open(directory); await reopened.set(undefined, 'stable-id', true);
    expect(await fs.readFile(replacement, 'utf8')).toBe('foreign-replacement');
  });

  it('cleans its current temp after actual rename refusal while preserving the conflicting directory', async () => {
    const directory = await home(); let conflicting!: string;
    const index = await NoticePageIndex.open(directory, { testFailure: async (point, location) => {
      if (point === 'beforePageRename') {
        conflicting = path.join(path.dirname(location), path.basename(location).slice(0, 64) + '.json');
        await fs.mkdir(conflicting);
      }
    } });
    await expect(index.set(undefined, 'stable-id', true)).rejects.toThrow();
    expect((await fs.lstat(conflicting)).isDirectory()).toBe(true);
    expect(await temps(directory)).toEqual([]);
  });

  it('retains prior-process temp after an actual temp-opened exit without granting it root authority', async () => {
    const directory = await home();
    expect(await child(directory, 'temp-opened')).toMatchObject({ code: 77 });
    const residue = await temps(directory); expect(residue).toHaveLength(1);
    const before = await fs.readFile(residue[0]);
    const reopened = await NoticePageIndex.open(directory);
    const root = await reopened.set(undefined, 'stable-id', true); await reopened.flush();
    expect(await reopened.get(root, 'stable-id')).toBe(true);
    expect(await temps(directory)).toEqual(residue);
    expect(await fs.readFile(residue[0])).toEqual(before);
    expect((await fs.readdir(directory)).includes('manifest.json')).toBe(false);
  }, 15000);

  it.skipIf(process.platform === 'win32')('refuses an actual regular-file to FIFO swap without a blocking open', async () => {
    const result = await child(await home(), 'fifo-swap');
    console.info('Q5 FIFO-swap nonblocking control', JSON.stringify(result));
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('PASS: swapped FIFO refused without blocking') });
  }, 15000);

  it('rejects a future page writer version even with a correct content hash', async () => {
    const directory = await home();
    const index = await NoticePageIndex.open(directory);
    const bytes = JSON.stringify({ schemaVersion: 1, minWriterVersion: 2, kind: 'leaf', entries: [{ key: 'id', value: true }] });
    const hash = createHash('sha256').update(bytes).digest('hex');
    await fs.mkdir(path.join(directory, hash.slice(0, 2)));
    await fs.writeFile(path.join(directory, hash.slice(0, 2), `${hash}.json`), bytes);
    await expect(index.get({ digest: hash, first: 'id', last: 'id', count: 1, depth: 0 }, 'id')).rejects.toThrow('writer');
  });

  it.each(['leaf', 'index', 'entry', 'child-reference', 'root-reference'] as const)(
    'D1 schema: refuses unknown %s fields without propagation or new writes', async (kind) => {
      const directory = await home(); const index = await NoticePageIndex.open(directory);
      async function save(page: unknown, depth: number): Promise<NoticePageRoot> {
        const bytes = JSON.stringify(page); const hash = createHash('sha256').update(bytes).digest('hex');
        await fs.mkdir(path.join(directory, hash.slice(0, 2)), { recursive: true });
        await fs.writeFile(path.join(directory, hash.slice(0, 2), `${hash}.json`), bytes);
        return { digest: hash, first: 'id', last: 'id', count: 1, depth };
      }
      const leaf = { schemaVersion: 1, minWriterVersion: 1, kind: 'leaf', entries: [{ key: 'id', value: { payload: true } }] };
      let root: NoticePageRoot;
      if (kind === 'leaf') root = await save({ ...leaf, unsupportedStructuralField: true }, 0);
      else if (kind === 'entry') root = await save({ ...leaf, entries: [{ ...leaf.entries[0], unsupportedStructuralField: true }] }, 0);
      else {
        const child = await save(leaf, 0);
        if (kind === 'root-reference') root = { ...child, unsupportedStructuralField: true } as NoticePageRoot;
        else root = await save({ schemaVersion: 1, minWriterVersion: 1, kind: 'index',
          children: [kind === 'child-reference' ? { ...child, unsupportedStructuralField: true } : child],
          ...(kind === 'index' ? { unsupportedStructuralField: true } : {}) }, 1);
      }
      const before = await immutableFiles(directory);
      await expect(index.get(root, 'id')).rejects.toThrow();
      await expect(index.set(root, 'later-id', true)).rejects.toThrow();
      expect(await immutableFiles(directory)).toEqual(before);
      expect(await temps(directory)).toEqual([]);
    });

  it('D1 schema: preserves arbitrary JSON payload fields inside an exact structural envelope', async () => {
    const index = await NoticePageIndex.open(await home());
    const value = { unsupportedStructuralField: true, nested: { futurePayloadField: ['kept', 1, null] } };
    const original = await index.set(undefined, 'id', value);
    const changed = await index.set(original, 'later-id', false);
    expect(await index.get(original, 'id')).toEqual(value);
    expect(await index.get(changed, 'id')).toEqual(value);
    expect(await index.get(changed, 'later-id')).toBe(false);
  });

  it('pages lexically without treating keys as board ordering and refuses malformed limits/keys/JSON', async () => {
    const index = await NoticePageIndex.open(await home());
    let root: NoticePageRoot | undefined;
    for (const name of ['same-hash/id-b', 'same-hash/id-a', 'other/id']) root = await index.set(root, name, { id: name });
    const first = await index.list(root, { limit: 2 });
    const second = await index.list(root, { limit: 2, after: first.nextAfter });
    expect([...first.entries, ...second.entries].map((e) => e.key)).toEqual(['other/id', 'same-hash/id-a', 'same-hash/id-b']);
    await expect(index.list(root, { limit: 257 })).rejects.toThrow('limit');
    await expect(index.get(root, '../\u0000')).rejects.toThrow('key');
    await expect(index.set(root, 'bad-json', Number.NaN)).rejects.toThrow('finite JSON');
    await expect(index.get({ ...root!, digest: '../../outside' }, 'id')).rejects.toThrow('reference');
  });

  it('streams a >64KiB baseline into bounded pages and verifies without collecting all details', async () => {
    const directory = await home();
    let yielded = 0;
    async function* baseline() {
      for (let n = 0; n < 4097; n++) {
        yielded++;
        yield { key: key(n), value: { postId: `${key(n)}-${'x'.repeat(180)}`, excluded: true } };
      }
    }
    const index = await NoticePageIndex.open(directory);
    const root = await index.build(baseline());
    await index.flush();
    expect(yielded).toBe(4097);
    expect(root?.count).toBe(4097);
    expect(root!.depth).toBeGreaterThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(root))).toBeLessThan(512);
    expect(index.cacheStats.leafEntries).toBe(0);
    const verified = await index.verify(root);
    expect(verified.rows).toBe(4097);
    expect(verified.pages).toBeLessThan(100);
    expect(index.cacheStats.peakLeafEntries).toBeLessThanOrEqual(256);
    expect((await fs.readdir(directory)).includes('manifest.json')).toBe(false);
    const cold = await NoticePageIndex.open(directory);
    expect(await cold.get(root, key(4096))).toMatchObject({ excluded: true });
    expect(cold.cacheStats.diskReads).toBeLessThanOrEqual(4);
  }, 30000);

  it('keeps prepared orphan pages inert on producer failure or duplicate baseline IDs', async () => {
    const directory = await home();
    const index = await NoticePageIndex.open(directory);
    const old = await index.set(undefined, 'old-id', { priorBaseline: true });
    await index.flush();
    async function* failed() {
      for (let n = 0; n < 130; n++) yield { key: key(n), value: true };
      throw new Error('synthetic-baseline-source-failure');
    }
    await expect(index.build(failed())).rejects.toThrow('synthetic-baseline');
    await expect(index.build([{ key: 'duplicate', value: true }, { key: 'duplicate', value: false }])).rejects.toThrow('strictly sorted');
    await expect(index.build([{ key: 'z', value: true }, { key: 'a', value: true }])).rejects.toThrow('strictly sorted');
    const reopened = await NoticePageIndex.open(directory);
    expect(await reopened.get(old, 'old-id')).toEqual({ priorBaseline: true });
    expect(await reopened.get(old, key(0))).toBeUndefined();
    expect((await fs.readdir(directory)).includes('manifest.json')).toBe(false);
  });

  it('finds predecessor intervals across leaves without loading the whole index', async () => {
    const index = await NoticePageIndex.open(await home());
    const root = await index.build(Array.from({ length: 200 }, (_, n) => ({ key: key(n * 2), value: n })));
    expect(await index.atOrBefore(root, key(199))).toEqual({ key: key(198), value: 99 });
    expect(await index.atOrBefore(root, key(200))).toEqual({ key: key(200), value: 100 });
    expect(await index.atOrBefore(root, 'a')).toBeUndefined();
    expect(await index.atOrBefore(root, 'z')).toEqual({ key: key(398), value: 199 });
    expect(await index.verify(undefined)).toEqual({ rows: 0, pages: 0 });
    expect(await index.build([])).toBeUndefined();
  });
});
