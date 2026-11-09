---
name: memory-upkeep
description: What to do when a Memory upkeep message arrives. Use it to check the listed memory pages against the transcripts they cite, fix what is wrong, and keep the index short.
---

# Memory upkeep

Clubhouse has already rolled up the timeline, fixed links that moved and archived unused unconfirmed topics. The message lists what is left for you. This is for you alone: don't call `tell_user`, and don't wake or message agents.

1. **Check each listed page,** unconfirmed ones first.
   - Search for its key facts with `search_memory`, scope `transcripts`.
   - A transcript backs it: set `Status: confirmed` and put the hit's link in `Source:`.
   - A transcript contradicts it: fix the page, or remove what is wrong.
   - Nothing backs it: leave it unconfirmed. Clubhouse archives it later if nothing uses it.
2. **Fix what Clubhouse couldn't,** listed at the end of the message: a cited file that is gone, or a link that goes nowhere. Point it at the right page or transcript, or remove it.
3. **Keep `index.md` short.** What is going on now, and links to pages. Move detail into topic pages, and take finished work off the index once its topic page says it is done.
4. **Stop when the list is done.** Don't review all of memory.
