/**
 * Helper presets from a phone (#2671): the page's data and `helperRouting.update`,
 * through the same service as Settings > Helpers. App-wide preset editing is a
 * person's action. See docs/mobile-control-v1.md#helper-presets.
 *
 * The capability lists only what works now, so a phone can't offer Auto early.
 */

import {
  HELPER_DIFFICULTIES,
  HELPER_ROUTING_FALLBACKS,
  HELPER_ROUTING_MODES,
  HELPER_ROUTING_REASONS,
  PRESET_CELL_STATES,
  describeRouting,
  routingLabel,
  type HelperRouting,
  type HelperRoutingSettings,
  type HelperRoutingUpdate,
} from '../../shared/helper-routing';
import type { DurableAgentConfig } from '../../shared/types';
import { HelperRoutingError, readHelperRouting, updateHelperPresets } from './helper-routing';
import { MobileControlError } from './mobile-control';
import { activeDispatcher, isDisabledDispatcherId } from './mobile-dispatcher';
import { resolveOrchestrationPolicies } from './orchestration-policy';

export const HELPER_ROUTING_CHANGED_EVENT = 'helper_routing:changed';
export const HELPER_ROUTING_PATH = '/api/v1/mobile/helper-routing';

/** The capabilities' `helperRouting`. */
export function helperRoutingCapability() {
  return {
    version: 1 as const,
    path: HELPER_ROUTING_PATH,
    modes: HELPER_ROUTING_MODES,
    scopes: ['app'] as const,
    quota: false,
    commands: ['helperRouting.update'] as const,
    snapshotField: 'helperRoutingRevision',
    event: HELPER_ROUTING_CHANGED_EVENT,
    difficulties: HELPER_DIFFICULTIES,
    reasons: HELPER_ROUTING_REASONS,
    fallbacks: HELPER_ROUTING_FALLBACKS,
    cellStates: PRESET_CELL_STATES,
  };
}

type AgentLookup = { project: { path: string }; config: DurableAgentConfig } | null | undefined;

/** Whether this agent can use presets, for a page opened from it. */
async function agentUse(agentId: string, info: AgentLookup): Promise<HelperRoutingSettings['agent']> {
  if (activeDispatcher(agentId) || isDisabledDispatcherId(agentId)) return { usable: false, reason: 'dispatcher_locked' };
  if (!info) return { usable: false };
  const policy = (await resolveOrchestrationPolicies(info.project.path, [info.config])).get(info.config.id);
  if (policy?.mcpOff) return { usable: false, reason: 'mcp_off' };
  if (!policy?.orchestrate) return { usable: false, reason: 'orchestration_off' };
  return { usable: true };
}

/**
 * The route's body. No `agentId` or `projectId` reads app-wide. Either way every
 * label family comes back, so a client can cache them once per revision.
 * `projectId` or `agentId` reads the model lists under that project's profile.
 */
export async function mobileHelperRouting(options: { projectPath?: string; agentId?: string; agent?: AgentLookup }): Promise<HelperRoutingSettings> {
  const settings = await readHelperRouting({ ...(options.projectPath && { projectPath: options.projectPath }) });
  if (!options.agentId) return settings;
  return { ...settings, agent: await agentUse(options.agentId, options.agent) };
}

const STATUS: Record<HelperRoutingError['code'], number> = {
  invalid_helper_routing: 400,
  helper_routing_stale: 409,
  model_unavailable: 409,
  effort_unavailable: 409,
};

/** helperRouting.update. A refused write changes nothing; a stale one also carries fresh values. */
export async function runHelperRoutingUpdate(
  command: HelperRoutingUpdate & { scope: string },
  assertAuthorized: () => void,
): Promise<HelperRoutingSettings> {
  if (command.scope !== 'app') {
    throw new MobileControlError('invalid_helper_routing', 400, 'rejected', 'Presets can only be changed app-wide.');
  }
  assertAuthorized();
  try {
    return await updateHelperPresets({ revision: command.revision, cells: command.cells, reset: command.reset }, { surface: 'mobile' });
  } catch (err) {
    if (!(err instanceof HelperRoutingError)) throw err;
    throw new MobileControlError(err.code, STATUS[err.code], 'rejected', err.message,
      err.settings ? { revision: err.settings.revision, settings: err.settings } : undefined);
  }
}

/** A helper's `routing` in its settings, with the words resolved. */
export function mobileHelperRoutingDetail(routing: HelperRouting | undefined) {
  if (!routing) return undefined;
  return {
    ...routing,
    display: {
      summary: describeRouting(routing),
      reason: routingLabel('reason', routing.reason),
      ...(routing.fallback !== 'none' && { fallback: routingLabel('fallback', routing.fallback) }),
    },
  };
}
