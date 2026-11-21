# #3733 local role and Canvas composition

Recorded November 20, 2026, on the local desktop. Branch `details-local-composition/3733-role-canvas-composition`. This is a composition checkpoint for independent review. It is not a PR and does not close #3733.

## Inputs

| Input | Commit |
| --- | --- |
| Mini base `Clubhouse-Orchestrator/3733-mini-continuation` | `b458b4c89fb478d0f605553d85c0e821c389bf23` |
| Canvas `Nov20SettingsCI/3733-canvas-inventory-integration` | `b4a47c3c0bf8d133b2a6afeefc00b251efe6df59` (base plus two commits) |
| Role `DetailsSessionDisplay/role-read-consumer` | `fcfa1bafdc78ef6477c26c0484dfe15d7e9aad7d` (five commits on `c5d6c20bcf321fedc7473f04c741cb7d203de397`) |
| `main` | `69ef383cefec405d811f1c199f25c10cdc0395b6` (#3744, #3745, #3746 since merge base `ae56577af`) |
| Ledger read | `c8c17129663aafe39130abf284badf204a6ff3ee` `docs/continuation/nov20-mini-ci-and-details.md` |

No shared branch was edited. Both merges are ancestry merges, so all 17 base commits missing from the role tip are kept.

## Commits

| Commit | Content |
| --- | --- |
| `26ca062208b7b7f6a62cdf93d13ab8a9ee420d70` | Merge role into Canvas. Conflicts only in `RemoteAgentDetailsView.tsx` and its test. Both are unions. Role's gated Other machines admission sits beside the base's `readEnabled`/`helpersOnly` sleeping-inline block, and both new tests are kept. |
| `cb1c98c3452910f60a077d5e862f3a6cb54f1720` | Merge `main`. `orchestration-settings.ts` keeps `displaySnapshot` and adds `helperAutoBudget` to the audit ignore list. `annexClientStore.ts` takes main's snapshot-delta imports and keeps `AgentStatus`. |
| `426e08593c84058443aeaf9bf72885755cede42f` | Central Details read keyed on host admission (receipt and connection generation) as well as snapshot identity. Adds composition tests. |
| `cd5fbb3a65c97dee357f310711333f90ad11bf13` | Two inherited assertions updated to the composed contracts. Validated head. |

## Interactions found

1. **#3744 equal-snapshot reuse versus central read cache.** Reconciliation now keeps the old snapshot object when a broadcast list is value-equal. The central `RemoteAgentDetailsView` read was cached by refresh key and snapshot identity only. A receipt or generation change on an equal snapshot could therefore reuse an earlier read. The fix adds `connectionGeneration:snapshotReceipt` to the read record and effect dependencies. It is not added to `refreshKey`, so selected page state is not reset on every snapshot. Receipts are minted per accepted snapshot, so the read cadence matches the cadence before #3744.
   Live event ordering limits how reachable this is. Main broadcasts satellites before forwarding the snapshot event (`annex-client.ts` around line 1121), and the renderer event handler now stores the event payload as a new object. Every accepted snapshot therefore still produces a new object. The stale-read case needs a reconcile-only path, such as the receipt-invalidation broadcast after a 401 or 403, which carries no event. Before the fix this failed closed. Treat the fix as defense in depth; review may keep or drop it.
2. **Role invalidation now covers Canvas pages.** Role's `invalidateSnapshotAdmission` on 401 and 403 runs inside `requestAgentDetails`, so Canvas page refusals also clear the positive receipt. This is the same path Skills and Actions pages already use.
3. **#3744 snapshot events store their payload.** The base pause/resume test asserted object identity as a stand-in for "no reattestation". The receipt check is unchanged and still passes. The identity check now uses value equality.
4. **Role test premise outdated.** The role branch predates the selected inventory validator (`5271faf5f`, `24909be31`). That validator now rejects a stray `inventoryPageOnly`, so the test asserts that both layers reject.
5. **Unchanged consumers.** `RemoteDispatcherRoleDetails` already keys on receipt and generation. Other Details cards and the Canvas page fence still use snapshot identity. With #3744 they keep page state across equal snapshots. They are not private role gates, and their own refusals return forbidden. Left as is.

## Risk-targeted tests added

- `RemoteAgentDetailsView.test.tsx`: an equal snapshot object with a revoked receipt refuses Other machines while mock reads still return ok. A cached denial does not survive a fresh receipt. A fresh receipt re-reads and permits. A new generation does not reuse the earlier result. Canvas page refusal drops the summary and page rows, and a later regrant on the same object reads a new host selection with no stale selection query.
- `annexClientStore.hydration.test.ts`: real reconciliation keeps the equal snapshot object and still takes each fresh receipt, its removal and a new generation.
- `annex-client.test.ts`: a Canvas page 401 or 403 clears the receipt once across selections, keeps the cached snapshot, and re-mints only on a fresh snapshot. A stale prior-epoch Canvas denial does not clear a fresh receipt.
- Discrimination: with the view fix reverted, both new view tests fail.

## Checks on `cd5fbb3a65c97dee357f310711333f90ad11bf13`

Dependencies: the worktree had no `node_modules`. The parent checkout's install is stale (0.42.0, 16 version mismatches), and using it would have meant false results. A temporary symlink pointed at the existing shared store `~/.clubhouse/orch/dependencies/bd9cc803…212d/node_modules`. Its `.package-lock.json` matched this head's lockfile with zero mismatches or missing packages, and this head's lockfile is identical to main's. TypeScript and Vitest resolved inside that store, with no parent checkout sources. Vitest ran with `--no-cache`, and the store's only cache file kept hash `30eb98fe` and its 06:40 timestamp. The symlink was removed afterwards. Nothing was installed.

Load admission: 16 cores, load average about 2.4 to 3.4 while the Go Swift suite ran at `-j 2`. Vitest used `--maxWorkers=4`.

| Check | Result |
| --- | --- |
| Focused Vitest, 26 files: role, Canvas, central consumers, and main-overlap stores and services | 1718 passed, 0 failed |
| `tsc --noEmit -p .` | Exit 0. 3945 files, 2457 from this worktree's `src`, none from the parent checkout. |
| ESLint on 317 TypeScript files changed from `main` | 31 errors, 784 warnings. All 22 error files are byte-identical to the Canvas parent and the ESLint config is unchanged, so every error is inherited (mostly `no-control-regex` and unused variables). No file touched by this composition reports an error. |

Run 1 on the same tree before `cd5fbb3a6` reported the two inherited-assertion failures in interactions 3 and 4. All the new tests passed in that run.

The focused files are `annex-client-handlers`, `annex-client`, `annex-server`, `managed-agents/delivery`, `orchestration-settings`, `remote-agent-details` (main), `remote-quick-details`, `selected-dispatcher-details` (main), `preload/index`, `AgentDetails`, `RemoteActionsCard`, `RemoteAgentDetailsView`, `RemoteCanvasesCard`, `SelectedManagedPartsPage`, `SleepingRemoteOrchestration`, `DispatcherView`, `RemoteDispatcherDetails`, `annexClientStore.hydration`, `annexClientStore`, `pendingPermissionStore`, `remoteChatBackend`, `remoteProjectStore`, and shared `remote-agent-details`, `remote-details-query`, `remote-inventory-page` and `selected-dispatcher-details`.

## Omissions

- No full `npm test` run. Hosted Validate is still required and separate.
- No E2E or live app or installed-app acceptance. Real-host role reads and Canvas paging are unproven outside test DOM and mocks.
- Root lint is not green because of the inherited errors above, which also exist on the Canvas parent.
- No independent review of this composition yet. No PR, and #3733 is not merged.
- Not composed here: the other ledger items still open on Mini (omitted-board navigation assessment, remaining bounded inventories, complete parity).
- Q5 and #3613 holds unchanged.
