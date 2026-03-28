# Assistant UI — Open Questions

Questions that need owner/coordinator input before design can proceed.

## Active

### 1. Mascot direction preference
**Context:** Three character directions created — Beacon (lightbulb antenna),
Ori (question-mark crest), Pip (glowing core). See `mascot/rationale.md` for
full tradeoffs.

**My recommendation:** Pip (most compact, best at small sizes, richest animation
surface) potentially hybridized with Ori's question-mark motif.

**Blocking:** Expression sheet and size variants — need to know which direction
to develop.

**Posted:** 2026-03-28

### 2. Chat panel placement confirmation
**Context:** CLAUDE.md specifies "replacing the help view in ExplorerRail."
After analyzing the codebase, I'm proposing the assistant takes over the full
ProjectPanelLayout area (same as HelpView does today), not a narrow sidebar.
This gives drill-in cards and previews the space they need. See
`chat-layout/proposal.md` for full rationale.

**Decision needed:** Full-width replacement (recommended) vs. sidebar panel?

**Posted:** 2026-03-28 (updated)

### 3. Conversation persistence
**Context:** Should assistant conversations persist across sessions (requiring
a conversation list/switcher) or start fresh each time?

**Blocking:** Chat feed state management design

**Posted:** 2026-03-28

### 4. Split-view for previews
**Context:** When the assistant offers "show me" previews, should they open
in a side-by-side layout (assistant left, preview in AccessoryPanel slot) or
expand inline within the feed?

**Blocking:** Drill-in card interaction design

**Posted:** 2026-03-28
