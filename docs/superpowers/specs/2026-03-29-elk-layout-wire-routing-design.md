# ELK-Based Canvas Layout & Wire Routing

## Goal

Add ELK (Eclipse Layout Kernel) as a layout option for the canvas, providing intelligent node placement that minimizes edge crossings and spline-based wire routing that avoids nodes and spaces parallel wires apart.

## Architecture

**New dependency:** `elkjs` — JavaScript port of Eclipse Layout Kernel. Runs async (wasm-based).

**New file:** `src/main/services/clubhouse-mcp/elk-layout.ts` — pure function that converts cards + edges into ELK's graph format, runs the layout, and returns node positions + routed edge spline paths.

**Integration points:**
- `canvas-layout.ts` — `'elk'` added to the `computeLayout` pattern union.
- `layout_canvas` MCP tool — agents request `pattern: 'elk'` for ELK-routed layouts.
- `WireOverlay.tsx` — uses stored `routedPath` from ELK instead of direct bezier when available.

**Data flow:**
1. User/agent triggers `layout_canvas` with `pattern: 'elk'`
2. `elk-layout.ts` converts cards + wireDefinitions into ELK graph (nodes with width/height, edges with source/target)
3. ELK runs with `elk.layered` algorithm, `edgeRouting: 'SPLINES'`
4. Results return as node positions + edge bend points
5. Node positions applied via existing `moveViews()` store action
6. Edge bend points converted to SVG path strings and stored as `routedPath` on each wire definition
7. `WireOverlay` renders `routedPath` when present, falls back to direct bezier otherwise

## ELK Configuration

- **Algorithm:** `elk.layered` (Sugiyama-style, best for directed graphs)
- **Edge routing:** `SPLINES` (smooth curves routed around nodes)
- **Node spacing:** `60` (matches existing SPACING constant)
- **Edge-edge spacing:** `20` (prevents parallel wire overlap)
- **Direction:** `RIGHT` (left-to-right flow for agent pipelines)
- **Port constraints:** `FIXED_SIDE` (ELK picks exit side per edge)

**Zone handling:** Canvas zones map to ELK compound nodes (parent containing children). ELK keeps children inside parent bounds.

## Routed Edge Path Storage

Add optional `routedPath?: string` field to `McpBindingEntry`. Contains the SVG path string computed from ELK's spline bend points.

- **Set** by `elk-layout.ts` after layout completes, via `updateWireDefinition()`
- **Cleared** when the user manually moves a node (routed paths become stale)
- **Used** by `WireOverlay.tsx`: if `routedPath` exists, render it; otherwise fall back to `computeWirePath()` direct bezier
- **Persisted** in `saveWires`/`loadWires` alongside other wire definition fields

After ELK layout, wires stay nicely routed until the user drags a node. Then they gracefully degrade to direct beziers.

## ELK Graph Conversion

`elk-layout.ts` converts canvas state to ELK format:

```typescript
// Input
interface ElkLayoutInput {
  cards: Array<{ id: string; width: number; height: number; zoneId?: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
  zones: Array<{ id: string; width: number; height: number; childIds: string[] }>;
}

// Output
interface ElkLayoutResult {
  nodes: Array<{ id: string; x: number; y: number }>;
  edges: Array<{ id: string; path: string }>; // SVG path strings
}
```

Zones become ELK parent nodes with their children nested inside. Non-zoned cards are top-level nodes.

## Files

| File | Action | Responsibility |
|------|--------|----------------|
| `src/main/services/clubhouse-mcp/elk-layout.ts` | Create | ELK graph conversion + layout execution |
| `src/main/services/clubhouse-mcp/elk-layout.test.ts` | Create | Tests for ELK conversion and output |
| `src/main/services/clubhouse-mcp/canvas-layout.ts` | Modify | Add `'elk'` to `computeLayout` pattern |
| `src/main/services/clubhouse-mcp/canvas-layout.test.ts` | Modify | Test `computeLayout('elk', ...)` |
| `src/main/services/clubhouse-mcp/assistant-api-contract.ts` | Modify | Add `'elk'` to layout pattern type |
| `src/renderer/stores/mcpBindingStore.ts` | Modify | Add `routedPath?: string` to `McpBindingEntry` |
| `src/renderer/plugins/builtin/canvas/canvas-store.ts` | Modify | Clear `routedPath` on node move; persist in save/loadWires |
| `src/renderer/plugins/builtin/canvas/WireOverlay.tsx` | Modify | Use `routedPath` when available |
| `src/renderer/plugins/builtin/canvas/wire-utils.ts` | Modify | Add `elkSplineToSvgPath()` helper |
| `package.json` | Modify | Add `elkjs` dependency |

## What Stays the Same

- All existing layout patterns (force, grid, horizontal, vertical, hub-spoke)
- Direct bezier routing for non-ELK layouts
- Physics sway (`useWirePhysics`) — works on any SVG path
- Flow dot animation (`WireFlowDots`) — `animateMotion` works on any `<path>`
- Wire activity states and visual differentiation (bidir/unidir colors, dash patterns)
- Theme system, settings, zone containment
