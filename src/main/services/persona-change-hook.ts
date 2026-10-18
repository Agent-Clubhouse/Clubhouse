/**
 * Persona change notifications for the orchestration policy (#2228), whose
 * defaults come from the persona. A module with no imports, so agent-config,
 * agent-settings-service and orchestration-policy can load it in any order.
 *
 * - An agent's own persona changed (updateDurableConfig): `previousPersona`
 *   is what it had before.
 * - The project's default persona changed (writeProjectAgentDefaults):
 *   `previousDefault` is the old default; it affects agents without their own.
 */
export type PersonaChange =
  | { kind: 'agent'; projectPath: string; agentId: string; previousPersona: string | undefined }
  | { kind: 'project-default'; projectPath: string; previousDefault: string | undefined };

export type PersonaChangeHook = (change: PersonaChange) => Promise<void>;

let hook: PersonaChangeHook | null = null;

export function setPersonaChangeHook(next: PersonaChangeHook | null): void {
  hook = next;
}

export async function notifyPersonaChanged(projectPath: string, agentId: string, previousPersona: string | undefined): Promise<void> {
  if (hook) await hook({ kind: 'agent', projectPath, agentId, previousPersona });
}

export async function notifyProjectDefaultPersonaChanged(projectPath: string, previousDefault: string | undefined): Promise<void> {
  if (hook) await hook({ kind: 'project-default', projectPath, previousDefault });
}
