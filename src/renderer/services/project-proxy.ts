/**
 * Project Proxy — Routes IPC calls for remote agents through the Annex client (#866).
 *
 * When an agent ID starts with `remote:`, IPC calls are routed through
 * the Annex client WebSocket instead of local PTY/agent handlers.
 * This is transparent to UI components.
 */
import { isRemoteAgentId, parseNamespacedId } from '../stores/remoteProjectStore';
import { useAnnexClientStore } from '../stores/annexClientStore';

/**
 * Write data to an agent's PTY (local or remote).
 */
export function ptyWrite(agentId: string, data: string): void {
  const parsed = parseNamespacedId(agentId);
  if (parsed) {
    // Remote agent — send through Annex client
    useAnnexClientStore.getState().sendPtyInput(parsed.satelliteId, parsed.agentId, data);
  } else {
    // Local agent — use local IPC
    window.clubhouse.pty.write(agentId, data);
  }
}

/**
 * Resize an agent's PTY (local or remote).
 */
export function ptyResize(agentId: string, cols: number, rows: number): void {
  const parsed = parseNamespacedId(agentId);
  if (parsed) {
    useAnnexClientStore.getState().sendPtyResize(parsed.satelliteId, parsed.agentId, cols, rows);
  } else {
    window.clubhouse.pty.resize(agentId, cols, rows);
  }
}

/**
 * Kill an agent (local or remote).
 */
export function agentKill(agentId: string): void {
  const parsed = parseNamespacedId(agentId);
  if (parsed) {
    useAnnexClientStore.getState().sendAgentKill(parsed.satelliteId, parsed.agentId);
  } else {
    window.clubhouse.pty.kill(agentId);
  }
}

/**
 * Get the PTY buffer for an agent (local or remote).
 * Remote agents don't have a direct buffer — return empty string.
 */
export async function getBuffer(agentId: string): Promise<string> {
  if (isRemoteAgentId(agentId)) {
    // Remote agents receive buffer data via the snapshot and streaming events
    return '';
  }
  return window.clubhouse.pty.getBuffer(agentId);
}

/**
 * Check if an agent ID refers to a remote agent.
 */
export { isRemoteAgentId, parseNamespacedId } from '../stores/remoteProjectStore';
