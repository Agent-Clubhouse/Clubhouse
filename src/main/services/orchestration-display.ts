/** Selected, passive orchestration display facts; no gate, launch, recovery or provider calls. */
import { resolveAgentOrchestrationDisplay, type PolicyFields } from './orchestration-agent-fields';
export { projectOrchestrationAgentFieldsForDisplay } from './orchestration-agent-fields';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfigTarget } from './agent-config-reader';
import { decideHelperAuto, type ResolvedOrchestrationPolicy } from '../../shared/orchestration-policy';
import { DISPLAY_SETTINGS_MAX_BYTES, type DisplayReceipt, type DisplayValue } from './display-settings';
import { peekMetadataFileForDisplaySync } from './settings-store';
import { readAutoHelpersForDisplay, readGlobalHelperCapForDisplay } from './orchestration-settings';


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

/** Use the already admitted config. Malformed fields never turn into false/default values. */
export function readOrchestrationForDisplay(target: AgentConfigTarget, options: { receipts?: DisplayReceipt[] } = {}): {
  fields: PolicyFields; sources: Partial<ResolvedOrchestrationPolicy['sources']>; globalCap: DisplayValue<number>;
  autoEffective: DisplayValue<NonNullable<ResolvedOrchestrationPolicy['autoEffective']>>;
} {
  const { policy, fields, sources } = resolveAgentOrchestrationDisplay(target.agent);
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
