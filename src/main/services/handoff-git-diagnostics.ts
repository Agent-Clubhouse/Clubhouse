import { appLog } from './log-service';

const commands = new Set(['init', 'fetch', 'bundle', 'rev-parse', 'cat-file', 'log', 'ls-tree', 'ls-files', 'config', 'symbolic-ref', 'for-each-ref', 'check-attr', 'diff', 'status', 'worktree', 'read-tree', 'checkout-index', 'update-index', 'remote']);

/** Git for Windows otherwise rejects ordinary app-owned pack paths at MAX_PATH. */
export function handoffGitPlatformFlags(): string[] {
  return process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
}

/** Only closed classifications leave this boundary; never argv, stderr, URLs or paths. */
export function reportHandoffGitFailure(args: string[], error: unknown, options: { expected?: boolean } = {}): string {
  let command = 'unknown';
  for (let index = 0; index < args.length; index++) {
    if (['-c', '--git-dir', '--work-tree'].includes(args[index])) { index++; continue; }
    if (args[index].startsWith('-')) continue;
    command = commands.has(args[index]) ? args[index] : 'unknown';
    break;
  }
  const value = error && typeof error === 'object' ? error as { code?: unknown; stderr?: unknown; killed?: unknown } : {};
  const exit = typeof value.code === 'number' && Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 ? value.code : 'unknown';
  const stderr = Buffer.isBuffer(value.stderr) ? value.stderr.subarray(0, 64 * 1024).toString('utf8')
    : typeof value.stderr === 'string' ? value.stderr.slice(0, 64 * 1024) : '';
  const stderrClass = value.code === 'ENAMETOOLONG' || /filename too long|file name too long|path too long|\$GIT_DIR.*too big/i.test(stderr) ? 'path_too_long'
    : value.code === 'EBUSY' || /resource busy|used by another process|being used by another process/i.test(stderr) ? 'busy'
      : /(?:\.lock|lock file|lockfile).*already exists|unable to create.*\.lock/i.test(stderr) ? 'lock'
        : value.code === 'EACCES' || value.code === 'EPERM' || /permission denied|access is denied/i.test(stderr) ? 'permission'
          : value.killed === true || value.code === 'ETIMEDOUT' ? 'timeout'
            : value.code === 'ENOENT' ? 'not_found'
              : value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit'
                : /dubious ownership/i.test(stderr) ? 'ownership'
                  : /not a git repository|does not appear to be a git repository/i.test(stderr) ? 'repository'
                    : /bad object|not a valid object|unable to read.*object/i.test(stderr) ? 'object'
                      : 'unknown';
  appLog('core:git', options.expected ? 'debug' : 'warn', 'Handoff Git operation failed', { meta: { command, exit, stderrClass } });
  // Retained handoff history and E2E diagnostics need the same safe explanation.
  return ` Git: ${command}; exit=${exit}; stderr=${stderrClass}.`;
}
