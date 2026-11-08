/**
 * Preview's settings summary for a managed agent (#2895): the settings that
 * aren't parts, in words. Main builds it for an agent, for a New agent draft
 * and for what a running session started with, so all three read the same.
 */
import type { ManagedSettingsRow } from './managed-agents-types';
import { accessLabel, type AccessLevel } from './agent-access';
import { resolveOrchestrationPolicy, type OrchestrationControl, type OrchestrationPolicyConfig } from './orchestration-policy';

const APPROVALS: Readonly<Record<OrchestrationControl, string>> = {
  'hands-off': 'no approvals',
  'ask-before-start': 'asks before starting',
  'ask-everything': 'asks for everything',
};

export interface ManagedSettingsSummaryInput {
  /** The CLI's display name. */
  cliName?: string;
  model?: string;
  effort?: string;
  /** Access (#2761). Unset reads as Ask first. */
  access?: AccessLevel;
  /** The lower level the agent starts at, when its CLI has no start for `access` in that runtime (#3004). */
  accessStartsAt?: { level: AccessLevel; runtime: 'chat' | 'terminal' };
  orchestration?: OrchestrationPolicyConfig;
  /** The helper template's name: the agent's own, else the app's default. */
  helperTemplateName?: string;
  /** A helper never orchestrates or connects to the Dispatcher. */
  helper?: boolean;
}

/** "Auto", "Auto, starts at Ask first in the terminal", or a helper's "…, never above its orchestrator". */
function accessValue(input: ManagedSettingsSummaryInput): string {
  const notes = [
    ...(input.accessStartsAt ? [`starts at ${accessLabel(input.accessStartsAt.level)} in ${input.accessStartsAt.runtime === 'chat' ? 'chat' : 'the terminal'}`] : []),
    ...(input.helper ? ['never above its orchestrator'] : []),
  ];
  return [accessLabel(input.access ?? 'ask'), ...notes].join(', ');
}

export function managedSettingsSummary(input: ManagedSettingsSummaryInput): ManagedSettingsRow[] {
  const policy = resolveOrchestrationPolicy(input.orchestration, { helper: input.helper });
  const rows: ManagedSettingsRow[] = [
    { key: 'cli', label: 'CLI', value: input.cliName || 'The project\'s CLI' },
    { key: 'model', label: 'Model', value: input.model && input.model !== 'default' ? input.model : 'CLI default' },
    { key: 'effort', label: 'Effort', value: input.effort || 'CLI default' },
    { key: 'access', label: 'Access', value: accessValue(input) },
    { key: 'orchestration', label: 'Orchestration', value: policy.orchestrate ? 'Can start helpers' : 'Off' },
  ];
  if (policy.orchestrate) {
    const selection = policy.sources.autoHelpers === 'agent'
      ? (policy.autoHelpers ? 'Smart selection' : 'fixed selection')
      : 'selection from the app setting';
    rows.push({ key: 'helpers', label: 'Helpers', value: [`Up to ${policy.maxHelpers} at once`, selection, APPROVALS[policy.control]].join(', ') });
    // Its own row: it reaches a running agent at once, so "Running now" never shows it waiting (D83).
    if (input.helperTemplateName) rows.push({ key: 'helperTemplate', label: 'Helper template', value: input.helperTemplateName });
  }
  if (!input.helper) rows.push({ key: 'dispatcher', label: 'Dispatcher', value: policy.connectToDispatcher ? 'Connected' : 'Not connected' });
  return rows;
}
