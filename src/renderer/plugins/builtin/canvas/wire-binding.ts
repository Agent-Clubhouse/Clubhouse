// ── Live binding for a wire definition ───────────────────────────────
//
// The one way a canvas wire definition becomes a live MCP binding: bind, then
// apply the wire's instructions and disabled tools. Used when wires are
// restored on load (canvas-store loadWires) and when the reconcile loop
// recreates a missing binding (main.ts), so a binding never comes up without
// the restrictions its wire carries (#2070).

import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

export async function bindWireDefinition(def: McpBindingEntry): Promise<void> {
  await window.clubhouse.mcpBinding.bind(def.agentId, {
    targetId: def.targetId,
    targetKind: def.targetKind,
    label: def.label,
    agentName: def.agentName,
    targetName: def.targetName,
    projectName: def.projectName,
  });
  if (def.instructions && Object.keys(def.instructions).length > 0) {
    await window.clubhouse.mcpBinding.setInstructions(def.agentId, def.targetId, def.instructions);
  }
  if (def.disabledTools && def.disabledTools.length > 0) {
    await window.clubhouse.mcpBinding.setDisabledTools(def.agentId, def.targetId, def.disabledTools);
  }
}
