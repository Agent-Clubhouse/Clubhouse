# Drill-In Card Designs

At every step, the user should be **learning, seeing, and approving**. Drill-in
cards are the primary vehicle for progressive disclosure in the assistant feed.

---

## Shared Card Anatomy

Every drill-in card follows this structure:

```
┌─ Card ──────────────────────────────────────────┐
│ [icon]  Title                        [▾] [···]  │  ← Header (always visible)
├─────────────────────────────────────────────────┤
│                                                  │
│  Summary / preview content                       │  ← Body (collapsible)
│                                                  │
├─────────────────────────────────────────────────┤
│  [Primary Action]  [Secondary]  [Skip]           │  ← Footer (actions)
└──���────────────────────────────��─────────────────┘
```

### Header
- **Icon**: 16×16, content-type-specific (code, project, agent, diff, etc.)
- **Title**: `text-sm font-semibold text-ctp-text`, one line, truncate with ellipsis
- **Collapse toggle** (▾/▸): Expand/collapse body
- **Overflow menu** (···): Copy, open in editor, dismiss, report issue

### Body
- Variable height, content-type-specific
- Default: collapsed (shows 2-3 line summary) for most types
- Exception: action cards default expanded (user needs to see what they're approving)
- Max collapsed height: 60px with fade gradient
- Max expanded height: 400px with scroll (or full height for short content)
- Transition: height animation 200ms ease-out

### Footer (when actions present)
- Right-aligned button group
- Primary: `bg-green-600 text-white px-3 py-1.5 rounded text-xs font-medium`
- Secondary: `bg-surface-0 text-ctp-subtext1 px-3 py-1.5 rounded text-xs`
- Skip/Dismiss: `text-ctp-subtext0 px-3 py-1.5 text-xs hover:text-ctp-text`
- Spacing: `gap-2` between buttons

### Card Chrome
```css
.drill-in-card {
  border: 1px solid var(--ctp-surface0);
  border-radius: 8px;           /* rounded-lg */
  background: var(--ctp-mantle);
  overflow: hidden;
}

.drill-in-card:hover {
  border-color: var(--ctp-surface1);
}

.drill-in-card.actionable {
  border-left: 3px solid var(--ctp-accent);
}

.drill-in-card.error {
  border-color: rgba(248, 113, 113, 0.4);  /* red-500/40 */
  background: rgba(248, 113, 113, 0.05);   /* red-500/5 */
}

.drill-in-card.success {
  border-color: rgba(166, 227, 161, 0.4);  /* green/40 */
  background: rgba(166, 227, 161, 0.05);   /* green/5 */
}
```

---

## Card Types

### 1. Action Card
**When:** The assistant proposes doing something (create file, modify config,
run command).

```
┌─ ⚡ Create project configuration ───────── [▾] ┐
│                                                  │
│  I'll create .clubhouse/project.json with        │
│  these settings:                                 │
│                                                  │
│  ┌─ project.json ─────────────── [📋] ─────┐    │
│  │  {                                       │    │
│  │    "name": "my-app",                     │    │
│  │    "orchestrator": "claude-code",        │    │
│  │    "agents": {                           │    │
│  │      "default": { "model": "sonnet" }    │    │
│  │    }                                     │    │
│  │  }                                       │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│                    [✓ Approve]  [✎ Edit]  [Skip] │
├──────────────────────────────────────────────────┤
│  ↩ Undo available for 10s after approval         │
└──────────────────────────────────────────────────┘
```

- **Default state**: Expanded (user must see what they're approving)
- **Left border**: `3px solid var(--ctp-accent)` (actionable indicator)
- **Code preview**: Monaco inline, read-only, with copy button
- **Edit flow**: Clicking "Edit" opens Monaco inline editor in the card
- **After approval**: Card collapses to a success state:
  ```
  ┌─ ✓ Created project.json ──────────── [▸] [↩] ┐
  └────────────────────────────────────────────────┘
  ```
- **Undo**: 10-second toast at bottom of feed. After timeout, card shows
  final "completed" state.

### 2. Preview Card
**When:** Showing an entity (project, agent, canvas, plugin) from the user's
workspace.

```
┌─ 📦 Project: my-app ───────────────────── [▾] ┐
│                                                  │
│  ┌──────┐  my-app                                │
│  │ icon │  /Users/me/projects/my-app             │
│  └──────┘  3 agents · 2 canvases · 5 plugins    │
│                                                  │
│  Orchestrator: Claude Code CLI                   │
│  Last active: 2 minutes ago                      │
│                                                  │
│                          [Open Project]  [···]   │
└────────────────────────────────────────���─────────┘
```

- **Default state**: Collapsed (summary line only)
- **Expanded**: Shows full metadata, description, status
- **Thumbnail**: Entity icon/avatar, 40×40
- **Metadata**: Key-value pairs in `text-xs text-ctp-subtext0`
- **Action**: "Open Project" / "View Agent" / "Open Canvas" — navigates in app

### 3. Code Snippet Card
**When:** Showing generated code, config examples, or API references.

```
���─ 💻 agent-config.ts ────────────── [📋] [▾] ┐
│                                                │
│  ┌─ typescript ──────────────────────────────┐ │
│  │  1 │ export const agentConfig = {         │ ��
│  │  2 │   name: 'my-agent',                  │ │
│  │  3 │   model: 'sonnet',                   │ │
│  │  4 │   tools: ['read', 'write', 'bash'],  │ │
│  │  5 │ };                                    │ │
│  └────��───────────────────────────────────────┘ │
│                                                  │
│                  [Insert at Cursor]  [Copy]       │
└────────────────��──────────────────────────────���──┘
```

- **Default state**: Collapsed to 5 lines, expand for full
- **Syntax highlighting**: Monaco inline, language auto-detected from filename
- **Line numbers**: Always visible
- **Actions**: Copy (to clipboard), Insert at Cursor (if editor is open)
- **Language badge**: Top-left inside code block, `text-[10px] text-ctp-subtext0`

### 4. Diff Card
**When:** Showing proposed changes to existing files.

```
┌─ 📝 Changes to settings.json ──────────── [▾] ��
│                                                  │
│  ┌─ unified diff ────────────────────────────┐   │
│  │    "orchestrator": "claude-code",         │   │
│  │ -  "model": "haiku",                      │   │
│  │ +  "model": "sonnet",                     │   │
│  │    "tools": ["read", "write"],            │   │
│  └────────���──────────────────────────────────┘   │
│                                                  │
│  1 file changed, 1 insertion, 1 deletion         │
│                                                  │
│                    [✓ Apply]  [✎ Edit]  [Skip]   │
└─��────────────────────────────────────────────────┘
```

- **Default state**: Expanded (user must review changes)
- **Diff format**: Unified by default, toggle to side-by-side if width > 500px
- **Colors**: Removed: `bg-red-500/10 text-red-400`, Added: `bg-green-500/10 text-green-400`
- **Summary line**: File count + insertions/deletions
- **Actions**: Apply (writes changes), Edit (opens in Monaco), Skip

### 5. Step Indicator Card
**When:** Multi-step wizard flow (e.g., "Set up your first project").

```
┌─ 🔢 Step 2 of 4: Configure Orchestrator ──────┐
│                                                  │
│  ○────●────○────○                                │
│  Name  Orch  Agents  Done                        │
│                                                  │
│  Which orchestrator will you use?                │
│                                                  │
│  ┌─────────────────┐  ┌─────────────────┐        │
│  │  Claude Code    │  │  GitHub Copilot │        │
│  │  CLI (P1)  [✓]  │  │  CLI (P1)       │        │
│  └─────────────────┘  └─────────────────┘        │
│  ┌─────────────────┐                             │
│  │  Codex CLI      │                             │
│  │  (P2)           │                             │
│  └─────────────────┘                             │
│                                                  │
│                          [← Back]  [Next →]      │
└──────────────────��───────────────────────────────┘
```

- **Default state**: Always expanded (user is actively working through steps)
- **Progress bar**: Horizontal dots/line, filled up to current step
- **Step labels**: Below dots, `text-[10px] text-ctp-subtext0`
- **Current step**: `text-ctp-accent font-semibold`
- **Completed steps**: `text-ctp-text` with checkmark
- **Selection controls**: Radio-style cards for choices, checkbox for multi-select
- **Navigation**: Back/Next buttons, Next disabled until selection made
- **Sticky option**: Step indicator can be sticky at top of feed (like PlanProgress)

### 6. Explanation Card
**When:** The assistant is teaching/explaining a concept with visuals.

```
┌─ 💡 How Canvas Layout Works ──────────── [▾] ┐
│                                                │
│  ┌─ animated diagram ───────────────────────┐  │
│  │                                           │  │
│  │   ┌─Hub─┐       ┌─Spoke─┐                │  ���
│  │   │     │──────→│       │                │  │
│  │   │     │──────→┌─Spoke─┐                │  │
│  │   └─────┘       │       │                │  │
│  │                  └─────���─┘                │  │
│  │                                           │  │
│  │   [▶ Replay]                              │  │
│  └─────────���─────────────────────────────────┘  │
│                                                  │
│  A **hub** canvas is the central workspace.      │
│  **Spokes** are connected canvases that the      │
│  hub can read from and write to.                 │
│                                                  │
│          [Got it]  [Tell me more]  [Show example] │
└─────────────────────��────────────────────────────┘
```

- **Default state**: Expanded
- **Illustration**: Animated SVG following conventions from rich-content spec
- **Text**: Below illustration, markdown-rendered, `text-sm leading-relaxed`
- **Actions**: Acknowledgment ("Got it"), follow-up prompts
- **Follow-up buttons**: Act as user input — clicking "Tell me more" sends
  that as a message to the assistant

---

## Interaction Patterns

### Progressive Disclosure
1. Cards start collapsed in the feed (except action/diff/step cards)
2. User clicks to expand → shows full content
3. Expanded cards can have nested expandable sections (e.g., "Show raw JSON")
4. Collapse all: Ctrl+Shift+C collapses all expanded cards in feed

### Consent Controls
Every card that proposes a change has explicit controls:
- **Approve/Apply** (green): Execute the proposed action
- **Edit**: Modify before applying (opens inline editor)
- **Skip/Dismiss**: Don't do this, continue conversation
- No action happens without explicit user consent

### Undo System
- After any approved action, a 10-second undo toast appears:
  ```
  ┌──────────────────────────────────────────────┐
  │  ✓ Created project.json        [Undo] · 7s   │
  └────────��─────────────────────────────────────┘
  ```
- Toast: `fixed bottom-4 left-1/2 -translate-x-1/2` (centered bottom)
- Style: `bg-ctp-surface1 text-ctp-text rounded-lg px-4 py-2 shadow-lg`
- Countdown: Circular progress or text countdown
- After timeout: Toast fades, action is permanent

### Follow-Up Prompts
Cards can include clickable follow-up suggestions:
- Render as pill buttons below card content
- Style: `bg-surface-0 text-ctp-subtext1 rounded-full px-3 py-1 text-xs`
- Hover: `bg-surface-1 text-ctp-text`
- Click: Sends the button text as a user message

---

## Keyboard Navigation

- **Tab**: Move focus between cards in feed
- **Enter/Space**: Expand/collapse focused card
- **A**: Approve focused action card
- **E**: Edit focused action card
- **S**: Skip focused action card
- **Escape**: Collapse focused card or dismiss undo toast
- Focus ring: `ring-2 ring-ctp-accent ring-offset-2 ring-offset-ctp-base`

---

## Responsive Behavior

### ≥600px (normal)
Full card layout as specified.

### 400-599px (narrow)
- Diff cards: unified only (no side-by-side toggle)
- Step indicator: Dots only, no labels (labels on hover)
- Entity previews: Stack vertically instead of inline
- Code blocks: No line numbers (save horizontal space)

### <400px (minimal)
- All cards: full-width, no margin
- Action buttons: Stack vertically
- Code: Horizontal scroll instead of wrap
