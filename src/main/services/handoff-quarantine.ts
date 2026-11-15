import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';

const NAME = /^q-[a-f0-9]{32}$/;
export const HANDOFF_QUARANTINE_MAX_AGE = 24 * 60 * 60 * 1000;
const active = new Set<string>();

/** Stable, user-specific app roots; never put received history directly in a shared temp directory. */
export function handoffQuarantineRoots(): string[] {
  const user = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12);
  return [...new Set([os.tmpdir(), process.env.LOCALAPPDATA].filter((base): base is string => !!base && path.isAbsolute(base)))]
    .map((base) => path.join(base, `ch-q-${user}`));
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

async function assertIdentity(directory: string, before: fs.Stats): Promise<void> {
  const current = await identity(directory);
  if (current.dev !== before.dev || current.ino !== before.ino) throw new Error('Handoff quarantine directory changed.');
}

/** Resolve the existing parent first (e.g. macOS /var), but reject a symlink at the app root. */
async function canonicalRoot(root: string): Promise<string> {
  return path.join(await fs.promises.realpath(path.dirname(root)), path.basename(root));
}

export async function sweepHandoffQuarantines(options: { roots?: string[]; now?: number } = {}): Promise<void> {
  for (const candidate of options.roots ?? handoffQuarantineRoots()) {
    try {
      const root = await canonicalRoot(candidate);
      const owner = await identity(root);
      for (const name of await fs.promises.readdir(root)) {
        if (name.length !== 34 || !NAME.test(name)) continue;
        const directory = path.join(root, name);
        if (active.has(directory)) continue;
        try {
          const stat = await identity(directory);
          if ((options.now ?? Date.now()) - stat.mtimeMs <= HANDOFF_QUARANTINE_MAX_AGE) continue;
          await assertIdentity(root, owner);
          await assertIdentity(directory, stat);
          await fs.promises.rm(directory, { recursive: true, force: true });
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
        try { await fs.promises.mkdir(candidate, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        owner = await identity(candidate);
        root = candidate;
        break;
      } catch { /* telemetry-exempt: an unsafe or unwritable root cannot hold received history */ }
    }
    if (!root || !owner) throw new Error('No safe short handoff quarantine root is available.');
    await sweepHandoffQuarantines({ roots: [root] });
    await assertIdentity(root, owner);
    directory = path.join(root, `q-${randomBytes(16).toString('hex')}`);
  }
  // Exclusive mkdir: never reuse or follow an existing name, even on collision.
  await fs.promises.mkdir(directory, { mode: 0o700 });
  const before = await identity(directory);
  active.add(directory);
  const assertCurrent = async () => {
    if (root && owner) await assertIdentity(root, owner);
    await assertIdentity(directory, before);
  };
  return {
    directory,
    assertCurrent,
    async cleanup() {
      try {
        await assertCurrent();
        await fs.promises.rm(directory, { recursive: true, force: true });
      } finally { active.delete(directory); }
    },
  };
}
