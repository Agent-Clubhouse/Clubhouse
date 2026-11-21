/** Pure labels shared by local controls and host read-only Details. */
import type { AgentAccessLevel, OrchestrationAccess, OrchestrationControl, HelperAutoOffReason, HelperAccessResolution } from './orchestration-policy';
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

/** The note under the access control: the live ceiling, or the rule when it isn't running. */
export function accessNote(access: HelperAccessResolution | null, running: boolean, name: string): string {
  if (!running || !access) return `Never more than ${name}’s level when a helper starts.`;
  // The five-level levels where known (#3000), so Plan reads as Plan.
  const ceiling = access.ceilingAccess ? PERMISSION_LEVEL_LABELS[access.ceilingAccess] : ACCESS_LEVEL_LABELS[access.ceiling];
  if (access.clamped) return `${name} runs at ${ceiling} now, so helpers get ${ACCESS_LEVEL_LABELS[access.level]}.`;
  return `At most ${ceiling}, ${name}’s level now.`;
}
