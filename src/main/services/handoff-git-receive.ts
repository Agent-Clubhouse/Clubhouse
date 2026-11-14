import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { devNull } from 'os';
import { normalizeGitRemote } from '../../shared/git-remote';
import type { HandoffTransferBounds } from '../../shared/handoff-manifest';
import { summarizeHandoffManifest } from '../../shared/handoff-manifest';
import type { HandoffSecretPolicy } from './handoff-secret-settings';
import { openHandoffRepository, verifyHandoffSnapshot, HandoffSnapshotError, type HandoffSnapshot } from './handoff-snapshot';
import { scanHandoffGitHistory } from './handoff-git-bundle';
import { handoffGitPlatformFlags, reportHandoffGitFailure } from './handoff-git-diagnostics';
const exec = promisify(execFile);

/** Acquires objects only after receiver-side checks. It never checks out or alters an existing branch. */
export async function receiveHandoffCommit(options: {
  projectRoot: string; snapshot: HandoffSnapshot; bounds: HandoffTransferBounds;
  handoffId: string; secretPolicy?: HandoffSecretPolicy; linkedProject?: boolean; authorize(): Promise<void>;
}): Promise<{ commit: string; source: 'existing' | 'remote' | 'bundle' }> {
  const { snapshot, bounds, secretPolicy, handoffId } = options;
  await options.authorize();
  await verifyHandoffSnapshot(snapshot.root, snapshot.manifest, summarizeHandoffManifest(snapshot.manifest), bounds,
    secretPolicy ? { policy: secretPolicy, handoffId } : undefined);
  const repository = await openHandoffRepository(options.projectRoot);
  const sourceKey = normalizeGitRemote(snapshot.manifest.repo.remote);
  const targetKey = normalizeGitRemote(repository.repo.remote);
  const commit = snapshot.manifest.repo.base;
  const hasCommit = async () => {
    try { return (await repository.read(['cat-file', '-t', commit]))?.toString('ascii').trim() === 'commit'; }
    catch { return false; /* telemetry-exempt: a missing object triggers fetch or a verified bundle fallback */ }
  };
  if (!options.linkedProject && (sourceKey ? targetKey !== sourceKey : !await hasCommit())) throw new Error('No matching registered project for this handoff.');
  const before = await fs.promises.lstat(snapshot.root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new HandoffSnapshotError('invalid_staging');
  const root = await fs.promises.realpath(snapshot.root);
  const quarantine = path.join(root, `quarantine-${randomUUID()}`);
  const hooks = path.join(quarantine, 'hooks'); const config = path.join(quarantine, 'empty-config');
  await fs.promises.mkdir(quarantine, { mode: 0o700 }); await fs.promises.mkdir(hooks, { mode: 0o700 }); await fs.promises.writeFile(config, '', { mode: 0o600 });
  const flags = [...handoffGitPlatformFlags(), '--no-replace-objects', '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true'];
  const check = async () => {
    await options.authorize(); secretPolicy?.assertCurrent();
    const current = await fs.promises.lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new HandoffSnapshotError('source_changed');
    await repository.assertCurrent();
  };
  try {
    let source: 'existing' | 'remote' | 'bundle' = 'existing';
    if (!await hasCommit()) {
      const env = { ...process.env };
      for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
      Object.assign(env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull });
      const read = async (args: string[], cwd = quarantine): Promise<Buffer> => {
        await check();
        try { return (await exec('git', [...flags, ...args], { cwd, env, timeout: 60_000, maxBuffer: 8 * 1024 ** 2, encoding: 'buffer' })).stdout; }
        catch (error) {
          const reported = new HandoffSnapshotError('git_failed');
          reported.message += reportHandoffGitFailure(args, error);
          throw reported;
        }
      };
      // Keep the quarantine's UUID ownership, while leaving more path budget for packs.
      const bare = path.join(quarantine, 'repo');
      await read(['init', '--bare', '--template=', path.basename(bare)]);
      // Git for Windows rejects an explicit GIT_DIR longer than PATH_MAX - 40
      // before core.longpaths is read. Keep the process cwd and Git's directory
      // argument separate so both repository setup and pack I/O support deep roots.
      const readBare = (args: string[]) => read(['--git-dir=.', ...args], bare);
      let acquired = false;
      if (sourceKey && targetKey === sourceKey) {
        // Resolve only the receiving project's configured origin (including its own rewrites).
        // Fetching into quarantine keeps unverified history out of the registered object database.
        const remote = (await repository.read(['remote', 'get-url', 'origin']))?.toString('utf8').trim();
        if (remote && !remote.includes('\0') && !remote.includes('\n')) {
          try {
            await readBare(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--', remote, commit]);
            acquired = true; source = 'remote';
          } catch { /* telemetry-exempt: an unavailable person-configured origin falls back to the frozen bundle */ }
        }
      }
      if (!acquired) {
        if (!snapshot.manifest.bundle) throw new Error('Handoff commit is unavailable.');
        source = 'bundle';
        const bundle = path.join(root, 'bundle.bin');
        const heads = (await readBare(['bundle', 'list-heads', bundle])).toString('ascii').trim();
        if (heads !== `${commit} HEAD`) throw new HandoffSnapshotError('hash_mismatch');
        await readBare(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--', bundle, 'HEAD']);
      }
      const imported = (await readBare(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).toString('ascii').trim();
      if (imported !== commit) throw new HandoffSnapshotError('hash_mismatch');
      await scanHandoffGitHistory({ repo: { base: commit }, read: readBare, assertCurrent: check }, secretPolicy);
      await secretPolicy?.recordUse(handoffId, 'receiver'); await check();
      // Fetch only the verified commit's reachable graph, never arbitrary extra refs.
      // A repository source makes upload-pack interpret its path as GIT_DIR,
      // hitting Windows' setup limit even with longpaths enabled. A bundle is
      // ordinary file I/O and also works when staging and the project differ in drive.
      const verifiedBundle = path.join(quarantine, 'verified.bundle');
      await readBare(['bundle', 'create', verifiedBundle, 'FETCH_HEAD']);
      const verifiedHeads = (await readBare(['bundle', 'list-heads', verifiedBundle])).toString('ascii').trim();
      if (verifiedHeads !== `${commit} FETCH_HEAD`) throw new HandoffSnapshotError('hash_mismatch');
      await repository.read([...flags, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--', verifiedBundle, commit]);
    } else {
      await scanHandoffGitHistory({ repo: { base: commit }, read: (args) => repository.read([...flags, ...args]), assertCurrent: check }, secretPolicy);
      await secretPolicy?.recordUse(handoffId, 'receiver');
    }
    await check();
    if (!await hasCommit()) throw new HandoffSnapshotError('hash_mismatch');
    return { commit, source };
  } finally {
    const current = await fs.promises.lstat(root, { bigint: true });
    if (current.isDirectory() && !current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino) await fs.promises.rm(quarantine, { recursive: true, force: true });
  }
}
