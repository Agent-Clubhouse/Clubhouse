# #3733 parity follow-ups after F1

Recorded November 20, 2026. Branch `details-local-composition/3733-f1-parity`, based on `5e3e21cfe` (QA-approved successor; QA report `bb0ef6b0a1fb74a76408bf2e7a2b2c8bf4c7ea14`). These notes add to `3733-local-successor.md`, which is left as recorded.

## Commits

| Commit | Change |
| --- | --- |
| `7daca0e3e` | F1, test only. Connections omission totals now follow the manual eligibility row from `9f2354d0d`. Evidence is in `evidence/3733-f1/`. |
| `0a3564452` | F1 evidence (docs only). The mutation log there does not record post-restore status; the committed source was clean before and after. |
| `c2297c45b` | #16. Remote waking shows no reported effort and no Running clock from a retained chat. A positive control shows both once the host reports running. Dropping the view's `details.running` session guard fails the test. |
| `c55535821` | Consistency audit. The real-chat Dispatcher Other machines gate now accepts a Details read of `unavailable` (404/405, older host) under a positive receipt, matching the no-chat O2 fallback. Forbidden, error, offline and rate-limited still withhold, as do revocation and a new epoch without a receipt. Reverting the change fails the older-host test only. |

### Consistency audit

| Condition | Real-chat (`RemoteAgentDetailsView.tsx:182`) | No-chat (`RemoteDispatcherRoleDetails.tsx:25,56`) |
| --- | --- | --- |
| Connected, paired, snapshot available, snapshot not paused | Required | Required |
| Positive `snapshotReceipt` | Required | Required |
| 401/403 | `forbidden`; revokes the receipt it was read under (`invalidateSnapshotAdmission`, O1) | Same |
| `unavailable` meaning | 404/405 only | 404/405/409 |
| Extra local checks | None | Store `satellitePaused` flag and a valid connection generation. Main also clears the receipt on `session:paused`. |

The authorization basis is the same receipt and the same denial revocation, so the gates now accept the same read statuses. No authority difference was found.

## Checklist corrections (supersede rows in `3733-local-successor.md`)

| # | Earlier status | Corrected status and reference |
| --- | --- | --- |
| 2 Effort | Gap | **Parity met.** Local shows live-reported effort only (`SettingsCard.tsx:287`, `!asleep && chat?.effortReported`). No local Details card reads the saved `effort` (`types.ts:330`). Remote matches (`RemoteSettingsCard.tsx:86`, session undefined while asleep). Showing the saved effort on both sides would be a new product field, not parity. |
| 6 Dispatcher card | Partial | **Delivered.** The host card (`remote-dispatcher-card.ts:39`) carries Connected, Description, When to reach it, Owns, a permission summary and each permission mode, with explicit unavailable states. These are the local `DispatcherCard` fields, rendered read-only. |
| 7 Subagents asleep | Partial | **Folded into #12.** Local subagents also require a chat session (`AgentDetails.tsx:212`), and local asleep shows Last session with no Subagents card. Remote asleep child activity appears in `RemoteSessionHistory` reports. |
| 13 Canvases | Navigation not assessed | **Assessed.** Omitted boards are disabled with a reason (`agent-canvases.ts:120`). Candidate: after `fetchOmittedCanvases` (`annex-client.ts`) fills `canvasState`, `snapshotTruncated.omitted` still lists it, so navigation stays refused. Allowing it requires proving backfill freshness across later truncated snapshots (the existing test asks only once). Not changed. |
| 16 Waking | Partial | **Delivered**, `c2297c45b`. Local waking only locks edits (`AgentDetailsAsleep.test.tsx:436`), which does not apply to read-only remote. |

## Remaining

- **#12:** session history for sleeping, unbound and earlier resumed sessions (including asleep subagent detail). Needs host history contract work.
- **#13:** backfilled-board navigation candidate above. Needs a freshness decision in annex-client.
- **#14:** role-card pagination by a safe role binding. Needs a new host paging contract.
- **#17:** live same-version and mixed-version matrix.
- **#18:** hosted CI.
