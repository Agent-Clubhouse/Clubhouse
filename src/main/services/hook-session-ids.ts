/**
 * Native session ids a CLI reported through its hooks (#3795), for CLIs that
 * print none to the terminal. Antigravity's hook payloads carry
 * `conversationId`. In memory only: the id is saved through the normal session
 * capture when the run ends, like an id scraped from output.
 */

interface Reported {
  provider: string;
  sessionId: string;
  at: number;
}

const reported = new Map<string, Reported>();

/** The latest id the agent's hooks reported. Hooks reach the hook server only with that launch's nonce. */
export function noteHookSessionId(agentId: string, provider: string, sessionId: string, at = Date.now()): void {
  reported.set(agentId, { provider, sessionId, at });
}

/**
 * The id reported by `provider`'s hooks since `since` (epoch ms), cleared
 * once read, so a later run never picks up an earlier run's id.
 */
export function takeHookSessionId(agentId: string, provider: string, since: number): string | undefined {
  const entry = reported.get(agentId);
  reported.delete(agentId);
  return entry && entry.provider === provider && entry.at >= since ? entry.sessionId : undefined;
}

/** For tests. */
export function clearHookSessionIds(): void {
  reported.clear();
}
