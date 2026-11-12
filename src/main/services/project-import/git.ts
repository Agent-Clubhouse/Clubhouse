import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getShellEnvironment } from '../../util/shell';
import { appLog } from '../log-service';
import { directoryIdentity, ImportError, validateImportBranch, type RemoteIdentity } from './types';

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  assertCurrent?: () => Promise<void>;
  beforeSpawn?: () => void;
}

export interface ImportGit {
  remote(url: string, branch: string | undefined, signal?: AbortSignal): Promise<RemoteIdentity>;
  run(args: string[], options: GitRunOptions): Promise<string>;
}

const OUTPUT_MAX = 1024 * 1024;
const AUTH_KEY = /^credential(?:\.https:\/\/github\.com(?:\/[A-Za-z0-9_./-]+)?)?\.(?:helper|username|usehttppath)$/i;

function nativeExecutable(binary: string): boolean {
  const fd = fs.openSync(binary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    if (process.platform === 'win32') {
      if (header.toString('ascii', 0, 2) !== 'MZ') return false;
      const offset = header.readUInt32LE(60);
      if (offset > 1024 * 1024) return false;
      const signature = Buffer.alloc(4);
      return fs.readSync(fd, signature, 0, 4, offset) === 4 && signature.equals(Buffer.from([0x50, 0x45, 0, 0]));
    }
    const magic = header.readUInt32BE(0);
    return process.platform === 'darwin'
      ? [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)
      : magic === 0x7f454c46;
  } finally {
    fs.closeSync(fd);
  }
}

function trustedGitRuntime(source: Record<string, string | undefined>): { binary: string; searchPath: string } {
  const rawPath = Object.entries(source).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const directories: string[] = [];
  for (const directory of rawPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const real = fs.realpathSync.native(directory);
      if (fs.statSync(real).isDirectory() && !directories.includes(real)) directories.push(real);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new ImportError('git_unavailable', 'Git search directories cannot be inspected safely. Repair the existing Git installation/PATH outside agent messages.');
      }
    }
  }
  for (const directory of directories) {
    const candidate = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      const binary = fs.realpathSync.native(candidate);
      if (!fs.statSync(binary).isFile()) continue;
      fs.accessSync(binary, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (!nativeExecutable(binary)) continue;
      return { binary, searchPath: directories.join(path.delimiter) };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new ImportError('git_unavailable', 'Git cannot be resolved safely. Repair the existing native Git installation outside agent messages.');
      }
    }
  }
  throw new ImportError('git_unavailable', 'No native Git executable exists in the existing absolute PATH directories. Install/repair Git outside agent messages; relative paths and shell shims are not used for repository import.');
}

function emptyGitConfig() {
  let directory: string | undefined;
  let fd: number | undefined;
  try {
    directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'clubhouse-import-git-'));
    const root = directory;
    const rootIdentity = directoryIdentity(fs.lstatSync(root));
    const file = path.join(root, 'empty.config');
    fd = fs.openSync(file, 'wx', 0o600);
    const descriptor = fd;
    const identity = directoryIdentity(fs.fstatSync(descriptor));
    const assertSafe = () => {
      try {
        const parent = fs.lstatSync(root);
        const stat = fs.lstatSync(file);
        const opened = fs.fstatSync(descriptor);
        if (!parent.isDirectory() || parent.isSymbolicLink() || directoryIdentity(parent) !== rootIdentity
          || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0
          || directoryIdentity(stat) !== identity || opened.size !== 0 || opened.nlink !== 1) throw new Error('changed');
      } catch {
        // telemetry-exempt: temporary paths and raw filesystem errors stay private.
        throw new ImportError('git_config_unavailable', 'Git isolation configuration changed. No further Git command was started.');
      }
    };
    return {
      file,
      assertSafe,
      close: () => {
        try {
          assertSafe();
          fs.closeSync(descriptor);
          fd = undefined;
          fs.unlinkSync(file);
          fs.rmdirSync(root);
        } catch {
          // telemetry-exempt: preserve unexpected files; report without paths or raw errors.
          appLog('core:project', 'warn', 'Temporary import Git isolation state could not be safely removed; unexpected state was preserved');
        } finally {
          if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        }
      },
    };
  } catch {
    // telemetry-exempt: setup failure is sanitized and removes only an owned empty directory.
    if (fd !== undefined) fs.closeSync(fd);
    if (directory) {
      try { fs.rmdirSync(directory); } catch {
        appLog('core:project', 'warn', 'Temporary import Git isolation setup failed; unexpected state was preserved');
      }
    }
    throw new ImportError('git_config_unavailable', 'An empty regular Git isolation file could not be created. Repair temporary-directory access outside agent messages.');
  }
}

export function importGitEnvironment(source: Record<string, string | undefined>, emptyConfig: string): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|GCM_|SSH_ASKPASS|GH_DEBUG|GITHUB_DEBUG|LD_PRELOAD|DYLD_|NODE_OPTIONS)/i.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'Never',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Git is spawned without a shell. Only bounded metadata and numeric progress leave this boundary. */
function execute(binary: string, args: string[], env: NodeJS.ProcessEnv, options: GitRunOptions, timeout: number, allowNoMatch = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ImportError('cancelled', 'Import cancelled. Existing and partially downloaded files are preserved.'));
      return;
    }
    options.beforeSpawn?.();
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // telemetry-exempt: only the sanitized operation failure is returned.
      reject(new ImportError('git_unavailable', 'Git could not be started. Install or repair Git, then preview again.'));
      return;
    }
    let stdout = '';
    let exceeded = false;
    let timedOut = false;
    let failedToStart = false;
    const stop = () => { child.kill('SIGTERM'); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    // Escalation targets the same tracked child, never a process name or unrelated process group.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      stop();
      killTimer ??= setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (data: Buffer) => {
      if (Buffer.byteLength(stdout) + data.length > OUTPUT_MAX) {
        exceeded = true;
        abort();
      } else {
        stdout += data.toString('utf8');
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      // Never retain Git/credential-helper diagnostics: they can contain credentials and private metadata.
      for (const match of data.toString('utf8').matchAll(/\b(\d{1,3})%/g)) {
        const percent = Number(match[1]);
        if (percent <= 100) options.onProgress?.(percent);
      }
    });
    const finish = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', () => {
      // Retain isolation files until close has also drained the tracked child's stdio.
      failedToStart = true;
    });
    child.on('close', (code) => {
      finish();
      if (options.signal?.aborted) reject(new ImportError('cancelled', 'Import cancelled; any files already created are preserved.'));
      else if (exceeded) reject(new ImportError('metadata_limit', 'Repository metadata exceeded the bounded import limit. No further work was attempted.'));
      else if (timedOut) reject(new ImportError('git_timeout', 'Git timed out. Check connectivity and existing Git authentication before retrying; partial files are preserved.'));
      else if (failedToStart) reject(new ImportError('git_unavailable', 'Git could not be started. Install or repair Git, then preview again.'));
      else if (allowNoMatch && code === 1) resolve('');
      else if (code !== 0) reject(new ImportError('git_failed', 'Git could not complete this operation. Restore GitHub access using your existing Git credential helper or GitHub sign-in outside agent messages, and check repository/branch access. Do not send credentials here.'));
      else resolve(stdout);
    });
  });
}

export function parseRemoteIdentity(url: string, raw: string, requested?: string): RemoteIdentity {
  const lines = raw.trim().split('\n');
  const defaultRef = lines.find((line) => /^ref: refs\/heads\/[^\t]+\tHEAD$/.test(line));
  const refs = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t(HEAD|refs\/heads\/[^\r\n\t]+)$/.exec(line);
    if (match) refs.set(match[2], match[1]);
  }
  if (!refs.size) throw new ImportError('empty_repository', 'The repository has no downloadable branch. Nothing was created; create a branch on GitHub, then preview again.');
  if (!defaultRef) throw new ImportError('missing_default_branch', 'GitHub did not advertise a usable default branch. Nothing was created; repair the repository default branch, then preview again.');
  const defaultBranch = validateImportBranch(defaultRef.slice('ref: refs/heads/'.length, -'\tHEAD'.length));
  const branch = validateImportBranch(requested ?? defaultBranch);
  const headCommit = refs.get(`refs/heads/${defaultBranch}`);
  const commit = refs.get(`refs/heads/${branch}`);
  if (!headCommit || refs.get('HEAD') !== headCommit) throw new ImportError('missing_default_branch', 'The advertised default branch has no matching commit. Nothing was created; repair it and preview again.');
  if (!commit) throw new ImportError('missing_branch', 'The selected branch does not exist. Nothing was created; choose an existing branch and preview again.');
  return { url, defaultBranch, branch, commit, headCommit };
}

export function createImportGit(sourceEnvironment: () => Record<string, string | undefined> = getShellEnvironment): ImportGit {
  let runtime: ReturnType<typeof trustedGitRuntime> | undefined;
  async function environment(config: ReturnType<typeof emptyGitConfig>, signal?: AbortSignal): Promise<{ env: NodeJS.ProcessEnv; binary: string }> {
    const source = sourceEnvironment();
    runtime ??= trustedGitRuntime(source);
    const env = importGitEnvironment(source, config.file);
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = runtime.searchPath;
    // Read only existing system/global credential configuration, never a nearby repository's config.
    // Carry it in the child environment, not argv, logs, receipts or model-visible errors.
    let count = 0;
    for (const scope of ['--system', '--global']) {
      const readEnv = { ...env };
      delete readEnv.GIT_CONFIG_NOSYSTEM;
      delete readEnv.GIT_CONFIG_SYSTEM;
      delete readEnv.GIT_CONFIG_GLOBAL;
      const raw = await execute(runtime.binary, ['config', scope, '--includes', '--null', '--get-regexp', '^credential\\.'], readEnv, { cwd: os.homedir(), signal, beforeSpawn: config.assertSafe }, 10_000, true);
      for (const item of raw.split('\0')) {
        const split = item.indexOf('\n');
        if (split < 0) continue;
        const key = item.slice(0, split);
        if (!AUTH_KEY.test(key)) continue;
        if (count >= 32) throw new ImportError('credential_config_limit', 'Existing credential configuration is too large for bounded import. Simplify GitHub credential-helper configuration outside agent messages.');
        env[`GIT_CONFIG_KEY_${count}`] = key;
        env[`GIT_CONFIG_VALUE_${count++}`] = item.slice(split + 1);
      }
    }
    env.GIT_CONFIG_COUNT = String(count);
    return { env, binary: runtime.binary };
  }

  const safe = [
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', 'init.templateDir=',
    '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false',
    '-c', 'core.attributesFile=', '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false', '-c', 'credential.interactive=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true',
  ];

  return {
    async remote(url, branch, signal) {
      const config = emptyGitConfig();
      try {
        const { env, binary } = await environment(config, signal);
        const raw = await execute(binary, [...safe, '-c', `core.hooksPath=${config.file}`, 'ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*'], env, { cwd: os.homedir(), signal, beforeSpawn: config.assertSafe }, 30_000);
        return parseRemoteIdentity(url, raw, branch);
      } finally { config.close(); }
    },
    async run(args, options) {
      const config = emptyGitConfig();
      try {
        const { env, binary } = await environment(config, options.signal);
        await options.assertCurrent?.();
        return await execute(binary, [...safe, '-c', `core.hooksPath=${config.file}`, ...args], env, {
          ...options,
          beforeSpawn: () => { config.assertSafe(); options.beforeSpawn?.(); },
        }, 10 * 60_000);
      } finally { config.close(); }
    },
  };
}
