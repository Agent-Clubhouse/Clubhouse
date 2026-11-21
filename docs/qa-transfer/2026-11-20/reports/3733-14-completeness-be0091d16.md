# Independent QA: #3733 item #14 completeness on main

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** main `be0091d1676764b0e3300898ab0ad1f135f88a46`.
  - **Tree is `65fc29a44e9acd67dcbce7d887808303d0d9fb32` per `git rev-parse be0091d16^{tree}`. It is not "e236" as stated in the request.**
  - #3755 merged as `d8c7247a4` and #3761 merged as `be0091d16`. gh reports both PRs as MERGED.
- **Method:** source read only. Nothing was run. No live, macOS or mixed-version acceptance.

## Scope of #14 (from main docs)

`docs/implementation-notes/3733-local-successor.md:70`: item 14 is "No-chat Dispatcher Settings, Connections and Actions". The local reference is the local Dispatcher view, and the remote is `RemoteDispatcherRoleDetails` through the role read. It was "Delivered (single page)". The remaining work was "role-card pagination by a safe role binding". `3733-local-parity-followups.md:40` describes the same deferral.

## Card set: local versus remote Dispatcher (source)

- **Local Dispatcher** (`AgentDetails.tsx`):
  - shows SettingsCard, Connections, Other machines and DispatcherActionsCard;
  - shows no Changes, Session, Subagents, Skills and MCP evidence, or Canvases (`showCanvases = !dispatcher`, at 217, 248, 268, 270, 347);
  - shows no Orchestrate or Dispatcher card, because `useOrchestrationCards` sets `orchestrationPath = undefined` for `isDispatcherAgent` (OrchestrationCards.tsx:24, #2533 locked).
- **Host producer** (`remote-agent-details.ts:96`): for the Dispatcher, the dispatcher, orchestrate, skills-mcp, session, canvases and changes cards are marked `not-applicable`.
  - `inventorySources` for the Dispatcher contains only `selected-action-relationships` (line 99). Canvas memberships and managed inventory sources are limited to non-Dispatcher agents.
  - **This confirms the owner's statement, and it matches the local card set.**
- **Remote role pane:** Settings, Connections (snapshot link plus pages), Other machines (from the snapshot) and Actions. The applicable card set therefore matches.

## Role paging versus #14 intent

| Card | Paging | Status on main |
|---|---|---|
| Connections | `RemoteDispatcherConnectionPages`, gated on `connectionPages === 1`; older host gets a summary-only note | Landed (#3755) |
| Actions | `RemoteDispatcherActionsPages`, gated on `inventoryPages === 1` plus the Actions source; older host gets a summary-only note | Landed (#3761) |
| Settings | Scalar summary, not a relationship list | No paging needed, except for the name lists below |
| Other machines | Snapshot-derived, not role read; omitted and absent states are labelled | Outside role paging |

**Source verdict:** the paging intended in #14 (Connections and Actions under the role binding) is present on main. Both have a producer and a consumer, the older-host fallback is explicit, and each runs under the existing role authorization. This is not an issue-closure or acceptance verdict.

## Remaining evidence limits, listed separately (not contract defects)

1. **Settings name lists are capped at 100, with no continuation.**
   - In an unmanaged setup, `setup.mcps` is sliced to 100 and `c.omitted` is incremented (`remote-agent-details.ts:154-157`).
   - In a managed setup, the 100-ID admission cap in `remote-managed-settings.ts:14-18` makes the summary unavailable rather than partial.
   - The local SettingsCard has no such cap. This is an acknowledged parity limit in `3733-finite-local-delta-checklist.txt:27`. It belongs to Settings scope, not to #14 role paging.
2. Card notes are capped at 20, with an "omitted" note (`:276`). This is a display limit.
3. **The Other machines card depends on snapshot completeness.** Truncated or omitted snapshots are labelled; there is no role read.
4. **Executed proof** for #3761 and #3755 is unit, synthetic and route-level only, per the PR and evidence. There's no live two-machine, same-version or mixed-version acceptance, and no packaged-app or macOS acceptance.
5. **The Actions grouped-owner/target/trigger note:** the Dispatcher Actions page reuses `SelectedActionsPage`, with the "Made by the Dispatcher" group (A3). Correcting the inaccurate note is routine, in-scope owner work. It needs an independent check afterwards, and I haven't re-reviewed it here.
6. **#3733 is currently CLOSED** (2026-11-21T08:41:40Z, COMPLETED) in gh. That state isn't QA acceptance of the full matrix, and nothing here makes it so.
