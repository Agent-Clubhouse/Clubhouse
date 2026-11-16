import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { inspectWindowsQuarantineRoot, verifyWindowsQuarantineRoot } from './handoff-quarantine-windows';
import { HandoffSnapshotError } from './handoff-snapshot';
import { reportHandoffGitFailure } from './handoff-git-diagnostics';
import { appLog } from './log-service';

const WINDOWS = process.platform === 'win32';

const NAME = /^q-[a-f0-9]{32}$/;
export const HANDOFF_QUARANTINE_MAX_AGE = 24 * 60 * 60 * 1000;
const active = new Set<string>();

/** Windows temp can be shared or attacker-controlled. Only a profile-local
 * LOCALAPPDATA root is eligible; its SID/DACL and ancestor chain are checked later. */
export function windowsHandoffQuarantineRoots(localAppData: string | undefined, profile: string): string[] {
  const paths = path.win32;
  if (!localAppData || !paths.isAbsolute(localAppData) || !paths.isAbsolute(profile)) return [];
  const relative = paths.relative(profile, localAppData);
  if (!relative || relative === '..' || relative.startsWith('..\\') || paths.isAbsolute(relative)) return [];
  return [paths.join(localAppData, 'ch-q')];
}

export function handoffQuarantineRoots(): string[] {
  if (WINDOWS) return windowsHandoffQuarantineRoots(process.env.LOCALAPPDATA, os.homedir());
  const user = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12);
  return [path.join(os.tmpdir(), `ch-q-${user}`)];
}

function pathTooLong(): Error {
  const error = new HandoffSnapshotError('git_failed');
  error.message += reportHandoffGitFailure(['init'], { code: 'ENAMETOOLONG' });
  return error;
}

// init itself has a MAX_PATH limit, before core.longpaths can help. Reserve
// separator/NUL space as well as keeping explicit Git directory setup bounded.
export function handoffQuarantineFits(directory: string, windows = process.platform === 'win32'): boolean {
  return !windows || path.join(directory, 'repo').length + 2 <= 260;
}

function privateDirectory(stat: fs.Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink()
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}

async function identity(directory: string): Promise<fs.Stats> {
  const stat = await fs.promises.lstat(directory);
  if (!privateDirectory(stat)) throw new Error('Unsafe handoff quarantine directory.');
  return stat;
}

async function assertIdentity(directory: string, before: fs.Stats, requirePrivate = true): Promise<void> {
  const current = requirePrivate ? await identity(directory) : await fs.promises.lstat(directory);
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Unsafe handoff quarantine directory.');
  if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('Handoff quarantine directory changed.');
}

/** Resolve the existing parent first (e.g. macOS /var), but reject a symlink at the app root. */
async function canonicalRoot(root: string): Promise<string> {
  if (WINDOWS) {
    let ancestor = path.dirname(root);
    for (;;) {
      const stat = await fs.promises.lstat(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe quarantine ancestor.');
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return path.join(await fs.promises.realpath(path.dirname(root)), path.basename(root));
}

async function assertRoot(root: string, owner: fs.Stats): Promise<void> {
  await assertIdentity(root, owner);
  if (await fs.promises.realpath(root) !== root) throw new Error('Handoff quarantine root changed.');
}

/** Never recursively rm a path through a potentially replaced ancestor. Recheck
 * every ancestor immediately before each non-following unlink/rmdir operation.
 * Windows additionally relies on the verified owner-only profile-root DACL.
 * Node has no handle-relative unlink/rmdir: a final-syscall race remains for
 * same-user/admin actors with rights to rename those protected ancestors. */
async function removeTree(directory: string, before: fs.Stats, guard: () => Promise<void>): Promise<void> {
  const check = async () => { await guard(); await assertIdentity(directory, before, false); };
  await check();
  for (const name of await fs.promises.readdir(directory)) {
    await check();
    const entry = path.join(directory, name);
    const stat = await fs.promises.lstat(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await removeTree(entry, stat, check);
    } else {
      await check();
      const current = await fs.promises.lstat(entry);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink() !== stat.isSymbolicLink()) throw new Error('Handoff quarantine entry changed.');
      await check();
      await fs.promises.unlink(entry);
    }
  }
  await check();
  await fs.promises.rmdir(directory);
}

export async function sweepHandoffQuarantines(options: { roots?: string[]; now?: number } = {}): Promise<void> {
  for (const candidate of options.roots ?? handoffQuarantineRoots()) {
    try {
      const root = await canonicalRoot(candidate);
      const owner = await identity(root);
      if (WINDOWS) await verifyWindowsQuarantineRoot(root, false);
      for (const name of await fs.promises.readdir(root)) {
        if (name.length !== 34 || !NAME.test(name)) continue;
        const directory = path.join(root, name);
        if (active.has(directory)) continue;
        try {
          const stat = await identity(directory);
          if ((options.now ?? Date.now()) - stat.mtimeMs <= HANDOFF_QUARANTINE_MAX_AGE) continue;
          await removeTree(directory, stat, () => assertRoot(root, owner));
        } catch { /* telemetry-exempt: never follow links or delete entries whose identity/ownership cannot be verified */ }
      }
    } catch { /* telemetry-exempt: absent, inaccessible, or unsafe roots are left untouched and retried on receive/startup */ }
  }
}

type RootStage = 'mkdir' | 'identity' | 'verify' | 'recover' | 'child';
export interface QuarantineRootOptions {
  roots?: string[]; windows?: boolean;
  /** Verifies (and, when `created`, initializes) a root's owner-only ACL. Defaults to the Windows check. */
  verify?: (directory: string, created: boolean) => Promise<void>;
  /** True only if the root is owned by the current user, is no reparse point, and is empty. */
  inspect?: (directory: string) => Promise<boolean>;
  retryDelay?: number;
}
const VERIFY_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class RootFailure extends Error {
  constructor(readonly stage: RootStage, readonly cause: unknown) { super(`Quarantine root ${stage} failed.`); }
}

/** Closed classification only: never log paths or error text. */
function rootFailureClass(failure: RootFailure): string {
  const value = failure.cause && typeof failure.cause === 'object' ? failure.cause as { killed?: unknown; code?: unknown } : {};
  const kind = value.killed === true || value.code === 'ETIMEDOUT' ? 'timeout'
    : value.code === 'EACCES' || value.code === 'EPERM' ? 'permission'
      : value.code === 'EBUSY' ? 'busy' : 'other';
  return `${failure.stage}:${kind}`;
}

/** Remove a root this call created but could not verify, so the next attempt
 * re-initializes it instead of failing on an uninitialized inherited DACL forever.
 * Non-recursive: fails (and leaves it) if anything is inside or identity changed. */
async function removeEmptyRoot(root: string, before: fs.Stats): Promise<boolean> {
  try {
    await assertIdentity(root, before, false);
    if ((await fs.promises.readdir(root)).length) return false;
    await fs.promises.rmdir(root);
    return true;
  } catch { return false; /* telemetry-exempt: an unremovable root stays and fails closed */ }
}

async function prepareRoot(candidate: string, created: boolean, verify: QuarantineRootOptions['verify']): Promise<{ owner: fs.Stats; created: boolean }> {
  let owner: fs.Stats;
  try { owner = await identity(candidate); } catch (error) { throw new RootFailure('identity', error); }
  try { if (verify) await verify(candidate, created); await assertRoot(candidate, owner); }
  catch (error) { throw new RootFailure('verify', error); }
  return { owner, created };
}

async function createRoot(candidate: string): Promise<fs.Stats | undefined> {
  try { await fs.promises.mkdir(candidate, { mode: 0o700 }); return await fs.promises.lstat(candidate); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new RootFailure('mkdir', error); return undefined; }
}

/** Open (creating if needed) one verified private root, then an exclusive child. */
async function openRoot(candidate: string, options: QuarantineRootOptions): Promise<{ owner: fs.Stats; directory: string }> {
  const verify = options.verify ?? (WINDOWS ? verifyWindowsQuarantineRoot : undefined);
  const inspect = options.inspect ?? (WINDOWS ? inspectWindowsQuarantineRoot : undefined);
  const delay = options.retryDelay ?? 250;
  let prepared: { owner: fs.Stats; created: boolean } | undefined;
  let last: RootFailure | undefined; let lastCreated = false;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS && !prepared; attempt++) {
    const fresh = await createRoot(candidate);
    try { prepared = await prepareRoot(candidate, !!fresh, verify); }
    catch (error) { // telemetry-exempt: classified and logged below as a closed failure class
      last = error as RootFailure; lastCreated = !!fresh;
      appLog('core:handoff', 'warn', 'Handoff quarantine root rejected', { meta: { failure: rootFailureClass(last), attempt, created: lastCreated } });
      if (fresh) await removeEmptyRoot(candidate, fresh);
      // An existing root may still be mid-initialization by a concurrent creator.
      else if (attempt < VERIFY_ATTEMPTS && last.stage === 'verify') await sleep(delay * attempt);
      else break;
    }
  }
  if (!prepared) {
    if (!last || last.stage !== 'verify' || lastCreated) throw last ?? new RootFailure('verify', undefined);
    // Recovery for a root left uninitialized by an earlier timed-out create: only
    // when it is provably ours and empty. Removal is non-recursive.
    try {
      const stat = await fs.promises.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !privateDirectory(stat) || await inspect?.(candidate) === false) throw new Error('not recoverable');
      if (!await removeEmptyRoot(candidate, stat)) throw new Error('not removable');
      const fresh = await createRoot(candidate);
      if (!fresh) throw new Error('recreated concurrently');
      try { prepared = await prepareRoot(candidate, true, verify); }
      catch (error) { await removeEmptyRoot(candidate, fresh); throw error; }
    } catch (error) {
      const failure = new RootFailure('recover', error instanceof RootFailure ? error.cause : error);
      appLog('core:handoff', 'warn', 'Handoff quarantine root rejected', { meta: { failure: rootFailureClass(failure), recovery: true } });
      throw failure;
    }
  }
  try {
    // Creating the child is part of the candidate attempt: a private but
    // unwritable root must not prevent trying another usable root.
    const child = path.join(candidate, `q-${randomBytes(16).toString('hex')}`);
    await fs.promises.mkdir(child, { mode: 0o700 });
    return { owner: prepared.owner, directory: child };
  } catch (error) { throw new RootFailure('child', error); }
}

export async function createHandoffQuarantine(staging: string, options: QuarantineRootOptions = {}): Promise<{
  directory: string; assertCurrent(): Promise<void>; cleanup(): Promise<void>;
}> {
  const nested = path.join(staging, `quarantine-${randomUUID()}`);
  let directory = nested;
  let owner: fs.Stats | undefined;
  let root: string | undefined;
  if (!handoffQuarantineFits(nested, options.windows)) {
    const roots: string[] = [];
    for (const candidate of options.roots ?? handoffQuarantineRoots()) {
      try { roots.push(await canonicalRoot(candidate)); }
      catch { /* telemetry-exempt: try another existing short parent */ }
    }
    for (const candidate of [...new Set(roots)].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      if (!handoffQuarantineFits(path.join(candidate, `q-${'0'.repeat(32)}`), true)) continue;
      try {
        const opened = await openRoot(candidate, options);
        owner = opened.owner; root = candidate; directory = opened.directory;
        break;
      } catch (error) { // telemetry-exempt: openRoot logged a closed failure class
        // Identity, verify and recover rejections were logged by openRoot; try another root. Unverified Windows ACLs fail closed.
        if (error instanceof RootFailure && (error.stage === 'mkdir' || error.stage === 'child')) appLog('core:handoff', 'warn', 'Handoff quarantine root rejected', { meta: { failure: rootFailureClass(error) } });
      }
    }
    if (!root || !owner) throw pathTooLong();
  } else {
    // Exclusive mkdir: never reuse or follow an existing name, even on collision.
    await fs.promises.mkdir(directory, { mode: 0o700 });
  }
  const before = await identity(directory);
  active.add(directory);
  if (root) await sweepHandoffQuarantines({ roots: [root] });
  const assertCurrent = async () => {
    if (root && owner) await assertRoot(root, owner);
    await assertIdentity(directory, before);
  };
  return {
    directory,
    assertCurrent,
    async cleanup() {
      try {
        await assertCurrent();
        await removeTree(directory, before, async () => { if (root && owner) await assertRoot(root, owner); });
      } finally { active.delete(directory); }
    },
  };
}
