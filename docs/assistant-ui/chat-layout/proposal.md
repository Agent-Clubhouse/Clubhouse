# Chat Layout Proposal

## Overview

The assistant chat replaces the existing HelpView when activated. It lives in
the same layout slot — triggered from ProjectRail, rendering in the full
ProjectPanelLayout area (same as `isHelp` route in App.tsx).

This leverages the existing toggle pattern (`toggleHelp` → `toggleAssistant`)
and avoids fighting the three-pane grid. The assistant IS the help system,
evolved.

---

## Layout Architecture

```
┌──────────────────────────────────────────────────┐
│                   TitleBar                        │
├──────┬───────────────────────────────────────────┤
│      │  ┌─ Assistant Chat ─────────────────────┐ │
│      │  │ ┌─Header──────────────────────────┐  │ │
│      │  │ │ [mascot 32px] Assistant    [···] │  │ │
│      │  │ └─────────────────────────────────┘  │ │
│ Rail │  │                                      │ │
│      │  │  ┌─Feed─────────────────────────┐   │ │
│  🤖  │  │  │ [mascot] Welcome message     │   │ │
│      │  │  │                              │   │ │
│      │  │  │        [user message]  [you] │   │ │
│      │  │  │                              │   │ │
│      │  │  │ [mascot] Response with       │   │ │
│      │  │  │   ┌─ActionCard──────────┐    │   │ │
│      │  │  │   │ Configure project   │    │   │ │
│      │  │  │   │ [Approve] [Edit]    │    │   │ │
│      │  │  │   └─────────────────────┘    │   │ │
│      │  │  │                              │   │ │
│      │  │  └──────────────────────────────┘   │ │
│      │  │                                      │ │
│      │  │ ┌─InputBar────────────────────────┐  │ │
│      │  │ │ [💬 Ask anything...]    [Send]  │  │ │
│      │  │ └─────────────────────────────────┘  │ │
│      │  └──────────────────────────────────────┘ │
└──────┴───────────────────────────────────────────┘
```

## Integration Strategy

### Entry Point: ProjectRail

Replace the existing Help button with an Assistant button:
- **Icon**: Robot mascot silhouette (18×18 SVG, stroke-based)
- **Active state**: `bg-ctp-accent text-white shadow-lg shadow-ctp-accent/30`
- **Toggle**: `useUIStore.toggleAssistant()` (new action, replaces `toggleHelp`)
- **Badge**: Notification dot when assistant has background activity
- **Position**: Same slot as current Help button in ProjectRail footer

The help content doesn't disappear — it becomes searchable through the
assistant ("How do I set up an agent?" → assistant replies with help content).

### Route: App.tsx

New condition alongside `isHelp`:
```
isAssistant → <AssistantChat />  (full ProjectPanelLayout replacement)
```

This is the same pattern HelpView uses — when active, it replaces the
three-pane layout with its own full-width content.

### Why Full-Width (Not a Sidebar)

1. **Drill-in cards need space.** Preview cards, code snippets, and diff views
   need at least 400px to be readable. A narrow sidebar can't support this.
2. **Existing pattern.** HelpView already takes over the full area — users
   already expect this toggle behavior.
3. **Focus.** When you're talking to the assistant, that's the primary activity.
   It deserves the full stage, not a cramped side panel.
4. **Future:** We can later add a "mini mode" that pins to a sidebar, but
   starting full-width is the safe default.

---

## Component Breakdown

### 1. AssistantHeader

```
┌─────────────────────────────────────────────────┐
│ [mascot 32px]  Assistant          [⋯] [✕]      │
│                 Idle · Ready to help             │
└─────────────────────────────────────────────────┘
```

- **Mascot avatar**: 32px rendered from chosen mascot SVG, expression matches
  current agent state
- **Title**: "Assistant" in `text-sm font-semibold text-ctp-text`
- **Status line**: Agent state in `text-xs text-ctp-subtext0` — maps to
  emotional state table (Idle, Thinking, Responding...)
- **Actions menu** (⋯): Clear conversation, View help docs, Settings
- **Close button** (✕): Returns to previous view
- **Height**: 48px (`py-2 px-3`)
- **Border**: `border-b border-surface-0 bg-ctp-mantle`

### 2. AssistantFeed

The scrollable message area. Follows StructuredAgentView's feed pattern.

**Message types:**

| Type | Alignment | Avatar | Style |
|------|-----------|--------|-------|
| Assistant text | Left | 24px mascot | `bg-ctp-mantle rounded-lg p-3` |
| User text | Right | None | `bg-ctp-accent/10 rounded-lg p-3` |
| Action card | Left, full width | None | ToolCard-style border card |
| Preview card | Left, full width | None | Custom with live preview |
| Step indicator | Center | None | Numbered progress dots |
| Error | Left | Mascot (sorry) | `border-red-500/40 bg-red-500/5` |

**Feed behavior:**
- `flex-1 overflow-y-auto px-4 py-3 space-y-3`
- Auto-scroll to bottom (unless user scrolled up >50px)
- Max content width: 600px centered (readability)
- Messages use `renderMarkdownSafe()` from MessageStream pattern
- Streaming cursor for in-progress responses

**Welcome state (empty feed):**
```
         ┌──────────────────────────┐
         │                          │
         │     [mascot 80px]        │
         │     idle animation       │
         │                          │
         │   Hi! I'm your assistant │
         │   I can help you:        │
         │                          │
         │   ┌─────────────────┐    │
         │   │ Set up a project│    │
         │   └─────────────────┘    │
         │   ┌─────────────────┐    │
         │   │ Configure agents│    │
         │   └─────────────────┘    │
         │   ┌─────────────────┐    │
         │   │ Learn the basics│    │
         │   └─────────────────┘    │
         │                          │
         └──────────────────────────┘
```

Suggestion chips are clickable and populate the input.

### 3. AssistantInputBar

```
┌─────────────────────────────────────────────────┐
│ [/] [Ask anything or type / for commands] [Send]│
└─────────────────────────────────────────────────┘
```

- **Slash command hint**: `/` icon button that opens command palette
- **Input**: `flex-1 bg-ctp-base border border-surface-0 rounded-lg px-3 py-2`
- **Send button**: `bg-ctp-accent text-white rounded-lg px-3 py-2`
  - Disabled when empty: `opacity-40`
  - Enter to send, Shift+Enter for newline
- **Height**: Auto-expanding textarea, max 120px
- **Border**: `border-t border-surface-0 bg-ctp-mantle px-3 py-2`
- **Slash commands**: Type `/` to see available commands in a dropdown above input

### 4. AssistantActionCard

For when the assistant proposes an action:

```
┌─────────────────────────────────────────────────┐
│ ⚡ Configure project "my-app"                    │
├─────────────────────────────────────────────────┤
│ I'll create a .clubhouse/project.json with:     │
│                                                  │
│ ┌─ preview ───────────────────────────────────┐ │
│ │ {                                           │ │
│ │   "name": "my-app",                         │ │
│ │   "agents": { ... }                         │ │
│ │ }                                           │ │
│ └─────────────────────────────────────────────┘ │
│                                                  │
│              [Approve]  [Edit]  [Skip]           │
└─────────────────────────────────────────────────┘
```

- **Header**: Icon + action title in `text-sm font-semibold`
- **Body**: Description + preview/diff content
- **Actions**: Always present — approve (primary), edit, skip
- **Style**: `border border-surface-0 rounded-lg bg-ctp-mantle overflow-hidden`
- **Approve button**: `bg-green-600 text-white` (matches success color)
- **Undo toast**: After approve, 10-second undo toast at bottom

---

## Color & Typography Summary

| Element | Text | Background | Border |
|---------|------|------------|--------|
| Header | `text-ctp-text` | `bg-ctp-mantle` | `border-surface-0` |
| Feed | `text-ctp-text` | `bg-ctp-base` | — |
| Assistant msg | `text-ctp-text` | `bg-ctp-mantle` | — |
| User msg | `text-ctp-text` | `bg-ctp-accent/10` | — |
| Action card | `text-ctp-text` | `bg-ctp-mantle` | `border-surface-0` |
| Input bar | `text-ctp-text` | `bg-ctp-mantle` | `border-surface-0` |
| Input field | `text-ctp-text` | `bg-ctp-base` | `border-surface-0` |
| Status text | `text-ctp-subtext0` | — | — |

---

## Keyboard Accessibility

- **Tab**: Navigate between header actions, feed items, input, send
- **Enter**: Send message (in input), activate focused card action
- **Escape**: Close assistant (return to previous view)
- **Shift+Enter**: Newline in input
- **/**:  Focus input and trigger command palette
- **Ctrl+L**: Clear conversation
- Focus trap within assistant panel when open

---

## Responsive Behavior

- **≥800px width**: Full layout as described, max-content 600px centered
- **<800px width**: Feed goes edge-to-edge, no max-width constraint
- **Reduced motion**: All mascot animations replaced with static poses,
  no streaming cursor animation, instant transitions

---

## Open Design Decisions

1. **Split view**: Should clicking "Show me" open a side-by-side preview
   (assistant left, preview right), or expand inline? Side-by-side uses the
   existing AccessoryPanel slot naturally.

2. **History**: Is conversation persistent across sessions, or fresh each time?
   Affects whether we need a conversation list/switcher.

3. **Multi-step wizards**: When the assistant runs a multi-step flow, should
   step indicators be sticky at the top (like PlanProgress in
   StructuredAgentView) or inline in the feed?
