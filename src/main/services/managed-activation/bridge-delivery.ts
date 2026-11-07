/**
 * Whether the managed terminal path delivers the Clubhouse MCP bridge. The
 * bridge always runs and every agent gets it (D69), but this path doesn't
 * snapshot, inject or restore MCP files yet (docs/managed-activation.md), so
 * activation refuses with activation_incompatible_config until it does.
 */
export function managedPathDeliversMcpBridge(): boolean {
  return false;
}
