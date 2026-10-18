/**
 * Called after updateDurableConfig changes an agent's persona, with the
 * persona it had before. The orchestration policy (#2228) registers it,
 * since its defaults come from the persona. A module with no imports, so
 * agent-config and orchestration-policy can both load it in any order.
 */
export type PersonaChangeHook = (projectPath: string, agentId: string, previousPersona: string | undefined) => Promise<void>;

let hook: PersonaChangeHook | null = null;

export function setPersonaChangeHook(next: PersonaChangeHook | null): void {
  hook = next;
}

export async function notifyPersonaChanged(projectPath: string, agentId: string, previousPersona: string | undefined): Promise<void> {
  if (hook) await hook(projectPath, agentId, previousPersona);
}
