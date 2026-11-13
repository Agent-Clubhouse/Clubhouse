import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { canonicalHandoffManifest, isSafeHandoffPath, parseHandoffManifest, type HandoffTransferBounds } from '../../shared/handoff-manifest';
import { HANDOFF_SECRET_CONTENT_MAX_BYTES, scanHandoffSecrets, safeHandoffDiagnosticPath } from '../../shared/handoff-secrets';
import { HandoffSecretPolicy, isTrustedHandoffSecretPolicy } from './handoff-secret-settings';
import { HandoffSnapshotError, openHandoffRepository, type HandoffSnapshot } from './handoff-snapshot';

export interface HandoffHistoryRepository {
  repo: { base: string };
  read(args: string[]): Promise<Buffer | null>;
  assertCurrent(): Promise<void>;
}
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Every historical pathname is checked: rev-list's first name per object loses rename aliases. */
export async function scanHandoffGitHistory(repository: HandoffHistoryRepository, policy?: HandoffSecretPolicy): Promise<void> {
  if (policy !== undefined && !isTrustedHandoffSecretPolicy(policy)) throw new HandoffSnapshotError('secret_blocked');
  const raw = await repository.read(['log', '-m', '--format=', '--raw', '-z', '--no-renames', '--root', '--no-abbrev', repository.repo.base]);
  if (!raw) throw new HandoffSnapshotError('git_failed');
  let records: string[];
  try { records = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0'); }
  catch { throw new HandoffSnapshotError('unsafe_entry'); /* telemetry-exempt: historical names may contain private material */ }
  const messages = await repository.read(['log', '--format=%B', repository.repo.base]);
  if (!messages) throw new HandoffSnapshotError('git_failed');
  const messageFindings = scanHandoffSecrets('metadata/commit-messages.txt', messages);
  if (messageFindings.length) throw new HandoffSnapshotError('secret_blocked', undefined, messageFindings);
  const blobs = new Map<string, Set<string>>();
  const check = (name: string, bytes?: Uint8Array) => {
    if (!isSafeHandoffPath(name)) throw new HandoffSnapshotError('unsafe_entry');
    const metadataFindings = scanHandoffSecrets('metadata/path.txt', new TextEncoder().encode(name));
    if (metadataFindings.length) throw new HandoffSnapshotError('secret_blocked', undefined, metadataFindings);
    const findings = policy ? policy.scan(name, bytes) : scanHandoffSecrets(name, bytes);
    if (findings.length) throw new HandoffSnapshotError('secret_blocked', undefined, findings);
  };
  for (let index = 0; index < records.length; index++) {
    const header = records[index].trim();
    if (!header) continue;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [AMDT]$/.exec(header);
    if (!match || index + 1 >= records.length) throw new HandoffSnapshotError('unsupported_repository');
    const name = records[++index]; check(name, new Uint8Array());
    if (match[2] === '000000') continue;
    if (!['100644', '100755', '120000'].includes(match[2]) || /^0+$/.test(match[4])) throw new HandoffSnapshotError('unsupported_repository');
    const names = blobs.get(match[4]) ?? new Set<string>(); names.add(name); blobs.set(match[4], names);
  }
  for (const [oid, names] of blobs) {
    const sizeText = (await repository.read(['cat-file', '-s', oid]))?.toString('ascii').trim();
    if (!sizeText || !/^\d+$/.test(sizeText)) throw new HandoffSnapshotError('git_failed');
    const size = BigInt(sizeText);
    const content = size <= BigInt(HANDOFF_SECRET_CONTENT_MAX_BYTES) ? await repository.read(['cat-file', 'blob', oid]) : undefined;
    if (content === null || content !== undefined && BigInt(content.byteLength) !== size) throw new HandoffSnapshotError('git_failed');
    if (content?.subarray(0, 43).toString() === 'version https://git-lfs.github.com/spec/v1\n') throw new HandoffSnapshotError('unsupported_repository');
    for (const name of names) check(name, content);
  }
  policy?.assertCurrent(); await repository.assertCurrent();
}

/** Bound the materialized tree too: a highly compressed bundle must not hide an oversized checkout. */
async function validateExpandedTree(repository: HandoffHistoryRepository, snapshot: HandoffSnapshot, bounds: HandoffTransferBounds): Promise<void> {
  const raw = await repository.read(['ls-tree', '-r', '-l', '-z', '--full-tree', snapshot.manifest.repo.base]);
  if (!raw) throw new HandoffSnapshotError('git_failed');
  const tree = new Map<string, number>();
  let records: string[];
  try { records = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0'); }
  catch { throw new HandoffSnapshotError('unsafe_entry'); /* telemetry-exempt: tree names are never reflected */ }
  if (records.pop() !== '') throw new HandoffSnapshotError('git_failed');
  for (const record of records) {
    const match = /^(?:100644|100755|120000) blob (?:[0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match || !isSafeHandoffPath(match[2])) throw new HandoffSnapshotError('unsupported_repository');
    tree.set(match[2], Number(match[1]));
  }
  for (const name of snapshot.manifest.deletions) tree.delete(name);
  for (const file of snapshot.manifest.files) tree.set(file.path, file.size);
  const files = [...tree].map(([name, size]) => ({ path: safeHandoffDiagnosticPath(name), size }));
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (files.length > bounds.maxFiles || files.some((file) => !Number.isSafeInteger(file.size) || file.size > bounds.perFileBytes) || !Number.isSafeInteger(totalBytes) || totalBytes > bounds.totalBytes) {
    const error = new HandoffSnapshotError('bounds_exceeded');
    error.boundsReport = { totalBytes, fileCount: files.length, bounds, largestFiles: files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, 10) };
    throw error;
  }
}

async function artifactHash(file: string, expectedSize: number): Promise<string> {
  const before = await fs.promises.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expectedSize)) throw new HandoffSnapshotError('unsafe_entry');
  const stamp = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new HandoffSnapshotError('source_changed');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let position = 0;
    while (position < expectedSize) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (!bytesRead) throw new HandoffSnapshotError('source_changed');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before) || stamp(await fs.promises.lstat(file, { bigint: true })) !== stamp(before)) throw new HandoffSnapshotError('source_changed');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** Fallback includes the complete commit ancestry; its actual bytes and history are checked before offering. */
export async function prepareHandoffBundle(options: {
  worktreeRoot: string; snapshot: HandoffSnapshot; bounds: HandoffTransferBounds;
  handoffId: string; secretPolicy?: HandoffSecretPolicy;
}): Promise<HandoffSnapshot> {
  const { snapshot, bounds, secretPolicy } = options;
  const repository = await openHandoffRepository(options.worktreeRoot);
  if (!COMMIT.test(snapshot.manifest.repo.base) || JSON.stringify(repository.repo) !== JSON.stringify(snapshot.manifest.repo) || snapshot.manifest.bundle) throw new HandoffSnapshotError('source_changed');
  await validateExpandedTree(repository, snapshot, bounds);
  await scanHandoffGitHistory(repository, secretPolicy);
  const stageStat = await fs.promises.lstat(snapshot.root, { bigint: true });
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new HandoffSnapshotError('invalid_staging');
  const root = await fs.promises.realpath(snapshot.root);
  if (root === repository.root || root.startsWith(`${repository.root}${path.sep}`) || repository.root.startsWith(`${root}${path.sep}`)) throw new HandoffSnapshotError('invalid_staging');
  const temporary = path.join(root, `bundle-${randomUUID()}`); const destination = path.join(root, 'bundle.bin');
  const metadata = path.join(root, `manifest-${randomUUID()}.json`);
  let published = false;
  try {
    await repository.read(['bundle', 'create', temporary, 'HEAD']);
    const heads = (await repository.read(['bundle', 'list-heads', temporary]))?.toString('ascii').trim();
    if (heads !== `${snapshot.manifest.repo.base} HEAD`) throw new HandoffSnapshotError('source_changed');
    const stat = await fs.promises.lstat(temporary, { bigint: true });
    if (stat.size > BigInt(bounds.perFileBytes) || stat.size + BigInt(snapshot.manifest.total_bytes) > BigInt(bounds.totalBytes)) {
      const error = new HandoffSnapshotError('bounds_exceeded', 'bundle.bin');
      const files = [...snapshot.manifest.files.map((file) => ({ path: safeHandoffDiagnosticPath(file.path), size: file.size })), { path: 'bundle.bin', size: Number(stat.size) }];
      error.boundsReport = { totalBytes: Number(stat.size) + snapshot.manifest.total_bytes, fileCount: files.length + snapshot.manifest.deletions.length, bounds,
        largestFiles: files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, 10) };
      throw error;
    }
    await fs.promises.chmod(temporary, 0o600);
    const size = Number(stat.size); const sha256 = await artifactHash(temporary, size);
    let manifest = parseHandoffManifest({ ...snapshot.manifest, bundle: { size, sha256 }, total_bytes: snapshot.manifest.total_bytes + size }, bounds);
    manifest = { ...manifest, manifest_sha256: createHash('sha256').update(canonicalHandoffManifest(manifest, bounds)).digest('hex') };
    await repository.assertCurrent(); secretPolicy?.assertCurrent();
    const current = await fs.promises.lstat(root, { bigint: true });
    if (!current.isDirectory() || current.dev !== stageStat.dev || current.ino !== stageStat.ino) throw new HandoffSnapshotError('source_changed');
    await secretPolicy?.recordUse(options.handoffId, 'sender');
    // An exclusive hard link cannot replace or follow a planted destination.
    await fs.promises.link(temporary, destination); published = true;
    const output = await fs.promises.open(metadata, 'wx', 0o600);
    try { await output.writeFile(JSON.stringify(manifest)); await output.sync(); } finally { await output.close(); }
    await fs.promises.rename(metadata, path.join(root, 'manifest.json'));
    return { root, manifest };
  } catch (error) {
    if (published) await fs.promises.rm(destination, { force: true });
    if (error instanceof HandoffSnapshotError) throw error;
    throw new HandoffSnapshotError('filesystem_failed', safeHandoffDiagnosticPath('bundle.bin'));
  } finally {
    await fs.promises.rm(temporary, { force: true }); await fs.promises.rm(metadata, { force: true });
  }
}
