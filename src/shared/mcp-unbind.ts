/**
 * Why the renderer asks main to unbind an MCP binding.
 *
 * `canvas-cleanup`: the canvas is tidying up wires it displayed (a card or a
 * canvas tab closed, a zone member left), not the user deleting the wire.
 * Main keeps a binding a persisted source still lists, such as an
 * orchestrator ↔ helper wire (#2225), and answers `{ kept: true }`.
 * No cause: the user deleted the wire itself; it is always unbound.
 */
export const MCP_UNBIND_CANVAS_CLEANUP = 'canvas-cleanup';
export type McpUnbindCause = typeof MCP_UNBIND_CANVAS_CLEANUP;

export interface McpUnbindResult {
  /** True when main kept the binding instead of unbinding it. */
  kept: boolean;
  /**
   * The wire is gone, but the removal of a Dispatcher-made link couldn't be saved
   * anywhere, so that link could come back if the app restarts before it can be.
   */
  removalNotSaved?: boolean;
}
