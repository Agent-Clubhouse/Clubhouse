import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { verifyWindowsQuarantineRoot } from './handoff-quarantine-windows';
import { HandoffSnapshotError } from './handoff-snapshot';
import { reportHandoffGitFailure } from './handoff-git-diagnostics';

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
 * Windows additionally relies on the verified owner-only profile-root DACL. */
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

export async function createHandoffQuarantine(staging: string, options: { roots?: string[]; windows?: boolean } = {}): Promise<{
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
        let created = false;
        try { await fs.promises.mkdir(candidate, { mode: 0o700 }); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const candidateOwner = await identity(candidate);
        if (WINDOWS) await verifyWindowsQuarantineRoot(candidate, created);
        await assertRoot(candidate, candidateOwner);
        const child = path.join(candidate, `q-${randomBytes(16).toString('hex')}`);
        // Creating the child is part of the candidate attempt: a private but
        // unwritable root must not prevent trying another usable root.
        await fs.promises.mkdir(child, { mode: 0o700 });
        owner = candidateOwner;
        root = candidate;
        directory = child;
        break;
      } catch { /* telemetry-exempt: try another root; unverified Windows ACLs fail closed */ }
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
