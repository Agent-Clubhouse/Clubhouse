/**
 * Words and pure helpers for the orchestration UI (#2232): the Orchestrate,
 * Helpers and Connections cards, the turn-off and dispose dialogs, and the
 * Helpers settings pages. Shared so every surface says the same thing.
 */

import type { Agent, DurableAgentConfig, HelperDisposeChecks } from '../../../../shared/types';
import type { AgentAccessLevel, OrchestrationAccess, OrchestrationControl } from '../../../../shared/orchestration-policy';
import { ACCESS_LEVELS } from '../../../../shared/orchestration-policy';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import { PERMISSION_LEVEL_LABELS } from '../../../../shared/chat/capabilities';
import type { AgentDot } from '../agent-status';

/** Access levels in the words the chat level menu uses. */
export const ACCESS_LEVEL_LABELS: Readonly<Record<AgentAccessLevel, string>> = {
  standard: PERMISSION_LEVEL_LABELS.ask,
  auto: PERMISSION_LEVEL_LABELS.auto,
  bypass: PERMISSION_LEVEL_LABELS.full_access,
};

export function accessLabel(access: OrchestrationAccess, orchestratorName: string): string {
  return access === 'same' ? `Same as ${orchestratorName}` : ACCESS_LEVEL_LABELS[access];
}

export const CONTROL_LABELS: Readonly<Record<OrchestrationControl, string>> = {
  'hands-off': 'Hands-off',
  'ask-before-start': 'Ask before starting',
  'ask-everything': 'Ask for everything',
};

export function controlHelp(control: OrchestrationControl, orchestratorName: string): string {
  switch (control) {
    case 'hands-off':
      return `Helpers start and are disposed without asking you. ${orchestratorName} can still ask when it judges it should.`;
    case 'ask-before-start':
      return `New helpers wait for your approval in ${orchestratorName}’s Helpers card. The sidebar shows when one is waiting.`;
    case 'ask-everything':
      return 'Starting a helper and every dispose come to you.';
  }
}

/** Whether `level` is above `ceiling`. */
export function aboveCeiling(level: AgentAccessLevel, ceiling: AgentAccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(level) > ACCESS_LEVELS.indexOf(ceiling);
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Helper state ────────────────────────────────────────────────────────

export type HelperState = 'starting' | 'failed' | 'awaiting-approval' | 'running' | 'sleeping' | 'handed-off';

export const HELPER_STATE_LABEL: Readonly<Record<HelperState, string>> = {
  starting: 'Starting',
  failed: 'Couldn’t start',
  'awaiting-approval': 'Waiting for approval',
  running: 'Running',
  sleeping: 'Sleeping',
  'handed-off': 'Handed off',
};

/**
 * A helper's state from its config and, when the rail has it, its live agent.
 * An unfinished creation wins; then a hand-off (#2229), then running or
 * asleep. `awaiting-approval` is never a config's state: a held start has no
 * helper yet, and the Helpers card shows it from the start request (#2234).
 */
export function helperState(config: DurableAgentConfig, agent?: Pick<Agent, 'status'>): HelperState {
  const creation = config.creation?.state;
  if (creation === 'creating' || agent?.status === 'creating') return 'starting';
  if (creation === 'failed') return 'failed';
  if (config.handoff) return 'handed-off';
  const status = agent?.status;
  if (status === 'running' || status === 'spawning' || status === 'waking') return 'running';
  return 'sleeping';
}

/** The status dot for a helper row: the live dot while it runs, else one for its state. */
export function helperDot(state: HelperState, liveDot: AgentDot | undefined): AgentDot {
  switch (state) {
    case 'starting':
    case 'awaiting-approval':
      return 'starting';
    case 'failed':
      return 'error';
    case 'handed-off':
      return 'idle';
    case 'running':
      return liveDot ?? 'idle';
    case 'sleeping':
      return 'sleeping';
  }
}

/**
 * Direct live helpers and disposed helpers of an agent, from every project
 * (#2514), in the order main lists them: its own project first.
 */
export function splitHelpers<H extends { config: DurableAgentConfig }>(helpers: readonly H[], parentId: string): { live: H[]; disposed: H[] } {
  const mine = helpers.filter((h) => h.config.parentAgentId === parentId);
  return {
    live: mine.filter((h) => !isDisposedAgent(h.config)),
    disposed: mine.filter((h) => isDisposedAgent(h.config)),
  };
}

/**
 * Disposed helpers nobody can reach from a Helpers card: their orchestrator is
 * gone, or they were released before being disposed. `configs` is one
 * project's; a helper whose orchestrator is in another project (#2514) is
 * reachable from that orchestrator's card when `hasParentElsewhere` says the
 * orchestrator is still there, and orphaned otherwise.
 */
export function orphanedDisposed(
  configs: readonly DurableAgentConfig[],
  hasParentElsewhere: (config: DurableAgentConfig) => boolean = () => false,
): DurableAgentConfig[] {
  const ids = new Set(configs.map((c) => c.id));
  return configs.filter((c) => {
    if (!isDisposedAgent(c)) return false;
    if (!c.parentAgentId) return true;
    return c.parentProjectPath ? !hasParentElsewhere(c) : !ids.has(c.parentAgentId);
  });
}

// ── Dispose checks ──────────────────────────────────────────────────────

/** Past this an exact count says nothing more (a branch with its whole history unpushed). */
const MAX_LISTED_COMMITS = 99;

function commits(n: number, what: string): string {
  return n > MAX_LISTED_COMMITS ? `More than ${MAX_LISTED_COMMITS} commits ${what}` : `${plural(n, 'commit', 'commits')} ${what}`;
}

/** Work disposing would lose. A check that couldn't run is not "at risk": it can never be forced. */
export function hasWorkAtRisk(checks: HelperDisposeChecks): boolean {
  return checks.dirty > 0 || checks.unpushed > 0;
}

/** True when disposing is blocked for good until the check can run. */
export function checksFailed(checks: HelperDisposeChecks): boolean {
  return !!checks.error;
}

// ── Failure text ────────────────────────────────────────────────────────

/** Output from a failed command (git's stderr, a node error code), which the UI keeps out of sentences. */
const RAW_OUTPUT = /Command failed|fatal:|\berror:|usage: git|\bgit (?:-C |rev-parse|show-ref|status|worktree|log|branch|for-each-ref)/i;
/** A node error code such as ENOENT or EBUSY (case matters: "exists" is a word). */
const ERROR_CODE = /\bE[A-Z]{3,}\b/;

/** True when `text` is a command's raw output rather than a sentence for people. */
export function isRawOutput(text: string): boolean {
  return RAW_OUTPUT.test(text) || ERROR_CODE.test(text);
}

/**
 * A failure for a sentence: `text` itself when it reads as one, else
 * `fallback`, with the raw output kept in `detail` for a tooltip or the log.
 */
export function plainFailure(text: string | null | undefined, fallback: string): { text: string; detail?: string } {
  const trimmed = text?.trim();
  if (!trimmed) return { text: fallback };
  return isRawOutput(trimmed) ? { text: fallback, detail: trimmed } : { text: trimmed };
}

/**
 * Why a helper's checks couldn't run, as the end of "couldn't be checked
 * because …". Main prefixes git's failures with "couldn't check, ", which the
 * sentence already says.
 */
export function checkFailureReason(error: string): { text: string; detail?: string } {
  const bare = error.replace(/^couldn[’']t check,\s*/i, '');
  const plain = plainFailure(bare, 'git couldn’t read its folder');
  return { text: plain.text.replace(/[.\s]+$/, ''), detail: plain.detail };
}

/** A short line for a helper row: what its folder holds that isn't saved. */
export function workSummary(checks: HelperDisposeChecks | undefined): string | null {
  if (!checks) return null;
  if (checks.error) return 'couldn’t check';
  const parts: string[] = [];
  if (checks.dirty > 0) parts.push(`${checks.dirty} uncommitted`);
  if (checks.unpushed > 0) parts.push(`${checks.unpushed > MAX_LISTED_COMMITS ? `${MAX_LISTED_COMMITS}+` : checks.unpushed} unpushed`);
  return parts.length > 0 ? parts.join(', ') : 'clean';
}

export interface CheckLine {
  /** `ok`, `risk` (work would be lost), `info` (doesn't block) or `failed` (couldn't run). */
  kind: 'ok' | 'risk' | 'info' | 'failed';
  text: string;
  /** The raw failure (git's output), for a tooltip. */
  detail?: string;
}

/** The checks as lines for a dispose dialog, worst first. */
export function checkLines(checks: HelperDisposeChecks): CheckLine[] {
  if (checks.error) {
    const reason = checkFailureReason(checks.error);
    return [{ kind: 'failed', text: `Couldn’t be checked because ${reason.text}`, ...(reason.detail && { detail: reason.detail }) }];
  }
  const lines: CheckLine[] = [
    checks.dirty > 0
      ? { kind: 'risk', text: `${plural(checks.dirty, 'file', 'files')} not committed` }
      : { kind: 'ok', text: 'No uncommitted files' },
    checks.unpushed > 0
      ? { kind: 'risk', text: commits(checks.unpushed, 'not pushed') }
      : { kind: 'ok', text: 'Every commit is pushed or on another branch' },
  ];
  if (checks.unmerged !== null) {
    lines.push(checks.unmerged > 0
      ? { kind: 'info', text: commits(checks.unmerged, 'not merged into the base branch') }
      : { kind: 'ok', text: 'Merged into the base branch' });
  }
  return lines.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

const ORDER: Record<CheckLine['kind'], number> = { failed: 0, risk: 1, info: 2, ok: 3 };

/** "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
