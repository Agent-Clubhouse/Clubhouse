# Phase 2 Design Review — Assistant UI Implementation

**Date:** 2026-03-29
**Reviewer:** Assistant-UI-Lead
**Scope:** All assistant UI components after Phase 2 test sprint

## Overall Assessment: Production-Ready with Minor Polish

The implementation is **well-built and design-compliant**. Catppuccin tokens are
used consistently, component architecture is clean, and accessibility basics are
covered (keyboard nav, focus states).

## Component Inventory (7 components, all complete)

| Component | Lines | Design Compliance |
|-----------|-------|-------------------|
| AssistantView | ~75 | Good — tri-state rendering matches spec |
| AssistantHeader | ~135 | Good — avatar, status, mode toggle, orchestrator selector |
| AssistantFeed | ~300 | Good — auto-scroll, welcome state, suggestion chips, action grouping |
| AssistantMessage | ~50 | Good — dual-mode (user right, assistant left with markdown) |
| AssistantInput | ~95 | Good — auto-expand, status-aware placeholders |
| AssistantActionCard | ~270 | Good — approve/skip, expandable details, duration display |
| types.ts | ~42 | Clean — FeedItem union, ActionCardData, status types |

## Issues Found

### Issue 1: Hardcoded Status Colors (Low Severity)
**Location:** `AssistantActionCard.tsx` (StatusIcon, status colors)
**Problem:** Uses Tailwind `text-red-400` / `text-green-400` instead of Catppuccin
theme variables. Colors happen to match Mocha visually, but won't adapt to theme changes.
**Fix:** Replace with `text-[#f38ba8]` (ctp-red) and `text-[#a6e3a1]` (ctp-green),
or define `text-ctp-error` / `text-ctp-success` utilities in index.css.

### Issue 2: Message Padding Inconsistency (Very Low Severity)
**Location:** `AssistantMessage.tsx` (line ~26)
**Problem:** Uses `px-3 py-2` while existing `MessageStream.tsx` uses `px-4 py-2`.
4px horizontal difference, visually negligible.
**Fix:** Standardize to `px-3 py-2` (assistant's convention is reasonable for
narrower chat context).

### Issue 3: Mascot Placeholder Pending Pip Integration
**Location:** AssistantHeader, AssistantFeed, AssistantMessage
**Problem:** Generic inline robot SVG icon (stroke-based, 18x18/6x6) used as
placeholder. Full Pip mascot with expressions not yet integrated.
**Status:** Pip SVGs and sleeping component ready in `docs/assistant-ui/mascot/`.
Integration blocked on routing the assistant into App.tsx.

## Design Decisions Verified

- [x] Full-width layout (replaces HelpView in ProjectPanelLayout)
- [x] Max content width 600px centered for readability
- [x] Catppuccin Mocha tokens throughout (base, mantle, surface0, accent)
- [x] Typography hierarchy: text-xs body, text-sm headers, text-[10px] metadata
- [x] Spacing: gap-2/gap-3, px-3 py-2 cards — matches ToolCard pattern
- [x] Keyboard accessible: Enter to send, Shift+Enter for newline, tab navigation
- [x] Suggestion chips in welcome state (6 contextual prompts)
- [x] Action grouping with collapsible cards and progress count
- [x] Approve/Skip consent controls on mutating tools
- [x] Expandable details (params, results, errors) via progressive disclosure
- [x] Auto-scroll with user-override detection (60px threshold)

## Content Review

### Personas (7 files in `content/personas/`)
- project-manager, qa, ui-lead, slop-detector, executor-pr-only, executor-merge, doc-updater
- All present and appropriately scoped

### Cookbooks (in `content/cookbooks/`)
- Scaffolding recipes for common project patterns

### Identity & Help
- `identity.md` — Clear boundary definition (what assistant can/cannot do)
- `recipes.md` — 7 workflow patterns
- `tool-guide.md` — MCP tool usage reference

## Recommendations for Main Integration

1. Fix hardcoded colors (5-minute change, can be part of any PR)
2. Integrate Pip mascot SVGs into components (replace placeholder icons)
3. Add assistant route to App.tsx alongside HelpView
4. Add Pip icon button to ProjectRail footer
5. Verify all three modes end-to-end after routing

## Test Coverage

- Unit tests: assistant-ui.test.ts, action-card.test.ts, assistant-agent.test.ts
- Component tests: AssistantView (9), AssistantMessage (7)
- Handler tests: assistant-handlers.ts (24), canvas-command-handler.ts (16)
- E2E: 19 independent tests (panel, conversation, builder persona, modes)
- **75 tests added in Phase 2 test sprint** — significant coverage improvement
