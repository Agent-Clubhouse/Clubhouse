/**
 * Canvas MCP tools — REMOVED.
 *
 * Global canvas tools were a scoping leak: they exposed canvas operations to
 * ALL agents. The assistant already has properly scoped canvas tools registered
 * via registerToolTemplate('assistant', ...) in assistant-tools.ts.
 *
 * This file is intentionally empty. The registerCanvasTools export is retained
 * as a no-op so any stale imports don't break at runtime.
 *
 * @see https://github.com/Agent-Clubhouse/Clubhouse/issues/238
 */

/** No-op — global canvas tools have been removed. */
export function registerCanvasTools(): void {
  // Intentionally empty: canvas tools are now assistant-scoped only.
}
