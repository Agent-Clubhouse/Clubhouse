# Remote Settings read parity (#3733)

## Finding and scope

Base: `a9d2c25580b759718bd5b0093bc570031c246d5b` (origin/main when assigned).
Beta7 reference: `9924802abaabe79e5632ee0ecf322b0a276a0ec4` (`v0.43.0-beta.7`).
Both sources include SettingsCard unconditionally in AgentDetails, but skip remote durable configuration, managed setup, configured MCP and instruction reads. Whole-card absence was not reproduced. SleepingAgent renders details under its open/width conditions. The beta7 reconnect blank-runtime report is distinct: #3729 is already included in the assigned main base.

Issue #3733 owns the confirmed missing-data gap. #2397 owns remote session controls/runtime mutation and overlaps next-wake runtime display. #2393 owns remote ChatView rendering. Closed #3286 explicitly preserves read-only remote Settings and desired/reported distinctions; it did not supply this read transport.

## Implementation

A desktop-only `GET /api/v1/agents/:id/settings-details` uses existing pinned paired-controller authorization. It rejects phone/session-only/pending callers and rechecks authorization after asynchronous lookup/summary reads and immediately before responding. No mutation endpoint or agent permission grant is added.

The allowlist contains provider/model, host-resolved next-start runtime/access, saved execution policy/context, host auto-sleep, managed template/name inventories/instruction-block count/attribution/waiting status, or an unmanaged instruction line count. Limits: 100 managed parts, 240-character display labels, 64 KiB response. No raw instructions, MCP definitions, environment values, paths or grants leave the host summary.

Managed setup is desired configuration, not proof of provider loading/use. A partial setup read remains an error alongside useful basic settings. Unmanaged file/global MCP and skill inventories, and unmanaged instructions without a dedicated worktree, explicitly say they are not shared by the host. These are deferred parity, not empty inventories. Older hosts have an unavailable state; failures/offline/forbidden/loading/rate limits are distinct.

RemoteSettingsCard has no local settings/managed/filesystem/editing hooks. It retains the Settings accordion and host attribution. Selection, status, snapshots and reconnection refresh it; stale target promises are ignored. The main client fences responses with the existing disconnect epoch, including in-place reconnects.

## RED before implementation

On unchanged base production code, the initial RemoteSettingsCard test file ran four tests: **4 failed**, one file failed (4.13 s). The managed template/instruction rows were absent for running/sleeping/error agents; the Settings accordion existed but had no remote loading/unsupported state. Command:

```
npx vitest run --project renderer src/renderer/features/agents/details/RemoteSettingsCard.test.tsx
```

This initial RED ran before the parent relayed the inherited resource gate. Every subsequent test/typecheck attempt used `/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh`, min4 targeted Vitest / min6 tsc, Vitest `--maxWorkers=2`. Gate refusals were respected. No Electron, Playwright or local E2E was run.

## Verification

Initial executable GREEN: 96/96 passed across five files (existing SettingsCard local tests plus new renderer/service/IPC/contract regressions); focused real-route/client checks: 9 passed, 728 intentionally unselected. Final exact-head results are reported in the parent handoff after commit.

The first existing SettingsCard attempt could not import `prosemirror-schema-list` from inherited dependencies. A reversible worktree-local node_modules symlink used the already installed approvals worktree; both package-lock blobs matched `7e45389f84ca58c5c7832cab169aa5674320d25d`. No installation, lockfile, provider, network, app configuration, reset or restart occurred.

## Acceptance matrix and limits

| Dimension | Evidence | Live acceptance |
| --- | --- | --- |
| Local managed/unmanaged awake/asleep | Existing SettingsCard regression suite | Not newly hand-tested |
| Remote managed normal awake/asleep/error | Host and renderer tests; one Settings accordion, read-only | Deferred |
| Remote unmanaged/Dispatcher | Synthetic renderer fixtures and canonical target lookup | Deferred |
| Host Chat disabled / driver unavailable | Real canonical runtime resolver with host settings mocked | Deferred |
| Same-version GET/auth boundary | Real route requests with fixture TLS/pinned peers, safe host summary unit tests | Deferred |
| Mixed/old version | 404/405 transport fixtures and unsupported renderer state | Deferred |
| Initial select / target race | Pending-response renderer regression | Deferred |
| Wake / reconnect / host snapshot | Renderer refresh plus main in-place reconnect epoch negative control | Deferred |
| Phone/wrong pin/pending/revocation | Real route auth boundary tests and post-await service tests | Deferred |

Unit/synthetic/fixture-TLS proof is not a two-machine app hand-test. No installed beta7 binaries or live remote agents were changed or woken. Independent QA is required before PR; no PR, merge, release or release-hold change is authorized by this proof. #3611 hand-test and #3706 release holds remain in force for dependent work.
