# Rich Content Rendering Spec

The assistant delivers **visual, illustrative content** — not just text. This
spec defines how rich content types render across all three input modes.

---

## Content Types

### 1. Animated SVG Illustrations
**Purpose:** Explain concepts visually (how canvas layout works, how agents
connect, how plugins load).

**Format:** Inline SVG with CSS animations. Same viewBox conventions as mascot
(scalable, theme-aware via CSS variables).

**Examples:**
- "How agents work" → animated flow: User → Task → Agent → Results
- "Canvas layout" → interactive diagram showing hub/spoke/annex relationships
- "Plugin architecture" → animated block diagram of plugin loading lifecycle

### 2. Code Snippets
**Purpose:** Show configuration, API examples, generated scaffolding.

**Format:** Syntax-highlighted code blocks using Monaco inline (already in
codebase for ToolCard output). Language-aware highlighting.

### 3. Entity Preview Cards
**Purpose:** Show real project/agent/canvas/plugin data inline.

**Format:** Styled cards with live data from the user's project. Compact
but informative — icon, name, key metadata, status indicator.

### 4. Diff Views
**Purpose:** Before/after comparisons for proposed changes.

**Format:** Side-by-side or unified diff with syntax highlighting. Red/green
for removed/added lines. Collapsible for long diffs.

### 5. Annotated Diagrams
**Purpose:** "Here's where to find this setting" — UI screenshots or mockups
with callout annotations.

**Format:** SVG overlay on a simplified UI wireframe. Numbered callouts with
connecting lines. Can animate to guide the eye sequentially.

### 6. Step-by-Step Walkthroughs
**Purpose:** Multi-step visual guides (e.g., "How to set up your first agent").

**Format:** Numbered cards with illustration + text pairs. Progress indicator.
Can auto-advance or be user-paced.

---

## Mode-Specific Rendering

### Headless / Structured Mode (Primary — Chat Feed)

Rich content renders **inline in the chat feed**. This is the best experience.

```
┌─ Chat Feed ─────────────────────────────────────┐
│                                                   │
│ [Pip] Here's how canvas layout works:             │
│                                                   │
│ ┌─ Animated SVG ───────────────────────────────┐ │
│ │                                               │ │
│ │   ┌─Hub─┐                                     │ │
│ │   │     │──→ ┌─Spoke─┐                        │ │
│ │   │     │──→ ┌─Spoke─┐                        │ │
│ │   └─────┘                                     │ │
│ │                                               │ │
│ │   [▶ Play animation]  [↕ Expand]              │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│ The hub canvas holds your main content...         │
│                                                   │
└───────────────────────────────────────────────────┘
```

**Layout rules:**
- Rich content blocks span full feed width (up to 600px max-content)
- Minimum height: 120px for illustrations, 60px for code blocks
- Maximum initial height: 300px — "Expand" control for taller content
- Rounded corners: `rounded-lg`
- Background: `bg-ctp-mantle` with `border border-surface-0`
- Padding: `p-3` inside the content frame
- Animations auto-play once when scrolled into view, then loop or stop
  based on content type
- "Play animation" button for user-initiated replay
- All animations respect `prefers-reduced-motion` (show final frame static)

**Inline code blocks:**
- Use existing Monaco inline pattern from ToolCard
- Max height: 200px with scroll, expandable to full
- Copy button top-right
- Language label top-left (subtle, `text-[10px] text-ctp-subtext0`)

**Entity preview cards:**
- Compact: 60px height, icon + name + metadata in a row
- Expandable: Click to show full details (description, settings, status)
- Multiple entities: Horizontal scroll or 2-column grid

### Interactive (PTY) Mode — Sidebar Push

PTY mode is a terminal — it can't render SVGs or rich HTML inline. Instead,
rich content is **pushed to a sidebar panel** in the Clubhouse UI.

```
┌──────────────────────────────────────────────────┐
│                   TitleBar                         │
├──────┬─────────────────────┬─────────────────────┤
│      │                     │  ┌─Rich Sidebar───┐ │
│      │   Terminal / PTY    │  │                 │ │
│      │                     │  │ [Animated SVG]  │ │
│ Rail │   > assistant: ...  │  │                 │ │
│      │   Here's how canvas │  │ [Entity Cards]  │ │
│  🤖  │   layout works.     │  │                 │ │
│      │   (See sidebar →)   │  │ [Code Preview]  │ │
│      │                     │  │                 │ │
│      │   >                 │  └─────────────────┘ │
└──────┴─────────────────────┴─────────────────────┘
```

**PTY behavior:**
- Assistant text response appears in terminal as normal text
- When rich content is available, terminal shows: `(See sidebar →)`
- Sidebar panel auto-opens on the right (or uses AccessoryPanel slot)
- Sidebar contains the same rich content components as inline chat
- Sidebar is dismissable (click X or press Escape)
- Multiple rich content blocks stack vertically in sidebar
- Sidebar width: 320-400px (enough for illustrations)

**Fallback text:** Every rich content block must have a text-only description
that renders in the terminal. The visual is an enhancement, not a requirement.

```
Terminal output:
  Canvas Layout:
  - Hub canvas: holds your main content
  - Spoke canvases: connected components
  - Annex: remote-controlled sub-canvases
  (See sidebar for animated diagram →)
```

### Structured Mode — Streaming Events

Structured mode receives events via `onStructuredEvent()`. Rich content is
delivered as a new event kind:

```typescript
type FeedItem =
  | { kind: 'rich-content'; contentType: RichContentType; data: RichContentData }

type RichContentType =
  | 'animated-svg'    // SVG string with CSS animations
  | 'code-snippet'    // { language, code, filename? }
  | 'entity-preview'  // { entityType, entityId, summary }
  | 'diff-view'       // { before, after, filename }
  | 'annotated-diagram' // SVG with callout overlay data
  | 'walkthrough'     // { steps: { illustration, text }[] }
```

Rendered by a new `RichContentRenderer` component in the feed, following the
same card patterns as ToolCard.

---

## Content Frame Component

All rich content shares a common frame:

```
┌─ ContentFrame ──────────────────────────────────┐
│ [icon] Canvas Layout              [↕] [📋] [✕] │
├─────────────────────────────────────────────────┤
│                                                  │
│           (rich content renders here)            │
│                                                  │
├─────────────────────────────────────────────────┤
│ [▶ Replay]                    Animated diagram   │
└─────────────────────────────────────────────────┘
```

- **Header**: Content type icon + title + expand/copy/dismiss controls
- **Body**: The actual rich content (SVG, code, cards, etc.)
- **Footer** (optional): Replay button (for animations), content type label
- **Style**: `border border-surface-0 rounded-lg bg-ctp-mantle overflow-hidden`
- **Transitions**: Fade-in on appear (200ms), collapse with height animation on dismiss

### Header controls:
- **Expand** (↕): Toggle between compact (max-height) and full view
- **Copy** (📋): Copy content to clipboard (code → text, SVG → image, etc.)
- **Dismiss** (✕): Remove from feed (with undo toast)

---

## Animated SVG Conventions

All assistant illustrations follow these rules for consistency:

### Technical
- ViewBox: Use semantic sizes (e.g., `0 0 400 240` for wide diagrams)
- Colors: Use CSS custom properties (`var(--ctp-accent)`, `var(--ctp-text)`, etc.)
- Animations: CSS `@keyframes` inside `<style>` block, not SMIL
- Duration: 2-6 seconds for concept animations, loop or play-once
- Easing: `ease-in-out` for most motion, `ease-out` for appears

### Visual Style
- **Line weight**: 1.5-2px strokes (consistent with icon system)
- **Corners**: Rounded (`rx="4"` or higher) — matches Catppuccin softness
- **Labels**: `font-family: monospace`, `font-size: 11-13px`
- **Arrows**: Rounded arrowheads, animated draw-on effect
- **Boxes**: `fill: var(--ctp-surface0)`, `stroke: var(--ctp-surface1)`
- **Highlights**: `var(--ctp-accent)` for focused/active elements
- **Flow direction**: Left-to-right or top-to-bottom

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
  .animated-element { opacity: 1; transform: none; }
}
```

Show the final/complete state of the diagram. No motion, all elements visible.

---

## Template Library (Planned)

Reusable visual explanation patterns:

| Template | Use Case | Layout |
|----------|---------|--------|
| Flow diagram | A → B → C processes | Horizontal chain with animated arrows |
| Tree/hierarchy | Project structure, plugin tree | Top-down branching |
| Before/after | Config changes, migrations | Side-by-side split |
| Annotated UI | "Click here" guidance | Wireframe + numbered callouts |
| Step sequence | Setup wizards, tutorials | Numbered cards, progressive reveal |
| Comparison table | Feature differences | Grid with checkmarks/crosses |
| Architecture block | System design | Boxes with labeled connections |

Each template will be an SVG generator function that accepts data and produces
a themed, animated illustration. This lets the assistant dynamically create
visuals for any explanation, not just pre-baked images.
