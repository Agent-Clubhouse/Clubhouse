import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => fixture.home },
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, access: vi.fn(actual.access), mkdir: vi.fn(actual.mkdir), readFile: vi.fn(actual.readFile) };
});

import { groupProjectRegistry } from './group-project-registry';
import { _resetAllBoardsForTesting, flushAllBulletinBoards, getBulletinBoard } from './group-project-bulletin';
import { createShutdownCoordinator } from '../shutdown-guard';
import { groupProjectHost } from './group-project-host';

const dataDir = () => path.join(fixture.home, '.clubhouse-dev', 'group-projects');
const registryFile = () => path.join(dataDir(), 'registry.json');
const boardFile = (id: string) => path.join(dataDir(), id, 'bulletin.json');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  const cache = path.join(process.cwd(), 'node_modules', '.cache');
  await fsp.mkdir(cache, { recursive: true });
  fixture.home = await fsp.mkdtemp(path.join(cache, 'group-project-storage-'));
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  groupProjectHost._resetForTesting();
});

afterEach(async () => {
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  vi.restoreAllMocks();
  await fsp.rm(fixture.home, { recursive: true, force: true });
});

describe('group project durable storage', () => {
  it('keeps shutdown waiting for a healthy board after another board fails, then reports the failure and permits retry', async () => {
    const failed = getBulletinBoard('gp_failed');
    const healthy = getBulletinBoard('gp_healthy');
    await failed.postMessage('a', 'work', 'Saved failed-board history');
    await healthy.postMessage('b', 'work', 'Saved healthy-board history');
    await flushAllBulletinBoards();
    await failed.postMessage('a', 'work', 'Retry this mutation');
    await healthy.postMessage('b', 'work', 'Drain this mutation');

    const entered = deferred();
    const release = deferred();
    const diskError = new Error('failed-board disk unavailable');
    const rename = fs.promises.rename;
    let rejectRename = true;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === boardFile('gp_failed') && rejectRename) {
        rejectRename = false;
        throw diskError;
      }
      if (to === boardFile('gp_healthy')) {
        entered.resolve();
        await release.promise;
      }
      await rename(from, to);
    });
    const failedFlush = vi.spyOn(failed, 'flush');
    const onCleanupError = vi.fn();
    const restore = vi.fn(async () => {});
    const coordinator = createShutdownCoordinator({
      plan: () => ({
        stop: [],
        persist: [
          { step: 'group_project_flush', label: 'flush group projects', run: () => groupProjectRegistry.flush(), timeoutMs: 5_000 },
          { step: 'bulletin_flush', label: 'flush bulletin boards', run: flushAllBulletinBoards, timeoutMs: 5_000 },
        ],
        restore: [{ step: 'config_restore', label: 'restore agent configs', run: restore, timeoutMs: 5_000 }],
      }),
      onCleanupError,
    });
    let completed = false;
    const shutdown = coordinator.run().then(() => { completed = true; });
    try {
      await entered.promise;
      await expect(failedFlush.mock.results[0].value).rejects.toBe(diskError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(restore).not.toHaveBeenCalled();
      expect(onCleanupError).not.toHaveBeenCalled();
      expect(await fsp.readFile(boardFile('gp_healthy'), 'utf-8')).not.toContain('Drain this mutation');
    } finally {
      release.resolve();
      await shutdown;
    }

    expect(await fsp.readFile(boardFile('gp_healthy'), 'utf-8')).toContain('Drain this mutation');
    expect(onCleanupError).toHaveBeenCalledExactlyOnceWith('flush bulletin boards', diskError);
    expect(restore).toHaveBeenCalledOnce();
    expect(await fsp.readFile(boardFile('gp_failed'), 'utf-8')).not.toContain('Retry this mutation');
    await flushAllBulletinBoards();
    expect(await fsp.readFile(boardFile('gp_failed'), 'utf-8')).toContain('Retry this mutation');
  });

  it('reports all failed board writes and keeps each mutation retryable', async () => {
    const first = getBulletinBoard('gp_first');
    const second = getBulletinBoard('gp_second');
    await first.postMessage('a', 'work', 'First mutation');
    await second.postMessage('b', 'work', 'Second mutation');
    const firstError = new Error('first disk failure');
    const secondError = new Error('second disk failure');
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (_from, to) => {
      throw to === boardFile('gp_first') ? firstError : secondError;
    });
    const firstFlush = vi.spyOn(first, 'flush');
    const secondFlush = vi.spyOn(second, 'flush');

    const flush = flushAllBulletinBoards();
    try {
      await expect(flush).rejects.toBeInstanceOf(Error);
      await expect(flush).rejects.toMatchObject({
        errors: [firstError, secondError],
        message: expect.stringContaining(firstError.message),
      });
      await expect(flush).rejects.toThrow(secondError.message);
    } finally {
      await Promise.allSettled([firstFlush.mock.results[0].value, secondFlush.mock.results[0].value]);
      rename.mockRestore();
    }

    await flushAllBulletinBoards();
    expect(await fsp.readFile(boardFile('gp_first'), 'utf-8')).toContain('First mutation');
    expect(await fsp.readFile(boardFile('gp_second'), 'utf-8')).toContain('Second mutation');
  });

  it.each(['registry', 'board'] as const)('atomically replaces the %s, reports failure and preserves a retryable snapshot', async (kind) => {
    const project = await groupProjectHost.create('Release');
    const board = getBulletinBoard(project.id);
    await groupProjectRegistry.flush();
    await board.flush();
    const file = kind === 'registry' ? registryFile() : boardFile(project.id);
    const before = await fsp.readFile(file, 'utf-8');
    if (kind === 'registry') {
      await groupProjectRegistry.update(project.id, { instructions: 'Keep history' });
    } else {
      await board.postMessage('a', 'release', 'Keep history');
    }

    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
    const flush = () => kind === 'registry' ? groupProjectRegistry.flush() : board.flush();
    await expect(flush()).rejects.toThrow('disk unavailable');
    expect(await fsp.readFile(file, 'utf-8')).toBe(before);
    expect((await fsp.readdir(path.dirname(file))).some(name => name.includes('.tmp-'))).toBe(false);
    expect(rename).toHaveBeenCalledTimes(1);

    await flush();
    expect(rename).toHaveBeenCalledTimes(2);
    expect(await fsp.readFile(file, 'utf-8')).toContain('Keep history');
  });

  it.each(['registry', 'board'] as const)('persists mutations made during an in-flight %s flush', async (kind) => {
    const project = await groupProjectRegistry.create('First');
    const board = getBulletinBoard(project.id);
    await groupProjectRegistry.flush();
    await board.flush();
    if (kind === 'registry') {
      await groupProjectRegistry.update(project.id, { name: 'Updated' });
    } else {
      await board.postMessage('a', 'first', 'Updated');
    }

    const entered = deferred();
    const release = deferred();
    const mkdir = fsp.mkdir;
    vi.mocked(fsp.mkdir).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return mkdir(...args);
    });
    const firstFlush = kind === 'registry' ? groupProjectRegistry.flush() : board.flush();
    await entered.promise;
    const waitingFlush = kind === 'registry' ? groupProjectRegistry.flush() : board.flush();
    try {
      if (kind === 'registry') {
        await groupProjectRegistry.create('Created during flush');
      } else {
        await board.postMessage('b', 'second', 'Created during flush');
      }
    } finally {
      release.resolve();
    }
    await Promise.all([firstFlush, waitingFlush]);

    const file = kind === 'registry' ? registryFile() : boardFile(project.id);
    expect(await fsp.readFile(file, 'utf-8')).toContain('Created during flush');
  });

  it('loads the registry only once for concurrent first readers', async () => {
    await groupProjectRegistry.create('Existing');
    await groupProjectRegistry.flush();
    groupProjectRegistry._resetForTesting();
    const reads = vi.mocked(fsp.readFile);
    reads.mockClear();

    const lists = await Promise.all([
      groupProjectRegistry.list(), groupProjectRegistry.list(), groupProjectRegistry.list(),
    ]);

    expect(lists.map(list => list.map(project => project.name))).toEqual([
      ['Existing'], ['Existing'], ['Existing'],
    ]);
    expect(reads.mock.calls.filter(([file]) => file === registryFile())).toHaveLength(1);
  });

  it.each(['registry', 'board'] as const)('refuses to overwrite a corrupt %s', async (kind) => {
    const project = await groupProjectHost.create('Existing');
    const board = getBulletinBoard(project.id);
    await groupProjectRegistry.flush();
    await board.flush();
    const file = kind === 'registry' ? registryFile() : boardFile(project.id);
    await fsp.writeFile(file, '{corrupt', 'utf-8');
    if (kind === 'registry') groupProjectRegistry._resetForTesting();
    else board._resetForTesting();

    const mutate = () => kind === 'registry'
      ? groupProjectRegistry.create('Must not replace history')
      : board.postMessage('a', 'release', 'Must not replace history');
    await expect(mutate()).rejects.toThrow();
    await expect(mutate()).rejects.toThrow();
    expect(await fsp.readFile(file, 'utf-8')).toBe('{corrupt');
  });

  it.each(['registry', 'board'] as const)('does not treat an inaccessible %s as a missing file', async (kind) => {
    vi.mocked(fsp.access).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const mutate = () => kind === 'registry'
      ? groupProjectRegistry.create('Must not replace history')
      : getBulletinBoard('gp_inaccessible').postMessage('a', 'release', 'Must not replace history');
    await expect(mutate()).rejects.toThrow('permission denied');
  });

  it('does not keep partially decoded topics after a failed load is repaired', async () => {
    const project = await groupProjectHost.create('Existing');
    const board = getBulletinBoard(project.id);
    await board.flush();
    board._resetForTesting();
    const file = boardFile(project.id);
    await fsp.writeFile(file, JSON.stringify({
      topics: {
        partial: [{ id: 'old', sender: 'a', topic: 'partial', body: 'Unverified', timestamp: new Date().toISOString() }],
        broken: null,
      },
    }));
    await expect(board.getDigest()).rejects.toThrow();
    await fsp.writeFile(file, JSON.stringify({ topics: {} }));

    await board.postMessage('a', 'repaired', 'Verified');
    await board.flush();

    expect((await board.getDigest()).map(topic => topic.topic)).toEqual(['repaired']);
    expect(await fsp.readFile(file, 'utf-8')).not.toContain('Unverified');
  });

  it('preserves history and applies protection changes made before the first board read', async () => {
    const project = await groupProjectHost.create('Existing');
    const board = getBulletinBoard(project.id);
    await board.flush();
    const before = await board.getAllMessages();
    board._resetForTesting();

    board.setTopicProtected('general', false);
    board.setTopicProtected('new-topic', true);
    await board.flush();
    board._resetForTesting();

    expect(await board.getAllMessages()).toEqual(before);
    expect(board.isTopicProtected('general')).toBe(false);
    expect(board.isTopicProtected('control')).toBe(true);
    expect(board.isTopicProtected('new-topic')).toBe(true);
  });
});
