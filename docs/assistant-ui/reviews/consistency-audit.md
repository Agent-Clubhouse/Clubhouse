# Consistency Audit — Assistant UI Components

Audit of assistant UI components against established patterns in ToolCard,
MessageStream, and the broader Clubhouse UI. Performed 2026-03-28.

## Verdict: GOOD — 2 minor issues, no critical problems

The assistant components follow existing conventions well. Font sizes,
border patterns, spacing tiers, and color usage are consistent.

---

## Component Coverage

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| AssistantView | `features/assistant/AssistantView.tsx` | ~60 | Clean container |
| AssistantHeader | `features/assistant/AssistantHeader.tsx` | ~120 | Status-aware |
| AssistantFeed | `features/assistant/AssistantFeed.tsx` | ~100 | Centered feed |
| AssistantMessage | `features/assistant/AssistantMessage.tsx` | ~50 | Markdown renderer |
| AssistantInput | `features/assistant/AssistantInput.tsx` | ~60 | Auto-expanding |
| AssistantActionCard | `features/assistant/AssistantActionCard.tsx` | ~100 | Tool execution |
| types.ts | `features/assistant/types.ts` | ~20 | Feed item types |

Reference patterns:
- `features/agents/structured/ToolCard.tsx`
- `features/agents/structured/MessageStream.tsx`

---

## What's Consistent

### Spacing (matches ToolCard exactly)
- Headers: `px-3 py-2 gap-2`
- Card bodies: `px-3 py-2`
- Feed spacing: `space-y-3`
- Button gaps: `gap-1.5` to `gap-2`

### Font Sizes
- Card headers: `text-xs` (matches ToolCard)
- Message body: `text-sm` (matches MessageStream)
- Duration/meta: `text-[10px]` (matches ToolCard)
- Titles: `text-sm font-semibold`

### Borders & Corners
- Cards: `rounded-lg border border-surface-0 bg-ctp-mantle`
- Dividers: `border-t border-surface-0` or `border-b border-surface-0`
- Error cards: `border-red-500/40 bg-red-500/5`
- All consistent with ToolCard pattern

### Colors (Catppuccin Mocha)
- Text hierarchy: `text-ctp-text` → `text-ctp-subtext1` → `text-ctp-subtext0`
- Backgrounds: `bg-ctp-base` (page) → `bg-ctp-mantle` (cards/bars)
- Surfaces: `bg-surface-0` (hover) → `bg-surface-1` (active)
- Accent: `bg-ctp-accent text-white` (buttons), `bg-ctp-accent/10` (tints)
- Focus: `focus:border-ctp-accent/50`

### Type System
- `ActionCardData` mirrors ToolCard's status pattern (running/completed/error)
- `FeedItem` union type is clean and extensible
- `AssistantStatus` states map well to UI states

---

## Issues Found

### Issue 1: Hardcoded status colors (Minor)
**Where:** `AssistantActionCard.tsx`
**Problem:** Status icons use `text-red-400` and `text-green-400` instead of
theme-aware CSS variables.
**Fix:** Use `text-[#f38ba8]` (ctp-red) and `text-[#a6e3a1]` (ctp-green),
or define `text-ctp-error` and `text-ctp-success` utilities.
**Impact:** Low — the colors happen to match Catppuccin Mocha, but won't
adapt if the theme changes.

### Issue 2: Message padding inconsistency (Minor)
**Where:** `AssistantMessage.tsx` vs `MessageStream.tsx`
**Problem:** AssistantMessage uses `px-3 py-2` while MessageStream uses
`px-4 py-2`.
**Fix:** Standardize to `px-3 py-2` (assistant convention) or `px-4 py-2`
(MessageStream convention). Either is fine — pick one.
**Impact:** Very low — 4px horizontal difference, barely visible.

---

## Patterns to Maintain Going Forward

These conventions should be followed for all new assistant UI work:

1. **Cards**: `rounded-lg border border-surface-0 bg-ctp-mantle`
2. **Spacing**: `px-3 py-2` for compact content, `px-4 py-3` for primary areas
3. **Feed items**: `space-y-3` between items
4. **Text**: `text-sm` for body, `text-xs` for meta/labels, `text-[10px]` for tiny
5. **Buttons**: `text-xs rounded px-3 py-1.5` for inline,
   `text-sm rounded-lg px-4 py-2` for primary
6. **Colors**: Always use Catppuccin CSS variables, never hardcode hex values
7. **Hover**: `hover:bg-surface-0` or `hover:bg-surface-0/50`
8. **Focus**: `focus:border-ctp-accent/50` for inputs,
   `ring-2 ring-ctp-accent` for keyboard focus
9. **Transitions**: `transition-colors` on interactive elements, 150ms default
10. **Max content width**: 600px centered with `max-w-[600px] mx-auto`
