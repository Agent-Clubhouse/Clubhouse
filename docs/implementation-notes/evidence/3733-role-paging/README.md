# #14: Dispatcher role Connections paging

Branch `details-local-composition/3733-role-paging-2820`, built on the #3749 head `2820e56dd6d345bea7377d7c8b43f42bab6d8c87` by cherry-picking the original #14 commits `8afcf85b8` and `7d3e3f290`. They applied without conflicts as `55ee36bfb` and `1bd612ca6fce8ea2463b231798f3b4abd27d4fb5`. Sanitized copies of output.

## Contract

- **Host:** `/api/v1/dispatcher/details` accepts only `card=connections` with `source`, `offset` and `projectOffset`, parsed as strictly as ordinary Details page queries. Any other key, a duplicate or a malformed number gets 400.
- **Role resolution is unchanged:** the role is resolved on the host under the same `desktopDetailsAuthorized` gate before and after the read, with the same role receipt (409 on change). The page body must match the query.
- **Service:** `readSelectedDispatcherDetails` refuses before it validates a query, so an unauthorized caller gets 403 before any 400.
- **Client:** `requestDispatcherDetails(machine, query, expectedAgentId)`.
  - A page must name the role agent the overview returned. Another role, a mismatched page or a whole read is an error.
  - A 400 to a page query (an older host) is unavailable. A whole-read 400 stays an error.
  - A 401/403 revokes only the receipt the read ran under.
- **Role pane:** source and page navigation inside Connections, shown only when the host advertises `connectionPages === 1`. Older hosts get a summary-only note.
- **Out of scope:** role Actions inventory paging.

## Checks on `1bd612ca6fce8ea2463b231798f3b4abd27d4fb5`

- `tsc.txt`: exit 0. `lint.txt` (the 16 changed files): exit 0.
- `focused.txt`: 11 files, 1206 passed, with a fresh `TMPDIR`. Pre- and post-status clean.
- Mutation logs, each with a byte-identical restore and post-restore status:
  - Effective: `client-binding`, `route-card`, `service-page` and `renderer-agent` each fail 1 test.
  - **Ineffective, no credit:** `renderer-context-ineffective` (dropping `contextKey` from the navigator identity) passes. On any role-context change the overview read re-keys and unmounts the navigator, so the identity key is redundant.
- `store-before.txt` and `store-after.txt`: shared store unchanged (isolated `node_modules`).

Not run: a full suite.
