/**
 * Persona change notifications for the orchestration policy (#2228), whose
 * defaults come from the persona. A module with no imports, so agent-config,
 * agent-settings-service and orchestration-policy can load it in any order.
 *
 * - An agent's own persona changed (updateDurableConfig): `previousPersona`
 *   is what it had before.
 * - The project's default persona changed (writeProjectAgentDefaults):
 *   `previousDefault` is the old default; it affects agents without their own.
 *
 * The orchestration policy owns the hook, which runs first. Anything else
 * that derives state from the policy (Dispatcher wires, #2537) listens with
 * {@link onPersonaChanged} and hears about the change once the hook is done.
 */
export type PersonaChange =
  | { kind: 'agent'; projectPath: string; agentId: string; previousPersona: string | undefined }
  | { kind: 'project-default'; projectPath: string; previousDefault: string | undefined };

export type PersonaChangeHook = (change: PersonaChange) => Promise<void>;

let hook: PersonaChangeHook | null = null;
const listeners = new Set<(change: PersonaChange) => void>();

export function setPersonaChangeHook(next: PersonaChangeHook | null): void {
  hook = next;
}

/** Called after the hook for every persona change. Returns an unsubscribe function. */
export function onPersonaChanged(listener: (change: PersonaChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function notify(change: PersonaChange): Promise<void> {
  try {
    if (hook) await hook(change);
  } finally {
    for (const listener of listeners) {
      try { listener(change); } catch { /* telemetry-exempt: a listener must not fail the persona write */ }
    }
  }
}

export async function notifyPersonaChanged(projectPath: string, agentId: string, previousPersona: string | undefined): Promise<void> {
  await notify({ kind: 'agent', projectPath, agentId, previousPersona });
}

export async function notifyProjectDefaultPersonaChanged(projectPath: string, previousDefault: string | undefined): Promise<void> {
  await notify({ kind: 'project-default', projectPath, previousDefault });
}
