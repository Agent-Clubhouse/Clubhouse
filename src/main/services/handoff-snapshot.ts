import { execFile, spawn } from 'child_process';
import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { devNull } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import picomatch from 'picomatch';
import {
  canonicalHandoffManifest, summarizeHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, isSafeHandoffPath, parseHandoffManifest, validateHandoffBounds,
  type HandoffManifestFile, type HandoffTransferBounds, type HandoffWorktreeManifest,
} from '../../shared/handoff-manifest';
import {
  HANDOFF_SECRET_CONTENT_MAX_BYTES, safeHandoffDiagnosticPath, scanHandoffSecrets, type HandoffSecretFinding,
} from '../../shared/handoff-secrets';
import { assertInternalHandoffLinks, handoffLinkTarget } from '../../shared/handoff-links';
import { HandoffSecretPolicy, isTrustedHandoffSecretPolicy } from './handoff-secret-settings';
import type { HandoffManifestSummary } from '../../shared/handoffs';

import { handoffGitPlatformFlags, reportHandoffGitFailure } from './handoff-git-diagnostics';

const exec = promisify(execFile);
const CHUNK_BYTES = 64 * 1024;
const LFS_POINTER_HEADER = Buffer.from('version https://git-lfs.github.com/spec/v1\n');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class HandoffSnapshotError extends Error {
  cleanupFailed = false;
  boundsReport?: { totalBytes: number; fileCount: number; largestFiles: Array<{ path: string; size: number }>; bounds: HandoffTransferBounds };
  constructor(
    readonly code: 'not_a_repository' | 'no_commits' | 'invalid_repository' | 'unsupported_repository' | 'uncommitted_branch' | 'git_failed' | 'unsafe_entry' | 'source_changed' | 'bounds_exceeded'
      | 'secret_blocked' | 'hash_mismatch' | 'filesystem_failed' | 'invalid_staging',
    readonly file?: string,
    readonly findings?: HandoffSecretFinding[],
  ) {
    super(`Handoff snapshot failed: ${code}${file ? ` (${safeHandoffDiagnosticPath(file)})` : ''}.`);
    this.name = 'HandoffSnapshotError';
    if (file) this.file = safeHandoffDiagnosticPath(file);
  }
  get instruction(): string | undefined {
    if (this.code === 'not_a_repository') return 'Code handoffs require a Git worktree with a commit. Initialize Git and create an initial commit, or send the task as a message.';
    if (this.code === 'invalid_repository') return 'Code handoffs need the project registered at the Git repository root and a named branch. Register the repository root as the project and retry.';
    if (this.code === 'no_commits') return 'Create an initial commit in this Git worktree before preparing or offering a code handoff.';
    if (this.code === 'uncommitted_branch') return 'Commit your work or use worktree mode.';
    return undefined;
  }
}

export interface HandoffSnapshot {
  root: string;
  manifest: HandoffWorktreeManifest;
}

export interface PrepareHandoffSnapshot {
  worktreeRoot: string;
  /** Existing app-owned staging directory, never a project path supplied by an agent. */
  stagingRoot: string;
  handoffId: string;
  include?: Partial<HandoffWorktreeManifest['include']>;
  exclude?: string[];
  bounds?: HandoffTransferBounds;
  /** Main-owned project policy, never deserialized from a sender. */
  secretPolicy?: HandoffSecretPolicy;
}

interface SourceFile {
  path: string;
  stat: fs.BigIntStats;
  sha256?: string;
  link?: boolean;
}

interface SourceRoot {
  root: string;
  required: string[];
  directories: Map<string, fs.BigIntStats>;
}

interface SnapshotGit {
  root: string;
  env: NodeJS.ProcessEnv;
  identity?: string;
}

interface GitModeAuthority {
  trustFileMode: boolean;
  trustSymlinks: boolean;
  indexModes: ReadonlyMap<string, string>;
}

function failure(error: unknown): HandoffSnapshotError {
  if (error instanceof Error && error.message === 'Invalid handoff manifest.') return new HandoffSnapshotError('unsafe_entry');
  if (error instanceof Error && error.message === 'Handoff manifest is too large.') return new HandoffSnapshotError('bounds_exceeded');
  return error instanceof HandoffSnapshotError ? error : new HandoffSnapshotError('filesystem_failed');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) && !/^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM)$/i.test(key)) delete env[key];
  }
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull };
}

/** Unlike UI Git helpers, never log Git stderr, URLs, paths or subprocess output. */
async function gitBytes(context: SnapshotGit, args: string[], missingAllowed: boolean | 'repository' = false): Promise<Buffer | null> {
  try {
    const result = await exec('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...handoffGitPlatformFlags(), ...args], {
      cwd: context.root, encoding: 'buffer', timeout: 30_000, maxBuffer: 8 * 1024 ** 2, env: context.env,
    });
    return result.stdout;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      if (missingAllowed === true && error.code === 1) return null;
      // Only classify Git's own no-repository diagnostic; other failures stay git_failed.
      if (missingAllowed === 'repository' && error.code === 128 && 'stderr' in error
        && /fatal: not a git repository\b/.test(String(error.stderr))) return null;
    }
    const reported = new HandoffSnapshotError('git_failed');
    reported.message += reportHandoffGitFailure(args, error);
    throw reported;
  }
}
async function git(context: SnapshotGit, args: string[], missingAllowed: boolean | 'repository' = false): Promise<string | null> {
  const result = await gitBytes(context, args, missingAllowed);
  if (result === null) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(result); }
  catch (error) {
    const reported = new HandoffSnapshotError('git_failed');
    reported.message += reportHandoffGitFailure(args, error);
    throw reported;
  }
}

/** Main-only Git access after the same worktree/control checks as snapshot selection. */
export async function openHandoffRepository(worktreeRoot: string, options: { mutableWorktree?: boolean } = {}) {
  const source = await directory(worktreeRoot);
  const context: SnapshotGit = { root: source.root, env: gitEnvironment() };
  const repo = await repository(context);
  // A newly allocated destination writes files itself; retain inode/mode pins
  // while allowing those intentional directory timestamp changes.
  const checkRoot = async () => {
    if (!options.mutableWorktree) return checkDirectories(source);
    for (const name of source.required) {
      const current = await fs.promises.lstat(name, { bigint: true }); const pinned = source.directories.get(name);
      if (!pinned || !current.isDirectory() || current.isSymbolicLink() || current.dev !== pinned.dev || current.ino !== pinned.ino || current.mode !== pinned.mode) throw new HandoffSnapshotError('source_changed');
    }
  };
  return {
    repo, root: source.root,
    read: (args: string[]) => gitBytes(context, args),
    streamBlob: async (oid: string, size: number, sink: (bytes: Buffer) => Promise<void>, authorize: () => Promise<void>) => {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 ** 3) throw new HandoffSnapshotError('bounds_exceeded');
      await authorize(); await checkRoot();
      const child = spawn('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...handoffGitPlatformFlags(), 'cat-file', 'blob', oid], {
        cwd: context.root, env: context.env, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let timedOut = false;
      const completion = new Promise<void>((resolve, reject) => {
        let settled = false;
        const failed = (error: unknown) => {
          if (settled) return;
          settled = true;
          const reported = new HandoffSnapshotError('git_failed');
          reported.message += reportHandoffGitFailure(['cat-file'], error);
          reject(reported);
        };
        child.once('error', failed);
        child.once('close', (code) => {
          if (code === 0 && !timedOut) { settled = true; resolve(); }
          else failed({ code, killed: timedOut });
        });
      });
      void completion.catch(() => {}); // telemetry-exempt: reported at the bounded stream boundary
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
      const hash = createHash(oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${size}\0`);
      let total = 0;
      try {
        for await (const chunk of child.stdout) {
          const bytes = Buffer.from(chunk); total += bytes.length;
          if (total > size) throw new HandoffSnapshotError('hash_mismatch');
          await authorize(); hash.update(bytes); await sink(bytes);
        }
        await completion; await authorize(); await checkRoot();
        if (total !== size || hash.digest('hex') !== oid) throw new HandoffSnapshotError('hash_mismatch');
      } catch (error) {
        child.kill(); await completion.catch(() => {}); // telemetry-exempt: stream failure below preserves the safe error
        throw failure(error);
      } finally { clearTimeout(timeout); }
    },
    assertCurrent: async () => {
      await checkRoot();
      if (JSON.stringify(await repository(context)) !== JSON.stringify(repo)) throw new HandoffSnapshotError('source_changed');
    },
  };
}

async function gitControls(context: SnapshotGit): Promise<void> {
  const gitDir = (await git(context, ['rev-parse', '--absolute-git-dir']))?.trimEnd();
  const commonDir = (await git(context, ['rev-parse', '--git-common-dir']))?.trimEnd();
  if (!gitDir || !commonDir) throw new HandoffSnapshotError('invalid_repository');
  const directories = [...new Set([gitDir, commonDir].map((name) => path.resolve(context.root, name)))];
  const identities: string[][] = [];
  for (const name of directories) {
    const stat = await fs.promises.lstat(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HandoffSnapshotError('unsupported_repository');
    identities.push([await fs.promises.realpath(name), stat.dev.toString(), stat.ino.toString()]);
    for (const relative of ['info/grafts', 'objects/info/alternates']) {
      try {
        await fs.promises.lstat(path.join(name, relative));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw error;
      }
      throw new HandoffSnapshotError('unsupported_repository');
    }
  }
  const identity = JSON.stringify(identities);
  if (context.identity !== undefined && context.identity !== identity) throw new HandoffSnapshotError('source_changed');
  context.identity = identity;
  if (await git(context, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])) {
    throw new HandoffSnapshotError('unsupported_repository');
  }
}

async function checkDirectories(source: SourceRoot, names = source.required): Promise<void> {
  for (const name of names) {
    const stat = await fs.promises.lstat(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HandoffSnapshotError('unsafe_entry');
    const pinned = source.directories.get(name);
    if (!pinned || stamp(stat) !== stamp(pinned)) throw new HandoffSnapshotError('source_changed');
  }
}

async function directory(root: string, parent?: SourceRoot): Promise<SourceRoot> {
  if (parent) await checkDirectories(parent);
  const stat = await fs.promises.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HandoffSnapshotError('unsafe_entry');
  const canonical = await fs.promises.realpath(root);
  const names = [...new Set([...(parent?.required ?? []), path.resolve(root), canonical])];
  const directories = new Map(parent?.directories);
  for (const name of [path.resolve(root), canonical]) {
    const pinned = directories.get(name);
    if (pinned && stamp(pinned) !== stamp(stat)) throw new HandoffSnapshotError('source_changed');
    directories.set(name, stat);
  }
  const source = { root: canonical, required: names, directories };
  await checkDirectories(source);
  return source;
}

async function repository(context: SnapshotGit): Promise<HandoffWorktreeManifest['repo']> {
  try { await fs.promises.lstat(path.join(context.root, '.git')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const top = await git({ ...context, env: { ...context.env, LC_ALL: 'C', LANGUAGE: 'C' } }, ['rev-parse', '--show-toplevel'], 'repository');
      throw new HandoffSnapshotError(top ? 'invalid_repository' : 'not_a_repository');
    }
    throw error;
  }
  await gitControls(context);
  if (paths(await git(context, ['ls-files', '-v', '-z'])).some((entry) => /^[a-zS] /.test(entry))) {
    throw new HandoffSnapshotError('unsupported_repository');
  }
  const top = await git(context, ['rev-parse', '--show-toplevel']);
  if (!top || await fs.promises.realpath(top.trimEnd()) !== context.root) throw new HandoffSnapshotError('invalid_repository');
  if (await git(context, ['ls-files', '--unmerged', '-z'])) throw new HandoffSnapshotError('unsafe_entry');
  const base = (await git(context, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], true))?.trim();
  if (!base) throw new HandoffSnapshotError('no_commits');
  const branch = (await git(context, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true))?.trim();
  const remote = (await git(context, ['config', '--get', 'remote.origin.url'], true))?.trim() ?? null;
  if (!base || !branch) throw new HandoffSnapshotError('invalid_repository');
  await rejectFilteredPaths(context, [...new Set([
    ...paths(await git(context, ['ls-files', '-z'])),
    ...paths(await git(context, ['ls-tree', '-r', '--name-only', '-z', base])),
  ])]);
  await gitControls(context);
  return { remote, base, branch };
}

/** Attribute queries do not execute clean/process drivers. A configured but unused
 * driver (for example a global Git LFS installation) does not affect raw bytes. */
async function rejectFilteredPaths(context: SnapshotGit, names: string[]): Promise<void> {
  for (let offset = 0; offset < names.length;) {
    const batch: string[] = [];
    let bytes = 0;
    while (offset < names.length && batch.length < 128 && bytes < 16 * 1024) {
      const name = names[offset++];
      batch.push(name);
      bytes += Buffer.byteLength(name) + 1;
    }
    // Inspect both working-tree and indexed attributes: deleting or editing an
    // attributes file must not conceal a filter used by the indexed tree.
    for (const cached of [false, true]) {
      const values = paths(await git(context, ['check-attr', ...(cached ? ['--cached'] : []), '-z', 'filter', '--', ...batch]));
      if (values.length !== batch.length * 3) throw new HandoffSnapshotError('git_failed');
      for (let index = 0; index < batch.length; index++) {
        const [name, attribute, value] = values.slice(index * 3, index * 3 + 3);
        if (name !== batch[index] || attribute !== 'filter') throw new HandoffSnapshotError('git_failed');
        if (value !== 'unspecified' && value !== 'unset') throw new HandoffSnapshotError('unsupported_repository');
      }
    }
  }
}

function paths(output: string | null): string[] {
  if (output === null) throw new HandoffSnapshotError('git_failed');
  const entries = output.split('\0');
  if (entries.pop() !== '') throw new HandoffSnapshotError('git_failed');
  return entries.filter(Boolean);
}

async function gitModeAuthority(context: SnapshotGit): Promise<GitModeAuthority> {
  const configured = await git(context, ['config', '--type=bool', '--get', 'core.filemode'], true);
  const policy = configured === null ? 'true' : configured.trim();
  if (policy !== 'true' && policy !== 'false') throw new HandoffSnapshotError('git_failed');
  const records = (await git(context, ['ls-files', '--stage', '-z']))?.split('\0');
  if (!records || records.pop() !== '') throw new HandoffSnapshotError('git_failed');
  const indexModes = new Map<string, string>();
  for (const record of records) {
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([\s\S]+)$/.exec(record);
    if (!match) throw new HandoffSnapshotError('unsupported_repository');
    const mode = match[1];
    const name = match[3];
    if (/^0+$/.test(match[2]) || indexModes.has(name)) throw new HandoffSnapshotError('unsupported_repository');
    indexModes.set(name, mode);
  }
  const symlinks = (await git(context, ['config', '--type=bool', '--get', 'core.symlinks'], true))?.trim() ?? 'true';
  if (symlinks !== 'true' && symlinks !== 'false') throw new HandoffSnapshotError('git_failed');
  return { trustFileMode: policy === 'true', trustSymlinks: symlinks === 'true', indexModes };
}

function physicalMode(stat: fs.BigIntStats): HandoffManifestFile['mode'] {
  return stat.isSymbolicLink() ? '120000' : stat.mode & 0o100n ? '100755' : '100644';
}

async function selection(
  source: SourceRoot, manifest: HandoffWorktreeManifest, bounds: HandoffTransferBounds, context: SnapshotGit, authority: GitModeAuthority,
): Promise<{ tracked: Set<string>; all: string[]; modes: ReadonlyMap<string, HandoffManifestFile['mode']> }> {
  const options = { dot: true, nonegate: true, noext: true, maxLength: 512 };
  const included = picomatch(manifest.include.ignored, options);
  const excluded = picomatch(manifest.exclude, options);
  const untracked = manifest.include.untracked ? paths(await git(context, ['ls-files', '--others', '--exclude-standard', '-z'])) : [];
  const ignored = manifest.include.ignored.length > 0
    ? paths(await git(context, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) : [];
  const others = new Set([...untracked, ...ignored.filter(included)].filter((name) => !excluded(name)));
  const tracked = new Set<string>();
  const modes = new Map<string, HandoffManifestFile['mode']>();
  for (const [name, mode] of authority.indexModes) {
    if (excluded(name) || (!manifest.include.tracked_changes && !others.has(name))) continue;
    if (!isSafeHandoffPath(name)) throw new HandoffSnapshotError('unsafe_entry');
    if (mode !== '100644' && mode !== '100755' && mode !== '120000') throw new HandoffSnapshotError('unsupported_repository');
    if (mode === '120000' ? !authority.trustSymlinks : !authority.trustFileMode) modes.set(name, mode);
  }
  const base = new Map<string, { mode: HandoffManifestFile['mode']; oid: string; size: bigint }>();
  if (manifest.include.tracked_changes || (!authority.trustFileMode && others.size > 0)) {
    for (const entry of paths(await git(context, ['ls-tree', '-r', '-l', '-z', '--full-tree', manifest.repo.base]))) {
      const match = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)\t(.+)$/.exec(entry);
      if (!match) throw new HandoffSnapshotError('git_failed');
      if (excluded(match[4]) || (!manifest.include.tracked_changes && !others.has(match[4]))) continue;
      const mode = match[1];
      if (mode !== '100644' && mode !== '100755' && mode !== '120000') throw new HandoffSnapshotError('unsupported_repository');
      base.set(match[4], { mode, oid: match[2], size: BigInt(match[3]) });
      if ((mode === '120000' ? !authority.trustSymlinks : !authority.trustFileMode) && !modes.has(match[4])) modes.set(match[4], mode);
    }
  }
  if (manifest.include.tracked_changes) {
    const candidates = new Set([...base.keys(), ...authority.indexModes.keys()]);
    let comparedBytes = 0n;
    for (const name of candidates) {
      if (excluded(name)) continue;
      const stat = await sourceStat(source, name, true, true);
      const original = base.get(name);
      if (stat?.isSymbolicLink()) modes.set(name, '120000');
      if (!stat) { if (original) tracked.add(name); continue; }
      if (!original || stat.size !== original.size || (modes.get(name) ?? physicalMode(stat)) !== original.mode) {
        tracked.add(name);
        continue;
      }
      comparedBytes += stat.size;
      if (stat.size > BigInt(Math.max(HANDOFF_TRANSFER_DEFAULTS.perFileBytes, bounds.perFileBytes))
        || comparedBytes > BigInt(Math.max(HANDOFF_TRANSFER_DEFAULTS.totalBytes, bounds.totalBytes))) {
        throw new HandoffSnapshotError('unsupported_repository');
      }
      const actual = await inspect(source, { path: name, stat, link: (modes.get(name) ?? physicalMode(stat)) === '120000' }, undefined, original.oid.length === 40 ? 'sha1' : 'sha256');
      if (actual !== original.oid) tracked.add(name);
    }
  }
  const all = [...new Set([...tracked, ...others])].sort(compare);
  await rejectFilteredPaths(context, all);
  return { tracked, all, modes };
}

function stamp(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Identity checks detect observed swaps; they do not replace descriptor-relative traversal. */
async function sourceStat(source: SourceRoot, relative: string, missingAllowed = false, allowLink = false): Promise<fs.BigIntStats | undefined> {
  if (!isSafeHandoffPath(relative)) throw new HandoffSnapshotError('unsafe_entry');
  await checkDirectories(source);
  const ancestors = [...source.required];
  let current = source.root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat: fs.BigIntStats;
    try {
      stat = await fs.promises.lstat(current, { bigint: true });
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        await checkDirectories(source, ancestors);
        return undefined;
      }
      throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(relative));
    }
    if (index === parts.length - 1 ? !stat.isFile() && !(allowLink && stat.isSymbolicLink()) : stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HandoffSnapshotError('unsafe_entry', safeHandoffDiagnosticPath(relative));
    }
    if (index === parts.length - 1) {
      await checkDirectories(source, ancestors);
      return stat;
    }
    const pinned = source.directories.get(current);
    if (pinned && stamp(pinned) !== stamp(stat)) throw new HandoffSnapshotError('source_changed', relative);
    source.directories.set(current, stat);
    ancestors.push(current);
  }
  throw new HandoffSnapshotError('unsafe_entry');
}

function block(findings: HandoffSecretFinding[]): void {
  if (findings.length) throw new HandoffSnapshotError('secret_blocked', findings[0].path, findings);
}

function scan(file: string, content?: Uint8Array, policy?: HandoffSecretPolicy): HandoffSecretFinding[] {
  if (policy !== undefined && !isTrustedHandoffSecretPolicy(policy)) throw new HandoffSnapshotError('secret_blocked');
  return policy ? policy.scan(file, content) : scanHandoffSecrets(file, content);
}

function metadata(manifest: HandoffWorktreeManifest, policy?: HandoffSecretPolicy): void {
  for (const value of [
    manifest.repo.remote ?? '', manifest.repo.branch, ...manifest.include.ignored, ...manifest.exclude, ...manifest.deletions,
  ]) block(scanHandoffSecrets('metadata/value.txt', new TextEncoder().encode(value)));
  for (const file of manifest.files) {
    block(scanHandoffSecrets('metadata/path.txt', new TextEncoder().encode(file.path)).map((finding) => ({ ...finding, path: safeHandoffDiagnosticPath(file.path) })));
    block(scan(file.path, new Uint8Array(), policy));
  }
}

async function writeAll(handle: FileHandle, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (!bytesWritten) throw new HandoffSnapshotError('filesystem_failed');
    offset += bytesWritten;
  }
}

async function validateSourceLink(root: SourceRoot, name: string, bytes: Uint8Array): Promise<void> {
  try {
    const target = handoffLinkTarget(bytes);
    assertInternalHandoffLinks(new Map([[name, target]]));
    // Keep .. in filesystem order: normalizing before resolving an existing
    // link can hide an escape. A missing tail is safe only beneath a verified
    // existing ancestor inside this worktree.
    let candidate = `${path.dirname(path.join(root.root, name))}${path.sep}${target.split('/').join(path.sep)}`;
    let resolved: string;
    for (;;) {
      try { resolved = await fs.promises.realpath(candidate); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
    const relative = path.relative(root.root, resolved).split(path.sep).join('/');
    if (relative && !isSafeHandoffPath(relative)) throw new Error('Outside link.');
  } catch { throw new HandoffSnapshotError('unsafe_entry', safeHandoffDiagnosticPath(name)); }
}

async function inspect(root: SourceRoot, source: SourceFile, sink?: (chunk: Uint8Array) => Promise<void>, gitObjectHash?: 'sha1' | 'sha256', policy?: HandoffSecretPolicy, onContent?: (bytes: Uint8Array) => void): Promise<string> {
  if (source.stat.isSymbolicLink()) {
    const before = await sourceStat(root, source.path, false, true);
    if (!before || stamp(before) !== stamp(source.stat)) throw new HandoffSnapshotError('source_changed', source.path);
    const bytes = await fs.promises.readlink(path.join(root.root, source.path), { encoding: 'buffer' });
    await validateSourceLink(root, source.path, bytes);
    const after = await sourceStat(root, source.path, false, true);
    if (!after || stamp(before) !== stamp(after) || BigInt(bytes.byteLength) !== before.size) throw new HandoffSnapshotError('source_changed', source.path);
    if (!gitObjectHash) block(scan(source.path, bytes, policy));
    const hash = createHash(gitObjectHash ?? 'sha256');
    if (gitObjectHash) hash.update(`blob ${bytes.byteLength}\0`);
    hash.update(bytes);
    onContent?.(bytes);
    if (sink) await sink(bytes);
    return hash.digest('hex');
  }
  if (source.link && source.stat.size > 4096n) throw new HandoffSnapshotError('unsafe_entry', source.path);
  const initial = await sourceStat(root, source.path);
  if (!initial || stamp(initial) !== stamp(source.stat)) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
  const handle = await fs.promises.open(path.join(root.root, source.path), fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await sourceStat(root, source.path);
    if (!opened.isFile() || !current || stamp(current) !== stamp(initial) || stamp(opened) !== stamp(initial)) {
      throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
    }
    const size = Number(opened.size);
    const small = size <= HANDOFF_SECRET_CONTENT_MAX_BYTES;
    const content = small ? Buffer.alloc(size) : undefined;
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, size)));
    const hash = createHash(gitObjectHash ?? 'sha256');
    if (gitObjectHash) hash.update(`blob ${size}\0`);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
      const current = await sourceStat(root, source.path);
      if (!current || stamp(current) !== stamp(initial) || stamp(await handle.stat({ bigint: true })) !== stamp(initial)) {
        throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (content) content.set(chunk, position);
      else if (sink) await sink(chunk);
      position += bytesRead;
    }
    if (content?.subarray(0, LFS_POINTER_HEADER.length).equals(LFS_POINTER_HEADER)) {
      throw new HandoffSnapshotError('unsupported_repository');
    }
    if (source.link) await validateSourceLink(root, source.path, content!);
    if (!gitObjectHash) block(scan(source.path, content, policy));
    const after = await sourceStat(root, source.path);
    if (!after || stamp(after) !== stamp(initial) || stamp(await handle.stat({ bigint: true })) !== stamp(initial)) {
      throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
    }
    if (onContent) {
      if (!content) throw new HandoffSnapshotError('unsafe_entry', safeHandoffDiagnosticPath(source.path));
      onContent(content);
    }
    if (content && sink) await sink(content);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function digest(manifest: HandoffWorktreeManifest, bounds: HandoffTransferBounds): string {
  return createHash('sha256').update(canonicalHandoffManifest(manifest, bounds), 'utf8').digest('hex');
}

async function preflight(options: Omit<PrepareHandoffSnapshot, 'stagingRoot' | 'handoffId'>) {
  const bounds = validateHandoffBounds(options.bounds ?? HANDOFF_TRANSFER_DEFAULTS);
  if (options.secretPolicy !== undefined && !isTrustedHandoffSecretPolicy(options.secretPolicy)) throw new HandoffSnapshotError('secret_blocked');
  options.secretPolicy?.assertCurrent();
  const env = gitEnvironment();
  const sourceRoot = await directory(options.worktreeRoot);
  const root = sourceRoot.root;
  const context: SnapshotGit = { root, env };
  const repo = await repository(context);
  const authority = await gitModeAuthority(context);
  let manifest = parseHandoffManifest({
    v: 1, repo, include: { tracked_changes: true, untracked: true, ignored: [], ...options.include },
    exclude: options.exclude ?? ['**/node_modules/**'], files: [], deletions: [], total_bytes: 0, manifest_sha256: '0'.repeat(64),
  }, bounds);
  metadata(manifest, options.secretPolicy);
  const selected = await selection(sourceRoot, manifest, bounds, context, authority);
  const sources: SourceFile[] = [];
  let totalBig = 0n;
  for (const file of selected.all) {
    const stat = await sourceStat(sourceRoot, file, selected.tracked.has(file), true);
    if (!stat) { manifest.deletions.push(file); continue; }
    totalBig += stat.size;
    const source: SourceFile = { path: file, stat, link: (stat.isSymbolicLink() ? '120000' : selected.modes.get(file) ?? physicalMode(stat)) === '120000' };
    if (stat.isSymbolicLink()) (selected.modes as Map<string, HandoffManifestFile['mode']>).set(file, '120000');
    sources.push(source);
  }
  const total = Number(totalBig);
  if (selected.all.length > bounds.maxFiles || totalBig > BigInt(bounds.totalBytes) || sources.some((source) => source.stat.size > BigInt(bounds.perFileBytes))) {
    const largest = [...sources].sort((a, b) => a.stat.size > b.stat.size ? -1 : a.stat.size < b.stat.size ? 1 : compare(a.path, b.path)).slice(0, 10);
    const error = new HandoffSnapshotError('bounds_exceeded', largest[0]?.path);
    error.boundsReport = { totalBytes: Math.min(total, Number.MAX_SAFE_INTEGER), fileCount: selected.all.length, bounds,
      largestFiles: largest.map((source) => ({ path: safeHandoffDiagnosticPath(source.path), size: Math.min(Number(source.stat.size), Number.MAX_SAFE_INTEGER) })) };
    throw error;
  }
  for (const source of sources) {
    if (source.stat.size <= BigInt(HANDOFF_SECRET_CONTENT_MAX_BYTES)) source.sha256 = await inspect(sourceRoot, source, undefined, undefined, options.secretPolicy);
    else block(scan(source.path, undefined, options.secretPolicy));
  }
  manifest = parseHandoffManifest({
    ...manifest, total_bytes: total, files: sources.map((source) => ({
      path: source.path, size: Number(source.stat.size), sha256: source.sha256 ?? '0'.repeat(64),
      mode: selected.modes.get(source.path) ?? physicalMode(source.stat),
    })),
  }, bounds);
  metadata(manifest, options.secretPolicy);
  options.secretPolicy?.assertCurrent();
  return { bounds, sourceRoot, root, context, repo, authority, manifest, selected, sources, total };
}

/** Reads the actual caller's selected files without allocating staging or sending bytes. */
export async function checkHandoffSnapshot(options: Omit<PrepareHandoffSnapshot, 'stagingRoot' | 'handoffId'>) {
  try {
    const { manifest } = await preflight(options);
    return { ready: true as const, files: manifest.files.map(({ path: name, size }) => ({ path: safeHandoffDiagnosticPath(name), size })),
      deletions: manifest.deletions.map(safeHandoffDiagnosticPath), totalBytes: manifest.total_bytes,
      bounds: validateHandoffBounds(options.bounds ?? HANDOFF_TRANSFER_DEFAULTS), allowlistedPaths: options.secretPolicy?.usedPaths() ?? [], findings: [] as HandoffSecretFinding[] };
  } catch (error) {
    const reported = failure(error);
    if (reported.code === 'bounds_exceeded' && reported.boundsReport) return { ready: false as const, reason: 'bounds_exceeded' as const, ...reported.boundsReport, findings: [] as HandoffSecretFinding[], allowlistedPaths: [] as string[] };
    if (reported.code !== 'secret_blocked') throw reported;
    return { ready: false as const, findings: reported.findings ?? [], allowlistedPaths: options.secretPolicy?.usedPaths() ?? [] };
  }
}

/**
 * Private staging preparation. All name/content/bounds checks precede
 * allocation; exact copied bytes are scanned again before a manifest is ready.
 */
export async function prepareHandoffSnapshot(options: PrepareHandoffSnapshot): Promise<HandoffSnapshot> {
  let allocated: string | undefined;
  try {
    if (!UUID.test(options.handoffId)) throw new HandoffSnapshotError('invalid_staging');
    const { bounds, sourceRoot, root, context, repo, authority, selected, sources, total, manifest: initialManifest } = await preflight(options);
    let manifest = initialManifest;
    const staging = (await directory(options.stagingRoot)).root;
    if (root === staging || staging.startsWith(`${root}${path.sep}`) || root.startsWith(`${staging}${path.sep}`)) throw new HandoffSnapshotError('invalid_staging');
    const snapshotRoot = path.join(staging, options.handoffId);
    await fs.promises.mkdir(snapshotRoot, { mode: 0o700 });
    allocated = snapshotRoot;
    await fs.promises.mkdir(path.join(snapshotRoot, 'files'), { mode: 0o700 });
    const files: HandoffManifestFile[] = [];
    for (const source of sources) {
      const destination = path.join(snapshotRoot, 'files', source.path);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const output = await fs.promises.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      let sha256: string;
      try {
        sha256 = await inspect(sourceRoot, source, (chunk) => writeAll(output, chunk), undefined, options.secretPolicy);
        if (source.sha256 && source.sha256 !== sha256) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
        await output.sync();
      } finally {
        await output.close();
      }
      files.push({ path: source.path, size: Number(source.stat.size), sha256, mode: selected.modes.get(source.path) ?? physicalMode(source.stat) });
    }
    for (const source of sources) {
      const current = await sourceStat(sourceRoot, source.path, false, true);
      if (!current || stamp(current) !== stamp(source.stat)) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
    }
    for (const deleted of manifest.deletions) {
      if (await sourceStat(sourceRoot, deleted, true)) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(deleted));
    }
    if (JSON.stringify((await selection(sourceRoot, manifest, bounds, context, authority)).all) !== JSON.stringify(selected.all)) {
      throw new HandoffSnapshotError('source_changed');
    }
    await checkDirectories(sourceRoot, [...sourceRoot.directories.keys()]);
    manifest = parseHandoffManifest({ ...manifest, files, total_bytes: total }, bounds);
    manifest.manifest_sha256 = digest(manifest, bounds);
    const manifestFile = await fs.promises.open(path.join(snapshotRoot, 'manifest.json'), 'wx', 0o600);
    try {
      await manifestFile.writeFile(JSON.stringify(manifest), 'utf8');
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    if (JSON.stringify(await repository(context)) !== JSON.stringify(repo)) throw new HandoffSnapshotError('source_changed');
    const currentAuthority = await gitModeAuthority(context);
    if (currentAuthority.trustSymlinks !== authority.trustSymlinks || currentAuthority.trustFileMode !== authority.trustFileMode || currentAuthority.indexModes.size !== authority.indexModes.size
      || [...authority.indexModes].some(([name, mode]) => currentAuthority.indexModes.get(name) !== mode)) {
      throw new HandoffSnapshotError('source_changed');
    }
    await checkDirectories(sourceRoot, [...sourceRoot.directories.keys()]);
    await options.secretPolicy?.recordUse(options.handoffId, 'sender');
    return { root: snapshotRoot, manifest };
  } catch (error) {
    const reported = failure(error);
    if (allocated) {
      try {
        await fs.promises.rm(allocated, { recursive: true, force: true });
      } catch {
        // telemetry-exempt: surfaced on the explicit failure, never reported as successful cleanup
        reported.cleanupFailed = true;
        reported.message += ' Staging cleanup failed.';
      }
    }
    throw reported;
  }
}

/** Receiver defense in depth, before any apply or wake can be scheduled. */
export async function verifyHandoffSnapshot(
  snapshotRoot: string, rawManifest: unknown, expected: HandoffManifestSummary,
  limits: HandoffTransferBounds = HANDOFF_TRANSFER_DEFAULTS,
  localPolicy?: { policy: HandoffSecretPolicy; handoffId: string; side?: 'sender' | 'receiver' },
): Promise<HandoffSnapshot> {
  try {
    const bounds = validateHandoffBounds(limits);
    const manifest = parseHandoffManifest(rawManifest, bounds);
    if (!expected || expected.fileCount !== summarizeHandoffManifest(manifest).fileCount || expected.totalBytes !== manifest.total_bytes
      || expected.sha256 !== manifest.manifest_sha256
      || !timingSafeEqual(Buffer.from(manifest.manifest_sha256, 'hex'), Buffer.from(digest(manifest, bounds), 'hex'))) {
      throw new HandoffSnapshotError('hash_mismatch');
    }
    if (localPolicy && !isTrustedHandoffSecretPolicy(localPolicy.policy)) throw new HandoffSnapshotError('secret_blocked');
    metadata(manifest, localPolicy?.policy);
    const source = await directory(snapshotRoot);
    const root = source.root;
    if (manifest.bundle) {
      const stat = await sourceStat(source, 'bundle.bin');
      if (!stat || stat.size !== BigInt(manifest.bundle.size)) throw new HandoffSnapshotError('hash_mismatch', 'bundle.bin');
      const actual = await inspect(source, { path: 'bundle.bin', stat });
      if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(manifest.bundle.sha256, 'hex'))) throw new HandoffSnapshotError('hash_mismatch', 'bundle.bin');
    }
    const filesRoot = await directory(path.join(root, 'files'), source);
    const links = new Map<string, string>();
    for (const file of manifest.files) {
      const stat = await sourceStat(filesRoot, file.path);
      if (!stat || stat.size !== BigInt(file.size)) throw new HandoffSnapshotError('hash_mismatch', safeHandoffDiagnosticPath(file.path));
      const actual = await inspect(filesRoot, { path: file.path, stat }, undefined, undefined, localPolicy?.policy,
        file.mode === '120000' ? (bytes) => {
          try { links.set(file.path, handoffLinkTarget(bytes)); }
          catch { throw new HandoffSnapshotError('unsafe_entry', safeHandoffDiagnosticPath(file.path)); }
        } : undefined);
      if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(file.sha256, 'hex'))) throw new HandoffSnapshotError('hash_mismatch', safeHandoffDiagnosticPath(file.path));
    }
    try { assertInternalHandoffLinks(links); } catch { throw new HandoffSnapshotError('unsafe_entry'); }
    await checkDirectories(filesRoot, [...filesRoot.directories.keys()]);
    await localPolicy?.policy.recordUse(localPolicy.handoffId, localPolicy.side ?? 'receiver');
    return { root, manifest };
  } catch (error) {
    throw failure(error);
  }
}

/** A verified, pinned source descriptor: chunks never follow a later path replacement. */
export async function openHandoffSnapshotArtifact(options: {
  snapshot: HandoffSnapshot; file: number; bounds?: HandoffTransferBounds;
  policy?: HandoffSecretPolicy; handoffId: string; side?: 'sender' | 'receiver'; authorize(): Promise<void>;
}) {
  let handle: FileHandle | undefined;
  try {
    await options.authorize();
    const bounds = validateHandoffBounds(options.bounds ?? HANDOFF_TRANSFER_DEFAULTS);
    const manifest = parseHandoffManifest(options.snapshot.manifest, bounds);
    if (manifest.manifest_sha256 !== digest(manifest, bounds)) throw new HandoffSnapshotError('hash_mismatch');
    if (options.policy !== undefined && !isTrustedHandoffSecretPolicy(options.policy)) throw new HandoffSnapshotError('secret_blocked');
    options.policy?.assertCurrent(); metadata(manifest, options.policy);
    if (!Number.isSafeInteger(options.file) || options.file < -1 || options.file >= manifest.files.length) throw new HandoffSnapshotError('unsafe_entry');
    const bundle = options.file === -1;
    const artifact = bundle ? manifest.bundle : manifest.files[options.file];
    if (!artifact) throw new HandoffSnapshotError('unsafe_entry');
    const parent = await directory(options.snapshot.root);
    const root = bundle ? parent : await directory(path.join(parent.root, 'files'), parent);
    const name = bundle ? 'bundle.bin' : manifest.files[options.file].path;
    const stat = await sourceStat(root, name);
    if (!stat || stat.size !== BigInt(artifact.size)) throw new HandoffSnapshotError('hash_mismatch', name);
    const actual = await inspect(root, { path: name, stat }, undefined, undefined, options.policy);
    if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(artifact.sha256, 'hex'))) throw new HandoffSnapshotError('hash_mismatch', name);
    handle = await fs.promises.open(path.join(root.root, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const pinned = handle;
    const check = async () => {
      await options.authorize(); options.policy?.assertCurrent();
      const current = await sourceStat(root, name);
      if (!current || stamp(current) !== stamp(stat) || stamp(await pinned.stat({ bigint: true })) !== stamp(stat)) throw new HandoffSnapshotError('source_changed', name);
    };
    await check(); await options.policy?.recordUse(options.handoffId, options.side ?? 'sender'); await check();
    return {
      size: artifact.size,
      read: async (offset: number, maximum = 256 * 1024): Promise<Buffer> => {
        try {
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.size || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024) throw new HandoffSnapshotError('unsafe_entry');
          await check();
          const bytes = Buffer.alloc(Math.min(maximum, artifact.size - offset));
          let position = 0;
          while (position < bytes.length) {
            const { bytesRead } = await pinned.read(bytes, position, bytes.length - position, offset + position);
            if (!bytesRead) throw new HandoffSnapshotError('source_changed', name);
            position += bytesRead;
          }
          await check(); return bytes;
        } catch (error) { throw failure(error); }
      },
      close: () => pinned.close(),
    };
  } catch (error) {
    await handle?.close(); throw failure(error);
  }
}

/** Read only bounded private metadata, and bind it to the immutable agreement summary. */
export async function readHandoffSnapshotManifest(root: string, expected: HandoffManifestSummary, bounds: HandoffTransferBounds) {
  try {
    const source = await directory(root);
    const stat = await sourceStat(source, 'manifest.json');
    if (!stat || stat.size > 2n * 1024n ** 2n) throw new HandoffSnapshotError('bounds_exceeded');
    const chunks: Buffer[] = [];
    await inspect(source, { path: 'manifest.json', stat }, async (bytes) => { chunks.push(Buffer.from(bytes)); });
    const manifest = parseHandoffManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), bounds);
    const summary = summarizeHandoffManifest(manifest);
    if (summary.fileCount !== expected.fileCount || summary.totalBytes !== expected.totalBytes || summary.sha256 !== expected.sha256 || manifest.manifest_sha256 !== digest(manifest, bounds)) throw new HandoffSnapshotError('hash_mismatch');
    return manifest;
  } catch (error) { throw failure(error); }
}
