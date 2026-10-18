// ── Live binding for a wire definition ───────────────────────────────
//
// The one way a canvas wire definition becomes a live MCP binding: bind, then
// apply the wire's instructions and disabled tools. Used when wires are
// restored on load (canvas-store loadWires) and when the reconcile loop
// recreates a missing binding (main.ts), so a binding never comes up without
// the restrictions its wire carries (#2070).

import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

/**
 * `current` returns the wire's definition as it is now. Instructions and
 * disabled tools are read from it after bind resolves, so an edit made in the
 * meantime (the wire popover) isn't overwritten with the captured copy; when it
 * returns undefined the wire was removed and nothing more is applied.
 */
export async function bindWireDefinition(def: McpBindingEntry, current: () => McpBindingEntry | undefined = () => def): Promise<void> {
  await window.clubhouse.mcpBinding.bind(def.agentId, {
    targetId: def.targetId,
    targetKind: def.targetKind,
    label: def.label,
    agentName: def.agentName,
    targetName: def.targetName,
    projectName: def.projectName,
  });
  const latest = current();
  if (!latest) return;
  if (latest.instructions && Object.keys(latest.instructions).length > 0) {
    await window.clubhouse.mcpBinding.setInstructions(def.agentId, def.targetId, latest.instructions);
  }
  if (latest.disabledTools && latest.disabledTools.length > 0) {
    await window.clubhouse.mcpBinding.setDisabledTools(def.agentId, def.targetId, latest.disabledTools);
  }
}
