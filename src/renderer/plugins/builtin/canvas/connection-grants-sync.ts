/**
 * Keep each canvas's copy of a wire's disabled tools in step with the
 * connection store (D129). The store is the source of truth; the copy on the
 * wire definition is what an older build reads, so a tool turned off on the
 * Connections card is off there too. Only canvases loaded in this window are
 * updated; one that isn't loaded is brought in step the next time its wire is
 * bound (main's store wins over the copy).
 */

import type { McpBindingEntry } from '../../../stores/mcpBindingStore';

interface WireStore {
  getState(): {
    wireDefinitions: McpBindingEntry[];
    updateWireDefinition: (agentId: string, targetId: string, updates: Partial<McpBindingEntry>) => void;
  };
}

const same = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((t) => b.includes(t));

/** Apply one direction's list to every loaded canvas that has that wire. */
export function syncWireTools(stores: readonly WireStore[], from: string, to: string, disabledTools: string[]): void {
  for (const store of stores) {
    const def = store.getState().wireDefinitions.find((w) => w.agentId === from && w.targetId === to);
    if (def && !same(def.disabledTools, disabledTools)) store.getState().updateWireDefinition(from, to, { disabledTools });
  }
}
