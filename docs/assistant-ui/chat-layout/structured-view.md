# Structured View Layout Spec

When the assistant returns structured data — project configs, agent setups,
multi-step wizards — the chat transforms from conversational to guided.
This spec covers the interactive card layouts for structured flows.

---

## When Structured View Activates

Structured view isn't a separate mode — it's a **content type within the chat
feed**. The assistant decides when to use it based on the task:

| Task Type | View | Example |
|-----------|------|---------|
| Q&A | Conversational (text) | "What is a canvas?" |
| Single action | Action card in feed | "Create a project" |
| Multi-step setup | Wizard cards | "Set up my workspace" |
| Configuration review | Config card grid | "Show my project settings" |
| Comparison | Comparison cards | "Compare orchestrators" |

---

## Wizard Flow

For multi-step tasks (onboarding, project setup, agent configuration):

```
┌─ Chat Feed ─────────────────────────────────────┐
│                                                   │
│ [Pip] Let's set up your project! Here's what      │
│       we'll do:                                   │
│                                                   │
│ ┌─ Wizard ─────────────────────────────────────┐ │
│ │                                               │ │
│ │  ●━━━━━○━━━━━○━━━━━○                          │ │
│ │  Name   Orch  Agents  Done                    │ │
│ │                                               │ │
│ │  Step 1: Name your project                    │ │
│ │                                               │ │
│ │  ┌──────────────────────────────────────────┐ │ │
│ │  │ Project name                             │ │ │
│ │  │ [my-awesome-app                       ]  │ │ │
│ │  └──────────────────────────────────────────┘ │ │
│ │                                               │ │
│ │  ┌──────────────────────────────────────────┐ │ │
│ │  │ Description (optional)                   │ │ │
│ │  │ [A web app for...                     ]  │ │ │
│ │  └──────────────────────────────────────────┘ │ │
│ │                                               │ │
│ │                          [Skip]  [Next →]     │ │
│ │                                               │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
└───────────────────────────────────────────────────┘
```

### Wizard Anatomy

**Progress bar (sticky option):**
- Horizontal dot-line, dots for each step
- Current: `bg-ctp-accent` filled circle
- Completed: `bg-ctp-accent` filled circle with checkmark
- Upcoming: `border-ctp-surface1` hollow circle
- Connecting line: `bg-ctp-surface1` (2px), `bg-ctp-accent` between completed
- Labels below dots: `text-[10px] text-ctp-subtext0`
- Can optionally stick to top of feed (below header) like PlanProgress

**Step content:**
- Step title: `text-sm font-semibold text-ctp-text`
- Step description (optional): `text-xs text-ctp-subtext0 mt-1`
- Input fields / selection cards / toggles
- Navigation: Back / Next buttons (right-aligned)

**Input fields within wizard:**
```css
.wizard-input {
  width: 100%;
  background: var(--ctp-base);
  border: 1px solid var(--ctp-surface0);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--ctp-text);
  outline: none;
  transition: border-color 0.15s;
}

.wizard-input:focus {
  border-color: var(--ctp-accent);
  box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.15);
}

.wizard-input::placeholder {
  color: var(--ctp-subtext0);
}
```

**Selection cards (e.g., choose orchestrator):**
```
┌───────────────────┐  ┌───────────────────┐
│ ○ Claude Code     │  │ ● GitHub Copilot  │
│   CLI             │  │   CLI             │
│   Recommended     │  │   P1 priority     │
└───────────────────┘  └───────────────────┘
```

- Radio-style: single select with circle indicator
- Checkbox-style: multi-select with square indicator
- Card: `border border-surface-0 rounded-lg p-3 cursor-pointer`
- Selected: `border-ctp-accent bg-ctp-accent/5`
- Hover: `border-surface-1 bg-surface-0/50`
- Grid: 2 columns when width > 400px, 1 column below
- Tag badges: "Recommended", "P1", etc. in `text-[10px] rounded-full px-2 py-0.5`

### Wizard Navigation

- **Next**: `bg-ctp-accent text-white px-4 py-1.5 rounded-lg text-xs font-medium`
  - Disabled when required fields empty: `opacity-40 cursor-not-allowed`
  - Enabled: `hover:bg-ctp-accent/90`
- **Back**: `text-ctp-subtext1 px-4 py-1.5 text-xs hover:text-ctp-text`
  - Hidden on first step
- **Skip**: `text-ctp-subtext0 px-3 py-1.5 text-xs`
  - Only shown when step is optional
  - Advances to next step without input
- Enter key advances to next step (when focused on last input)

### Wizard Completion

After the last step, show a summary card:

```
┌─ Wizard Complete ──────────────────────────────┐
│                                                  │
│  [Pip celebrating]                               │
│                                                  │
│  ✓ Project created!                              │
│                                                  │
│  ┌─ Summary ──────────────────────────────────┐ │
│  │  Name:         my-awesome-app              │ │
│  │  Orchestrator: GitHub Copilot CLI          │ │
│  │  Agents:       2 (default, test-runner)    │ │
│  │  Canvas:       1 (main workspace)          │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  [Open Project]  [Configure More]  [Done]        │
└──────────────────────────────────────────────────┘
```

---

## Config Card Grid

For reviewing/editing existing configuration:

```
┌─ Chat Feed ─────────────────────────────────────┐
│                                                   │
│ [Pip] Here's your project setup:                  │
│                                                   │
│ ┌─ Project ──────┐  ┌─ Orchestrator ────┐        │
│ │ 📦 my-app     │  │ 🤖 Claude Code   │        │
│ │ /Users/me/... │  │ CLI (v1.2.3)     │        │
│ │ Active        │  │ Connected        │        │
│ │ [Edit]        │  │ [Switch]         │        │
│ └────────────────┘  └──────────────────┘        │
│                                                   │
│ ┌─ Agents ───────────────────────────────────┐   │
│ │ default       test-runner      deploy       │   │
│ │ Sonnet        Haiku            Sonnet       │   │
│ │ 5 tools       3 tools         2 tools      │   │
│ │ [Configure]   [Configure]     [Configure]  │   │
│ └────────────────────────────────────────────┘   │
│                                                   │
│ ┌─ Canvases ─────────────────────────────────┐   │
│ │ main-workspace (hub)    components (spoke)  │   │
│ │ 12 cards, 3 columns     8 cards, 2 columns │   │
│ │ [Open]                  [Open]              │   │
│ └────────────────────────────────────────────┘   │
│                                                   │
└───────────────────────────────────────────────────┘
```

### Config Card Anatomy

```css
.config-card {
  border: 1px solid var(--ctp-surface0);
  border-radius: 8px;
  background: var(--ctp-mantle);
  padding: 12px;
  min-width: 140px;
}

.config-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ctp-text);
  display: flex;
  align-items: center;
  gap: 6px;
}

.config-card-meta {
  font-size: 11px;
  color: var(--ctp-subtext0);
  margin-top: 4px;
}

.config-card-action {
  font-size: 11px;
  color: var(--ctp-accent);
  margin-top: 8px;
  cursor: pointer;
}

.config-card-action:hover {
  text-decoration: underline;
}
```

### Config Card Grid Layout

- Grid: `display: grid; gap: 8px;`
- 2 columns when width > 360px: `grid-template-columns: 1fr 1fr`
- 3 columns when width > 520px: `grid-template-columns: 1fr 1fr 1fr`
- 1 column below 360px
- Group header: `text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-1`

### Inline Editing

When user clicks "Edit" on a config card:

```
┌─ Project ─────── editing ───────────────────────┐
│ 📦 Name                                         │
│ [my-app                                       ]  │
│                                                  │
│ 📁 Path                                         │
│ /Users/me/projects/my-app    (read-only)         │
│                                                  │
│ 📝 Description                                  │
│ [A web app for managing...                    ]  │
│                                                  │
│                         [Cancel]  [Save Changes] │
└──────────────────────────────────────────────────┘
```

- Card expands in-place to show editable fields
- Read-only fields shown but greyed out
- Save applies changes via assistant tool call
- Cancel collapses back to summary view
- Transition: 200ms height animation

---

## Comparison Layout

For comparing options (orchestrators, models, configurations):

```
┌─ Compare Orchestrators ─────────────────────────┐
│                                                  │
│           Claude Code    Copilot CLI   Codex CLI │
│ ─────────────────────────────────────────────── │
│ Priority    P1 ●         P1 ●          P2 ○    │
│ Interactive ✓ green      ✓ green       ✗ gray  │
│ Headless    ✓ green      ✓ green       ✓ green │
│ Structured  ✓ green      ✓ green       ✗ gray  │
│ MCP tools   ✓ green      ✓ green       ~ amber │
│ Status      Connected    Connected     On path  │
│                                                  │
│                         [Select Claude Code]     │
└──────────────────────────────────────────────────┘
```

- Table layout: First column is labels, subsequent are options
- Checkmarks: `text-green-400` (✓), `text-ctp-subtext0` (✗), `text-amber-400` (~)
- Header row: `font-semibold text-sm`
- Data rows: `text-xs`, alternate `bg-surface-0/30` for readability
- Scrollable horizontally if > 3 options
- Selection button at bottom for actionable comparisons

---

## Mascot Integration in Structured Views

The mascot appears as a small guide beside structured content:

- **Wizard**: 32px avatar in step header, expression matches step context
  (idle on input steps, thinking during validation, celebrating on completion)
- **Config grid**: No mascot (content speaks for itself)
- **Comparison**: Small 24px mascot with "thinking" expression beside the table
- **Completion**: 80px mascot with celebrating expression, centered above summary

---

## Keyboard Navigation

- **Tab**: Cycle through wizard inputs, card actions, grid items
- **Enter**: Submit current step / activate focused action
- **Escape**: Cancel editing, collapse expanded card
- **Arrow keys**: Navigate selection cards in grid (←→ between columns, ↑↓ between rows)
- **Space**: Toggle checkbox selection cards
