# #3733 finite checklist: fresh status audit on `be0091d16`

Recorded November 21, 2026, against `main` `be0091d1676764b0e3300898ab0ad1f135f88a46` (tree `65fc29a44e9acd67dcbce7d887808303d0d9fb32`, which is also the tree of PR head `e236c530`).

- **Method:** source reading only. No tests, no live hosts, no network reads.
- **Not changed:** it re-checks each milestone of `3733-finite-local-delta-checklist.txt` (audit target `2482e8bc2`). That file and `3733-local-parity-followups.md` stay as recorded.
- **Status words:**
  - **Closed in source:** the source now has the path the checklist asked for. That is not live acceptance.
  - **Open:** the gap is still present in source.
  - **Unknown:** couldn't be settled from source in this bounded pass.
- **Scope of claims:** this makes no #3733 completion claim. (Issue state is outside this audit. #3733 was closed at 2026-11-21T08:41:41Z, a closure the parent attributes to #3749, and was later reopened for the remaining scope.)

## Milestones

| # | Checklist item | Status at `be0091d16` | Source evidence |
| --- | --- | --- | --- |
| 1 | Whole Dispatcher surface with no chat identity | **Closed in source** | `DispatcherView.tsx:89` routes `kind === 'details'` to `RemoteDispatcherDetails.tsx:47`, which renders `RemoteDispatcherRoleDetails` (Settings, Connections with source pages, Other machines, Actions with relationship pages). The host role read is `annex-server.ts` `handleSelectedDispatcherDetailsRoute`, and service `selected-dispatcher-details.ts`. Landed in #3749, #3755, #3759 and #3761. The live state matrix is item 8. |
| 2 | Helper rows, status, navigation and disposed group | **Closed in source**, with one test gap | Host `selected-helper-page.ts:44-87`: per-row project display name (`:54`, `:64`), saved or current-run status including `needs-you` and runtime `failed` (`:80-81`), disposed date (`:47`), per-page bounded work checks with an `admission-limit` reason (`:85`). Renderer `RemoteHelpersCard.tsx`: status labels (`:13`), host-aware Open (`:50-58`, `remote-helper-navigation.ts`), a pending "Waiting to start" group (`:67`), a Disposed fold (`:69`). Sleeping inline surface: `RemoteAgentDetailsView.tsx:187-196`, tested in `SleepingRemoteOrchestration.test.tsx`. **Test gap:** no test drives the inline site's `onRefused` retry (`RemoteAgentDetailsView.tsx:195`). `RemoteHelpersCard.test.tsx:42-47` covers the card callback only. |
| 3 | Bounded continuation past 100 rows | **Closed in source** | Pages exist for helpers (`selected-helper-page.ts`, up to 4096), Action relationships (`actions/selected-details-page.ts`, ordinary and Dispatcher role), Canvas memberships (`selected-canvas-membership-page.ts`) and managed blocks, skills and MCPs (`selected-managed-parts-page.ts:25`, up to 4096, 25 heads per page). Sources are listed in `remote-agent-details.ts:99`. Retained limits are below. |
| 4 | Provider and subagent evidence beyond tail and list caps | **Unknown** | `CHAT_DETAILS_LIST_LIMIT = 64` is still in force (`shared/chat/details-evidence.ts:32`). The 2000-event reference cited by the checklist (`remoteChatBackend.ts`) doesn't resolve at that path on `be00`, and I didn't trace its successor in this pass. No continuation for omitted child activity or reports was found. Needs a dedicated source trace before scheduling. |
| 5a | Known zero tokens shown as "Not reported" | **Closed in source** | `RemoteAgentDetailsView.tsx:171-172,238` test `tokens !== undefined`, not truthiness. |
| 5b | Live elapsed clock | **Closed in source** | `useNow(clockActive)` and `runningFor` (`RemoteAgentDetailsView.tsx:174-177`) in the session summary. |
| 5c | Ended or last activity | **Closed in source** | `remote-session-history.ts:13-15` gives Ended from `lastSleep`. `:60-63` adds Last activity from parsed event timestamps, with a note that it isn't a verified end time. |
| 5d | Unmanaged legacy persona and migration-failure notices | **Closed in source** | `remote-agent-settings.ts:81-92`: fixed reason categories only, never saved free text. |
| 6 | Changes representation | **Partial** | Closed: aggregate diffstat (`RemoteChangesCard.tsx:23`, `PlusMinus`), saved-turn renames via `-M` (`read-only-repository-changes.ts:134-141`), live verified identical moves (`:149-151`, note at `RemoteChangesCard.tsx:82`). **Open:** branch-scope renames. `-M` runs only when `query.scope !== 'branch'` (`:134`), and the branch scope has no explanatory note. Also open: a changed symlink's own metadata, since mode `120000` is still `unsafe` (`:102`, `:203`). |
| 7a | Deferred focus | **Closed in source** | `RemoteAgentDetailsView.tsx:143-155` keeps a per-nonce request with tried targets and a `fulfilled` flag set only when the requested card is opened. A later-hydrated requested card is then still opened. |
| 7b | Omitted-board navigation | **Open (#13)** | `agent-canvases.ts:120-135` refuses while `snapshotTruncated.omitted` names canvas sections, or the board isn't in the current snapshot. Options are in `3733-omitted-board-navigation-options.md`. |
| 7c | Skills and MCP grouping, wires | **Closed in source** | `RemoteSkillsMcpEvidence.tsx:45-73`: Installed by Clubhouse, Set up by Clubhouse, Provider-reported, MCP servers, Host Clubhouse MCP handshake, Set in Clubhouse, Wires. |
| 7d | Action drilldown | Not a closeout item | The checklist marks a read-only Action modal as optional scope. Unchanged. |
| 8 | Live and mixed-version evidence matrix | **Unverified** | No live, mixed-version or macOS evidence exists for #3733. Hosted CI ran on Ubuntu and Windows only; macOS jobs are skipped by the run plan (for example #3761 run `44898861856`). Needs explicit live authorization. |

## Retained limits (deliberate, kept separate from gaps)

These are bounds, not missing features. Removing them would be new scope.

- Whole-read card rows are capped at `REMOTE_DETAILS_MAX_ROWS = 100` (`shared/remote-agent-details.ts:11`), with notes at most 20 per card (`:127`). An omission notice points to the host (`RemoteDetailsEvidence.tsx:11`). Continuation exists only through the pages in item 3.
- The managed setup summary refuses more than 100 ids as unavailable (`remote-managed-settings.ts:14-18`). The managed parts pages still reach up to 4096 items.
- The role Settings card is a scalar host read. Other machines comes from the selected host's shared snapshot under a positive receipt, not a role read (`RemoteDispatcherRoleDetails.tsx`).
- Snapshot truncation (`snapshotTruncated.omitted`) withholds sections. Retained data isn't presented as fresh.
- #12 Last session: parity met with the five stated limits in `3733-local-parity-followups.md`.

## Follow-up found during #14

The Dispatcher Actions page note (`actions/selected-details-page.ts:78`) says rows are "grouped by owner, target and trigger". A Dispatcher page has one `dispatcher` group (`:51`). This is a narrow copy correction with a test, prepared separately.
