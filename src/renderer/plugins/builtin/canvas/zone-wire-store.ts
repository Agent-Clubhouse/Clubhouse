/**
 * Zone wire store — manages zone-level wire definitions (conceptual wires
 * between zones and targets). These expand into individual MCP bindings.
 */

import { create } from 'zustand';

export interface ZoneWireDefinition {
  id: string;
  /** The zone this wire originates from. */
  sourceZoneId: string;
  /** The target — could be a zone ID, agent ID, group-project ID, or browser view ID. */
  targetId: string;
  /** What the target is — determines how the wire expands. */
  targetType: 'zone' | 'agent' | 'group-project' | 'agent-queue' | 'browser';
}

interface ZoneWireState {
  wires: ZoneWireDefinition[];
  addWire: (wire: Omit<ZoneWireDefinition, 'id'>) => ZoneWireDefinition;
  removeWire: (wireId: string) => void;
  removeWiresForZone: (zoneId: string) => void;
  removeWiresForTarget: (targetId: string) => void;
  loadWires: (wires: ZoneWireDefinition[]) => void;
}

function generateWireId(): string {
  return `zw_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export const useZoneWireStore = create<ZoneWireState>((set, get) => ({
  wires: [],

  addWire: (wire) => {
    // Deduplicate: skip if identical source+target already exists
    const existing = get().wires.find(
      (w) => w.sourceZoneId === wire.sourceZoneId && w.targetId === wire.targetId,
    );
    if (existing) return existing;

    const newWire: ZoneWireDefinition = { ...wire, id: generateWireId() };
    set((s) => ({ wires: [...s.wires, newWire] }));
    return newWire;
  },

  removeWire: (wireId) => {
    set((s) => ({ wires: s.wires.filter((w) => w.id !== wireId) }));
  },

  removeWiresForZone: (zoneId) => {
    set((s) => ({
      wires: s.wires.filter((w) => w.sourceZoneId !== zoneId && w.targetId !== zoneId),
    }));
  },

  removeWiresForTarget: (targetId) => {
    set((s) => ({
      wires: s.wires.filter((w) => w.targetId !== targetId && w.sourceZoneId !== targetId),
    }));
  },

  loadWires: (wires) => {
    set({ wires });
  },
}));
