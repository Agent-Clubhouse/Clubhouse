import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';

/**
 * Make `FileHandle.sync` (the fsync behind every atomic write) a counted no-op.
 *
 * On a hosted Windows runner an fsync costs several milliseconds, and a flow that
 * saves a few parts, or delivers a setup, does dozens of them: 1s locally became
 * 5s and over the default test timeout. Use this only in tests about what is
 * written (content, revisions, ordering, what is left alone), never in a test
 * about durability: that one must keep the real fsync. Writes, renames and reads
 * are unchanged, and the stub is restored when the returned `restore` runs.
 */
export async function skipFsync(): Promise<{ readonly skipped: number; restore(): void }> {
  const probeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'skip-fsync-'));
  const probe = await fs.open(path.join(probeDirectory, 'probe'), 'w');
  const handlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  await fs.rm(probeDirectory, { recursive: true, force: true });
  let skipped = 0;
  const spy: MockInstance = vi.spyOn(handlePrototype, 'sync').mockImplementation(async () => { skipped++; });
  return { get skipped() { return skipped; }, restore: () => spy.mockRestore() };
}

/**
 * `skipFsync` for every test in the calling file. The stub is installed per test
 * (`beforeEach`) and removed after it (`afterEach`), because the vitest config's
 * `restoreMocks` undoes spies before each test, so a stub installed once in
 * `beforeAll` would silently not apply.
 */
export function skipFsyncInThisFile(): void {
  let active: Awaited<ReturnType<typeof skipFsync>> | undefined;
  beforeEach(async () => { active = await skipFsync(); });
  afterEach(() => { active?.restore(); active = undefined; });
}
