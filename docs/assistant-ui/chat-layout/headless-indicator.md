# Headless Mode Indicator Spec

When the assistant works in the background (headless mode), the user needs
to know something is happening without the chat panel being open. This spec
covers the notification system for background assistant activity.

---

## Components

### 1. Activity Badge (ProjectRail Icon)

The robot icon in ProjectRail shows activity state:

```
┌────────────┐
│            │
│   [🤖]    │  ← Robot icon (18px pip-icon)
│     ●     │  ← Activity dot (bottom-right)
│            │
└────────────┘
```

**States:**

| State | Badge | Color | Animation |
|-------|-------|-------|-----------|
| No assistant | None | — | — |
| Idle (panel closed) | None | — | — |
| Working (panel closed) | Dot | `--ctp-accent` (#89b4fa) | `badge-dot-blink` (1.5s) |
| Needs attention | Dot | Orange (#f97316) | `badge-pulse` (2s) |
| Error occurred | Dot | Red (#f38ba8) | Steady (no animation) |
| Completed task | Dot | Green (#a6e3a1) | Fade out after 5s |

**Badge dot:**
- Size: 6×6px circle
- Position: Bottom-right of icon, offset by (-2px, -2px) from corner
- Border: 1.5px `var(--ctp-mantle)` to separate from icon
- Z-index: Above icon

**CSS:**
```css
.assistant-badge {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1.5px solid var(--ctp-mantle);
}

.assistant-badge--working {
  background: var(--ctp-accent);
  animation: badge-dot-blink 1.5s ease-in-out infinite;
}

.assistant-badge--attention {
  background: #f97316;
  animation: badge-pulse 2s ease-in-out infinite;
}

.assistant-badge--error {
  background: #f38ba8;
}

.assistant-badge--done {
  background: #a6e3a1;
  animation: badge-fade-out 5s ease-out forwards;
}

@keyframes badge-fade-out {
  0%, 80% { opacity: 1; }
  100% { opacity: 0; }
}
```

### 2. Toast Notifications

When the assistant completes a background task or needs attention, show a
toast notification that slides up from the bottom.

```
┌──────────────────────────────────────────────────┐
│ [pip 24px]  Created project "my-app"       [View]│
│             with 2 agents and 1 canvas      [✕]  │
└──────────────────────────────────────────────────┘
```

**Toast anatomy:**
- **Mascot**: 24px Pip avatar in appropriate expression (celebrating, error, permission)
- **Title**: Action summary in `text-sm font-semibold text-ctp-text`
- **Subtitle**: Detail in `text-xs text-ctp-subtext0`
- **View button**: Opens assistant panel to the relevant message
- **Dismiss**: Close toast (✕)

**Toast styling:**
```css
.assistant-toast {
  position: fixed;
  bottom: 16px;
  right: 16px;
  max-width: 360px;
  padding: 12px 16px;
  background: var(--ctp-surface1);
  border: 1px solid var(--ctp-surface0);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 50;
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
```

**Toast types:**

| Type | Left Border | Mascot | Auto-dismiss |
|------|------------|--------|-------------|
| Success | Green (#a6e3a1) | Celebrating | 8s |
| Info | Blue (#89b4fa) | Idle | 6s |
| Warning | Orange (#f97316) | Permission | No (requires action) |
| Error | Red (#f38ba8) | Error/Sorry | No (requires action) |

**Auto-dismiss behavior:**
- Success/info toasts auto-dismiss after timeout
- Warning/error toasts stay until user interacts
- Hovering pauses auto-dismiss timer
- Stacking: Max 3 toasts visible, oldest on top, newest at bottom

**Animations:**
```css
.assistant-toast-enter {
  animation: toast-slide-in 0.25s ease-out;
}

.assistant-toast-exit {
  animation: toast-slide-out 0.2s ease-in forwards;
}

@keyframes toast-slide-in {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes toast-slide-out {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(16px); }
}
```

### 3. Status Bar Text (Inside Chat Panel)

When the chat panel IS open and the assistant is working headlessly:

```
┌─ Header ────────────────────────────────────────┐
│ [pip 32px]  Assistant                      [···] │
│              Working... Creating project         │
└─────────────────────────────────────────────────┘
```

**Status text:**
- Position: Below "Assistant" title in header
- Font: `text-xs text-ctp-subtext0`
- Content: "[State]... [Current action description]"
- Truncate with ellipsis at panel width

**Status states:**
| State | Text | Color |
|-------|------|-------|
| Idle | "Ready to help" | `text-ctp-subtext0` |
| Thinking | "Thinking..." | `text-ctp-subtext0` |
| Working | "Working... [action]" | `text-ctp-accent` |
| Waiting for approval | "Waiting for your approval" | Orange (#f97316) |
| Error | "Something went wrong" | `text-red-400` |

---

## Interaction Flows

### Background Task Completion

1. User asks assistant to do something, closes panel
2. Badge appears on ProjectRail icon (working state, blue dot blink)
3. Assistant completes task
4. Badge changes to green (done)
5. Toast slides in: "[pip celebrating] Done! Created project with 2 agents"
6. User clicks "View" ��� panel opens, scrolled to completion message
7. Toast dismisses, badge fades after 5s

### Background Error

1. Badge on ProjectRail icon (working state)
2. Error occurs
3. Badge changes to red (steady)
4. Toast slides in: "[pip error] Couldn't create canvas — missing permissions"
5. Toast stays until user clicks "View" or dismisses
6. "View" opens panel to error message with retry option

### Permission Needed

1. Badge changes to orange (attention pulse)
2. Toast: "[pip permission] Need approval to modify settings.json"
3. Toast includes "Review" button (not auto-dismiss)
4. "Review" opens panel to the pending action card with Approve/Skip

---

## Keyboard Accessibility

- **Toast focus**: Toasts are announced via `aria-live="polite"` region
- **Tab to toast**: Tab from main content reaches toast actions
- **Escape**: Dismiss topmost toast
- **Toast role**: `role="status"` for info/success, `role="alert"` for error/warning
