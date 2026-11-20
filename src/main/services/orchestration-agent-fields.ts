/** Pure bounded field model; no service/store/provider imports or I/O. */
import { normalizeOrchestrationConfig, ORCHESTRATION_DEFAULTS, resolveOrchestrationPolicy, type OrchestrationPolicy, type ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';
import type { DisplayValue } from './display-settings';
export type PolicyFields = { [K in keyof OrchestrationPolicy]: DisplayValue<OrchestrationPolicy[K]> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const agentDisplayInput = (field: string) => ({ field, source: 'agent' as const, observedAt: Date.now() });

/** The same validated saved agent fields, without project/global settings reads. */
export function resolveAgentOrchestrationDisplay(agent: { orchestration?: unknown; parentAgentId?: unknown }): {
  policy: ResolvedOrchestrationPolicy; fields: PolicyFields; sources: Partial<ResolvedOrchestrationPolicy['sources']>;
} {
  const raw: unknown = agent.orchestration;
  const shape = raw === undefined || record(raw), selected = record(raw) ? raw : {};
  const parent: unknown = agent.parentAgentId, helper = typeof parent === 'string' && !!parent;
  const roleKnown = parent === undefined || typeof parent === 'string';
  const policy = resolveOrchestrationPolicy(shape ? normalizeOrchestrationConfig(selected) : undefined, { helper });
  const keys = Object.keys(ORCHESTRATION_DEFAULTS) as Array<keyof OrchestrationPolicy>;
  const valid = (key: keyof OrchestrationPolicy) => selected[key] === undefined || normalizeOrchestrationConfig({ [key]: selected[key] })?.[key] !== undefined;
  const fields = Object.fromEntries(keys.map((key) => {
    const inputs = [agentDisplayInput(`Agent orchestration ${key}`)];
    const known = key === 'connectToDispatcher' && helper ? true : shape && valid(key)
      && (key !== 'connectToDispatcher' || roleKnown && (policy.sources.connectToDispatcher !== 'default' || valid('orchestrate')));
    return [key, known ? { state: 'ok', value: policy[key], inputs } : { state: 'unavailable', inputs }];
  })) as PolicyFields;
  const sources = Object.fromEntries(keys.filter((key) => fields[key].state === 'ok').map((key) => [key, policy.sources[key]])) as Partial<ResolvedOrchestrationPolicy['sources']>;
  return { policy, fields, sources };
}

/** Validated fields only: callers cannot consume fallback policy values for unknown metadata. */
export function projectOrchestrationAgentFieldsForDisplay(agent: { orchestration?: unknown; parentAgentId?: unknown }): {
  fields: PolicyFields; sources: Partial<ResolvedOrchestrationPolicy['sources']>;
} {
  const { fields, sources } = resolveAgentOrchestrationDisplay(agent);
  return { fields, sources };
}
