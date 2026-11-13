import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { isSafeHandoffPath, summarizeHandoffManifest, type HandoffTransferBounds } from '../../shared/handoff-manifest';
import { handoffLinkTarget, assertInternalHandoffLinks } from '../../shared/handoff-links';
import { safeHandoffDiagnosticPath } from '../../shared/handoff-secrets';
import type { HandoffApplyCheckpoint } from '../../shared/handoffs';
import type { HandoffSecretPolicy } from './handoff-secret-settings';
import { openHandoffRepository, openHandoffSnapshotArtifact, verifyHandoffSnapshot, HandoffSnapshotError, type HandoffSnapshot } from './handoff-snapshot';
interface Entry { name: string; mode: '100644' | '100755' | '120000'; size: number; oid?: string; file?: number; target?: string; sha256?: string }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode].join(':');

export function handoffApplyPaths(projectRoot: string, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new HandoffSnapshotError('invalid_staging');
  const parent = path.join(projectRoot, '.clubhouse', 'handoffs');
  return { parent, pending: path.join(parent, `pending-${id}`), worktree: path.join(parent, id), branch: `handoff/${id.slice(0, 12)}` };
}

/** Builds a complete portable tree before worktree allocation; overlays cannot hide unsafe base links. */
async function plannedTree(repository: Awaited<ReturnType<typeof openHandoffRepository>>, options: ApplyHandoffSnapshotOptions): Promise<Entry[]> {
  const { snapshot, bounds } = options;
  const output = await repository.read(['ls-tree', '-r', '-l', '-z', '--full-tree', snapshot.manifest.repo.base]);
  if (!output) throw new HandoffSnapshotError('git_failed');
  let records: string[];
  try { records = new TextDecoder('utf-8', { fatal: true }).decode(output).split('\0'); }
  catch { throw new HandoffSnapshotError('unsafe_entry'); /* telemetry-exempt: untrusted tree names are never reflected */ }
  if (records.pop() !== '') throw new HandoffSnapshotError('git_failed');
  const tree = new Map<string, Entry>();
  for (const value of records) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)\t([\s\S]+)$/.exec(value);
    if (!match || !isSafeHandoffPath(match[4])) throw new HandoffSnapshotError('unsafe_entry');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > bounds.perFileBytes) throw new HandoffSnapshotError('bounds_exceeded');
    tree.set(match[4], { name: match[4], mode: match[1] as Entry['mode'], oid: match[2], size });
  }
  for (const deleted of snapshot.manifest.deletions) tree.delete(deleted);
  snapshot.manifest.files.forEach((file, index) => tree.set(file.path, { name: file.path, mode: file.mode, size: file.size, file: index, sha256: file.sha256 }));
  const entries = [...tree.values()].sort((a, b) => compare(a.name, b.name));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (entries.length > bounds.maxFiles || !Number.isSafeInteger(totalBytes) || totalBytes > bounds.totalBytes) {
    const error = new HandoffSnapshotError('bounds_exceeded');
    error.boundsReport = { totalBytes, fileCount: entries.length, bounds,
      largestFiles: [...entries].sort((a, b) => b.size - a.size || compare(a.name, b.name)).slice(0, 10).map((entry) => ({ path: safeHandoffDiagnosticPath(entry.name), size: entry.size })) };
    throw error;
  }
  const leaves = new Set(entries.map((entry) => entry.name.normalize('NFC').toLowerCase()));
  if (leaves.size !== entries.length) throw new HandoffSnapshotError('unsafe_entry');
  const spelling = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/'); const key = prefix.normalize('NFC').toLowerCase();
      if (spelling.has(key) && spelling.get(key) !== prefix || count < parts.length && leaves.has(key)) throw new HandoffSnapshotError('unsafe_entry');
      spelling.set(key, prefix);
    }
    if (entry.mode === '120000') {
      if (!entry.size || entry.size > 4096) throw new HandoffSnapshotError('unsafe_entry');
      if (entry.oid) entry.target = handoffLinkTarget((await repository.read(['cat-file', 'blob', entry.oid]))!);
      else {
        const artifact = await openHandoffSnapshotArtifact({ snapshot, file: entry.file!, bounds, policy: options.secretPolicy, handoffId: options.id, side: 'receiver', authorize: options.authorize });
        try { entry.target = handoffLinkTarget(await artifact.read(0)); } finally { await artifact.close(); }
      }
    }
  }
  try { assertInternalHandoffLinks(new Map(entries.filter((entry) => entry.mode === '120000').map((entry) => [entry.name, entry.target!]))); }
  catch { throw new HandoffSnapshotError('unsafe_entry'); /* telemetry-exempt: unsafe link payloads are never reflected */ }
  return entries;
}
/** Verify destination bytes and the exact allocated tree before publishing it. */
async function verifyAppliedEntries(root: string, entries: Entry[], check: () => Promise<void>): Promise<void> {
  const files = new Map(entries.map((entry) => [entry.name, entry]));
  const directories = new Set<string>();
  for (const entry of entries) {
    const parts = entry.name.split('/'); parts.pop();
    while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
  }
  const walk = async (relative: string): Promise<void> => {
    await check();
    for (const child of await fs.promises.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${child.name}` : child.name;
      if (name === '.git') {
        if (!child.isFile() || child.isSymbolicLink()) throw new HandoffSnapshotError('unsafe_entry');
        continue;
      }
      if (directories.has(name)) {
        if (!child.isDirectory() || child.isSymbolicLink()) throw new HandoffSnapshotError('unsafe_entry');
        await walk(name); continue;
      }
      const entry = files.get(name);
      if (!entry) throw new HandoffSnapshotError('unsafe_entry');
      const file = path.join(root, name); const before = await fs.promises.lstat(file, { bigint: true });
      const stamp = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      if (entry.mode === '120000') {
        if (!before.isSymbolicLink() || await fs.promises.readlink(file) !== entry.target) throw new HandoffSnapshotError('unsafe_entry');
      } else {
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(entry.size)
          || process.platform !== 'win32' && Boolean(before.mode & 0o100n) !== (entry.mode === '100755')) throw new HandoffSnapshotError('hash_mismatch');
        const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        try {
          if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new HandoffSnapshotError('source_changed');
          const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let offset = 0;
          while (offset < entry.size) {
            await check(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, entry.size - offset), offset);
            if (!bytesRead) throw new HandoffSnapshotError('source_changed'); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
          }
          if (hash.digest('hex') !== entry.sha256 || stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new HandoffSnapshotError('hash_mismatch');
        } finally { await handle.close(); }
      }
      if (stamp(await fs.promises.lstat(file, { bigint: true })) !== stamp(before)) throw new HandoffSnapshotError('source_changed');
      files.delete(name);
    }
  };
  await walk(''); if (files.size) throw new HandoffSnapshotError('hash_mismatch');
}

export interface ApplyHandoffSnapshotOptions {
  id: string; projectId: string; projectRoot: string; snapshot: HandoffSnapshot; bounds: HandoffTransferBounds;
  secretPolicy?: HandoffSecretPolicy;
  authorize(): Promise<void>;
  checkpoint(value: HandoffApplyCheckpoint): Promise<void>;
}

/** Always stages a new branch/worktree, then moves it into its final registered-project location. */
export async function applyHandoffSnapshot(options: ApplyHandoffSnapshotOptions) {
  const bounds = options.bounds;
  await options.authorize();
  const snapshot = await verifyHandoffSnapshot(options.snapshot.root, options.snapshot.manifest, summarizeHandoffManifest(options.snapshot.manifest), bounds,
    options.secretPolicy ? { policy: options.secretPolicy, handoffId: options.id } : undefined);
  options = { ...options, snapshot };
  const repository = await openHandoffRepository(options.projectRoot, { mutableWorktree: true });
  const entries = await plannedTree(repository, options);
  const paths = handoffApplyPaths(repository.root, options.id);
  const pinned = new Map<string, string>();
  const checkOwnership = async () => {
    for (const [name, expected] of pinned) {
      const current = await fs.promises.lstat(name, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== expected) throw new HandoffSnapshotError('source_changed');
    }
  };
  const check = async () => { await options.authorize(); options.secretPolicy?.assertCurrent(); await checkOwnership(); };
  const directory = async (name: string, create: boolean) => {
    await check();
    if (create) {
      try { await fs.promises.mkdir(name, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = await fs.promises.lstat(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !path.isAbsolute(name) || path.relative(name, await fs.promises.realpath(name)) !== '') throw new HandoffSnapshotError('unsafe_entry');
    pinned.set(name, identity(stat)); await check();
  };
  await directory(repository.root, false);
  await directory(path.join(repository.root, '.clubhouse'), true); await directory(paths.parent, true);
  for (const name of [paths.pending, paths.worktree]) {
    try { await fs.promises.lstat(name); throw new HandoffSnapshotError('invalid_staging'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const hooks = path.join(snapshot.root, `empty-hooks-${randomUUID()}`); await fs.promises.mkdir(hooks, { mode: 0o700 });
  const flags = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false'];
  let created = false; let moved = false;
  try {
    await options.checkpoint({ projectId: options.projectId, worktree: paths.worktree, branch: paths.branch, stagingId: options.id });
    await check(); await repository.assertCurrent();
    await repository.read([...flags, 'worktree', 'add', '--no-checkout', '-b', paths.branch, '--', paths.pending, snapshot.manifest.repo.base]); created = true;
    await directory(paths.pending, false);
    await repository.read([...flags, '-C', paths.pending, 'read-tree', '--reset', snapshot.manifest.repo.base]);
    const stagedRepository = await openHandoffRepository(paths.pending, { mutableWorktree: true });
    for (const entry of entries.filter((entry) => entry.mode !== '120000')) {
      let parent = paths.pending;
      for (const part of entry.name.split('/').slice(0, -1)) { parent = path.join(parent, part); await directory(parent, true); }
      await check();
      const output = await fs.promises.open(path.join(paths.pending, entry.name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const contentHash = createHash('sha256');
        const write = async (bytes: Buffer) => {
          contentHash.update(bytes);
          await check(); let position = 0;
          while (position < bytes.length) { const { bytesWritten } = await output.write(bytes, position, bytes.length - position); if (!bytesWritten) throw new HandoffSnapshotError('filesystem_failed'); position += bytesWritten; }
        };
        if (entry.oid) await repository.streamBlob(entry.oid, entry.size, write, options.authorize);
        else {
          const artifact = await openHandoffSnapshotArtifact({ snapshot, file: entry.file!, bounds, policy: options.secretPolicy, handoffId: options.id, side: 'receiver', authorize: options.authorize });
          try { for (let offset = 0; offset < entry.size; offset += 256 * 1024) await write(await artifact.read(offset)); }
          finally { await artifact.close(); }
        }
        const writtenHash = contentHash.digest('hex');
        if (entry.sha256 && entry.sha256 !== writtenHash) throw new HandoffSnapshotError('hash_mismatch');
        entry.sha256 = writtenHash;
        await output.chmod(entry.mode === '100755' ? 0o755 : 0o644); await output.sync();
      } finally { await output.close(); }
    }
    // Links are leaves and are created last, after the complete combined graph was validated.
    for (const entry of entries.filter((entry) => entry.mode === '120000')) {
      let parent = paths.pending;
      for (const part of entry.name.split('/').slice(0, -1)) { parent = path.join(parent, part); await directory(parent, true); }
      await check(); await fs.promises.symlink(entry.target!, path.join(paths.pending, entry.name));
    }
    await verifyAppliedEntries(paths.pending, entries, check);
    await check(); await stagedRepository.assertCurrent(); await repository.assertCurrent();
    await repository.read([...flags, 'worktree', 'move', '--', paths.pending, paths.worktree]); moved = true;
    pinned.delete(paths.pending);
    for (const name of [...pinned.keys()]) if (name.startsWith(`${paths.pending}${path.sep}`)) pinned.delete(name);
    await directory(paths.worktree, false); await check();
    return { worktree: paths.worktree, branch: paths.branch, commit: snapshot.manifest.repo.base };
  } catch (error) {
    // Only this invocation's freshly allocated worktree can be removed; pre-existing paths never enter this branch.
    if (created) {
      try {
        for (const name of [...pinned.keys()]) if (name === paths.pending || name.startsWith(`${paths.pending}${path.sep}`) || name === paths.worktree || name.startsWith(`${paths.worktree}${path.sep}`)) pinned.delete(name);
        await checkOwnership(); await repository.read([...flags, 'worktree', 'remove', '--force', '--', moved ? paths.worktree : paths.pending]);
        await repository.read([...flags, 'branch', '-D', '--', paths.branch]);
      } catch { if (error instanceof HandoffSnapshotError) error.cleanupFailed = true; /* telemetry-exempt: failure remains explicit if owned worktree cleanup is incomplete */ }
    }
    throw error;
  } finally { await fs.promises.rm(hooks, { recursive: true, force: true }); }
}

/** Recovery may remove only an unpublished worktree proven to belong to this checkpoint.
 * A fully moved tree is preserved: its agent may already have received the mission before the crash. */
export async function recoverPendingHandoffApply(projectRoot: string, id: string, checkpoint: HandoffApplyCheckpoint): Promise<'none' | 'removed' | 'published'> {
  const repository = await openHandoffRepository(projectRoot, { mutableWorktree: true });
  const paths = handoffApplyPaths(repository.root, id);
  if (checkpoint.stagingId !== id || !path.isAbsolute(checkpoint.worktree) || path.relative(paths.worktree, checkpoint.worktree) !== '' || checkpoint.branch !== paths.branch) throw new HandoffSnapshotError('invalid_staging');
  const directory = async (name: string) => {
    const stat = await fs.promises.lstat(name);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !path.isAbsolute(name) || path.relative(name, await fs.promises.realpath(name)) !== '') throw new HandoffSnapshotError('unsafe_entry');
  };
  try { await fs.promises.lstat(paths.worktree); await directory(paths.worktree); return 'published'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await fs.promises.lstat(paths.pending); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'; throw error; }
  await directory(path.join(repository.root, '.clubhouse')); await directory(paths.parent); await directory(paths.pending);
  const listed = (await repository.read(['worktree', 'list', '--porcelain', '-z']))?.toString('utf8').split('\0\0') ?? [];
  const own = listed.some((entry) => {
    const fields = entry.split('\0');
    const worktree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    return !!worktree && path.isAbsolute(worktree) && path.relative(paths.pending, worktree) === ''
      && fields.includes(`branch refs/heads/${paths.branch}`);
  });
  if (!own) throw new HandoffSnapshotError('invalid_staging');
  const hooks = path.join(paths.parent, `recovery-hooks-${randomUUID()}`); await fs.promises.mkdir(hooks, { mode: 0o700 });
  const flags = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false'];
  try {
    await repository.assertCurrent(); await directory(paths.parent); await directory(paths.pending);
    await repository.read([...flags, 'worktree', 'remove', '--force', '--', paths.pending]);
    await repository.read([...flags, 'branch', '-D', '--', paths.branch]);
    return 'removed';
  } finally { await fs.promises.rm(hooks, { recursive: true, force: true }); }
}
