/**
 * Dispose requests waiting on the user (#2229, #2232). Under "ask-everything"
 * dispose_helper sends the request to the renderer instead of disposing; this
 * records it, so the user's answer can be reported to that orchestrator once,
 * and only for a request main actually sent. Kept in memory: a request from
 * before a restart has no orchestrator turn left to answer.
 */

import * as path from 'path';

const pending = new Map<string, string>();

function key(projectPath: string, helperId: string): string {
  return `${path.resolve(projectPath)}\0${helperId}`;
}

/** Note that `orchestratorId` asked the user to decide about disposing `helperId`. A newer request replaces an older one. */
export function recordDisposeRequest(projectPath: string, helperId: string, orchestratorId: string): void {
  pending.set(key(projectPath, helperId), orchestratorId);
}

/**
 * Use up the pending request for this helper from this orchestrator. True
 * once per recorded request; false when there is none, or it was another
 * orchestrator's.
 */
export function takeDisposeRequest(projectPath: string, helperId: string, orchestratorId: string): boolean {
  const k = key(projectPath, helperId);
  if (pending.get(k) !== orchestratorId) return false;
  pending.delete(k);
  return true;
}

export function _resetDisposeRequestsForTesting(): void {
  pending.clear();
}
