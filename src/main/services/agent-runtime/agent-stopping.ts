/**
 * Thrown by a terminal agent's sendMessage when the agent was told to stop and
 * its process has not exited yet: anything written now would be lost. Callers
 * report it as not delivered.
 *
 * Kept in its own module, with no imports, so callers can recognise the
 * refusal even where tests replace the runtime modules.
 */
export class AgentStoppingError extends Error {
  readonly code = 'agent_stopping';
  constructor(readonly agentId: string) {
    super('The agent is shutting down, so the message was not delivered.');
    this.name = 'AgentStoppingError';
  }
}

/** Whether `err` is a send refused because the agent is shutting down. */
export function isAgentStoppingError(err: unknown): err is AgentStoppingError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'agent_stopping';
}
