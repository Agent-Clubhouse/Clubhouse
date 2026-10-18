/**
 * Strict names for anything that becomes a folder under
 * `.clubhouse/agents/` or a git branch (#2221).
 *
 * Agent names used to reach git through a shell string. They now go to git
 * as separate arguments, and this check keeps them to a set that is safe as
 * a folder name on every platform and as a git ref: ASCII letters, digits,
 * `-` and `_` (plus `/` between parts of a branch name), no part starting
 * with `-` or `.`, no `..`, and a length cap. Lookalike unicode letters,
 * whitespace, quotes and shell metacharacters are all refused.
 */

export const AGENT_FOLDER_NAME_MAX_LENGTH = 64;
export const AGENT_BRANCH_NAME_MAX_LENGTH = 128;

export type AgentGitNameKind = 'folder' | 'branch';

const PART = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Device names Windows will not create as a folder, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function problemWith(value: unknown, kind: AgentGitNameKind): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'is required';
  const max = kind === 'folder' ? AGENT_FOLDER_NAME_MAX_LENGTH : AGENT_BRANCH_NAME_MAX_LENGTH;
  if (value.length > max) return `must be at most ${max} characters`;
  if (value.startsWith('-') || value.startsWith('.')) return 'must not start with "-" or "."';
  if (value.includes('..')) return 'must not contain ".."';
  const parts = kind === 'branch' ? value.split('/') : [value];
  for (const part of parts) {
    if (!PART.test(part)) {
      return kind === 'branch'
        ? 'may only use letters, digits, "-", "_" and "/" between parts, and no part may start with "-"'
        : 'may only use letters, digits, "-" and "_"';
    }
    if (WINDOWS_RESERVED.test(part)) return `must not use "${part}", which is reserved on Windows`;
  }
  return null;
}

/**
 * Returns why `value` is not a valid agent folder name (`kind: 'folder'`) or
 * branch name (`kind: 'branch'`), as a sentence for the user, or null when it is valid.
 */
export function validateAgentGitName(value: unknown, kind: AgentGitNameKind = 'folder'): string | null {
  const problem = problemWith(value, kind);
  return problem ? `${kind === 'folder' ? 'Agent name' : 'Branch name'} ${problem}` : null;
}

/** Like validateAgentGitName, but throws an `Invalid agent name: ...` / `Invalid branch name: ...` error. */
export function assertAgentGitName(value: unknown, kind: AgentGitNameKind = 'folder'): asserts value is string {
  const problem = problemWith(value, kind);
  if (problem) throw new Error(`Invalid ${kind === 'folder' ? 'agent' : 'branch'} name: ${problem}`);
}
