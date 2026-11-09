/**
 * No agent sets Access above its own running level (D126, fixed rule 2 of
 * the permission model). It covers every way an agent's call decides another
 * agent's Access: creating an agent, a template push, starting a helper, and
 * the Dispatcher too. People in the app aren't agents and aren't limited.
 *
 * A call that names a level above the caller's, or that would leave an agent
 * above it through a template or the default for new agents, is refused with
 * both levels named. Access isn't a Clubhouse permission, so there is nothing
 * to ask for with request_grant: the refusal says to use a lower level or to
 * ask the user.
 */

import { accessLabel, ACCESS_LEVELS, type AccessLevel } from '../../../shared/agent-access';
import { fiveLevelOf } from '../../../shared/orchestration-policy';
import { agentRegistry } from '../agent-registry';

/** The level the agent runs at now. One that isn't running, or unknown, reads as Ask first. */
export function callerRunningAccess(agentId: string): AccessLevel {
  const launch = agentRegistry.get(agentId)?.launchAccess;
  return launch ? fiveLevelOf(launch) : 'ask';
}

export function accessAbove(level: AccessLevel, ceiling: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(level) > ACCESS_LEVELS.indexOf(ceiling);
}

/**
 * Null when `level` is at or below the caller's own, else the refusal.
 * `what` finishes "you can't …", for example "create an agent" or "start a helper";
 * `from` says where the level came from when the caller didn't name it, and
 * `fix` replaces the default way forward.
 */
export function accessCeilingRefusal(agentId: string, level: AccessLevel | undefined, what: string, opts: { from?: string; fix?: string } = {}): string | null {
  if (!level) return null;
  const own = callerRunningAccess(agentId);
  if (!accessAbove(level, own)) return null;
  const source = opts.from ? ` ${opts.from} sets ${accessLabel(level)}.` : '';
  const fix = opts.fix ?? `Use ${accessLabel(own)} or lower, or ask the user to set it.`;
  return `You run at ${accessLabel(own)}, so you can't ${what} at ${accessLabel(level)}: an agent never sets Access above its own.${source} ${fix}`;
}
