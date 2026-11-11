---
name: memory-upkeep
description: What to do when a Memory upkeep message arrives. Use it to check the listed memory pages against the transcripts they cite, fix what is wrong, and keep the index short.
---

# Memory upkeep

Clubhouse has already rolled up the timeline, fixed links that moved and archived unused unconfirmed topics. The message lists what is left for you. This is for you alone: don't call `tell_user`, and don't wake or message agents.

Use `read_memory` and `write_memory` for the listed pages. Prefer these tools over direct file edits: they record reads and writes, stamp topic dates and keep bounded versions. Direct edits are discouraged, not blocked. Do not edit history or the access record.

1. **Check each listed page,** unconfirmed ones first.
   - Search for its key facts with `search_memory`, scope `transcripts`.
   - A transcript backs it: set `Status: confirmed` and put the hit's link in `Source:`.
   - A transcript contradicts it: keep a short `Conflicting: YYYY-MM-DD ...` line with both facts, dates and sources before resolving against transcripts. Keep the newer, better-sourced fact, not just the newest claim. Keep the five newest dated conflict lines, each at most 500 characters; unresolved conflicts stay for review rather than being archived.
   - Nothing backs it: leave it unconfirmed. Clubhouse archives it later if nothing uses it.
   - Preserve `Status:`, `Source:`, `Created:` and `Updated:` header lines and any unknown headers. Use ISO 8601 dates with a zone; keep Created unchanged and set Updated when facts change. Add inline dated source trailers to important facts. Old pages without dates remain valid; add dates when editing, not in a bulk rewrite.
2. **Fix what Clubhouse couldn't,** listed at the end of the message: a cited file that is gone, or a link that goes nowhere. Point it at the right page or transcript, or remove it.
3. **Keep `index.md` short.** What is going on now, and links to pages. Move detail into topic pages, and take finished work off the index once its topic page says it is done.
   - A neglected page has not been read or updated by the controller in 30 days, or has never been read and is that old. Read the listed pages, then keep, merge or retire them with sources. Do not delete confirmed topics without judgment. No list means no extra review.
4. **Stop when the list is done.** Don't review all of memory.
