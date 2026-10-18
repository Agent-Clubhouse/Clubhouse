/**
 * Agent runtime registry: the one place call sites get an AgentRuntime for a
 * live agent, whether it runs in a terminal or in chat
 * (docs/structured-chat-research.md §7.2).
 */

import * as ptyManager from '../pty-manager';
import { agentRegistry } from '../agent-registry';
import type { AgentRuntime } from '../../../shared/chat';
import { PtyAgentRuntime } from './pty-runtime';

const chatRuntimes = new Map<string, AgentRuntime>();

export function registerChatRuntime(runtime: AgentRuntime): void {
  chatRuntimes.set(runtime.agentId, runtime);
}

export function unregisterChatRuntime(agentId: string, runtime?: AgentRuntime): void {
  if (!runtime || chatRuntimes.get(agentId) === runtime) chatRuntimes.delete(agentId);
}

/**
 * Runtime for a live agent: its chat runtime, or a PTY runtime when a
 * terminal is running. Headless and sleeping agents have none.
 */
export function getAgentRuntime(agentId: string): AgentRuntime | undefined {
  const chat = chatRuntimes.get(agentId);
  if (chat) return chat;
  // Same test the call sites used before the seam: the registry says it's a
  // terminal agent. Unregistered PTYs (e.g. during spawn) fall back to liveness.
  const reg = agentRegistry.get(agentId);
  if (reg) return reg.runtime === 'pty' ? new PtyAgentRuntime(agentId) : undefined;
  if (ptyManager.isRunning(agentId)) return new PtyAgentRuntime(agentId);
  return undefined;
}

export function isChatAgent(agentId: string): boolean {
  const runtime = chatRuntimes.get(agentId);
  return !!runtime && runtime.isRunning();
}

/**
 * Stop every chat runtime in parallel. Each stop closes its driver, settles
 * pending permissions and writes the session's end, so it resolves once that
 * end is in the transcript. A failed stop doesn't hold up the others.
 */
export async function stopAllChatRuntimes(): Promise<void> {
  const results = await Promise.allSettled([...chatRuntimes.values()].map((runtime) => runtime.stop()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) {
    const reasons = failed.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    throw new Error(`${failed.length} chat runtime(s) failed to stop: ${reasons.join('; ')}`);
  }
}

/** For tests. */
export function clearChatRuntimes(): void {
  chatRuntimes.clear();
}

export { PtyAgentRuntime } from './pty-runtime';
export { ChatAgentRuntime } from './chat-runtime';
export { onChatEvent, publishChatEvent } from './chat-event-bus';
export { readChatTranscript, listChatSessions } from './chat-transcript';
export { registerChatDriver, resolveChatDriver } from './chat-drivers';
