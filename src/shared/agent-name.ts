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
  const what = kind === 'folder' ? 'the agent name' : 'the branch name';
  if (typeof value !== 'string' || value.length === 0) {
    return kind === 'folder' ? 'Enter a name for the agent.' : 'Enter a branch name.';
  }
  const max = kind === 'folder' ? AGENT_FOLDER_NAME_MAX_LENGTH : AGENT_BRANCH_NAME_MAX_LENGTH;
  if (value.length > max) return `Keep ${what} to ${max} characters or fewer.`;
  if (value.startsWith('-') || value.startsWith('.')) return `Start ${what} with a letter, digit or _.`;
  if (value.includes('..')) return `Remove the ".." from ${what}.`;
  const parts = kind === 'branch' ? value.split('/') : [value];
  for (const part of parts) {
    if (!PART.test(part)) {
      return kind === 'branch'
        ? 'Use only letters, digits, - and _ in the branch name, with / between parts that each start with a letter, digit or _.'
        : 'Use only letters, digits, - and _ in the agent name.';
    }
    if (WINDOWS_RESERVED.test(part)) return `"${part}" is reserved on Windows, so choose another ${kind === 'folder' ? 'agent' : 'branch'} name.`;
  }
  return null;
}

/**
 * Returns why `value` is not a valid agent folder name (`kind: 'folder'`) or
 * branch name (`kind: 'branch'`), as a sentence for the user, or null when it is valid.
 */
export function validateAgentGitName(value: unknown, kind: AgentGitNameKind = 'folder'): string | null {
  return problemWith(value, kind);
}

/** Like validateAgentGitName, but throws an Error whose message is that sentence. */
export function assertAgentGitName(value: unknown, kind: AgentGitNameKind = 'folder'): asserts value is string {
  const problem = problemWith(value, kind);
  if (problem) throw new Error(problem);
}
