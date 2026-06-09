# Canvas Library Evaluation: ReactFlow vs Svelte Flow vs Custom

**Date:** 2026-04-13  
**Scope:** Feasibility of replacing the Clubhouse custom canvas with ReactFlow or Svelte Flow  
**TL;DR:** ReactFlow is technically compatible and covers ~65% of our needs out of the box. Svelte Flow is a non-starter in our React + Electron stack. Full migration is possible but costly — the custom zone, wire physics, and MCP integration systems are the hardest gaps to bridge.

---

## 1. Current Implementation Overview

The Clubhouse canvas is a custom-built React + SVG system with ~6,500 LOC of canvas-specific logic across 85+ files. It was built specifically for multi-agent orchestration — not general graph visualization — and several of its features have no equivalent in any third-party library.

### Key subsystems

| Subsystem | LOC | What it does |
|---|---|---|
| Viewport (pan/zoom) | ~200 | CSS transform + zoom-toward-cursor math |
| Node types (5 variants) | ~800 | Agent, Zone, Anchor, Sticky Note, Plugin Widget |
| Zone containment & reflow | ~300 | Spatial nesting, auto-resize to fit children, theme propagation |
| Wire rendering & physics | ~1,040 | Bezier SVG wires, spring-mass animation, flow dots, activity glow |
| ELK layout integration | ~418 | Layered, radial, force, MRTree auto-layout with overlap resolution |
| Drag / resize / multi-select | ~600 | 8-direction resize, lasso select, zone-drag-children coordination |
| Minimap | ~528 | Custom SVG minimap with click-to-navigate and status coloring |
| Theme scoping | ~100 | Per-zone Catppuccin theme override propagated to terminals/editors |
| Canvas Zustand store | ~800 | Per-canvas state, IndexedDB persistence, wire definition persistence |

### Notable custom capabilities

- **Wire physics system** (`useWirePhysics.ts`): Spring-mass damper per wire endpoint. Stiffness 180, damping 12. Wires sway with ambient 1.5px oscillation at 0.3 Hz, with per-wire phase randomization so they move independently. View drag applies −0.3× inertia displacement.
- **Wire activity tracking** (`useWireActivity.ts`): Listens to `window.clubhouse.mcpBinding.onToolActivity()` IPC events. Tracks per-wire forward/reverse activity with 4 s decay. Wires shift between `idle → ambient → active-forward / active-reverse / active-both` states, changing glow intensity, dot speed, and dot count.
- **Animated flow dots** (`WireFlowDots.tsx`): SVG `<animateMotion>` dots along wire paths. 2 slow dots in ambient mode (6 s), 5 fast dots in active mode (1.4 s), with staggered phase offsets. Bidirectional wires run forward + reverse dots simultaneously.
- **Zone containment** (`zone-containment.ts`): Containment is spatial — a view belongs to a zone if >50% of its area overlaps. Moving any view triggers `recomputeZones()` which rebuilds containment maps and auto-resizes zone bounding boxes.
- **ELK radial hub preference**: For radial layout, automatically selects the most-connected node as hub if no explicit center is set. Runs an iterative overlap resolution pass afterward (max 10 passes, 20 px AABB padding).

---

## 2. ReactFlow — Deep Feature Analysis

**Library:** `@xyflow/react` v12  
**Maintained by:** xyflow (same team as Svelte Flow)  
**License:** MIT  
**Stack:** React  
**Maturity:** Very high — 36 k+ GitHub stars, 372+ releases, production use across major companies

### What it gives us out of the box

| Feature | ReactFlow support | Notes |
|---|---|---|
| Pan / zoom viewport | ✅ Full | `useReactFlow()` hook, similar model to ours |
| Custom node types | ✅ Full | Arbitrary React components, typed generics |
| Custom edge types | ✅ Full | Custom SVG paths, `<animateMotion>`, glow via SVG filters |
| NodeResizer (8-direction) | ✅ Built-in | `<NodeResizer>` component with handle UI |
| Multi-select | ✅ Built-in | Shift-click multi-select |
| Lasso selection | ⚠️ Partial | No built-in lasso rect; requires custom implementation |
| Grouped/nested nodes | ✅ Built-in | `parentId` + `extent: 'parent'`; group node type |
| Minimap | ✅ Built-in | `<MiniMap>` with per-node color callbacks and viewport rect |
| ELK layout | ✅ Via elkjs | Official example; use elkjs directly, feed positions back to RF |
| Zustand state | ✅ Native | ReactFlow uses Zustand internally; exports `useStore()` |
| TypeScript | ✅ Excellent | Library written in TypeScript; generic node/edge types |
| CSS variables / theming | ✅ Comprehensive | 30+ `--xy-*` CSS variables + color mode prop |
| Electron compatibility | ✅ Confirmed | No documented issues; DOM-based React works normally |
| Performance (DOM-based) | ✅ ~1000 node limit | Viewport virtualization; practical ceiling higher than our typical use |

### Where we'd still need custom code

| Our feature | ReactFlow gap | Effort to bridge |
|---|---|---|
| **Wire spring physics** | No spring animation on edges; edges are static SVG paths | High — port `useWirePhysics.ts` as custom hook |
| **Wire flow dots** | No built-in animated dots along edges | Medium — custom edge component with `<animateMotion>` |
| **Wire activity states** | No IPC-linked activity tracking | High — port `useWireActivity.ts`; wire it to IPC events |
| **Zone spatial containment** | `parentId` nesting exists but no spatial "is 50% inside?" auto-assignment | High — reimplement `recomputeZones` + drag trigger |
| **Zone auto-resize** | No auto-resize of parent to fit children | Medium — compute bounds on node change, push back to store |
| **Zone theme propagation** | No concept of zone-scoped theming | Medium — context wrapping per parent node |
| **Lasso selection** | Not built-in | Low — ~100 LOC custom selection rect |
| **Zone-drag-children** | Built-in when using `parentId` + `extent: 'parent'` | Low — likely handled by RF's group logic |
| **MCP wire binding integration** | No concept of binding types, `agentId`, `targetKind`, etc. | Medium — mapping layer from our binding model to RF edge model |
| **Wire persistence** | No separate persistence layer for edges | Low — wire definitions → RF initial edges + Zustand |
| **Wire glow / activity styling** | Not built-in but fully doable in SVG | Low — CSS filter + animation, already done in custom edge |
| **Minimap status colors** | `nodeColor` fn exists | Low — map agent status → color |
| **Plugin widget nodes** | Custom node type with registry lookup | Medium — dynamic nodeTypes registration |
| **Annex compatibility gates** | No concept | Low — logic inside custom node component |

### Compatibility verdict

ReactFlow is a solid **architectural match**. It uses the same mental model (nodes + edges + viewport + Zustand), the same tech stack (React + TypeScript), and runs fine in Electron. The library covers viewport, basic node/edge rendering, resize, multi-select, minimap, and ELK integration without any customization. The gaps are real but they're all in the custom-Clubhouse-specific layer (wire physics, zone containment, MCP activity) — not in fundamental rendering primitives.

---

## 3. Svelte Flow — Deep Feature Analysis

**Library:** `@xyflow/svelte` v1.5.2  
**Maintained by:** xyflow (same team as ReactFlow)  
**License:** MIT  
**Stack:** Svelte 5 (runes-based)  
**Maturity:** High within Svelte ecosystem — production use in Windmill, Sparrow, Whimsy

### Svelte Flow feature parity with ReactFlow

At the API level, Svelte Flow is nearly 1:1 with ReactFlow. Same concepts: custom node/edge types, `parentId` nesting, `<MiniMap>`, ELK adapter pattern, CSS variable theming, TypeScript generics. The xyflow team explicitly commits to feature parity going forward.

### The fundamental problem: wrong runtime

Our app is React + Electron. Svelte Flow is a Svelte library. These are incompatible at the component model level.

| Issue | Detail |
|---|---|
| **Framework incompatibility** | Svelte components are not React components. React doesn't know how to render them. |
| **Embedding Svelte in React** | Possible via Sveltris (a bridge library) but adds complexity, bundle size, and immaturity risk |
| **Dual runtime overhead** | Adding Svelte Flow forces shipping Svelte 5 runtime (~15 KB gzip) on top of React. Net ~55–70 KB added vs. ~50–60 KB for ReactFlow alone |
| **Documented Electron bug** | GitHub issue #5412: node selection fails unreliably in Electron on macOS (Chrome 138+, macOS Sequoia 15.0). Unresolved. This is a showstopper for an interactive canvas in a desktop Electron app. |
| **State model mismatch** | Svelte Flow v1 uses Svelte 5 runes (`$state`, `.current` pattern). These patterns don't translate to React; the state model would need a full translation layer. |

### Can we use Svelte Flow anyway?

Technically yes — via a separate Electron BrowserWindow running a Svelte app, communicating via IPC. In practice this means:
- A separate Svelte build pipeline
- IPC messages for every canvas interaction (node moves, edge changes, viewport)
- Two state systems to keep in sync
- A worse user experience than what we have today

**Verdict: Svelte Flow is not viable for this project.** It's a well-built library — for a Svelte app. We are not a Svelte app.

---

## 4. Side-by-Side Comparison

| Dimension | Custom (current) | ReactFlow v12 | Svelte Flow v1 |
|---|---|---|---|
| **Tech stack fit** | ✅ React native | ✅ React native | ❌ Svelte; bridge required |
| **Electron fit** | ✅ No issues | ✅ No issues | ⚠️ Selection bug in Electron |
| **Wire physics** | ✅ Spring-mass, per-wire | ❌ Not included | ❌ Not included |
| **Wire flow dots** | ✅ animateMotion | ❌ Not included | ❌ Not included |
| **Wire activity tracking** | ✅ IPC-integrated | ❌ Not included | ❌ Not included |
| **Zone nesting** | ✅ Spatial auto-assign | ⚠️ parentId, no auto-assign | ⚠️ parentId, no auto-assign |
| **Zone auto-resize** | ✅ Bounds reflow | ❌ Not included | ❌ Not included |
| **Zone theme scoping** | ✅ Per-zone Catppuccin | ❌ Not included | ❌ Not included |
| **ELK layout** | ✅ 4 algorithms | ✅ via elkjs adapter | ✅ via elkjs adapter |
| **Radial overlap resolution** | ✅ Custom 10-pass | ❌ Not included | ❌ Not included |
| **Minimap** | ✅ Custom SVG + status | ✅ Built-in (simpler) | ✅ Built-in (simpler) |
| **Lasso select** | ✅ Built-in | ⚠️ Manual | ⚠️ Manual |
| **8-direction resize** | ✅ Custom | ✅ NodeResizer built-in | ✅ Custom implementation |
| **Plugin widget nodes** | ✅ Registry-based | ⚠️ Custom nodeType required | ⚠️ Custom nodeType required |
| **MCP binding integration** | ✅ Native | ⚠️ Mapping layer required | ⚠️ Mapping layer required |
| **TypeScript quality** | ✅ Good | ✅ Excellent | ✅ Excellent |
| **Bundle impact** | — (already built) | ~50–60 KB gzip | ~55–70 KB gzip (+ Svelte runtime) |
| **Performance ceiling** | ~100–150 nodes | ~1000 nodes (viewport culling) | ~100–500 nodes |
| **Virtualization** | ❌ None | ✅ Viewport culling | ❌ None documented |
| **Maintenance burden** | High (fully owned) | Low (xyflow maintained) | Low (xyflow maintained) |
| **Community / ecosystem** | — | Very large | Moderate |

---

## 5. Gap Analysis: What Migration Actually Requires

If we migrated to ReactFlow, here's what we'd be getting for free vs. what we'd rewrite:

### Replaced by ReactFlow (no custom code)
- Viewport pan/zoom
- Basic node drag, selection, multi-select
- NodeResizer with 8-direction handles
- Group node (parentId + extent)
- MiniMap component
- ELK adapter
- Edge rendering (static bezier, straight, step)
- Zustand store compatibility
- TypeScript types

### Must be reimplemented as custom ReactFlow extensions (~2,600 LOC estimated)

| Component | Our LOC | Reimplemented LOC | Notes |
|---|---|---|---|
| `useWirePhysics.ts` | 255 | ~255 | Port as-is; hooks are framework-agnostic |
| `WireFlowDots.tsx` | 140 | ~140 | Custom edge component |
| `useWireActivity.ts` | 200 | ~200 | Port as-is |
| `WireOverlay.tsx` → custom edge | 320 | ~200 | RF custom edge simplifies some coordination |
| `wire-utils.ts` | 125 | ~100 | Path math unchanged |
| Zone containment logic | 300 | ~400 | More complex in RF due to different node lifecycle |
| Zone auto-resize | 100 | ~150 | Need `onNodesChange` hook coordination |
| Zone theme context | 100 | ~80 | Context wrapping per parent node |
| MCP binding → RF edge mapping | 0 (native) | ~200 | Transform binding model → RF edge format |
| Plugin widget custom node | 200 | ~150 | RF custom nodeType |
| Lasso selection | 200 | ~100 | RF provides selection rect API hooks |
| Minimap status coloring | 100 | ~50 | `nodeColor` fn covers this |

**Total custom code needed:** ~2,025–2,600 LOC  
**Current custom canvas LOC:** ~6,500 LOC  
**Net reduction:** ~3,900–4,500 LOC (~60% reduction)

### What we give up in migration

- **Wire physics is ours to keep** (hooks port cleanly) — no regression expected
- **Minimap click-to-navigate drag** — ReactFlow's built-in minimap has this, slight behavior differences possible
- **Radial layout overlap resolution** — need to port the 10-pass resolver; ELK's output alone may not be sufficient for our variable card sizes
- **The zone "50% containment" model** — RF's `parentId` is manually assigned; we'd either pre-assign at drop time or replicate the spatial detection logic

---

## 6. Migration Effort Estimate

| Phase | Work | Estimate |
|---|---|---|
| Setup & scaffolding | Install RF, wrap canvas with `<ReactFlow>`, port store schema | 3–5 days |
| Node types | Agent, Zone, Sticky, Anchor, Plugin — custom nodeType components | 1–2 weeks |
| Zone containment | Spatial detection, auto-resize, zone-drag-children | 2–3 weeks |
| Wire system | Port physics, flow dots, activity tracking, custom edge | 2–3 weeks |
| ELK integration | Adapter + overlap resolver port | 3–5 days |
| MCP binding mapping | binding model → RF edge model + wire store migration | 3–5 days |
| Minimap parity | Status coloring, click-to-navigate | 2–3 days |
| Theme scoping | Zone context wrappers | 1–2 days |
| Testing & regression | QA all canvas interactions end-to-end | 1–2 weeks |
| **Total** | | **6–10 weeks (1 engineer)** |

Risk factors that could extend this:
- Zone containment + RF's node lifecycle (`parentId` rules) is the highest-risk area — may require significant iteration
- Wire physics in a custom edge component has subtle interaction with RF's internal SVG management
- Plugin widget lifecycle (registry subscriptions) needs careful integration with RF's `nodeTypes` registration pattern

---

## 7. Recommendation

### Short answer

**Don't migrate now.** Consider ReactFlow if and when the custom canvas becomes a performance bottleneck or a maintenance burden that outweighs the migration cost.

### Why not now

1. **The unique features are the hard ones.** Wire physics, activity-based glow, zone spatial containment, MCP binding integration — these are the things users notice and that differentiate Clubhouse. They all require custom code regardless of library. The parts ReactFlow would handle for free (viewport, basic drag, resize) are the cheapest to maintain in our current codebase.

2. **Migration is 6–10 weeks of high-risk refactor.** Zone containment and the wire system are tightly coupled to drag/resize behavior. The risk of regressions in a non-trivial canvas interaction is real.

3. **Performance isn't a problem yet.** Our current implementation runs smoothly at 50–100 views, which covers normal Clubhouse workflows. ReactFlow's viewport culling would help above 150+ nodes — we're not there.

4. **The complexity reduction is real but overstated.** ~4,000 LOC reduction sounds significant. But the 2,600 LOC we'd rewrite are the hardest, most specialized parts of the current implementation. We'd be trading "own a lot of simple code + complex code" for "own less code but it's all complex."

### When it would make sense

- If canvas performance degrades as users build larger projects (> 100 nodes routine)
- If we want to invest in canvas features that RF's ecosystem already provides (e.g., complex edge routing, better group UI, more interaction patterns)
- If the current canvas codebase becomes hard to onboard new contributors to
- If we plan a major canvas redesign anyway — migration cost amortizes into a redesign

### On Svelte Flow specifically

Do not use Svelte Flow in this project. It's a well-maintained library but wrong for our stack. The Electron selection bug alone would be a showstopper; the dual-runtime overhead and interop complexity make it worse. If the app ever moves to Svelte, revisit.

---

## 8. Quick Reference

```
Current canvas:    ~6,500 LOC, fully custom, zero library dependencies
ReactFlow covers:  ~60-65% of needs out of the box
Custom code needed if migrated: ~2,000-2,600 LOC
Net LOC reduction: ~3,900-4,500 LOC (~60%)
Migration timeline: 6-10 weeks (1 engineer)
Migration risk: Medium-High (zone + wire coupling)
Svelte Flow: ❌ Not viable (wrong stack, Electron bug)
```
