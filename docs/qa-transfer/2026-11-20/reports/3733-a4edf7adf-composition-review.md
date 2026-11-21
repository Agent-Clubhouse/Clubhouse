# Independent QA: #3733 local role and Canvas composition

Reviewer: qa-details-local-composition (helper of Clubhouse-Orchestrator), default reviewer template. November 20, 2026.
Review target: `a4edf7adff8529e3be35820356079b272fbe4a44` on `details-local-composition/3733-role-canvas-composition`. The tip adds notes only. Tested source: `cd5fbb3a65c97dee357f310711333f90ad11bf13`.
Method: I read source and artifacts in an isolated worktree. I made no product edits, ran no tests, lint, tsc or install, and did no live probes, restarts or settings changes. Reproducing the merges used `git merge-tree` plus one temporary detached worktree, which I removed afterwards. Read-only `gh run` queries confirmed main's Validate state.

## Verdict

**APPROVE the composition at `a4edf7adf` (tested source `cd5fbb3a6`).** The result evidence is now verified from the repository at `6af2bc3dc` (E1, resolved). Notes wording needs two corrections (D1, D2), and neither changes code. The 31 lint errors are a real landing gate and are not waived (L1).

This verdict covers the composition only. It is not acceptance of full #3733 (see the last section).

## 1. Ancestry and refs (verified)

- `origin/Clubhouse-Orchestrator/3733-mini-continuation` = `b458b4c89f…`, `origin/Nov20SettingsCI/3733-canvas-inventory-integration` = `b4a47c3c0b…`, `origin/DetailsSessionDisplay/role-read-consumer` = `fcfa1bafdc…`, `origin/main` = `69ef383cef…`. All four are ancestors of `a4edf7adf`. `c5d6c20bc` is also an ancestor.
- Canvas contains the base. The role branch has its five commits on `c5d6c20bc`, and `fcfa1bafd..b458b4c89` has 17 commits, all kept through ancestry merges.
- The PG1 cherry-picks `01e6bf86d`, `7b0ce8b89` and `1e50f5273` and the cold branch `463515904` are ancestors. `fee2d0c19` itself is not, as expected for cherry-picks.

## 2. Conflict resolutions (verified by re-merge)

- Merge 1 (`26ca06220`, role into Canvas): `git merge-tree` gives exactly the two conflicts the notes list, `RemoteAgentDetailsView.tsx` and its test. Compared with the automatic merge tree, the recorded merge changes only those two files.
  - In the view, role's gated `otherMachines` (dispatcher, `ok`, connected, not needing pairing, snapshot available, receipt present, not paused) replaces the Canvas line that took remotes without a gate. The base's `readEnabled` and `helpersOnly` inline block is kept as is. Canvas's "Last host snapshot" stale note is dropped in favour of role's withheld note. That is correct, because role never renders remotes when stale or unattested.
  - In the test, compared with Canvas the union has no deletions. Compared with role it adds 22 lines.
- Merge 2 (`cb1c98c34`, main): exactly the two listed conflicts.
  - `orchestration-settings.ts` keeps `displaySnapshot: true` and adds `helperAutoBudget` to the ignore list.
  - `annexClientStore.ts` takes main's snapshot-delta and remoteProjectStore imports and keeps `AgentStatus`.
  - No other file differs from the automatic merge.

## 3. Receipt and generation central read (`426e08593`)

- Change: the read record carries `admission = connectionGeneration:snapshotReceipt`. The cached result is reused only when key, snapshot identity and admission all match, and admission is an effect dependency. `refreshKey` is unchanged, so page and card state is not reset.
- Main behaviour for equal snapshots, confirmed in source:
  - Reconcile keeps `old.snapshot` when `sameSnapshotValue` holds (`annexClientStore.ts:392,397`) and takes receipt and generation fresh from the broadcast.
  - Main mints a receipt per accepted snapshot (`annex-client.ts:1117`), broadcasts satellites (1120), then forwards the event (1121). The renderer's event handler stores the IPC payload as a new object (`annexClientStore.ts:831`).
  - So each accepted snapshot still produces a new object. A receipt change on the same object comes only from a reconcile-only broadcast: the `invalidateSnapshotAdmission` broadcast on 401/403 (`annex-client.ts:2499-2503`) and the short window between the satellites broadcast and the event.
- Fail-closed versus positive recovery:
  - Other machines is gated on the receipt directly, so revocation hid it before the fix. That part was fail-closed.
  - Without the fix, the cached `ok` read on the same object stays in use after a page 401/403 revocation. Its other card data, including the private Canvas summary, stays on screen until the next snapshot event. This is source-derived and matches the notes' claim that the Canvas regrant test fails when the fix is reverted.
  - Before #3744 the broadcast replaced the object and forced a re-read, so the fix restores that behaviour and is more than defense in depth for those cards.
  - Positive recovery (fresh receipt on the same object) re-reads. A new generation does not reuse an earlier result.
  - There is no loop: the re-read after revocation may 403 again, but `invalidateSnapshotAdmission` returns early once the receipt is gone. The 150 ms debounce coalesces the broadcast and the event.
- Recommendation: **keep the fix.**

## 4. Role authority and final receipts

- `requestDispatcherDetails` fences pin, role, kind, network-pending, epoch **and receipt identity** across the await, and invalidates on 401/403.
- `RemoteDispatcherRoleDetails` keys its context on generation, receipt, pairing, unavailability and pause, and renders private snapshot fields only when the receipt is present.
- Central Other machines uses the gated predicate above. Role's `inventoryPageOnly` rejection has two layers (cd5 test update). This is consistent with the selected-inventory validator at `5271faf5f` and `24909be31`.

## 5. Canvas 401/403, selection, regrant, stale epoch

- Canvas pages go through `requestAgentDetails`. On 401/403 it calls `invalidateSnapshotAdmission`, which is once-only. The query identity is captured before the await, and selection travels only for skills-mcp, actions and canvases.
- Before reading the status, the response is fenced on `connectionEpochs` and `satelliteFor`. The tests cover:
  - once-only invalidation across selections, keeping the cached snapshot, and re-minting only on a fresh snapshot;
  - a stale prior-epoch denial (agent, role, canvas) that does not clear a fresh receipt;
  - the view regrant reading a new host selection with exactly one page query, no stale selection and no local `getAgentCanvases`.
- **Observation O1 (not blocking, fail-closed, predates this composition):** `requestAgentDetails` fences on epoch only, not receipt identity, unlike `requestDispatcherDetails`. In one epoch, a 401/403 for a request issued under receipt R1 that resolves after a newer snapshot minted R2 clears R2. That over-revokes until the next snapshot and never exposes data. The composition widens it to Canvas pages, as the notes' interaction 2 says. If tightened later, capture the receipt at request time and only invalidate when it still matches. No test covers the same-epoch case.

## 5b. Substantive review of the unapproved inputs

The parent reported that neither the role successor nor the Canvas successor had a verified independent or combined approval, so I reviewed their source changes directly. Earlier ledger slice approvals are not relied on.

**Role (`c5d6c20bc..fcfa1bafd`, 22 files)**
- Main client `requestDispatcherDetails`:
  - It uses a fixed path with no caller id or page parameters. It requires a connected, unpaired-free satellite and a controlled-from-here peer with a TLS pin that is not network-pending.
  - After the await it fences on satellite identity, state, epoch, **receipt identity**, pin, role and kind.
  - 404/405/409 map to `unavailable`. On 401/403 it does a once-only receipt invalidation and returns `forbidden`. A response that fails strict validation maps to `error`. There is no fallback.
- IPC uses `stringArg({maxLength:240})`. Preload exposes only `dispatcherDetails(machine)`.
- Shared `isSelectedDispatcherDetails` enforces:
  - exact keys;
  - `role:'dispatcher'`;
  - a nested full `isRemoteAgentDetails` bound to the same `agentId`;
  - rejection of `connectionPageOnly`, `helperPageOnly` and `inventoryPageOnly`;
  - a UTF-8 byte bound.
  The host-side `readSelectedDispatcherDetails` also rejects `inventoryPageOnly`.
- `connectionGeneration` is public local epoch metadata only. No role data enters the store.
- Renderer `RemoteDispatcherRoleDetails`:
  - It reads once per view, coalesced over 150 ms, with an `active` guard against unmount.
  - Its context includes machine, satellite id, state, generation, receipt, pairing, unavailability and paused. The `dispatcher:changed` event bumps a revision.
  - Results are revalidated in the renderer. There is no synthetic Agent and no role cache.
  - Settings, Connections and Actions come only from the host-authorized DTO. Other machines and the snapshot on/off state need both a successful role read **and** a positive receipt.
- Central Other machines gate: covered in section 4.
- I found no defect.
- **O2 (product confirmation, not blocking):** on the no-chat Dispatcher page, an old host or role-unavailable host (404/405/409) no longer shows Dispatcher on/off or Other machines from the snapshot, even with a positive receipt. The base showed both. The role notes and test (`RemoteDispatcherDetails.test.tsx:96`) make this deliberate ("never revives snapshot peers as a fallback"), and checklist M1 allows unavailability "as policy permits". The parent should confirm this loss of passive information is acceptable for old hosts.

**Canvas (`b458b4c89..b4a47c3c0`, 16 files)**
- The changes wire the existing base producer `readSelectedCanvasMembershipPage` into the existing selected-inventory GET.
- Host:
  - `inventorySources` includes the canvas source only for non-Dispatchers, so a Dispatcher query gets 400 `unsupported_inventory_page`. Quick also rejects it.
  - The producer gets `authorized`, the target witness and receipts. Its combined receipt is checked afterwards by the same 403/409 fences as the managed and Actions pages.
- Shared:
  - The query and page validators dispatch on `source`.
  - `isRemoteAgentDetails` requires that a canvas page's `agentId` equals the envelope's, and that only the canvases card is unrequested in a page-only envelope.
- Main client: the canvas card carries `selection` and gets the same `inventoryPageOnly`/source/offset/selection response checks.
- Renderer `RemoteCanvasesCard` / `readCanvasMembershipPage`:
  - It revalidates the full envelope, source advertisement, page `agentId`, offset and selection.
  - The summary is shown only when `contextReadable`. Refusal triggers a central re-read through `onRefused`. Navigation reuses the existing guarded `jumpToCanvas`/`remoteCanvasJumpUnavailable`.
- Boards omitted from the snapshot remain unavailable.
- I found no defect. The producer itself is base content (`b458b4c89`) and was outside this slice's diff.

## 6. Evidence verification

- **Tip binding verified:** `git diff --name-status cd5fbb3a6 a4edf7adf` gives one `A` line for the notes file. Excluding that path, the trees are identical.
- At `5b6538f9c` on `details-local-composition/3733-inherited-lint-fixes`, under `docs/implementation-notes/evidence/3733-local-composition/`:
  - `tests.txt` has 26 lines, and every named suite exists. The set covers every test file the composition commits touched and the main-overlap files from the automatic merge.
  - `validated-head` = `cd5fbb3a6…`.
  - `tsc-files.txt` lists 3945 files. All are `<worktree>` or `<deps-store>`, with no parent-checkout paths.
  - `errfiles.txt` lists 22 files.
- **E1, resolved:** at `5b6538f9c` the four logs were missing because `.gitignore:3` (`*.log`) excluded them. At `6af2bc3dc` (same branch and directory) they are force-added, and I checked all 10 non-`/tmp` SHA256SUMS entries against the git blob contents.
  - `focused-2.log` (`cd5fbb3a6`): Test Files 26 passed (26), Tests **1718 passed (1718)**. Its stderr only has jsdom "canvas getContext not implemented" noise.
  - `focused-1.log`: 2 failed and 1716 passed. The failures are exactly the two inherited assertions that `cd5fbb3a6` updated: `selected-dispatcher-details` inventoryPageOnly and annexClientStore pause/resume.
  - `tsc.log`: `tsc exit=0`.
  - `lint.log`: **31 errors, 784 warnings**. By rule: 20 `no-control-regex`, 10 `@typescript-eslint/no-unused-vars`, 1 `@typescript-eslint/no-unused-expressions`.
  - The error files number **24, not 22**. The original `errfiles.txt` missed `agent-config.ts` and `read-only-repository-changes.ts`. My file list derived from `lint.log` matches `errfiles-raw.txt` exactly.
- The discriminating-revert claim ("both new view tests fail with the fix reverted") has no log. It is consistent with the source analysis in section 3.

## 7. Lint qualification (L1)

- All 24 error files are byte-identical to Canvas `b4a47c3c0` **and** Mini base `b458b4c89`. Relative to main, 21 are new and 3 are modified, which matches `errfiles-vs-main.txt`. No error file is among the composition's changes from Canvas, so the composition introduces no error.
- Main's "ESLint (errors only)" job **passed** at `69ef383ce` (Validate run on that SHA). The errors are inherited only within the #3733 stack, not from main. Hosted Validate ESLint will fail on any PR of this tree until the separate lint successor lands. Do not call this green, and do not waive it.
- Separately, main's Validate at `69ef383ce` failed only `Unit + Component Tests (windows-latest, 2/2)`. That is main's own state, outside this composition.

## 8. Notes corrections (docs only, non-blocking)

- **D1:** interaction 1 says "Before the fix this failed closed… review may keep or drop it." Narrow this: the Other machines gate was fail-closed, but other card data from the central read, including the private Canvas summary, was kept on equal snapshots after a 401/403 revocation. Keep the fix.
- **D2:** "every error is inherited" needs to say inherited from the #3733 base stack, not from main. Main's ESLint is green, so lint is a landing gate. Also change "22 error files" to 24.

## Proof reached, models and limits

- Reached: the role and Canvas source changes read in full (section 5b). Ancestry, conflict sets and resolutions re-derived from git. The equal-snapshot, receipt and admission paths were read in source. Test intent was read. Tip binding and errfile lineage were verified with git.
- Reached: the committed logs at `6af2bc3dc`, with their manifest checked against git blobs.
- Not reached:
  - no test, tsc or lint execution by the reviewer, so results come from the owner's logs;
  - no full `npm test`, hosted Validate, E2E, or live or installed app.
- Models: renderer tests use jsdom with mocked `annexClient` and satellite store state. Main tests use fake sockets and an HTTP responder. Real-host role reads, Canvas paging and IPC ordering are unproven outside mocks.
- Environment, per the notes: macOS, 16 cores, shared dependency store via a temporary symlink, Vitest `--maxWorkers=4 --no-cache`, with the Go suite running at the same time.

## Remaining full #3733 obligations (composition is not full acceptance)

Measured against `3733-finite-local-delta-checklist.txt` milestones 1–8, `3733-nov20-active.md` items 1–5, and ledger `c8c171296`:

1. **No-chat Dispatcher surface (M1):** the selected-role HTTP and consumer are now composed. Still owed: the card surface when no chat identity exists, plus discriminators for connected+chat, no-chat with role evidence, saved off, never created, unavailable, offline, forbidden and old host.
2. **Helper rows (M2):** qualified rows and eight-row continuation, plus sleeping inline, are in. Still owed: whatever remains of failed/needs-you/handoff/disposed lifecycle distinctions and host-aware Open across projects in the final matrix.
3. **Bounded continuation (M3):** Canvas membership pages, managed list and selected Actions are composed. Still owed: the remaining bounded inventories (MCP/skills lists beyond 100, Action relationship rows), checked with 101+ row and removal/reconnect/permission-loss discriminators.
4. **Provider and subagent completeness (M4):** history beyond 2000 events and 64 items. Selected durable history is partial for sleeping, unbound and earlier resumed sessions.
5. **Session and Settings truthfulness (M5):** known-0 usage, running clock, honest last activity, unmanaged migration notices. Verify each is landed in the composed tree.
6. **Changes (M6):** diffstat is in at `6d7cac9b2`. Still owed: live and branch rename, and link-own metadata.
7. **Navigation and presentation (M7):** deferred focus is in at `5077d3a38`. Still owed: the omitted-board navigation assessment (board content still unavailable) and grouped Skills/MCP names and kinds.
8. **Connections (active item 1):** remaining source eligibility and suspension, group owner-memory and pending distinctions, legacy and unqualified source identity, host navigation, and the two paging-boundary concerns plus their corrections, which need exact proof and independent review.
9. **Final acceptance (M8, active item 5):**
   - the original card/field/state/provider/role/old-host matrix on one composed exact head;
   - fresh latest-main integration;
   - full `npm test`, typecheck and **lint green, which needs the lint successor**;
   - hosted Validate;
   - independent review of the final composed head;
   - E2E or live acceptance where it applies.
   - Lifecycle transport and old-host Settings fallback need coverage only.
10. **Holds:** #3706 public release hold remains. Q5 policy and the #3613 production-review refusal are out of scope here.
