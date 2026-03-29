# Assistant UI — Open Questions

Questions that need owner/coordinator input before design can proceed.

## Active

### ~~1. Mascot direction preference~~ RESOLVED
**Decision:** Pip (Comp C) confirmed by coordinator on 2026-03-28.
Expression sheet complete.

### 2. Chat panel placement confirmation
**Context:** CLAUDE.md specifies "replacing the help view in ExplorerRail."
After analyzing the codebase, I'm proposing the assistant takes over the full
ProjectPanelLayout area (same as HelpView does today), not a narrow sidebar.
This gives drill-in cards and previews the space they need. See
`chat-layout/proposal.md` for full rationale.

**Decision needed:** Full-width replacement (recommended) vs. sidebar panel?

**Posted:** 2026-03-28 (updated)

### ~~3. Conversation persistence~~ RESOLVED
**Decision:** Single persistent thread for v1 (coordinator decision 2026-03-28).
**Implementation:** perky-moth (Mission 2) added SAVE_HISTORY / LOAD_HISTORY
IPC handlers persisting to `~/.clubhouse/assistant/chat-history.json`.
History cleared on explicit reset.

### ~~4. Split-view for previews~~ RESOLVED
**Decision:** Inline for v1 (coordinator decision 2026-03-28).
Rich content (entity previews, canvas visualizations, code snippets) renders
inline in the chat feed. Split-view deferred — revisit if inline feels cramped.
