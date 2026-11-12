import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { getShellEnvironment } from '../../util/shell';
import { ImportError, validateImportBranch, type RemoteIdentity } from './types';

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface ImportGit {
  remote(url: string, branch: string | undefined, signal?: AbortSignal): Promise<RemoteIdentity>;
  run(args: string[], options: GitRunOptions): Promise<string>;
}

const OUTPUT_MAX = 1024 * 1024;
const AUTH_KEY = /^credential(?:\.https:\/\/github\.com(?:\/[A-Za-z0-9_./-]+)?)?\.(?:helper|username|usehttppath)$/i;

export function importGitEnvironment(source: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|GCM_|SSH_ASKPASS|GH_DEBUG|GITHUB_DEBUG|LD_PRELOAD|DYLD_|NODE_OPTIONS)/i.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: os.devNull,
    GCM_INTERACTIVE: 'Never',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_PROTOCOL_FROM_USER: '0',
  };
}

/** Git is spawned without a shell. Only bounded metadata and numeric progress leave this boundary. */
function execute(args: string[], env: NodeJS.ProcessEnv, options: GitRunOptions, timeout: number, allowNoMatch = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ImportError('cancelled', 'Import cancelled. Existing and partially downloaded files are preserved.'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn('git', args, { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // telemetry-exempt: only the sanitized operation failure is returned.
      reject(new ImportError('git_unavailable', 'Git could not be started. Install or repair Git, then preview again.'));
      return;
    }
    let stdout = '';
    let exceeded = false;
    let timedOut = false;
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
      finish();
      reject(new ImportError('git_unavailable', 'Git could not be started. Install or repair Git, then preview again.'));
    });
    child.on('close', (code) => {
      finish();
      if (options.signal?.aborted) reject(new ImportError('cancelled', 'Import cancelled; any files already created are preserved.'));
      else if (exceeded) reject(new ImportError('metadata_limit', 'Repository metadata exceeded the bounded import limit. No further work was attempted.'));
      else if (timedOut) reject(new ImportError('git_timeout', 'Git timed out. Check connectivity and existing Git authentication before retrying; partial files are preserved.'));
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
  async function environment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
    const source = sourceEnvironment();
    const env = importGitEnvironment(source);
    // Read only existing system/global credential configuration, never a nearby repository's config.
    // Carry it in the child environment, not argv, logs, receipts or model-visible errors.
    let count = 0;
    for (const scope of ['--system', '--global']) {
      const readEnv = { ...env };
      delete readEnv.GIT_CONFIG_NOSYSTEM;
      delete readEnv.GIT_CONFIG_SYSTEM;
      delete readEnv.GIT_CONFIG_GLOBAL;
      const raw = await execute(['config', scope, '--includes', '--null', '--get-regexp', '^credential\\.'], readEnv, { cwd: os.homedir(), signal }, 10_000, true);
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
    return env;
  }

  const safe = [
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', `core.hooksPath=${os.devNull}`, '-c', 'init.templateDir=',
    '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false',
    '-c', 'core.attributesFile=', '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false', '-c', 'credential.interactive=false',
    '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true',
  ];

  return {
    async remote(url, branch, signal) {
      const env = await environment(signal);
      const raw = await execute([...safe, 'ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*'], env, { cwd: os.homedir(), signal }, 30_000);
      return parseRemoteIdentity(url, raw, branch);
    },
    async run(args, options) {
      return execute([...safe, ...args], await environment(options.signal), options, 10 * 60_000);
    },
  };
}
