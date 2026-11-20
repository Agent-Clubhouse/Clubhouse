/** Selected, passive orchestration display facts; no gate, launch, recovery or provider calls. */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfigTarget } from './agent-config-reader';
import { decideHelperAuto, normalizeOrchestrationConfig, ORCHESTRATION_DEFAULTS, resolveOrchestrationPolicy, type OrchestrationPolicy, type ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';
import { DISPLAY_SETTINGS_MAX_BYTES, agentDisplayInput, type DisplayReceipt, type DisplayValue } from './display-settings';
import { peekMetadataFileForDisplaySync } from './settings-store';
import { readAutoHelpersForDisplay, readGlobalHelperCapForDisplay } from './orchestration-settings';

type PolicyFields = { [K in keyof OrchestrationPolicy]: DisplayValue<OrchestrationPolicy[K]> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Project files may only turn Auto off. Backup-only/corrupt sources remain unknown. */
export function readProjectHelperAutoOffForDisplay(projectPath: string, options: { receipts?: DisplayReceipt[] } = {}): DisplayValue<boolean> {
  const read = (): DisplayValue<boolean> => {
    const inputs = [{ field: 'Project helper Auto restriction', source: 'primary' as const, observedAt: Date.now() }];
    const file = path.join(projectPath, '.clubhouse', 'settings.json');
    const raw = peekMetadataFileForDisplaySync(file, DISPLAY_SETTINGS_MAX_BYTES);
    if (raw === 'unreadable') return { state: 'unavailable', inputs };
    if (raw === 'missing') {
      try {
        if (!fs.statSync(projectPath).isDirectory()) return { state: 'unavailable', inputs };
        // The ordinary project-default reader can recover from this backup.
        // Display must not silently pretend the restriction is absent.
        fs.lstatSync(file + '.bak'); return { state: 'unavailable', inputs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unavailable', inputs };
        try { if (!fs.statSync(projectPath).isDirectory()) return { state: 'unavailable', inputs }; } catch { return { state: 'unavailable', inputs }; }
        return { state: 'ok', value: false, inputs };
      }
    }
    const defaults = raw.agentDefaults;
    if (defaults !== undefined && !record(defaults)) return { state: 'unavailable', inputs };
    const value = record(defaults) ? defaults.helperAuto : undefined;
    if (value !== undefined && value !== 'off') return { state: 'unavailable', inputs };
    return { state: 'ok', value: value === 'off', inputs };
  };
  const result = read();
  if (options.receipts) {
    const signature = JSON.stringify({ state: result.state, value: result.state === 'ok' ? result.value : undefined });
    options.receipts.push({ current: () => { try { const now = read(); return JSON.stringify({ state: now.state, value: now.state === 'ok' ? now.value : undefined }) === signature; } catch { return false; } } });
  }
  return result;
}

/** The same validated saved agent fields, without project/global settings reads. */
function projectOrchestrationAgentFields(agent: { orchestration?: unknown; parentAgentId?: unknown }): {
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
  const { fields, sources } = projectOrchestrationAgentFields(agent);
  return { fields, sources };
}

/** Use the already admitted config. Malformed fields never turn into false/default values. */
export function readOrchestrationForDisplay(target: AgentConfigTarget, options: { receipts?: DisplayReceipt[] } = {}): {
  fields: PolicyFields; sources: Partial<ResolvedOrchestrationPolicy['sources']>; globalCap: DisplayValue<number>;
  autoEffective: DisplayValue<NonNullable<ResolvedOrchestrationPolicy['autoEffective']>>;
} {
  const { policy, fields, sources } = projectOrchestrationAgentFields(target.agent);
  const project = readProjectHelperAutoOffForDisplay(target.project.path, options), app = readAutoHelpersForDisplay(options), globalCap = readGlobalHelperCapForDisplay(options);
  const inputs = [...fields.orchestrate.inputs, ...fields.autoHelpers.inputs, ...project.inputs, ...app.inputs];
  let autoEffective: DisplayValue<NonNullable<ResolvedOrchestrationPolicy['autoEffective']>> = { state: 'unavailable', inputs };
  if (project.state === 'ok' && project.value) {
    autoEffective = { state: 'ok', value: decideHelperAuto({ projectOff: true, app: false }), inputs };
  } else if (project.state === 'ok' && fields.orchestrate.state === 'ok' && fields.autoHelpers.state === 'ok'
    && (app.state === 'ok' || policy.sources.autoHelpers === 'agent')) {
    autoEffective = { state: 'ok', value: decideHelperAuto({ projectOff: false, app: app.state === 'ok' ? app.value : false,
      policy: { orchestrate: fields.orchestrate.value, autoHelpers: fields.autoHelpers.value, sources: policy.sources } }), inputs };
  }
  return { fields, sources, globalCap, autoEffective };
}
