/**
 * How Clubhouse launches `agy acp` and what it claims about it (#3797). Every
 * fact here comes from the public docs, read 2026-11-23:
 * https://antigravity.google/docs/ide/extensions/acp/ and
 * https://antigravity.google/docs/cli/acp/ (flags, steering, questions,
 * authentication) and https://antigravity.google/docs/cli/reference/ (modes).
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PermissionLevel } from '../../../shared/chat/capabilities';
import { ANTIGRAVITY_CHAT_DRIVER_ID, ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';
import type { ChatDriverId } from '../../../shared/chat/capabilities';
import type { AcpLevelPolicy } from '../acp/capabilities';
import type { AcpLaunchSpec } from '../acp/driver';

/** "Run `agy` in a terminal" is the ACP guide's sign-in; `agy acp --login` is its SSH-friendly one. */
export const ANTIGRAVITY_LOGIN_HINT = 'Run `agy` in a terminal to sign in, or `agy acp --login` over SSH.';

/**
 * Levels to the CLI's documented modes (`--mode plan|accept-edits`, and the
 * default). Auto is left out: it needs the terminal sandbox, a minimum
 * version per platform and a non-business account, none of which Clubhouse
 * can check, so a start at Auto is refused rather than mislabelled (the same
 * rule as the terminal provider). Full access is the launch flag
 * `--dangerously-skip-permissions`, so it needs a restart either way.
 *
 * The ACP pages don't document the session mode ids. A level is only applied
 * when the session itself offers the mapped id; otherwise the start is
 * refused (AcpLevelPolicy).
 */
const LEVEL_MODES: Readonly<Record<PermissionLevel, string | undefined>> = {
  plan: 'plan',
  ask: 'default',
  auto_edit: 'accept-edits',
  auto: undefined,
  full_access: undefined,
};

export const ANTIGRAVITY_LEVEL_POLICY: AcpLevelPolicy = {
  mode: (level) => LEVEL_MODES[level],
  processLevels: ['full_access'],
};

export interface AntigravityLaunchOptions {
  /**
   * Clubhouse's own log folder for `--log-file`, so the ACP server log isn't
   * left only under the person's `~/.gemini`. Absent: no flag (the CLI's
   * default path).
   */
  logDir?: string;
}

/** `agy acp` arguments for one launch. `extraArgs` are the caller's, already validated. */
export function antigravityAcpArgs(opts: { extraArgs: readonly string[]; level?: PermissionLevel }, launch: AntigravityLaunchOptions = {}): string[] {
  return [
    'acp',
    // One file per launch: concurrent agents never share a log.
    ...(launch.logDir ? ['--log-file', path.join(launch.logDir, `antigravity-acp-${Date.now()}-${randomUUID().slice(0, 8)}.log`)] : []),
    ...(opts.level === 'full_access' ? ['--dangerously-skip-permissions'] : []),
    ...opts.extraArgs,
  ];
}

export function antigravityAcpLaunchSpec(launch: AntigravityLaunchOptions = {}): AcpLaunchSpec {
  return {
    // Not in CHAT_DRIVER_IDS until registration (the integrator adds it with the telemetry enum).
    id: ANTIGRAVITY_CHAT_DRIVER_ID as ChatDriverId,
    provider: ANTIGRAVITY_PROVIDER_ID,
    // Only when the person picks it, until the real-login gates (#3802) pass.
    optIn: true,
    args: (opts) => antigravityAcpArgs(opts, launch),
    claims: {
      // "When the agent asks a question, clients that support ACP elicitation forms show a native form."
      questions: true,
      // "Sending a prompt while a turn runs steers that turn instead of starting a new one."
      // How each prompt is then answered isn't documented: the neutral driver
      // keeps the turn open until every prompt in it is answered, an
      // assumption until the real-login check (#3802 V13).
      steer: true,
    },
    levels: ANTIGRAVITY_LEVEL_POLICY,
    loginHint: ANTIGRAVITY_LOGIN_HINT,
    // A saved model the account isn't offered refuses, never silently switches (#3797).
    unofferedModel: 'refuse',
  };
}
