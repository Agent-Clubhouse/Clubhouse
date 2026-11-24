/**
 * A managed delivery problem that must stop the start rather than let the
 * session run on the old files (#3792). The spawn path continues after any
 * other delivery error, as it always has; it stops only for this one.
 */
export type ManagedStartRefusedCode =
  /** The composed AGENTS.md would pass Antigravity's per-file limit. */
  | 'antigravity_instructions_too_large'
  /** AGENTS.md is a link or not a plain file. */
  | 'antigravity_instructions_unsafe'
  /** Clubhouse's block markers are missing a pair, repeated or out of order. */
  | 'antigravity_instructions_markers'
  /** AGENTS.md changed between Clubhouse reading and writing it; it was left as it is. */
  | 'antigravity_instructions_changed'
  /** Before Codex writes AGENTS.md over an Antigravity start's, the copy of the person's text couldn't be made. */
  | 'antigravity_codex_backup_failed'
  /** A write failed after the checks passed, so the folder may hold part of this start's setup. */
  | 'antigravity_delivery_incomplete'
  /** Other Antigravity refusals, such as the MCP and hooks config checks. */
  | `antigravity_${string}`;

export class ManagedStartRefused extends Error {
  readonly code: ManagedStartRefusedCode;
  /** The error behind the refusal, when there is one. */
  readonly cause?: unknown;
  constructor(code: ManagedStartRefusedCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ManagedStartRefused';
    this.code = code;
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export function isManagedStartRefused(err: unknown): err is ManagedStartRefused {
  return err instanceof ManagedStartRefused;
}
