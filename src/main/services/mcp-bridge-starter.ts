/**
 * Starts the Clubhouse MCP bridge. The bridge always runs (the maintainer,
 * 2026-11-07): it starts with the app, and nothing turns it off. The IPC layer
 * owns its start and tool registration and hands its starter in here, so
 * services that need the bridge up (a spawn, start_helper) can ask for it
 * without importing the IPC layer.
 */

let startBridge: (() => void) | null = null;

/** Set by the IPC layer, which owns the bridge's start and its tool registration. */
export function setMcpBridgeStarter(starter: () => void): void {
  startBridge = starter;
}

/** Make sure the bridge is up. Idempotent, and retries a bridge that failed to start. */
export function ensureMcpBridge(): void {
  startBridge?.();
}

/** For testing. */
export function _resetMcpBridgeStarterForTesting(): void {
  startBridge = null;
}
