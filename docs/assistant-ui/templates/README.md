# Visual Explanation Templates

Reusable SVG templates the assistant can embed inline to explain concepts visually.
Each template uses Catppuccin Mocha CSS variables with hardcoded fallbacks, animated
draw-on effects, and `prefers-reduced-motion` fallbacks.

## Templates

### Structural Templates

| Template | File | Use When |
|---|---|---|
| Step Sequence | `step-sequence.svg` | Multi-step wizard flows (setup, scaffolding) |
| Annotated Wireframe | `annotated-wireframe.svg` | Explaining UI areas with numbered callouts |

### Concept Illustrations

| Illustration | File | Teaches |
|---|---|---|
| Canvas & Zones | `concept-canvas-zones.svg` | Workspace layout: zones group agents, wires connect, cross-zone collaboration |
| Agent Communication | `concept-agent-communication.svg` | How MCP wires expose tools bidirectionally between agents |
| Plugin Architecture | `concept-plugin-architecture.svg` | How plugins contribute widgets, tools, themes to core app |

## Design Conventions

All templates follow these rules:

- **ViewBox**: Width 480px, height varies (200–320px)
- **Colors**: CSS variables with Catppuccin Mocha fallbacks
  - Background: `var(--ctp-base, #1e1e2e)`
  - Surfaces: `var(--ctp-surface0, #313244)`
  - Text: `var(--ctp-text, #cdd6f4)`
  - Accent: `var(--ctp-accent, #89b4fa)`
- **Semantic colors**: Blue=primary, Green=success/spoke, Amber=warning/remote, Pink=highlight, Violet=special
- **Typography**: `monospace`, 14px titles, 11px labels, 8-9px sublabels
- **Animations**: Staggered fade-in (0.2s intervals), draw-on for connectors (`stroke-dasharray`/`stroke-dashoffset`), pulse for active elements
- **Reduced motion**: All animations disabled via `@media (prefers-reduced-motion: reduce)` — elements show at full opacity, static
- **Rounded corners**: `rx: 6-10` for boxes, `rx: 3-4` for small elements
