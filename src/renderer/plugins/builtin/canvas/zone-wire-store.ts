/**
 * Zone wire definitions — conceptual wires between a zone and a target.
 *
 * A zone wire is "shorthand" for wiring every agent inside the zone to the
 * target; it expands into individual MCP bindings (see `zone-wire-expansion.ts`)
 * and renders as a single visual wire to the zone (see `wire-render-contract.ts`).
 *
 * The canvas store (`canvas-store.ts`) is the single source of truth for zone
 * wires — it persists them to storage and serialises them in the annex
 * snapshot so they survive the annex round-trip. This module only owns the
 * shape and id generation.
 */

export interface ZoneWireDefinition {
  id: string;
  /** The zone this wire originates from. */
  sourceZoneId: string;
  /** The target — could be a zone ID, agent ID, group-project ID, or browser view ID. */
  targetId: string;
  /** What the target is — determines how the wire expands. */
  targetType: 'zone' | 'agent' | 'group-project' | 'agent-queue' | 'browser';
}

export function generateZoneWireId(): string {
  return `zw_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
