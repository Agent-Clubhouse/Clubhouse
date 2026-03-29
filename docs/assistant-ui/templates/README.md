# Visual Explanation Templates

Reusable SVG templates the assistant can use (or adapt) to explain concepts
visually. Each template demonstrates a pattern for a common explanation type.

## Available Templates

### 1. Flow Diagram (`flow-diagram.svg`)
**Pattern:** A → B → C → D linear process
**Example:** "How Agents Work" — User → Task → Agent → Results

**Features:**
- Sequential box reveal (fade-in, staggered 0.3-0.6s)
- Arrow draw-on animation (stroke-dashoffset 60→0)
- Final box pulse glow for emphasis
- Subtitle under each box for context
- Title + summary subtitle at top

**When to use:** Explaining any sequential process — agent lifecycle, plugin
loading, canvas creation flow, onboarding steps.

### 2. Architecture Block (`architecture-block.svg`)
**Pattern:** Central node with radiating connections to satellite nodes
**Example:** "Canvas Layout" — Hub ←→ Spokes with Annex connection

**Features:**
- Hub node with glow pulse (3s loop)
- Spoke nodes fade in sequentially
- Connector lines draw-on from hub to spokes
- Dashed connector for remote/optional relationships (Annex)
- Color-coded node types with legend
- Dot indicators at connection endpoints

**When to use:** Explaining any hub-spoke architecture — canvas layout, project
structure, agent-to-tool relationships, plugin ecosystem.

## Template Conventions

All templates follow the rules from `rich-content/rendering-spec.md`:

### Sizing
- Wide diagrams: `viewBox="0 0 480 200"` to `480 280`
- Square diagrams: `viewBox="0 0 320 320"`
- Always include `width` and `height` attributes matching viewBox aspect ratio

### Colors
Use CSS custom properties with Catppuccin Mocha fallbacks:
```css
var(--ctp-base, #1e1e2e)       /* background */
var(--ctp-surface0, #313244)   /* box fill */
var(--ctp-surface1, #45475a)   /* box stroke */
var(--ctp-text, #cdd6f4)       /* labels */
var(--ctp-subtext0, #a6adc8)   /* sublabels */
var(--ctp-accent, #89b4fa)     /* primary/highlight */
```

Semantic colors:
- Blue (`--ctp-accent`): Primary, hub, active
- Green (`#a6e3a1`): Success, connected, spoke
- Amber (`#f5a623`): Warning, remote, optional
- Red (`#f38ba8`): Error, disconnected
- Pink (`#f472b6`): Celebration, highlight

### Typography
- Labels: `font-family: monospace; font-size: 11-12px`
- Sublabels: `font-family: monospace; font-size: 9px`
- Titles: `font-size: 14px; font-weight: bold`
- Always `text-anchor: middle` for centered labels

### Animation
- **Stagger**: 0.2-0.4s between sequential elements
- **Draw-on**: `stroke-dasharray: N; stroke-dashoffset: N → 0`
- **Fade-in**: `opacity: 0 → 1` over 0.3-0.4s
- **Pulse**: Subtle opacity loop (0.08→0.2) for emphasis, 2-3s
- **Total duration**: Keep under 3s for the full reveal sequence

### Reduced Motion
Every template must include:
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    opacity: 1 !important;
    stroke-dashoffset: 0 !important;
  }
}
```

### Background
- Use `var(--ctp-base)` fill on a rounded rect (`rx="8"`)
- Optional subtle dot grid pattern for depth (see flow-diagram example)

### 3. Before/After (`before-after.svg`)
**Pattern:** Side-by-side comparison with highlighted changes
**Example:** "Configuration Change" — model upgrade from Haiku to Sonnet

**Features:**
- Left panel (BEFORE) with red-highlighted removed line
- Right panel (AFTER) with green-highlighted added line
- Dashed center divider with animated arrow
- BEFORE/AFTER badges with semantic colors
- Code block styling with monospace font
- Staggered fade-in: left → divider → right → highlights

**When to use:** Showing configuration changes, migration diffs, setting
updates — any time you need to show what changed and why.

### 4. Tree/Hierarchy (`tree-hierarchy.svg`)
**Pattern:** Top-down branching structure with cascading reveal
**Example:** "Project Structure" — Project → Agents + Canvases + Plugins → leaves

**Features:**
- Root node with accent border (project)
- Three branches to category nodes (agents, canvases, plugins)
- Leaf nodes with metadata (model, type, count)
- Legend box with descriptions per category
- Top-down cascade animation (root → connectors → branches → leaves)
- Color-coded categories (green agents, blue canvases, amber plugins)

**When to use:** Explaining project structure, plugin ecosystems, agent
hierarchies, file organization — any parent-child relationship tree.

### 5. Step Sequence (`step-sequence.svg`)
**Pattern:** Numbered cards with progress track showing multi-step wizard flow
**Example:** "Set Up a Canvas" — Create → Add Cards → Connect → Layout

**Features:**
- Horizontal progress track with fill animation (green for completed)
- Numbered badge circles: green checkmark (done), blue number (active), gray (pending)
- Three card states: completed (green border), active (blue border + glow pulse), pending (dimmed)
- Active step shows Approve/Skip action buttons (consent pattern)
- Staggered left-to-right cascade reveal
- Bottom legend explaining the three states
- Timing labels per step for user expectation setting

**When to use:** Any multi-step scaffolding flow — canvas setup, project creation,
agent configuration, plugin installation. The assistant's primary interaction pattern
for Builder persona flows.

### 6. Annotated UI Wireframe (`annotated-wireframe.svg`)
**Pattern:** Wireframe mock with numbered callout bubbles pointing to key areas
**Example:** "Assistant Chat Panel" — header, feed, action card, chips, input bar

**Features:**
- Centered wireframe mock using actual UI proportions (header, feed, input)
- Numbered blue callout circles (1-5) with dashed leader lines
- Each callout has a label + brief description
- Wireframe uses placeholder shapes (rounded rects, circles) not real text
- Shows key interaction elements: avatar, messages, action card, suggestion chips
- Callouts pop in sequentially after wireframe fades in

**When to use:** Explaining what UI elements do, onboarding walkthroughs, pointing out
where to find settings, showing users "click here" guidance. The assistant's primary
pattern for "let me show you where that is" responses.

## Planned Templates

| Template | Pattern | Priority |
|----------|---------|----------|
| Comparison grid | Feature table with checks | Low |
| Timeline | Horizontal event sequence | Low |

## Creating New Templates

1. Copy the closest existing template as a starting point
2. Replace content (boxes, labels, connections) with your data
3. Adjust viewBox dimensions to fit content
4. Update animation stagger timing for the number of elements
5. Test with `prefers-reduced-motion` enabled
6. Verify colors work on both dark and light (use CSS variables)
