import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { skipFsync, skipFsyncInThisFile } from './skip-fsync';

const syncOfHandles = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skip-fsync-test-'));
  const handle = await fs.open(path.join(directory, 'file'), 'w');
  const prototype = Object.getPrototypeOf(handle) as { sync: unknown };
  await handle.close();
  await fs.rm(directory, { recursive: true, force: true });
  return prototype.sync;
};
let real: unknown;
beforeAll(async () => { real = await syncOfHandles(); });

describe('skip-fsync', () => {
  it('counts the syncs it skips and puts the real one back, even when the test body throws', async () => {
    const fsync = await skipFsync();
    try {
      expect(await syncOfHandles()).not.toBe(real);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skip-fsync-test-'));
      const handle = await fs.open(path.join(directory, 'file'), 'w');
      await handle.sync(); await handle.close();
      await fs.rm(directory, { recursive: true, force: true });
      expect(fsync.skipped).toBe(1);
      throw new Error('a failing test body');
    } catch (error) {
      expect((error as Error).message).toBe('a failing test body');
    } finally { fsync.restore(); }
    expect(await syncOfHandles()).toBe(real);
  });

  describe('for a whole file', () => {
    skipFsyncInThisFile();
    // The vitest config restores mocks before each test, so the stub must be (re)installed per test.
    it('is in force in the first test', async () => { expect(await syncOfHandles()).not.toBe(real); });
    it('and again in the second', async () => { expect(await syncOfHandles()).not.toBe(real); });
  });

  it('is gone after the file-level hook has run', async () => { expect(await syncOfHandles()).toBe(real); });
});
