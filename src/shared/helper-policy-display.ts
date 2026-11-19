/** Pure labels shared by local controls and host read-only Details. */
import type { AgentAccessLevel, OrchestrationAccess, OrchestrationControl, HelperAutoOffReason } from './orchestration-policy';
import { PERMISSION_LEVEL_LABELS } from './chat/capabilities';

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

export const AUTO_LOCKED_NOTES: Partial<Record<HelperAutoOffReason, string>> = { project_off: 'This project turned it off.' };
