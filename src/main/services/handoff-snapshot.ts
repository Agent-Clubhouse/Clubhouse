import { execFile } from 'child_process';
import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { devNull } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import picomatch from 'picomatch';
import {
  canonicalHandoffManifest, HANDOFF_TRANSFER_DEFAULTS, isSafeHandoffPath, parseHandoffManifest, validateHandoffBounds,
  type HandoffManifestFile, type HandoffTransferBounds, type HandoffWorktreeManifest,
} from '../../shared/handoff-manifest';
import {
  HANDOFF_SECRET_CONTENT_MAX_BYTES, safeHandoffDiagnosticPath, scanHandoffSecrets, type HandoffSecretFinding,
} from '../../shared/handoff-secrets';
import type { HandoffManifestSummary } from '../../shared/handoffs';

const exec = promisify(execFile);
const CHUNK_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class HandoffSnapshotError extends Error {
  cleanupFailed = false;
  constructor(
    readonly code: 'invalid_repository' | 'unsupported_repository' | 'git_failed' | 'unsafe_entry' | 'source_changed' | 'bounds_exceeded'
      | 'secret_blocked' | 'hash_mismatch' | 'filesystem_failed' | 'invalid_staging',
    readonly file?: string,
    readonly findings?: HandoffSecretFinding[],
  ) {
    super(`Handoff snapshot failed: ${code}${file ? ` (${safeHandoffDiagnosticPath(file)})` : ''}.`);
    this.name = 'HandoffSnapshotError';
    if (file) this.file = safeHandoffDiagnosticPath(file);
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
}

interface SourceFile {
  path: string;
  stat: fs.BigIntStats;
  sha256?: string;
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
async function git(context: SnapshotGit, args: string[], missingAllowed = false): Promise<string | null> {
  try {
    const result = await exec('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
      cwd: context.root, encoding: 'buffer', timeout: 10_000, maxBuffer: 8 * 1024 ** 2, env: context.env,
    });
    return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch (error) {
    if (missingAllowed && error !== null && typeof error === 'object' && 'code' in error && error.code === 1) return null;
    throw new HandoffSnapshotError('git_failed');
  }
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
  await gitControls(context);
  if (await git(context, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], true)) {
    throw new HandoffSnapshotError('unsupported_repository');
  }
  if (paths(await git(context, ['ls-files', '-v', '-z'])).some((entry) => /^[a-zS] /.test(entry))) {
    throw new HandoffSnapshotError('unsupported_repository');
  }
  const top = await git(context, ['rev-parse', '--show-toplevel']);
  if (!top || await fs.promises.realpath(top.trimEnd()) !== context.root) throw new HandoffSnapshotError('invalid_repository');
  if (await git(context, ['ls-files', '--unmerged', '-z'])) throw new HandoffSnapshotError('unsafe_entry');
  const base = (await git(context, ['rev-parse', '--verify', 'HEAD^{commit}']))?.trim();
  const branch = (await git(context, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true))?.trim();
  const remote = (await git(context, ['config', '--get', 'remote.origin.url'], true))?.trim() ?? null;
  if (!base || !branch) throw new HandoffSnapshotError('invalid_repository');
  await gitControls(context);
  return { remote, base, branch };
}

function paths(output: string | null): string[] {
  if (output === null) throw new HandoffSnapshotError('git_failed');
  const entries = output.split('\0');
  if (entries.pop() !== '') throw new HandoffSnapshotError('git_failed');
  return entries.filter(Boolean);
}

async function selection(source: SourceRoot, manifest: HandoffWorktreeManifest, bounds: HandoffTransferBounds, context: SnapshotGit): Promise<{ tracked: Set<string>; all: string[] }> {
  const options = { dot: true, nonegate: true, noext: true, maxLength: 512 };
  const included = picomatch(manifest.include.ignored, options);
  const excluded = picomatch(manifest.exclude, options);
  const tracked = new Set<string>();
  if (manifest.include.tracked_changes) {
    const base = new Map<string, { mode: string; oid: string; size: bigint }>();
    for (const entry of paths(await git(context, ['ls-tree', '-r', '-l', '-z', '--full-tree', manifest.repo.base]))) {
      const match = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)\t(.+)$/.exec(entry);
      if (!match) throw new HandoffSnapshotError('git_failed');
      if (excluded(match[4])) continue;
      if (!['100644', '100755'].includes(match[1])) throw new HandoffSnapshotError('unsupported_repository');
      base.set(match[4], { mode: match[1], oid: match[2], size: BigInt(match[3]) });
    }
    const candidates = new Set([...base.keys(), ...paths(await git(context, ['ls-files', '--cached', '-z']))]);
    let comparedBytes = 0n;
    for (const name of candidates) {
      if (excluded(name)) continue;
      const stat = await sourceStat(source, name, true);
      const original = base.get(name);
      if (!stat) { if (original) tracked.add(name); continue; }
      if (!original || stat.size !== original.size || (stat.mode & 0o100n ? '100755' : '100644') !== original.mode) {
        tracked.add(name);
        continue;
      }
      comparedBytes += stat.size;
      if (stat.size > BigInt(Math.max(HANDOFF_TRANSFER_DEFAULTS.perFileBytes, bounds.perFileBytes))
        || comparedBytes > BigInt(Math.max(HANDOFF_TRANSFER_DEFAULTS.totalBytes, bounds.totalBytes))) {
        throw new HandoffSnapshotError('unsupported_repository');
      }
      const actual = await inspect(source, { path: name, stat }, undefined, original.oid.length === 40 ? 'sha1' : 'sha256');
      if (actual !== original.oid) tracked.add(name);
    }
  }
  const untracked = manifest.include.untracked ? paths(await git(context, ['ls-files', '--others', '--exclude-standard', '-z'])) : [];
  const ignored = manifest.include.ignored.length > 0
    ? paths(await git(context, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) : [];
  const all = [...new Set([...tracked, ...untracked, ...ignored.filter(included)])].filter((file) => !excluded(file)).sort(compare);
  return { tracked, all };
}

function stamp(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Identity checks detect observed swaps; they do not replace descriptor-relative traversal. */
async function sourceStat(source: SourceRoot, relative: string, missingAllowed = false): Promise<fs.BigIntStats | undefined> {
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
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
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

function metadata(manifest: HandoffWorktreeManifest): void {
  for (const value of [
    manifest.repo.remote ?? '', manifest.repo.branch, ...manifest.include.ignored, ...manifest.exclude, ...manifest.deletions,
  ]) block(scanHandoffSecrets('metadata/value.txt', new TextEncoder().encode(value)));
  for (const file of manifest.files) block(scanHandoffSecrets(file.path, new Uint8Array()));
}

async function writeAll(handle: FileHandle, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (!bytesWritten) throw new HandoffSnapshotError('filesystem_failed');
    offset += bytesWritten;
  }
}

async function inspect(root: SourceRoot, source: SourceFile, sink?: (chunk: Uint8Array) => Promise<void>, gitObjectHash?: 'sha1' | 'sha256'): Promise<string> {
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
    const small = !gitObjectHash && size <= HANDOFF_SECRET_CONTENT_MAX_BYTES;
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
    if (!gitObjectHash) block(scanHandoffSecrets(source.path, content));
    const after = await sourceStat(root, source.path);
    if (!after || stamp(after) !== stamp(initial) || stamp(await handle.stat({ bigint: true })) !== stamp(initial)) {
      throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
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

/**
 * Entirely local and unregistered. All name/content/bounds checks precede
 * allocation; exact copied bytes are scanned again before a manifest is ready.
 */
export async function prepareHandoffSnapshot(options: PrepareHandoffSnapshot): Promise<HandoffSnapshot> {
  let allocated: string | undefined;
  try {
    if (!UUID.test(options.handoffId)) throw new HandoffSnapshotError('invalid_staging');
    const bounds = validateHandoffBounds(options.bounds ?? HANDOFF_TRANSFER_DEFAULTS);
    const env = gitEnvironment();
    const sourceRoot = await directory(options.worktreeRoot);
    const root = sourceRoot.root;
    const context: SnapshotGit = { root, env };
    const staging = (await directory(options.stagingRoot)).root;
    if (root === staging || staging.startsWith(`${root}${path.sep}`) || root.startsWith(`${staging}${path.sep}`)) throw new HandoffSnapshotError('invalid_staging');
    const repo = await repository(context);
    let manifest = parseHandoffManifest({
      v: 1, repo, include: { tracked_changes: true, untracked: true, ignored: [], ...options.include },
      exclude: options.exclude ?? ['**/node_modules/**'], files: [], deletions: [], total_bytes: 0, manifest_sha256: '0'.repeat(64),
    }, bounds);
    metadata(manifest);
    const selected = await selection(sourceRoot, manifest, bounds, context);
    if (selected.all.length > bounds.maxFiles) throw new HandoffSnapshotError('bounds_exceeded');
    const sources: SourceFile[] = [];
    let total = 0;
    for (const file of selected.all) {
      const stat = await sourceStat(sourceRoot, file, selected.tracked.has(file));
      if (!stat) { manifest.deletions.push(file); continue; }
      total += Number(stat.size);
      if (stat.size > BigInt(bounds.perFileBytes) || !Number.isSafeInteger(total) || total > bounds.totalBytes) throw new HandoffSnapshotError('bounds_exceeded', safeHandoffDiagnosticPath(file));
      const source: SourceFile = { path: file, stat };
      if (stat.size <= BigInt(HANDOFF_SECRET_CONTENT_MAX_BYTES)) source.sha256 = await inspect(sourceRoot, source);
      else block(scanHandoffSecrets(file));
      sources.push(source);
    }
    manifest = parseHandoffManifest({
      ...manifest, total_bytes: total, files: sources.map((source) => ({
        path: source.path, size: Number(source.stat.size), sha256: source.sha256 ?? '0'.repeat(64),
        mode: source.stat.mode & 0o100n ? '100755' : '100644',
      })),
    }, bounds);
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
        sha256 = await inspect(sourceRoot, source, (chunk) => writeAll(output, chunk));
        if (source.sha256 && source.sha256 !== sha256) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
        await output.sync();
      } finally {
        await output.close();
      }
      files.push({ path: source.path, size: Number(source.stat.size), sha256, mode: source.stat.mode & 0o100n ? '100755' : '100644' });
    }
    for (const source of sources) {
      const current = await sourceStat(sourceRoot, source.path);
      if (!current || stamp(current) !== stamp(source.stat)) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(source.path));
    }
    for (const deleted of manifest.deletions) {
      if (await sourceStat(sourceRoot, deleted, true)) throw new HandoffSnapshotError('source_changed', safeHandoffDiagnosticPath(deleted));
    }
    if (JSON.stringify((await selection(sourceRoot, manifest, bounds, context)).all) !== JSON.stringify(selected.all)) {
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
    await checkDirectories(sourceRoot, [...sourceRoot.directories.keys()]);
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
): Promise<HandoffSnapshot> {
  try {
    const bounds = validateHandoffBounds(limits);
    const manifest = parseHandoffManifest(rawManifest, bounds);
    if (!expected || expected.fileCount !== manifest.files.length + manifest.deletions.length || expected.totalBytes !== manifest.total_bytes
      || expected.sha256 !== manifest.manifest_sha256
      || !timingSafeEqual(Buffer.from(manifest.manifest_sha256, 'hex'), Buffer.from(digest(manifest, bounds), 'hex'))) {
      throw new HandoffSnapshotError('hash_mismatch');
    }
    metadata(manifest);
    const source = await directory(snapshotRoot);
    const root = source.root;
    const filesRoot = await directory(path.join(root, 'files'), source);
    for (const file of manifest.files) {
      const stat = await sourceStat(filesRoot, file.path);
      if (!stat || stat.size !== BigInt(file.size)) throw new HandoffSnapshotError('hash_mismatch', safeHandoffDiagnosticPath(file.path));
      const actual = await inspect(filesRoot, { path: file.path, stat });
      if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(file.sha256, 'hex'))) throw new HandoffSnapshotError('hash_mismatch', safeHandoffDiagnosticPath(file.path));
    }
    await checkDirectories(filesRoot, [...filesRoot.directories.keys()]);
    return { root, manifest };
  } catch (error) {
    throw failure(error);
  }
}
