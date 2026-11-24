/**
 * Antigravity access mapping (#3791), from the CLI reference
 * (https://antigravity.google/docs/cli/reference/, read 2026-11-23):
 *
 * - Plan: `--mode plan`
 * - Ask first: no flag (the CLI's default mode)
 * - Auto-accept edits: `--mode accept-edits`
 * - Full access: `--dangerously-skip-permissions`
 * - Auto: not offered. `--mode auto` needs the terminal sandbox, a minimum
 *   version per platform and a non-business account; without evidence for
 *   all three the CLI would silently run in default mode instead, so a start
 *   at Auto is refused rather than mislabelled.
 *
 * The person's own `permissions` rules in their Antigravity settings still
 * apply on top (Deny > Ask > Allow); Clubhouse never edits them.
 */

import type { PermissionLevel } from '../../../shared/chat/capabilities';
import type { SpawnOpts } from '../types';

export class AntigravityAccessError extends Error {}

/** The level a terminal launch starts at, from `access` or the legacy free-agent pair. */
export function antigravityStartLevel(opts: Pick<SpawnOpts, 'access' | 'freeAgentMode' | 'permissionMode'>): PermissionLevel {
  if (opts.access) return opts.access;
  if (!opts.freeAgentMode) return 'ask';
  // The legacy pair: skip-all is Full access, anything else is Auto, which is
  // refused like an explicit Auto rather than quietly started lower.
  return opts.permissionMode === 'skip-all' ? 'full_access' : 'auto';
}

/** The start flags for a level. Throws for a level Antigravity can't start at. */
export function antigravityAccessArgs(level: PermissionLevel): string[] {
  switch (level) {
    case 'plan': return ['--mode', 'plan'];
    case 'ask': return [];
    case 'auto_edit': return ['--mode', 'accept-edits'];
    case 'full_access': return ['--dangerously-skip-permissions'];
    case 'auto':
      throw new AntigravityAccessError('Antigravity agents cannot start at Auto yet. Choose Auto-accept edits or Full access.');
  }
}
