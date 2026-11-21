# Independent QA: PR #3749 whole-PR gap review

Reviewer: qa-details-local-composition (two parallel read-only reviewer lanes, findings verified by me). November 21, 2026.
Frozen head: `ead9452306ee273e6ace6b96f12517a0c397e870`. Base: main `69ef383ce`.
Method: I read source only. I ran no tests and made no edits.

## Coverage map

| Range | Status |
| --- | --- |
| main → `4fcae1c95` (cold composition, includes f1220 root, PG1 cherry-picks and 463 superseded) | Bounded APPROVE recorded at `654f56f71` (proof `77f6f2f2d`). Accepted, not re-reviewed. |
| `4fcae1c95` → `b458b4c89` (60 commits, 49 non-test source files, about +1776 lines) | **Reviewed here.** No other verdict files exist; the c8c ledger names reviews without verdict SHAs. |
| `b458b4c89` → `ead945230` | Reviewed earlier: a4edf7adf composition (6cba706d9), 5e3e21cfe successor (bb0ef6b0a), 782e08cde follow-ups (8e36af214), ead945230 28-failure fixes (a753890d5). main's #3744–3746 are covered by main's own review and seen here only through conflict resolution. |

The merges `0056aae0d`, `66b077123`, `6b230d8de`, `b7b40600b` and `b458b4c89` each equal their `git merge-tree` result. The first four have no conflicts. b458b4c89 is the Canvas integration merge.

## Verdict for the gap range

**No blockers and no majors.**
- Two minor findings are open at head (M1 and M2).
- One minor finding was present at b458 and is already fixed at head by `426e08593`.
- The rest are observations.

Combined with the earlier records, every source path in the PR now has a recorded source review or an accepted verdict. This is source review, not acceptance of runtime or live behaviour. Hosted CI remains the gate.

## Areas reviewed with no finding

- **Managed inventory** (`5271faf5f`, `e5c07d627`, `3116ab759`, merge `0056aae0d`):
  - The producer reads only the already-admitted durable snapshot's selected IDs. It checks `isAssetId`, caps at 4096 items and withholds grant-gated skills.
  - It opens a fresh bounded catalog reader for each page and re-checks admission and the reader receipt after every head read.
  - The host then re-checks authorization, target, provider, inventory receipts and run identity, returning 409 or 403.
  - The validators allowlist keys, enforce exact row counts and keep `next` consistent with `total`. The renderer re-validates and matches the page to its request.
- **Actions** (`74dd9c635`, `4f50e6969`, `08b5fa2ac`, `24909be31`, merges `e8f1f3ca0` and `66b077123`):
  - The engine is captured and never initialized, and app-owned actions are hidden.
  - Descriptions are built by `describeAction`, which never includes prompt or message text ("with a prompt" only).
  - The page receipt re-snapshots and hashes the page, so any change returns 409. The strict validator is `isRemoteActionRelationshipPage`.
- **Shared inventory transport** (`useSelectedInventoryPage`, query validators, the client and server query paths): the request matches the response on source, offset and selection, and pages show only while the central Details read is admitted.
- **Canvas membership producer and integration** (`b517b57f3`, `20c94def6`, `fd360a0ec`, merge `b458b4c89`):
  - Sources are only fixed allowlisted files under the home folder and the project folder. Links and `..` are rejected, and backups are only lstat'd.
  - Only the offset and selection are caller-controlled.
  - At most 4096 boards and views are visited. A combined receipt is pushed. A selection mismatch returns `changed`.
  - The renderer checks agent and project identity. A jump re-checks the current snapshot and the remote source.
- **Helper continuation** (`b7b40600b`):
  - The producer checks authorization and target before and after each await. Helper identity must match strictly (config, parent, realpath).
  - Work checks are bounded to 8 rows within 2 s. Quick agents and Dispatchers get 400.
  - Open requires a current snapshot showing the agent as a direct durable child.
- **Sleeping inline helpers** (`d927c3363`, `76bf28c99`, merge `6b230d8de`): the view is admitted only on the same host, for a durable non-Dispatcher agent. One read owner serves both views, no transcript loads, and it is fenced by the generation.
- **Changes** (`8684f58c9`, `c6096bfa2`):
  - The only new git call is `check-attr`. Nothing writes, runs filters or hooks, or touches the network. Links and submodules are excluded, and reads are bounded (MAX_CONTENT, a 32 MB budget, 32 checks).
  - The diffstat never turns missing counts into zero.
- **Skills/MCP and outgoing wires** (`bc7eff971`, `cf60564f1`, `f901f452e`): wires are read only on full non-Dispatcher reads, the receipts are re-checked last, and the strict validator allows at most 50 rows with total 4096 or less.
- **Selected-role HTTP and identityless cards** (`c5d6c20bc`, `532f2ee4b`): mTLS and authorization are checked before and after the await, the role receipt is re-checked, and the card shows nothing from the snapshot without a receipt.
- **Session history** (`01878a4a5`, `00be836ee`, `d90cd8d50`):
  - The binding is captured only for admitted durable non-Dispatcher reads and is fully re-checked afterwards.
  - Cursors are strictly bounded: at most 2000 events within 8 MB, and `stillSelected` is checked after the await.
  - Shell init is never triggered.
- **Focus** (`a5d44036a`): UI only.

## Findings open at head

**M1 (minor, availability): large Dispatcher role reads return 500.**
- `selected-dispatcher-details.ts:39-41` at head checks the wrapped body against `REMOTE_DETAILS_MAX_BYTES`.
- `readRemoteAgentDetails` (`remote-agent-details.ts:309`) has already trimmed the inner body to that same limit, and the wrapper adds `version`, `role` and `agentId`.
- A Dispatcher whose Details needed trimming can land just over the limit. It then gets 500 every time and the no-chat pane shows "Couldn't read". This fails closed and leaks nothing.
- Fix: trim the inner body to `MAX - wrapperOverhead`, or apply the trimming loop to the wrapped body, and add a test at the boundary.

**M2 (minor, consistency): `RemoteHelpersCard` has no `onRefused`.**
- At `RemoteHelpersCard.tsx:16-40` and `RemoteAgentDetailsView.tsx:195,216` at head, the Actions, Managed and Canvas cards bump the central retry after a 403, but the helpers card doesn't.
- In practice a helper-page 403 revokes the receipt it was read under (O1). The `426e08593` admission key then forces a central re-read, which is refused, so other cards withdraw. The gap matters only if no positive receipt existed.
- Fix: add `onRefused` and wire it to `setRetry` in both the column and `helpersOnly` views, for consistency.

## Fixed at head

- At b458, a loaded session-history archive page stayed visible after the host paused, because the receipt was cleared while the snapshot object was kept.
- `426e08593` (admission key) withdraws `details` and so the page.
- Optional hardening: have `RemoteSessionHistory` require `snapshotReceipt` itself.

## Observations (no action required for merge)

- **Selection-token hashes include host paths.** Managed (`project.path` plus hidden grant-gated IDs) and Canvas (`home` plus `project.path`) both do this. A Details-authorized peer could test guesses at a username or at hidden grant-gated choices. Consider a per-process salt or hashing receipt signatures instead.
- **Helper pages have no selection token,** so an insert between pages can duplicate or skip a row. The UI already says each page is a separate observation.
- **`helperPageOnly` validator** (`shared/remote-agent-details.ts:101`) lacks the top-level key allowlist that `inventoryPageOnly` has, and `remote-helper-page.ts` `text()` does not reject control characters. The producer sanitizes, so this is defence in depth.
- **Inline sleeping helpers make a full Details GET on every snapshot change.** That wastes host work. The `orchestrate` page query would be enough.
- **Inline card wording:** it shows "Loading helpers…" indefinitely while the snapshot is unavailable.
- **Rename keys** can be composed from two listed keys. There is no exposure: both paths are eligible, the source must be a unique exact-oid match, and the pair is revalidated with no-follow reads.
- **`exactRenameSource`** has worst-case O(additions × before) CPU cost on huge trees.

## Gates for this PR (unchanged)

- Hosted Validate run 44868309476 on `ead945230`.
- The owner's decision on M1 and M2: fix them in a successor, or record them as accepted minors.
- The unrecorded intermittent group-simulation failure, as an observation to assess with current CI.
- The PR does not close #3733. #13, #14 and the live matrix are deferred.
- The #3706 public-release hold applies to releases only.

## Addendum: selection-hash scope (source-based, no new test claim)

Both hashes were introduced in this PR: managed in `5271faf5f`, Canvas in `b517b57f3`.

**Managed** (`selected-managed-parts-page.ts:29`) is `sha256([agentId, projectId, project.path, source, selected])`, unkeyed.
- **Caller-visible inputs:**
  - agentId, projectId and source;
  - `project.path`, because the snapshot ships full Project objects (`annex-server.ts:1394`).
- **Hidden inputs:** the raw asset IDs, plus the withheld grant-gated skill. `GRANT_GATED_SKILL_IDS` holds one public ID.
- **Entropy:** custom IDs are `asset-${randomUUID()}`, so the list can only be reconstructed for setups that are entirely built-in. Even then a peer could only test the presence and position of the single prepare-handoff ID.
- **Contract:** the code withholds that entry for *applicability* (comment at :26-28). Delivery is by grant (`delivery.ts:85`). There is no secrecy boundary, so this does not cross a confidentiality contract.

**Canvas** (`selected-canvas-membership-page.ts:90`) hashes `[agentId, projectId, project.path, home, rows]`. The rows are delivered on the pages and the path is in the snapshot, so nothing hidden can be recovered.

**Recommendation:** non-blocking hardening. Key the token with a per-process secret (HMAC). Controls: a stale token after a change, and a token that differs across processes.

**Helper observations** (no selection token, no top-level key allowlist, control characters in text): correctness and defence-in-depth items, not security flaws.
