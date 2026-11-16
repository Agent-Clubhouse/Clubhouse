import { execFile, execFileSync, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createHash, randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HANDOFF_TRANSFER_DEFAULTS, canonicalHandoffManifest } from '../../shared/handoff-manifest';
import { prepareHandoffSnapshot } from './handoff-snapshot';
import { prepareHandoffBundle } from './handoff-git-bundle';
import { receiveHandoffCommit } from './handoff-git-receive';
import { openHandoffRepository } from './handoff-snapshot';
import * as gitPaths from './handoff-git-paths';
import * as quarantines from './handoff-quarantine';
import * as bundles from './handoff-git-bundle';
import { HandoffSnapshotError } from './handoff-snapshot';
import * as snapshotArtifacts from './handoff-snapshot';
const execution = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), children: new Set<import('child_process').ChildProcess>() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  // Remember every Git child so cleanup can wait for it, even after a timed-out case.
  const track = <T extends import('child_process').ChildProcess | undefined>(child: T): T => {
    if (child) { execution.children.add(child); child.once('close', () => execution.children.delete(child)); }
    return child;
  };
  const run = promisify(actual.execFile) as (...args: unknown[]) => Promise<unknown> & { child?: import('child_process').ChildProcess };
  execution.exec = vi.fn((...args: unknown[]) => { const result = run(...args); track(result.child); return result; });
  execution.spawn = vi.fn((...args: Parameters<typeof actual.spawn>) => track(actual.spawn(...args)));
  const wrapped = Object.assign(vi.fn(actual.execFile), { [promisify.custom]: execution.exec });
  return { ...actual, execFile: wrapped, spawn: execution.spawn };
});
const exec = promisify(execFile);
let root: string; let sender: string; let receiver: string; let staging: string;
let crossDriveRoot: string | undefined;
const url = 'https://example.invalid/team/project.git';
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
async function initialize(repo: string, message: string) {
  fs.mkdirSync(repo); await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'public.txt'), message); await git(repo, 'add', '.'); await git(repo, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', message);
  await git(repo, 'config', 'remote.origin.url', url);
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-commit-'))); sender = path.join(root, 'sender'); receiver = path.join(root, 'receiver'); staging = path.join(root, 'stage'); fs.mkdirSync(staging);
  const config = path.join(root, 'empty-config'); fs.writeFileSync(config, ''); vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  await initialize(sender, 'Sender base'); await initialize(receiver, 'Receiver original');
  // An absent file remote fails locally and deterministically; no test reaches the internet.
  await git(receiver, 'config', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`, url);
});
// Every receive is tracked: a case that times out leaves its receive (and Git
// children) running, and they would otherwise hold folders open during cleanup.
const receiving = new Set<Promise<unknown>>();
const receive = (options: Parameters<typeof receiveHandoffCommit>[0]) => {
  const pending = receiveHandoffCommit(options);
  const settled = pending.then(() => undefined, () => undefined).finally(() => receiving.delete(settled));
  receiving.add(settled);
  return pending;
};
const within = (promise: Promise<unknown>, ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms); promise.then(() => { clearTimeout(timer); resolve(); });
});
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
function killTree(child: ChildProcess) {
  if (exited(child)) return;
  try {
    if (process.platform === 'win32' && child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}
async function settleGit() {
  await within(Promise.all([...receiving]), 5_000);
  for (const child of execution.children) killTree(child);
  await within(Promise.all([...execution.children].map((child) => new Promise((resolve) => child.once('close', resolve)))), 10_000);
  await within(Promise.all([...receiving]), 10_000);
}
// Windows holds folders open briefly after a process exits (EBUSY/EPERM/ENOTEMPTY):
// retry with a short bounded backoff (about 1.5 s total at the defaults below).
const remove = (directory: string) => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
afterEach(async () => {
  vi.unstubAllEnvs();
  await settleGit();
  await remove(root);
  if (crossDriveRoot) { await remove(crossDriveRoot); crossDriveRoot = undefined; }
}, 60_000);
async function prepared() {
  const handoffId = randomUUID(); const snapshot = await prepareHandoffSnapshot({ worktreeRoot: sender, stagingRoot: staging, handoffId });
  return { projectRoot: receiver, snapshot: await prepareHandoffBundle({ worktreeRoot: sender, snapshot, handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS }), handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS, authorize: async () => {} };
}
it('prefers a configured shared remote and arrives at the exact commit without changing the receiving worktree', async () => {
  const remote = path.join(root, 'remote.git'); await git(root, 'clone', '--bare', sender, remote);
  await git(receiver, 'config', '--unset-all', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`);
  await git(receiver, 'config', `url.${pathToFileURL(remote).href}.insteadOf`, url);
  const options = await prepared(); const before = (await git(receiver, 'rev-parse', 'HEAD')).stdout.trim();
  expect(await receive(options)).toEqual({ commit: options.snapshot.manifest.repo.base, source: 'remote' });
  expect((await git(receiver, 'cat-file', '-t', options.snapshot.manifest.repo.base)).stdout.trim()).toBe('commit');
  expect((await git(receiver, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before);
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
}, 30_000);
it('falls back to an independently scanned bundle when the configured remote lacks the commit', async () => {
  const options = await prepared(); const before = (await git(receiver, 'rev-parse', 'HEAD')).stdout.trim();
  expect(await receive(options)).toEqual({ commit: options.snapshot.manifest.repo.base, source: 'bundle' });
  expect((await git(receiver, 'rev-parse', 'HEAD')).stdout.trim()).toBe(before);
  expect(fs.readdirSync(options.snapshot.root).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 30_000);
it('passes exactly one Windows longpaths setting at every handoff Git execution boundary', async () => {
  const options = await prepared();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  execution.exec.mockClear(); execution.spawn.mockClear();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    expect(await receive(options)).toMatchObject({ source: 'bundle' });
    const repository = await openHandoffRepository(receiver);
    const oid = (await repository.read(['rev-parse', `${options.snapshot.manifest.repo.base}:public.txt`]))!.toString('ascii').trim();
    await repository.streamBlob(oid, Buffer.byteLength('Sender base'), async () => {}, async () => {});
    const commands = execution.exec.mock.calls.map((call) => call[1] as string[]);
    // Receiver/sender reads, direct quarantine exec, and streaming spawn all run.
    expect(commands.some((args) => args.some((arg) => arg.startsWith('--git-dir=')))).toBe(true);
    expect(commands.some((args) => args.includes('fetch') && !args.some((arg) => arg.startsWith('--git-dir=')))).toBe(true);
    expect(execution.spawn).toHaveBeenCalledTimes(1);
    for (const args of [...commands, ...execution.spawn.mock.calls.map((call) => call[1] as string[])]) {
      expect(args.filter((arg) => arg.startsWith('core.longpaths='))).toEqual(['core.longpaths=true']);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
}, 30_000);
it('classifies an impossible launch layout before spawning and cleans its quarantine', async () => {
  const options = await prepared(); execution.exec.mockClear();
  vi.spyOn(gitPaths, 'handoffGitLocation').mockReturnValueOnce(null);
  await expect(receiveHandoffCommit(options)).rejects.toMatchObject({
    code: 'git_failed', message: expect.stringContaining('Git: init; exit=unknown; stderr=path_too_long.'),
  });
  expect(execution.exec.mock.calls.some((call) => (call[1] as string[]).includes('init'))).toBe(false);
  expect(fs.readdirSync(options.snapshot.root).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 30_000);
it.each([['pack filename', 150], ['explicit Git directory', 170], ['repository path', 220], ['very deep repository path', 300]] as const)('handles bundle packs beyond the Windows %s limit (root%i) with isolated Git configuration', async (limit, rootLength) => {
  const options = await prepared();
  // Windows CI checks out on D: while temp staging is on C:. Exercise that
  // boundary too: making only the final fetch source relative cannot fix it.
  if (process.platform === 'win32' && path.parse(process.cwd()).root.toLowerCase() !== path.parse(root).root.toLowerCase()) {
    crossDriveRoot = await fs.promises.mkdtemp(path.join(process.cwd(), '.handoff-receiver-'));
    receiver = path.join(crossDriveRoot, 'receiver');
    await initialize(receiver, 'Receiver original');
    await git(receiver, 'config', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`, url);
    options.projectRoot = receiver;
  }
  const canonical = await fs.promises.realpath(root);
  let destination = canonical;
  while (destination.length + 81 < rootLength) destination = path.join(destination, 'x'.repeat(80));
  destination = path.join(destination, 'deep-' + 'x'.repeat(rootLength - destination.length - 6));
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  expect(destination.length).toBe(rootLength);
  await fs.promises.rename(options.snapshot.root, destination);
  options.snapshot.root = destination;
  const quarantine = path.join(destination, `quarantine-${randomUUID()}`);
  const bare = path.join(quarantine, 'objects.git');
  const pack = (repo: string) => path.join(repo, 'objects', 'pack', `pack-${'a'.repeat(40)}.pack`);
  expect(pack(bare).length).toBeGreaterThan(260);
  expect(pack(path.join(quarantine, 'repo')).length).toBeGreaterThan(260);
  if (rootLength >= 220) expect(path.join(quarantine, 'repo').length).toBeGreaterThan(260);
  if (process.platform === 'win32' && rootLength < 220) {
    // Reproduce the original isolated-config failure without changing global Git.
    await git(destination, '-c', 'core.longpaths=false', 'init', '--bare', '--template=', bare);
    const diagnostic = limit === 'pack filename' ? /Filename too long[\s\S]*error: index-pack died/ : /'\$GIT_DIR' too big/;
    const fetch = (longpaths: boolean) => git(destination, '-c', `core.longpaths=${longpaths}`, '--git-dir', bare, 'fetch', '--no-tags', '--', path.join(destination, 'bundle.bin'), 'HEAD');
    expect(bare.length > 220).toBe(limit === 'explicit Git directory');
    await expect(fetch(false)).rejects.toMatchObject({ code: limit === 'pack filename' ? 1 : 128, stderr: expect.stringMatching(diagnostic) });
    if (limit === 'explicit Git directory') {
      // This setup guard is independent of core.longpaths; relative GIT_DIR is required.
      await expect(fetch(true)).rejects.toMatchObject({ code: 128, stderr: expect.stringMatching(diagnostic) });
    }
    await fs.promises.rm(path.dirname(bare), { recursive: true, force: true });
  }
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const receivingHead = (await git(receiver, 'rev-parse', 'HEAD')).stdout.trim();
  if (rootLength >= 220) Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  execution.exec.mockClear();
  try {
    expect(await receive(options)).toEqual({ commit: options.snapshot.manifest.repo.base, source: 'bundle' });
    if (rootLength >= 220) {
      const quarantineCalls = execution.exec.mock.calls.filter((call) => (call[1] as string[]).includes('init')
        || (call[1] as string[]).some((arg) => arg.startsWith('--git-dir=')));
      expect(quarantineCalls.length).toBeGreaterThan(0);
      for (const call of quarantineCalls) {
        const cwd = (call[2] as { cwd: string }).cwd;
        expect(cwd.length).toBeLessThan(260);
        expect(cwd.startsWith(destination)).toBe(false);
        if (platform.value === 'win32') {
          const profileRoot = await fs.promises.realpath(path.join(process.env.LOCALAPPDATA!, 'ch-q'));
          expect(cwd.startsWith(profileRoot + path.sep)).toBe(true);
        }
        expect(fs.existsSync(cwd)).toBe(false);
        const command = call[1] as string[];
        if (command.includes('list-heads')) {
          const bundle = path.resolve(cwd, command.at(-1)!);
          expect(path.dirname(bundle)).toBe(cwd);
          expect(bundle.length).toBeLessThan(260);
        }
        const gitDir = command.find((arg) => arg.startsWith('--git-dir='));
        if (gitDir) expect(Buffer.byteLength(gitDir.slice('--git-dir='.length))).toBeLessThan(220);
      }
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
  expect((await git(receiver, 'cat-file', '-t', options.snapshot.manifest.repo.base)).stdout.trim()).toBe('commit');
  expect((await git(receiver, 'show', `${options.snapshot.manifest.repo.base}:public.txt`)).stdout).toBe('Sender base');
  expect((await git(receiver, 'rev-parse', 'HEAD')).stdout.trim()).toBe(receivingHead);
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
  expect(fs.readdirSync(destination).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 60_000);
it.each(['setup', 'init', 'timeout', 'hash mismatch', 'secret rejection', 'copied bundle mismatch'] as const)('cleans an external quarantine after %s failure', async (failure) => {
  const options = await prepared();
  const destination = path.join(root, 'x'.repeat(220 - root.length - 1));
  await fs.promises.rename(options.snapshot.root, destination);
  options.snapshot.root = destination;
  const allocate = quarantines.createHandoffQuarantine;
  let directory: string | undefined;
  vi.spyOn(quarantines, 'createHandoffQuarantine').mockImplementation(async (staging) => {
    const owned = await allocate(staging, { roots: [path.join(root, 'q')], windows: true });
    directory = owned.directory;
    return owned;
  });
  if (failure === 'setup') {
    const mkdir = fs.promises.mkdir;
    vi.spyOn(fs.promises, 'mkdir').mockImplementation(async (...args: Parameters<typeof mkdir>) => {
      if (path.basename(args[0].toString()) === 'hooks') throw new Error('Injected setup failure');
      return mkdir(...args);
    });
  } else if (failure === 'copied bundle mismatch') {
    const open = snapshotArtifacts.openHandoffSnapshotArtifact;
    vi.spyOn(snapshotArtifacts, 'openHandoffSnapshotArtifact').mockImplementation(async (request) => {
      const artifact = await open(request);
      return { ...artifact, read: async (...args: Parameters<typeof artifact.read>) => {
        const bytes = await artifact.read(...args);
        if (bytes.length) bytes[0] ^= 1;
        return bytes;
      } };
    });
  } else if (failure === 'secret rejection') {
    vi.spyOn(bundles, 'scanHandoffGitHistory').mockRejectedValueOnce(new HandoffSnapshotError('secret_blocked'));
  } else {
    const run = execution.exec.getMockImplementation()!;
    execution.exec.mockImplementation(async (...args) => {
      const command = args[1] as string[];
      if (failure === 'hash mismatch' && command.includes('list-heads')) return { stdout: Buffer.from(`${'0'.repeat(40)} HEAD`), stderr: Buffer.alloc(0) };
      if (failure !== 'hash mismatch' && command.includes('init')) throw Object.assign(new Error('Injected Git failure'), failure === 'timeout' ? { code: 'ETIMEDOUT', killed: true } : { code: 128 });
      return run(...args);
    });
  }
  if (failure === 'copied bundle mismatch') await expect(receiveHandoffCommit(options)).rejects.toMatchObject({ code: 'hash_mismatch' });
  else await expect(receiveHandoffCommit(options)).rejects.toThrow();
  expect(directory).toBeDefined();
  expect(path.dirname(directory!)).toBe(await fs.promises.realpath(path.join(root, 'q')));
  expect(fs.existsSync(directory!)).toBe(false);
  await expect(git(receiver, 'cat-file', '-e', `${options.snapshot.manifest.repo.base}^{commit}`)).rejects.toThrow();
}, 30_000);
it('rejects hash-valid secret-bearing bundle history before importing it into the registered repository', async () => {
  const token = `ghp_${'a'.repeat(36)}`; fs.writeFileSync(path.join(sender, 'retired.txt'), token);
  await git(sender, 'add', '.'); await git(sender, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'Malicious peer history');
  const handoffId = randomUUID(); const snapshot = await prepareHandoffSnapshot({ worktreeRoot: sender, stagingRoot: staging, handoffId });
  const bundle = path.join(snapshot.root, 'bundle.bin'); await git(sender, 'bundle', 'create', bundle, 'HEAD'); const bytes = fs.readFileSync(bundle);
  snapshot.manifest.bundle = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; snapshot.manifest.total_bytes += bytes.length;
  snapshot.manifest.manifest_sha256 = createHash('sha256').update(canonicalHandoffManifest(snapshot.manifest)).digest('hex');
  await expect(receiveHandoffCommit({ projectRoot: receiver, snapshot, handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS, authorize: async () => {} })).rejects.toMatchObject({ code: 'secret_blocked' });
  await expect(git(receiver, 'cat-file', '-e', `${snapshot.manifest.repo.base}^{commit}`)).rejects.toThrow();
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
  expect(fs.readdirSync(snapshot.root).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 30_000);
it('refuses a different registered repository without creating any worktree or importing objects', async () => {
  const options = await prepared(); await git(receiver, 'config', 'remote.origin.url', 'https://example.invalid/team/other.git');
  await expect(receiveHandoffCommit(options)).rejects.toThrow('No matching registered project');
  await expect(git(receiver, 'cat-file', '-e', `${options.snapshot.manifest.repo.base}^{commit}`)).rejects.toThrow();
}, 30_000);

it('allows a different registered repository only with the main-owned person link decision', async () => {
  const options = await prepared(); await git(receiver, 'config', 'remote.origin.url', 'https://example.invalid/team/linked.git');
  expect(await receive({ ...options, linkedProject: true })).toEqual({ commit: options.snapshot.manifest.repo.base, source: 'bundle' });
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
}, 30_000);

it('quarantines shared-remote history and leaves no blocked commit or secret blob in the registered project', async () => {
  const token = `ghp_${'b'.repeat(36)}`; fs.writeFileSync(path.join(sender, 'retired.txt'), token);
  await git(sender, 'add', '.'); await git(sender, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'Untrusted remote history');
  const blockedCommit = (await git(sender, 'rev-parse', 'HEAD')).stdout.trim();
  const blockedBlob = (await git(sender, 'rev-parse', 'HEAD:retired.txt')).stdout.trim();
  fs.rmSync(path.join(sender, 'retired.txt')); // Only the history contains the credential.
  const remote = path.join(root, 'malicious-remote.git'); await git(root, 'clone', '--bare', sender, remote);
  await git(receiver, 'config', '--unset-all', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`);
  await git(receiver, 'config', `url.${pathToFileURL(remote).href}.insteadOf`, url);
  const handoffId = randomUUID(); const snapshot = await prepareHandoffSnapshot({ worktreeRoot: sender, stagingRoot: staging, handoffId });
  await expect(receiveHandoffCommit({ projectRoot: receiver, snapshot, handoffId, bounds: HANDOFF_TRANSFER_DEFAULTS, authorize: async () => {} })).rejects.toMatchObject({ code: 'secret_blocked' });
  await expect(git(receiver, 'cat-file', '-e', blockedCommit)).rejects.toThrow();
  await expect(git(receiver, 'cat-file', '-e', blockedBlob)).rejects.toThrow();
  expect(fs.readFileSync(path.join(receiver, 'public.txt'), 'utf8')).toBe('Receiver original');
  expect(fs.readdirSync(snapshot.root).some((name) => name.startsWith('quarantine-'))).toBe(false);
}, 30_000);
