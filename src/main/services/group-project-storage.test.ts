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
import { _resetAllBoardsForTesting, getBulletinBoard } from './group-project-bulletin';

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
});

afterEach(async () => {
  groupProjectRegistry._resetForTesting();
  _resetAllBoardsForTesting();
  vi.restoreAllMocks();
  await fsp.rm(fixture.home, { recursive: true, force: true });
});

describe('group project durable storage', () => {
  it.each(['registry', 'board'] as const)('atomically replaces the %s, reports failure and preserves a retryable snapshot', async (kind) => {
    const project = await groupProjectRegistry.create('Release');
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
    const project = await groupProjectRegistry.create('Existing');
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
    const project = await groupProjectRegistry.create('Existing');
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
});
