/**
 * Validates a shell command prefix to prevent command injection.
 *
 * Rejects shell metacharacters that could allow arbitrary command execution
 * when the prefix is interpolated into `sh -c` invocations.
 */

const DISALLOWED_PATTERN = /[;&|$`()<>!]/;

export function validateCommandPrefix(prefix: string): string {
  if (DISALLOWED_PATTERN.test(prefix)) {
    throw new Error('commandPrefix contains disallowed shell metacharacters');
  }
  return prefix;
}
