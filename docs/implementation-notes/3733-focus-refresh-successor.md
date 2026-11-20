# #3733 deferred-focus refresh successor

Parent under review: `7de23c3c2759be331c5cb3e6156d07e0548a2f49`.
Branch: `DetailsSessionDisplay/dispatcher-tests-focus` (normal successor, no history rewrite).

QA found that the last-resolved-card key introduced in the parent was insufficient: a normal host snapshot invalidates the Details response and hides Subagents during rehydration. The same focus nonce then resolves to Session and back to Subagents, replaying the focus after the user manually collapsed it. The prior rerender-only test did not exercise this transition.

The remote view now retains one bounded focus-request record keyed by selected namespaced identity and nonce. It tries each fallback target once while awaiting the requested target; fulfilling the requested card finishes that request permanently across host snapshot invalidation/rehydration. A new nonce starts a new request. Existing selected-identity guard, initial fallback, child selection and deferred availability behavior remain. No local renderer, host, route, contract or access changes.

Three added cases exercise real snapshot replacement and matching hydration:
- First fulfillment delayed through a refresh: manually collapsed fallback stays closed, superseded serialized hydration does not expose Subagents, then current hydration opens the requested child.
- After fulfillment, child/Subagents collapsed but fallback still open: refresh must not reopen Subagents or reselect the collapsed child; new nonce must reopen both.
- Same after user also collapses fallback Session: invalidation must not reopen Session either.

Red/green evidence:
- Restore only the parent renderer temporarily; the three new cases produce **2 failed / 1 passed / 57 skipped**. Failures distinguish Subagents reopening after hydration and Session reopening at invalidation. Renderer restored afterward.
- Corrected targeted focus set: **5 passed / 55 skipped**, retaining initial delayed focus and cross-host raw-ID collision isolation.
- Corrected full scoped suites: **87 passed** (60 remote Details, 27 AgentDetails). Existing Dispatcher pending/unavailable/no-local-fallback proof remains passing.
- Final report records exact successor SHA, final rerun, typecheck and scoped lint. Independent successor review remains required before integration; no merge performed.

Serial test command (lane granted by Orchestrator; 1 worker, no parallel files):
```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project renderer src/renderer/features/agents/details/RemoteAgentDetailsView.test.tsx src/renderer/features/agents/details/AgentDetails.test.tsx --maxWorkers=1 --no-file-parallelism
```
Dependencies remain the existing verified November19 directory; no installs. Deferred: independent successor review and live acceptance, remaining #3733 checklist scope. These tests establish this renderer behavior, not full provider/live parity. No PR/merge/release; original standby preserved and unpushed.
