# Independent QA: #3733 item 14, Dispatcher role Connections paging

Reviewer: qa-details-local-composition. November 21, 2026.
Head: `dd4fe669491509dbcbe180121b0ce8845ebacdb6` (`origin/details-local-composition/3733-role-paging-2820`, remote verified). It adds docs only on top of the source `1bd612ca6fce8ea2463b231798f3b4abd27d4fb5` and the contract commit `55ee36bfb`, on the reviewed #3749 head `2820e56dd`. 16 files.
Method: I read source and committed artifacts only and ran nothing.

## Verdict

**APPROVE, scoped to Connections-only role paging.**
- **Role Actions paging stays deferred.** No completeness claim for #14 may include it.
- Landing depends on #3749 landing first and then a current-source composition proof. No PR before then, as you said.

## Source

- **Route** (`annex-server.ts:4114`):
  - mTLS, then `desktopDetailsAuthorized`, with a 403 **before** any query parsing. Authorization comes before the strict parse.
  - The query is parsed as strictly as ordinary Details pages: allowlisted keys, each appearing once, numeric offsets matching `^(0|[1-9]\d{0,3})$`, and `isSelectedDispatcherConnectionsQuery` (an `isRemoteDetailsQuery` with `card === 'connections'` only).
  - The query is handed to the producer, and the existing final role receipt still answers 409 when stale.
- **Producer** (`selected-dispatcher-details.ts`):
  - It pages only the host-selected role (`target.agent.id`), with no caller identity.
  - The inner body must validate as `isRemoteAgentDetails`. For a page, the wrapper must pass `isSelectedDispatcherConnectionPage(body, query)`, which requires `connectionPageOnly === true`, the page's source, offset and projectOffset to match the query, no helper or inventory page-only flags, and the byte bound.
  - A full read still rejects page-only envelopes.
- **Client** (`requestDispatcherDetails`):
  - With a query, it requires a valid query **and** a non-empty `expectedAgentId`.
  - A response is accepted only if it is a valid Connections page for that exact query with `agentId === expectedAgentId`, so a different role gives `error`.
  - **Old host:** a page 400 gives `unavailable`, while a whole-read 400 gives `error`. 404, 405 and 409 give `unavailable`, unchanged.
  - The pin, role, kind, epoch **and receipt-identity** checks in `current()` are unchanged. 401 and 403 still go to `invalidateSnapshotAdmission(sat, receipt)`.
- **IPC and preload:** optional `objectArg` and `stringArg(maxLength 2048)`. The overview call shape is unchanged when there is no query.
- **Renderer** (`RemoteDispatcherConnectionPages.tsx`, used in `RemoteDispatcherRoleDetails`):
  - It appears only with an eligible role value and `connectionPages === 1`. Older hosts get the note "summary only, needs host update".
  - Page reads pass the overview's `value.agentId`, and results are re-checked for `agentId` and for page identity against the query.
  - Navigation is keyed on the role context key (generation, receipt, pause, role revision, retry) plus the role agent, so any context change resets to Overview.
  - The previous-page stack is limited to 32 entries.
- **Fences retained:**
  - `connectionAttempt` ×5, the clock-only retry and O1 ×2 are present;
  - none of the touched files overlaps #3753 (P7);
  - the overview role read is unchanged.

## Evidence (`evidence/3733-role-paging/`)

- **Seals and head:** all 13 committed copies match. `validated-head` is `1bd612ca6`. Pre-status is empty and a clean post-status is printed. The store is unchanged before and after.
- **Focused run:** **11 files, 1206 passed**, exit 0.
- **Typecheck and lint:** tsc exits 0. Lint has 0 errors and 490 warnings.
- **Mutations:** each is restored byte-identical with a clean post-status.

| Mutation | Result |
| --- | --- |
| `route-card` (shared query validator) | 1 failed: "…no page other than a Connections source page" |
| `service-page` | 1 failed: "pages the host-selected role Connections only, validating the page against the query" |
| `client-binding` | 1 failed: "…bound to the first page's role agent, with older hosts unavailable" |
| `renderer-agent` | 1 failed: "…with the overview role agent and resets on a role event" |
| `renderer-context` | **ineffective** (27 passed), no credit |

## Observations

- **Renderer context reset:** nothing discriminates it at the renderer level. A stale page after a receipt or epoch change is still refused in main by `current()`, which returns offline. Consider a renderer control that changes only the receipt and checks the reset to Overview.
- **Authorization order:** this is verified from source. There is no dedicated mutation for it, though the route test covers the refusal.
