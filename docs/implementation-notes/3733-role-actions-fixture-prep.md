# #14 role Actions paging: fixture and source preparation

Recorded November 21, 2026, on top of the frozen contract commit `0853da899` (`3733-role-actions-paging-contract.md`, unchanged). These are tests and analysis only, with **no product source edits**. Nothing here implements the contract, completes #14 or #3733, or replaces the QA contract review or lane3613's hunk clearance.

## 1. Dispatcher relationship-group reuse (open question b)

Read from `main` `50cb77ab6`:

- **Producer.** `actions/selected-details-page.ts` ~51: with `dispatcher = true` the page has exactly one group, `dispatcher`, listing every visible Action whose `owner.kind === 'dispatcher'`. The owned, targeting and triggered-by groups are not computed for the role.
  - This matches the whole-read Actions card (`actions/details-read.ts` ~12, same `dispatcher` branch). Paging introduces no new grouping.
- **Selection token.** `hash([subject, related ids and groups])`, where `subject` is `{ agentId, projectId, dispatcher }`. A token minted for one role agent can't page another: the producer returns `changed`, not rows.
- **Renderer.** `SelectedActionsPage.tsx` ~20 already titles the `dispatcher` group "Made by the Dispatcher". Reuse needs no presentation change.
- **One wording mismatch, existing and not introduced here.** The producer's first page note says rows are "grouped by owner, target and trigger". That's inaccurate for the single-group role page. It's the same text the ordinary Dispatcher page already sends.
  - Recommendation: leave the producer unchanged in this slice (the contract says no producer change) and list it as a follow-up.
- **Not shown for the role**, by the existing semantics: Actions that target or are triggered by the Dispatcher agent but are owned by someone else. This is the same as local and ordinary-remote Details. Recorded so nobody reads it as a parity gap introduced by paging.

## 2. Inventory-page budget boundary (newly required proof)

How the producer enforces the budget, on `main`: an inventory page is never trimmed. `remote-agent-details.ts` ~119 throws `inventory_page_limit` when the page body exceeds `budget`, and the catch returns `500 details_read_failed` (when still authorized). The role service passes non-200 results through unchanged.

Prepared tests:

- **Producer level, passes on `main`.** `remote-agent-details.test.ts`, under "Details byte budget for wrapping callers (M1)": "applies the budget to a Dispatcher Actions inventory page".
  - The page comes from the real `readSelectedActionRelationshipPage`, with a Dispatcher subject, 30 Dispatcher-owned Actions and lone-surrogate names.
  - It checks for 25 `dispatcher` rows, `next: 25`, no private text, a 200 at exactly the natural size, and `500 details_read_failed` one byte under.
  - Discriminating mutation: changing `> budget` to `> budget + 1` at ~119 fails only this test (10 others pass). The restore was byte-identical (sha256 compared).
- **Role-service level, RED until implemented.** `selected-dispatcher-details.test.ts`, describe "role Actions relationship pages (#14, RED-first)":
  - **fixture check (passes):** `actionsPage(agentId, offset, bytes?)` builds a page-only body that `isRemoteAgentDetails` accepts and `isSelectedDispatcherDetails` rejects, padded to an exact size.
  - **RED:** query pass-through with `{ maxBytes: budgetFor(roleId) }` at offsets 0 and 25.
  - **RED:** mismatched pages (other offset, other selection, a whole read) give `500 dispatcher_details_invalid`.
  - **RED, the M1 boundary now reachable:** a page at exactly `budgetFor(id)` returns 200 with the whole response equal to `REMOTE_DETAILS_MAX_BYTES`; one byte over gives `500 dispatcher_details_limit`. Covers ASCII and quoted/non-ASCII role ids.
  - **RED:** a producer `500 details_read_failed` (irreducible page) passes through unchanged.
  - **passes (guard):** mixed or extra keys, a missing or bad selection, a bad offset and the Canvas source give 400 before any role lookup.
  - Observed RED reason: every RED case gets `400 invalid_dispatcher_details_query`, the role path's current refusal of Actions queries. That's the right reason, not a fixture failure.
- **Implementation must update one existing assertion.** The Connections test (~93) lists `{ card: 'actions', source: 'selected-action-relationships' }` among the bad queries, expecting 400. Under the contract that query becomes valid, so the implementation PR replaces it with a still-invalid Actions shape (for example, with `projectOffset`).

## 3. Reachability at the real cap (measured, plus a stated estimate)

- **Measured:** the real producer page in the fixture above is 42,105 bytes, with a 1,577-byte row (a 237-character lone-surrogate name, a 50-character description).
- **Estimate, not proven:**
  - Each row's text is bounded by `display()`: a name of up to 240 characters and a description of up to 2,048 characters. A lone surrogate serializes to 6 bytes.
  - So the worst 25-row page is about 347 KB, above the role budget (about 262,080 bytes for a short role id). Typical ASCII pages are about 40-60 KB.
  - A real at-budget role page needs escape-heavy names or descriptions near the 2,048-character cap; descriptions are built from `describeTrigger` and `describeSteps` with resolved names.
  - The boundary proof therefore uses the producer's exact-size test plus the role service's budget fixture. It doesn't claim a natural real-world page at the cap.

## Validation of this prep

- Commands: targeted `vitest --no-cache --maxWorkers=1` with a fresh `TMPDIR` on both files, `tsc --noEmit` (no errors in these files), and eslint on both test files (clean).
- The isolated per-entry `node_modules` symlinks excluded `.cache` and `.vite`. No installs, and no writes to the shared store.
