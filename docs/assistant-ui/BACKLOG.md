# Assistant UI — Design Backlog

Priority order: top = highest impact.

## In Progress

- **More visual templates** — Before/after split, tree/hierarchy

## Done

- **Mascot character design** — Pip selected (Comp C). 3 comps + rationale.
- **Mascot expression sheet** — All 8 emotional states + animation specs + guide.
- **Mascot size variants** — 32px avatar, 18px icon.
- **Chat layout proposal** — Full spec in `chat-layout/proposal.md`.
- **Rich content rendering spec** — Mode-specific rendering, ContentFrame, SVG conventions.
- **Drill-in card designs** — 6 card types, interaction patterns, consent/undo system.
- **Visual explanation templates** — Flow diagram + architecture block prototypes + guide.

## Up Next
2. **Visual explanation templates** — Reusable patterns for "here's how this
   works" content (annotated diagrams, concept animations, walkthrough GIFs)
3. **Animated concept illustrations** — Canvas layout, agent connections,
   plugin architecture — visual teaching aids the assistant can embed
4. **Sleeping mascot integration** — Sleeping variant matching SleepingMascots.tsx
   pattern for the assistant orchestrator entry
5. **Animation keyframes** — CSS animation specs for each mascot state
   transition, respecting prefers-reduced-motion
6. **Structured view layout** — Interactive card layouts for wizard/config flows
7. **Headless mode indicator** — Background activity badge, toast notification
   designs with mascot micro-expressions
8. **PTY sidebar visual spec** — How rich content renders in terminal mode
   via a pushed sidebar panel
9. **Consistency audit** — Review existing assistant-adjacent components
   (ToolCard, MessageStream) for pattern alignment
