import { expect, it, vi } from 'vitest';
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
import { appLog } from './log-service';
import { handoffGitPlatformFlags, reportHandoffGitFailure } from './handoff-git-diagnostics';

it.each([
  [{ code: 128, stderr: Buffer.from('fatal: private/path: Filename too long') }, 'path_too_long', 128],
  [{ code: 'ENAMETOOLONG' }, 'path_too_long', 'unknown'],
  [{ code: 'EBUSY' }, 'busy', 'unknown'],
  [{ code: 128, stderr: "Unable to create 'private/index.lock': File exists. Another git process seems to be running" }, 'lock', 128],
  [{ code: 'EPERM' }, 'permission', 'unknown'],
  [{ killed: true }, 'timeout', 'unknown'],
  [{ code: 'ENOENT' }, 'not_found', 'unknown'],
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'output_limit', 'unknown'],
  [{ code: 128, stderr: 'fatal: detected dubious ownership in private repo' }, 'ownership', 128],
  [{ code: 128, stderr: 'fatal: not a git repository: private' }, 'repository', 128],
  [{ code: 128, stderr: 'fatal: bad object private' }, 'object', 128],
  [{ code: 'secret-code', stderr: 'secret-stderr', message: 'secret-message' }, 'unknown', 'unknown'],
])('reports only closed command, exit and stderr classifications for %j', (error, stderrClass, exit) => {
  const detail = reportHandoffGitFailure(['--git-dir', 'private-path', '-c', 'private=value', 'fetch', '--', 'https://secret@private', 'secret-ref'], error);
  expect(detail).toBe(` Git: fetch; exit=${exit}; stderr=${stderrClass}.`);
  expect(appLog).toHaveBeenCalledWith('core:git', 'warn', 'Handoff Git operation failed', { meta: { command: 'fetch', exit, stderrClass } });
  expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toMatch(/private|secret/);
});
it('never reflects an unrecognized command or arbitrary exit value', () => {
  expect(reportHandoffGitFailure(['secret-command'], { code: 99999 })).toBe(' Git: unknown; exit=unknown; stderr=unknown.');
});
it('enables long paths per command only on Windows', () => {
  expect(handoffGitPlatformFlags()).toEqual(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []);
});
