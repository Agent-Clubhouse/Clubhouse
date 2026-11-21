# Independent QA: #13 contract successor and Dispatcher Actions note

Reviewer: qa-details-local-composition, November 21, 2026. Nothing was executed by me apart from hashing.

## A. #13 contract successor

- **Target:** `b26fabe2d1b4c13be1824ecde16f09aa6ba8ab74`, parent `c27a1bfcf`. It is docs only and changes only `3733-selected-board-read-contract.md`.
- **This report supplements** my `c27a1bfcf` report at `c3843f887`. Both reviews ran in parallel, so this successor predates B-1.

### Resolved in this successor

- **Labels:** the member view uses the selected agent's name, which is already in the body. Every other agent view is labelled `Agent`, with no name, `displayName` or `title`. ACCEPT. This is stricter than my stored-label option and matches your preference.
  - Wording nit: "No existing permitted Details projection exports other agents' board labels" is true of **Details**. Untruncated snapshots do export raw boards, and the options note already says so. Suggest adding "(snapshot exposure is separate and not relied on)" to avoid a contradiction.
- **Transition:**
  - Preview is offered only for omission or absence refusals. A navigable row shows Open only; host or reconnect refusals show neither.
  - It is re-evaluated on every store change.
  - When the row becomes navigable, an open preview closes and a pending read is discarded on arrival.
  - Nothing reopens automatically, and no stale page is retained.
  - ACCEPT, with matching renderer proofs.
- **Fallback:** unavailable, an older host's 400 or a transport failure shows the existing refusal plus one status line, with no retained preview. ACCEPT.
- **Honest scope:** it states that it is "not canvas-tab navigation" and "doesn't complete #13". ACCEPT. Per your note, #13 completion remains open against the original objective. The reviewer can't waive it, and I don't.

### Still required (from the `c27a1bfcf` report, not yet addressed)

- **B-1 (mixed-version blocker):** `isRemoteAgentDetails` at `shared/remote-agent-details.ts:96` rejects any unknown `inventorySources` entry. Advertising `selected-canvas-board` in the overview would make every older client, including current main, reject the whole remote Details read.
  - **Fix:**
    - don't advertise it;
    - the host admits a board query when membership is offered (the gate at `remote-agent-details.ts:101`);
    - the client probes, and maps an older host's 400 to `unavailable`, as already specified;
    - the new page validator binds the board page to the advertised membership source;
    - an old-client frozen-fixture control.
- **Widening points:**
  - (i) dispatch by source at `remote-agent-details.ts:106`;
  - (ii) the membership and board readers each refuse the other's query, tested both ways;
  - (iii) an explicit board branch in `isRemoteInventoryPage`;
  - (iv) the route's `member` key allowed for the board source only.
- **Budget:** pre-measure against the remaining M1 budget so the result is `unavailable: 'limit'`. Add a control with 500 or fewer views and long labels.

**Verdict for A:** APPROVE the label, transition, fallback and scope amendments. The contract is ready for implementation **once B-1 and widening points (i) to (iv) are added**. That is a docs-only successor, and I'll confirm it quickly.

## B. Dispatcher Actions note correction

- **Product:** `ad46882fa8fa44a796bf4125bc62f77879f4ef23`, tree `cdb230a2e0f86e5387062ece080f77b2c0dbd55b`, parent `be0091d16`.
- **Docs tip:** `be4e983493acf9f71f353af63e936b711484b22b`, which matches `origin/details-local-composition/3733-dispatcher-actions-note`. The tip changes only the 16 files under `docs/implementation-notes/3733-dispatcher-actions-note-evidence/`, with no source change.

### Source: correct

- `selected-details-page.ts:51` builds one group, `dispatcher`, for `subject.dispatcher` (`owner.kind === 'dispatcher'`). The new note, "Relationship rows list Actions made by the Dispatcher…", is accurate.
- The ordinary three-group note is byte-identical, and the second note is unchanged.
- The test checks:
  - page validity;
  - both rows grouped as `dispatcher`, with the third, non-Dispatcher Action excluded;
  - the exact new note, and the absence of the "owner, target and trigger" and "multiple groups" wording;
  - the ordinary note unchanged;
  - `notes[1]` shared.
- No wire, type or authority change.

### Evidence verification (hashing only)

- All 15 `SHA256SUMS` entries match the committed normalized copies.
- `state-before` and `state-after`: head `ad46882fa`, tree `cdb230a2e`, 0 status lines, run from 11:47:35Z to 11:54:19Z.
- `hashes-before` equals `hashes-after`. Both changed files hash to the `ad46882fa` blobs, which I recomputed: `d200323c…` and `2fcbeaf5…`.
- `exits.txt`: vitest, tsc and eslint all 0. `vitest-raw`: 1468 files passed and 13 skipped; 35868 tests passed and 114 skipped. tsc and eslint raw output is empty, the sha256 of an empty file.
- **Mutation:** `subject.dispatcher ?` → `false ?` fails exactly the new test (1 failed, 233 passed), and the restore is byte-identical to `d200323c…`. It discriminates.
- Committed copies are path-normalized. `raw-originals.sha256` records digests of the host-local originals, which I can't check because they aren't in the repo.

**Verdict for B: APPROVE** `ad46882fa` for PR, with evidence `be4e98349`. The executed credit is exactly the full suite, tsc and lint at `ad46882fa`, as recorded. Hosted CI on the PR head is still required, and there is no live acceptance.
