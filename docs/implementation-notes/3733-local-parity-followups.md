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

## Inherited full-suite failures (28) fixed

`11fc59dbe` failed 28 tests in 5 files. The same 28 fail on the Mini base `b458b4c89` and pass on `main` `69ef383ce` (`evidence/3733-full-suite-11fc/`). Fixes, one commit per cause:

| Commit | Cause | Kind |
| --- | --- | --- |
| `2fa5dd57e` | `spawnAgent` checks `isAgentRunning` before noting a start, and quick headless runs pass `observeStarted` last. The headless mocks and argument lists predated both. | Test only (25 tests) |
| `36a06057a` | Details, changes and role routes had no `clubhouse.annex.route` templates, and literal capture groups leaked into the template. | Telemetry template and allowlist (1 test) |
| `25d38c962` | `currentIdentityDisplayOrigin` (from `16e9ca834`) looked up `app.getPath('userData')` in the memory-only session. It now uses a fixed `ephemeral:memory` origin. | Product fix (1 test) |
| `d702a2705` | The remote SettingsCard case expected access from the local chat. Access for another machine now comes only from a host read. | Test contract (1 test) |

The full suite on `d702a2705` passed (35527 passed, 0 failed), with lint and tsc at exit 0. Evidence, per-cause mutation logs and the surviving c229/c555 logs are in `evidence/3733-inherited-28-fixes/`.

## #12 reconciled: local fields and retained limits

**Original local fields** for a sleeping agent come from the Last session card (`AgentDetails.tsx:426-439`): Runs on, Ended, Why, Usage loading, Duration, Cost, the "No earlier session recorded" note, Folder and Branch. Usage comes from `getSessionSummary(projectPath, agentId, sessionId, agent.orchestrator)` (`useLastSession.ts:84`). Local Details has no browsable session history.

**Remote equivalents:** Ended and Why from `lastSleep`; Last CLI from the recorded session provider; Duration, Cost and Last activity from a bounded passive transcript read (`remote-session-history.ts`); Folder and Branch (`remote-agent-details.ts:261`). The "No earlier session recorded" note is the same.

**Retained limits** (host evidence the remote card withholds rather than infers):

1. Usage is read only when the session's recorded provider is unambiguous. Local uses the agent's current configured orchestrator, so after a provider switch the remote card shows "Not recorded unambiguously" where local may attribute usage.
2. Passive lookup covers `claude-code`, `codex-cli` and `copilot-cli` only. Other session-capable providers show usage unknown.
3. The host shell environment is never initialized. With a cold cache, usage is unknown.
4. An unsafe saved session id is refused without any transcript query.
5. The read is bounded by `SUMMARY_TRANSCRIPT_MAX_BYTES`, and truncation is noted.

Every original local field has a remote equivalent. The five limits are deliberate read-only restrictions, not missing fields, so #12 is **parity met with stated limits**. `RemoteSessionHistory` browsing goes beyond local and is not expanded. Its own partial coverage (sleeping, unbound, earlier resumed) stays documented in that component.
