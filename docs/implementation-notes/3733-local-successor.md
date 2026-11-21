# #3733 local successor: lint, receipt and fallback fixes, and parity checklist

Recorded November 20, 2026. Branch `details-local-composition/3733-inherited-lint-fixes`, based on the frozen and QA-approved `a4edf7adff8529e3be35820356079b272fbe4a44` (QA report `qa-details-local-composition/3733-a4edf7adf-review` at `6cba706d9925220a01844e646faab7c4d7353b79`). The frozen branch is unchanged. This is not a PR, and it needs independent review.

## Corrections to the composition notes

These corrections add to `3733-local-role-canvas-composition.md`, which is left as recorded.

- **D1.** The lint errors were 31 in **24** files, not 22: 20 `no-control-regex`, 10 `@typescript-eslint/no-unused-vars` and 1 `@typescript-eslint/no-unused-expressions`. The earlier extraction missed `agent-config.ts` and `read-only-repository-changes.ts`. See `evidence/3733-local-composition/errfiles-raw.txt`.
- **D2.** The errors were inherited within the #3733 stack only. All 24 files match the Canvas parent and the Mini base. They were not inherited from `main` `69ef383ce`, where 21 of the files do not exist and 3 differ. Hosted lint would have blocked `a4edf7adf`.
- The first evidence push left out the `.log` files because of `.gitignore`. They are force-added in `6af2bc3dc`.

## Commits on the successor

| Commit | Change |
| --- | --- |
| `5b6538f9c`, `6af2bc3dc` | Evidence for the frozen composition (docs only). |
| `6fad09027` | Fixes the 31 lint errors without suppressions. `src/shared/ascii-control.ts` checks UTF-16 code units exactly like the original non-`u` classes. `hasAsciiControl` matches the single `[\x00-\x1f\x7f]` test, `replaceAsciiControl` the global replace with a literal space, and `hasC0Control` the C0-only session-id check, which keeps its own slash test. Dead imports and helpers are removed; both affected test files assert side effects inline. A comma expression becomes a block. |
| `42331c3b5` | O1. `requestAgentDetails` captures the receipt at request start. A late 401/403 revokes only that receipt, never a newer one minted in the same epoch. |
| `8cd17005c` | O2. The no-chat Dispatcher pane shows snapshot on/off and Other machines when the role read is `unavailable` (older host, 404/405/409) under a positive receipt. This can be dropped independently. |

### O1 detail

`invalidateSnapshotAdmission(sat, admitted)` now returns unless `sat.snapshotReceipt === admitted`. `requestDispatcherDetails` passes its captured receipt, and its `current()` already refused changed receipts, so the role path behaves as before. Current denials and the epoch guards are unchanged. New tests in `annex-client.test.ts`:

- An old-receipt late 403 keeps the new receipt, for full Details and Canvas page reads. Both fail when only `annex-client.ts` is reverted.
- A late 401 under the current receipt still revokes it and broadcasts once.

Hunks for reconciling with any annex-wake-readiness work: the `invalidateSnapshotAdmission` signature and guard, the `receipt` capture beside `epoch` in `requestAgentDetails`, and the two `invalidateSnapshotAdmission(sat, receipt)` calls.

### O2 detail

Before the role consumer, the pane at `c5d6c20` showed `dispatcher.enabled` and `dispatcherPresence.remotes` under a positive receipt with no Details read. The role consumer at `fcfa1bafd` required a successful role read and asserted "never revives snapshot peers as a fallback" for `unavailable` as well. Since a denial revokes the receipt it was read under, an eligible connection with a positive receipt and an `unavailable` role read shows only those snapshot fields, labelled "host snapshot". Role settings, Connections and Actions stay unavailable. `forbidden`, `offline`, `error` and `rate_limited` still withhold everything. Paused, snapshot-unavailable, unpaired and no-receipt states stay ineligible. This narrows an explicit role-branch assertion, so review should confirm or drop the commit. New tests: the older-host fallback (fails without the change), receipt removal, pause, and forbidden with a positive receipt.

### F1, pre-existing failure

`src/main/services/remote-connection-endpoint-fields.test.ts` fails 2 of 17 cases (`bounded-page`: omitted 142, expected 112; `bounded-identity-page`: omitted 21, expected 20). It fails the same way on `b458b4c89`, `b4a47c3c0`, `26ca06220`, `cb1c98c34` and `a4edf7adf`. Bisecting `3b739fe5f` (good) to `b458b4c89` points to `9f2354d0d` "Expose scoped outgoing wire records and manual restriction evidence", which adds rows to the Connections card without updating this test. Whether the expectation or the bound is wrong is not yet decided. It was outside the composition's focused set. Not fixed here.

## Checks on `8cd17005cb30e382b0e5cb61c942aee780a37434`

The dependency store was the same as before (lockfile identical, verified). It was linked only for these runs, then removed, and its cache hash is unchanged. Load average was about 5.8 on 16 cores, so Vitest used 3 workers.

| Check | Command | Result |
| --- | --- | --- |
| Lint over the full changed-from-main scope | `git diff --name-only 69ef383ce HEAD -- '*.ts' '*.tsx' \| xargs eslint` (319 files) | Exit 0. 0 errors, 784 warnings (the same count as on `cd5fbb3a6`; none waived or added). |
| Typecheck | `tsc --noEmit -p .` | Exit 0 |
| Focused Vitest | `vitest run --no-cache --maxWorkers=3` over 130 files: the 26 composition files plus every test importing a module the successor changed | 5472 passed, 1 skipped, 2 failed. The failures are F1 only. Exit 1. |

Raw output is in `evidence/3733-local-successor/`.

## Finite parity checklist (#3733 acceptance mapped to source on `8cd17005c`)

Local cards are in `src/renderer/features/agents/details/AgentDetails.tsx` (`LocalAgentDetails`). Remote cards are in `RemoteAgentDetailsView.tsx`; the no-chat Dispatcher pane is in `features/dispatcher/RemoteDispatcherRoleDetails.tsx`. Status uses unit or synthetic proof only. Live same-version and mixed-version runs are a separate column and none have been done.

| # | Card or field | Local source | Remote source | Status | Remaining |
| --- | --- | --- | --- | --- | --- |
| 1 | Settings: provider, model, runtime, access, execution policy, auto-sleep, context | `SettingsCard` | `RemoteSettingsCard`, `RemoteQuickSettingsCard`, host `remote-agent-settings` | Delivered for awake and asleep, with explicit unsupported, offline and error states | Live matrix |
| 2 | Settings: effort | `SettingsCard` (configured and live) | `RemoteSettingsCard:86` and `RemoteQuickSettingsCard:21` show live-reported effort only | **Gap.** `RemoteAgentSettings` has no configured or next-start effort field, so asleep effort is missing | Additive host field plus renderer row, older-host unsupported state |
| 3 | Managed setup, instructions and parts | `SetupCard` | `SelectedManagedPartsPage`, settings `setup` | Delivered (managed continuation `3116ab759`) | Live matrix |
| 4 | Changes | `ChangesCard` | `RemoteChangesCard` | Delivered (diffstat `6d7cac9b2`) | Live matrix |
| 5 | Orchestration and helpers | `OrchestrationCardPair` | `RemoteHelpersCard` (column and sleeping inline) | Delivered (qualified rows `392419050`, sleeping inline `76bf28c99`) | Live matrix |
| 6 | Dispatcher connection card (normal agent) | `DispatcherCard` (state, permissions, edit) | `basic('dispatcher')` renders host evidence rows only | **Partial.** Generic rows, with no structured equivalent of the local permission and contact fields | Audit host `dispatcher` card rows against the local fields; read-only only |
| 7 | Subagents | `AgentDetails.tsx:367` | `RemoteAgentDetailsView.tsx:216` with hydrated provider evidence | Delivered for live sessions; asleep falls back to provider evidence | Asleep subagents beyond the current runtime's evidence are partial |
| 8 | Connections and outgoing wires | `ConnectionsCard` | `RemoteConnectionsCard`, `RemoteOutgoingWiresEvidence` | Delivered (`57ca9a504`, `e8d6a145e`) | Endpoint eligibility needs separate evidence (ledger). F1 test drift. |
| 9 | Other machines | `AgentDetails.tsx:396` | Real-chat Dispatcher in `RemoteAgentDetailsView`; no-chat in `RemoteDispatcherRoleDetails` | Delivered with receipt admission; O2 restores the older-host snapshot fallback | O2 review |
| 10 | Actions | `AgentActionsCard`, `DispatcherActionsCard` | `RemoteActionsCard`, `SelectedActionsPage`, role Actions evidence | Delivered (`e8f1f3ca0`) | Live matrix |
| 11 | Skills and MCP | `McpCard`, `ProviderSkillsCard` | `RemoteSkillsMcpEvidence` | Delivered (`fa830f2b1`) | Live matrix |
| 12 | Session, Last session, context | `AgentDetails.tsx:428/441` | `RemoteAgentDetailsView.tsx:235`, `RemoteSessionHistory` | **Partial.** Current-runtime history delivered (`bb3851959`). Sleeping, unbound and earlier resumed sessions are partial | History for those three session kinds |
| 13 | Canvases | `AgentDetails.tsx:484` | `RemoteCanvasesCard`, `SelectedCanvasMembershipPage` | Delivered for membership metadata | Board contents omitted from the snapshot stay unavailable; navigation to an omitted board not yet assessed |
| 14 | No-chat Dispatcher Settings, Connections and Actions | Local Dispatcher view | `RemoteDispatcherRoleDetails` via the role read | Delivered (single page) | Role-card pagination by a safe role binding is deferred (role notes) |
| 15 | States: loading, unsupported or older host, offline, stale, denied, reconnect, wake, select | Shared | Receipt and epoch admission, O1, view admission key `426e08593` | Delivered in unit tests | Live reconnect and wake matrix |
| 16 | Awake, asleep, error and waking, by provider capability | Shared | `asleep` covers `sleeping` and `error`; there is no explicit `waking` branch | **Partial.** No dedicated waking assertion | Add a waking-state test or document that it falls under awake or loading |
| 17 | Same-version and mixed-version live app matrix | n/a | n/a | **Not started** (deferred by the issue where unavailable) | Requires live hosts; outside unit proof |
| 18 | Hosted CI and full `npm test` | n/a | n/a | **Not run** for this successor | Required before any PR |

Finite remaining work: items 2, 6, 7 (asleep), 12, 13 (navigation assessment), 14 (pagination), 16, 17, 18, plus F1, the O2 review decision, and independent review of this successor.
