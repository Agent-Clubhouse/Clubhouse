# Spec: Goobers instance panel (rail plugin + core service)

**Status:** Scoped — UX decisions resolved 2026-09-15; MVP gaps closed 2026-09-16, ready for handoff
**Owner:** fuzzy-bobcat (PM) · **Date:** 2026-09-15 (rev. 2026-09-16)
**Audience:** executor agents implementing this, plus QA/security reviewers.

---

## 1. Summary

Add a **Goobers** entry to the Clubhouse left rail that opens a full-window panel for
monitoring and controlling the local Goobers instance — the self-hosted Go daemon that
runs AI-agent workflows ("gaggles") against GitHub backlogs.

**Governing assumption: one Clubhouse, one Goobers instance, one machine.** There is no
multi-instance switcher, no remote instance, no per-project binding. The instance is a
machine-level fact, like the editor command setting.

### Goals

- See at a glance whether the instance is healthy and whether the daemon is running.
- Browse gaggles, workflows, and run history; drill into a run's timeline and diagnostics.
- Take the small set of safe actions: start/stop the daemon, cancel a run.
- Live updates without polling churn, using the daemon's SSE change feed.

### Non-goals (explicitly out of scope for this feature)

- **Editing Goobers configuration.** The config-authoring HTTP routes are declared in
  `internal/apicontract/authoring.go` but *never registered by the daemon*. There is no
  API for this. Config editing stays in the user's editor + `goobers apply`.
- **Triggering workflow runs.** `POST /api/v1/triggers` starts agentic work that spends
  real money. Deferred to Phase 3 behind an explicit confirm. See §12.
- **Gate approve / override / rerun.** The Goobers source comments these as *"a deliberate
  stub today"* (`contract.go:726-737`); real gate resolution lands in their #466/#468.
  Do not build buttons on them until upstream is real.
- **Managing more than one instance**, or an instance on another machine.
- **Embedding the Goobers portal in a webview.** Rejected — see §4.3.

---

## 2. Constraints that shape the design

These are findings, not opinions. Each one closed off an otherwise-obvious approach.

### 2.1 A Clubhouse plugin cannot talk to a localhost service — BLOCKING

- There is **no network namespace** in `PluginAPI`. No `http`, `fetch`, `net`, `ws`.
- The CSP (`src/main/csp-nonce.ts:28`) declares **no `connect-src`**, so it falls back to
  `default-src 'self'`. The production renderer is a `file://` document, for which `'self'`
  does not match `http://127.0.0.1:8080`. In dev, `'self'` is the webpack origin only.
  **`fetch('http://127.0.0.1:8080')` fails in both dev and prod.**
- `api.process.exec` exists but is **buffered-only**, timeout clamped to 60s max, capped at
  **50 spawns/minute globally across all plugins**. It cannot carry a live stream and would
  starve other plugins if polled.
- `api.terminal` *would* work — it is an unallowlisted login shell — and is therefore
  **forbidden here**. Using it would knowingly route around the `allowedCommands` security
  control. Called out so reviewers can reject any patch that reaches for it.

**Consequence: this is core work plus a plugin, not a plugin alone.** All network I/O lives
in the main process, where CSP does not apply.

### 2.2 The daemon is usually *not* running

On the reference machine the daemon is down, `scheduler/up.lock` is present but unlocked,
and it records a **stale pid 7027 from 2026-09-13**. A client that trusted that pid would
report the daemon as running. The "down" state is the common case and must be a
first-class, actionable screen — not an error.

### 2.3 There is no auth, and no OpenAPI

- Default local install uses `httpapi.NullAuthenticator` — every request succeeds with no
  credential. The instance's `instance.yaml` has `api: {}`, i.e. defaults.
- The API binds **loopback-only**, structurally enforced (`internal/httpapi/server.go:100-113`
  refuses a non-loopback bind without both TLS and a real authenticator). There is no
  insecure escape hatch, so loopback-only is a guarantee we can rely on.
- The wire contract is **Go-generated TypeScript**, not OpenAPI. See §5.

### 2.4 `EventSource` cannot be used

Resuming the SSE stream requires sending a `Last-Event-ID` **request header**, which the
`EventSource` API cannot set. The Goobers portal uses `fetch` + `ReadableStream` with a
hand-rolled SSE parser for exactly this reason. We must do the same (in main, over node
`http`).

### 2.5 Experimental flags are renderer-only — they do not gate the service

`ExperimentalFlags` lives in `src/renderer/plugins/builtin/index.ts:31` and nothing in
`src/main` reads it. Flag-gating (§12) therefore gates **the plugin, not the service**.
Without an explicit decision, every user on the build — flag off, panel never opened —
would get a main-process service that validates roots, installs a file watcher, and polls a
daemon every 5s. See §7.7 for the gating rule; this is a Phase 1 requirement, not a
refinement.

### 2.6 Clubhouse ships Windows; this feature does not

The app is packaged and signed for Windows, but §7.5 requires a login-shell environment for
the spawned daemon, and Goobers itself is developed against macOS/Linux. **v1 is
macOS and Linux only.** On `win32` the rail item is not contributed and the service does not
start (§7.8). Stating this is not a scope cut we are hiding — it is the difference between
"unsupported" and "broken".

### 2.7 The login-shell environment already exists in core

`src/main/util/shell.ts` exports `getShellEnvironment()` — sources `$SHELL -ilc env`, caches
it, is pre-warmed at startup via `preWarmShellEnvironment()`, and passes `process.env`
through unchanged on `win32`. **Do not hand-roll a `$SHELL -l -c` invocation** (§7.5); reuse
this, which also lets the daemon be spawned with `execFile`-style argv instead of a shell
string, removing the quoting hazard in §10.6 entirely.

---

## 3. Architecture

```
  Goobers daemon (127.0.0.1:8080)
        │  HTTP/1.1 + SSE   (loopback, no auth)
        ▼
  ┌─────────────────────────────────────────────┐
  │ MAIN PROCESS                                │
  │  src/main/services/goobers-service.ts       │  ← owns connection, SSE, cache,
  │  src/main/services/goobers-daemon.ts        │    liveness probe, lifecycle
  │  src/main/ipc/goobers-handlers.ts           │
  └─────────────────────────────────────────────┘
        │  IPC.GOOBERS.*  (invoke) + CHANGED (broadcast)
        ▼
  ┌─────────────────────────────────────────────┐
  │ PRELOAD  src/preload/goobers.ts             │  → window.clubhouse.goobers.*
  └─────────────────────────────────────────────┘
        ▼
  ┌─────────────────────────────────────────────┐
  │ RENDERER                                    │
  │  src/renderer/stores/goobersStore.ts        │  ← zustand, mirrors main state
  │  src/renderer/plugins/builtin/goobers/      │  ← thin panel, no privileged perms
  └─────────────────────────────────────────────┘
```

This mirrors the **`group-project` plugin** exactly: a main-process service singleton, an
IPC slice, a renderer store, and a plugin whose `main.ts` imports that store. The one
addition is that our service holds a network connection.

**Templates to copy from, verbatim where possible:**

| Concern | Existing file to model on |
|---|---|
| HTTP client in main | `src/main/services/annex-client.ts` (hand-rolled node `http`, `req.setTimeout` + `destroy`) |
| Service singleton shape, change fan-out, debounced flush | `src/main/services/group-project-registry.ts` |
| Long-lived external process supervision | `src/main/services/pty-manager.ts` |
| Login-shell environment for spawns | `src/main/util/shell.ts` — `getShellEnvironment()` (§2.7); do not reimplement |
| Hand-written settings sub-page | `src/renderer/features/settings/EditorSettingsView.tsx` (§4.1) |
| Renderer store + `init…Listener()` | `src/renderer/stores/groupProjectStore.ts` |
| Plugin (app-mode, full-window, rail item) | `src/renderer/plugins/builtin/review/` |

### 3.1 Why not a webview onto the Goobers portal

The installed binary **does** embed the portal (confirmed: `dist/assets/index-*.js` present
in the binary's strings), and `goobers dashboard` serves it. Pointing a webview at it would
be cheap. Rejected because:

- It requires spawning and supervising a **second** long-lived child process (`goobers
  dashboard`) on top of the daemon, with its own port, lifecycle, and failure modes.
- The result would not look or behave like Clubhouse — no rail integration, no badges, no
  shared theme, no command palette.
- We would inherit the portal's `BroadcastChannel` leader election and same-origin
  assumptions inside an Electron webview.

The portal's **source** is still extremely valuable — we vendor its types (§5) and copy its
timing constants (§7.3).

---

## 4. Configuration and discovery

### 4.1 Settings

Add a `GOOBERS_SETTINGS` entry to `src/shared/settings-definitions.ts`. That file's own
docs state: *"By defining a setting here, the IPC channel, handler, preload bridge, and
renderer store are all derived automatically."* Closest precedent is `EDITOR_SETTINGS`.

**This must not be plugin storage or plugin settings.** The main-process service reads this
config at app startup, before any renderer or plugin exists. Plugin settings are a
renderer-side construct hydrated at plugin activation — architecturally too late.

```ts
// src/shared/settings-definitions.ts
export const GOOBERS_SETTINGS = {
  instanceRoot: '',        // absolute path to the instance root; '' = unconfigured
  binaryPath: 'goobers',   // bare name resolved via login shell PATH, or an absolute path
  autoConnect: true,       // connect on app start when a root is configured
  manageDaemon: false,     // allow Start/Stop from Clubhouse (hazards: §7.5; discovery: §8.6)
};
```

#### The settings UI is not free — build it

An earlier draft of this section claimed that declaring `instanceRoot` as
`type: 'directory'` would get a **Browse…** button for nothing. **That is wrong, and
believing it would ship an MVP with no way to configure the instance root at all.**

- `SettingsDefinition` (`src/shared/settings-definitions.ts:21-28`) is exactly
  `{ key, filename, defaults }`. **There is no `type` field and no renderer.**
- `type: 'directory'` belongs to `PluginSettingSchema` (`src/shared/plugin-types.ts:21`),
  rendered by `plugin-settings-renderer.tsx:100`. That is *plugin* settings — the construct
  §4.1 just ruled out on startup-ordering grounds. The two are mutually exclusive.
- The precedent this section names, `EDITOR_SETTINGS`, gets its UI from a hand-written
  `EditorSettingsView.tsx`, routed in `MainContentView.tsx:258`.

**Phase 1 deliverable (Stream A):** a `GoobersSettingsView` following `EditorSettingsView`,
with a text field plus **Browse…** wired to `window.clubhouse.project.pickDirectory()` for
`instanceRoot`, a `binaryPath` field, and toggles for `autoConnect` and `manageDaemon` (the
latter carrying the §8.4 hazard copy). Route it alongside the other settings sub-pages.

The panel's own **Not configured** screen (§8.4) must offer the same picker inline rather
than only deep-linking to settings — first run should never require finding a settings page.
Either surface is acceptable; shipping neither is not.

This is distinct from the *auto-detect* affordance in §4.2, which finds candidate roots for
you. The manual picker is the baseline and is never gated behind auto-detect.

#### Settings changes at runtime

The service subscribes to its own settings and reacts; it does not read them once at boot.

| Change | Service response |
|---|---|
| `instanceRoot` changed | Disconnect, drop all cached `Instance`/`Health`/run state, re-validate (§4.2), reconnect if valid. **Never** show the previous root's data under the new root's identity. |
| `binaryPath` changed | Re-resolve and re-validate executability (see below); update the Start button's enabled state. |
| `autoConnect` → false | Stop polling and close the watcher; keep the last state visible, marked stale. |
| `autoConnect` → true | Run the §7.1 startup sequence immediately. |
| `manageDaemon` → false | Hide Start/Stop. **A drain already in progress keeps being tracked** — we did not stop observing reality just because the button went away. |

#### Resolving `binaryPath`

Resolve once, on connect and on change, and cache the result:

1. Absolute path ⇒ `stat` it; must exist and be executable by us.
2. Bare name ⇒ resolve against `getShellEnvironment().PATH` (§2.7). Not found is a
   **first-class state** (§8.4), not a silent failure at Start time.
3. Store the resolved absolute path and use *that* for spawns, never the raw setting.

Unresolvable `binaryPath` disables daemon control and shows the "Goobers binary not found"
screen. It does **not** block the read path — a running daemon is still monitorable without
the CLI.

### 4.2 Validating and identifying the instance

There is **no `GOOBERS_HOME`, no `GOOBERS_ROOT`, and no instance registry.** `~/.goobers/`
holds only `copilot.pat`. A root is defined by exactly one thing:

> `<root>/instance.yaml` exists and is a regular file.

Validation sequence when a root is set:

1. `stat <root>/instance.yaml` — absent ⇒ reject with *"not a Goobers instance root"*.
2. `stat <root>/.instance-decommissioned` — present ⇒ reject as a historical root.
3. Read `<root>/.instance-id` (32 lowercase hex + `\n`) as the **durable root identity**.
   Display and store this.
   - **Do not** use `<root>/instance-id` (no leading dot). That is a *different* file — the
     runtime engine ID, mode 0600 — and it legitimately holds a different value. On the
     reference instance: `.instance-id` = `eaf74575d8de50fa5471027ba7fd15cb`,
     `instance-id` = `e86a94384664f7981488722ac46d2432`. Conflating them is a bug.
4. Never write anything into the instance root. The only client-written file Goobers
   supports is `updates/stop-request`, and only via `goobers down`.

**Auto-detect — convenience only, Phase 2.** `goobers roots discover --json` returns
`{"paths":[...],"partial":bool,"visited":int}`, searching cwd + home. Offer it as a
"Find my instance" button that pre-fills the field the Browse button already fills. Note it
**exits 1** when `partial` is true, and it requires `binaryPath` to resolve — which is why
it can't be the only way to configure a root.

### 4.3 Locating the API

The daemon writes its actually-bound address to **`<root>/scheduler/api.address`** at
readiness and deletes it at clean shutdown. Resolution order:

1. `<root>/scheduler/api.address` (authoritative when present)
2. `api.listen` in `<root>/instance.yaml`
3. Default `127.0.0.1:8080`

**Parse defensively — this file is written by another process, live.**

- The daemon writes it at readiness, so a read can legitimately catch it **empty or
  partially written**. An unparseable address is *not* "daemon not running": retry a few
  times over ~1s before concluding anything. Flapping the UI between states on this race is
  a bug reviewers should look for.
- Accept `host:port`, bracketed IPv6 (`[::1]:8080`), and a bare `:port`.
- Normalize wildcard binds for the *client*: `0.0.0.0` ⇒ `127.0.0.1`, `::` ⇒ `::1`. We are
  connecting, not binding.
- A parsed host that is not loopback is a hard error, not a connection attempt. §2.3 says
  the daemon structurally cannot bind non-loopback; if we somehow read one, the address file
  is not describing a daemon we should talk to.

---

## 5. Data contract

### 5.1 Vendor the portal's generated types

`/Users/cazzone/Repos/Goobers/portal/src/api/types.ts` is the only complete TypeScript
description of the wire format, and Goobers CI fails if it drifts from the Go structs
(`wireContract.test.ts` against `wire.generated.ts`). There is no OpenAPI spec to generate
from.

**Action:** copy the subset we consume into `src/shared/goobers-api-types.ts` with a
provenance header:

```ts
// Vendored from Goobers portal/src/api/types.ts
// Source commit: <sha>   Binary contract: portal-v0.1.0-21-ga1b2ae99
// DO NOT EDIT BY HAND. Re-vendor when the Goobers API version changes.
// Upstream is contract-tested against the Go structs; this copy is not.
```

**Drift is a real risk and must be handled at runtime, not just by discipline** — see §9.4.

### 5.2 Types the panel consumes

Full field lists live in the vendored file; these are the ones the UI renders.

**`ReadStateEnvelope`** — embedded in nearly every response. Carries honest staleness:
`readState.lagSeconds`, `.completeness`, `.degraded`, `.observedAt`. The Goobers system is
deliberately designed to *report* degradation rather than hide it, so **the panel must
surface it** rather than rendering stale data as fresh.

**`Instance`** (`GET /api/v1/instance`) — `name`, `environment`, `instanceRoot`,
`rootIdentity`, `ready`, `status`, `concurrency{activeRuns,maxConcurrentRuns}`,
`counts{gaggles,goobers,workflows,activeRuns}`, `warnings[]`, `maintenance`, `fleetEnrolled`.

**`Health`** (`GET /api/v1/health`) — `build{version,commit,date}`, `ready`, `healthy`,
`freshness{observedAt, definitionsLoadedAt, journalUpdatedAt, lastSchedulerTickAt,
lastTickAgeMillis}`.

**`Gaggle`** — `name`, `displayName`, `project`, `backlog`, `gooberCount`, `workflowCount`,
`activeRunCount`, `warnings[]`.

**`RunSummary`** — `id`, `workflow`, `gaggle`, `trigger{kind,ref}`, `phase`, `terminal`,
`currentStage`, `startedAt`, `finishedAt`, `durationMillis`, `lastActivityAt`, `stale`,
`repassCount`, `retryCount`, `noWork`, `terminalReason`, `activeStages[]`, `operator`.

**`OperatorRunSummary`** — the operations payload: `issue{number,title}`, `pullRequest`,
`currentStage`, `lastHeartbeatAt`, `heartbeatAgeMillis`, `liveness`, `trajectory`, `claim`,
`latestError`, `review`, `nextTransition`, **`potentialBlockers[]`**, and
**`diagnosticsLimitations[]`**.

> **Render `potentialBlockers` and `diagnosticsLimitations` differently.** The split is
> deliberate (upstream #3346): the first is *what is impeding the run*; the second is
> *what this read could not establish* (missing credential, unreachable provider).
> Conflating them previously manufactured convincing false signals on two healthy runs.
> Suggested treatment: blockers as warning-styled chips; limitations as muted
> "diagnostics incomplete" footnote text.

**`RunDetail`** — `RunSummary` plus `graph`, `graphStatus`, `escalation`, `terminalCause`,
`outcome`, `transitions[]`, `transitionsStatus`.

> **If we ever draw the workflow graph (Phase 3), highlight edges from `transitions[]`
> only.** Inferring "both endpoints were visited ⇒ edge taken" is what made the upstream
> portal highlight an untaken repass edge (#1430). Respect
> `transitionsStatus: "projected"` with an empty array — a fresh run legitimately has none.

**`RunEvent`** — `seq`, `type`, `time`, `category`, `stage`, `gate`, `verdict`, `status`,
`actor`, `decision`, `rationale`, `attempt`, `outputs`, `artifacts[]`, `externalRef`,
`error`, `raw`. `type` is an **open union** — unknown event types must render, not crash.

**`StageAttempt`** — `id`, `visit`, `number`, `class`, `status`, `errorCode`, `errorClass`,
`model`, `startedAt`, `finishedAt`, `durationMillis`, `artifacts[]`, `error`.

### 5.3 Enum strings (exact)

```
RunPhase           = "running" | "completed" | "failed" | "aborted" | "escalated"
StageAttemptStatus = "running" | "success" | "failure" | "blocked" | "no-work" | ""
AttemptClass       = "initial" | "policy" | "infra" | "human"
InstanceStatus     = "starting" | "ready" | "degraded"
Environment        = "dev" | "staging" | "prod"
RunTriggerKind     = "manual" | "schedule" | "signal" | "item"
RunEventCategory   = "transition" | "decision" | "result" | "evidence" | "liveness"
                   | "bookkeeping" | "unknown"
MaintenanceState   = "none" | "queued" | "running" | "completed" | "failed" | "cancelled"
UpdateModel        = "instance" | "run" | "workflow"
Harness            = "copilot" | "claude-code"
```

Traps:

- **There is no `queued` or `parked` run phase.** Five phases only.
- `StageAttempt.status` has `""` as a **real wire value** (in-flight/unrecorded).
- `OperatorRunSummary.liveness` is only ever `"no-heartbeat"` or `"terminal"` in
  non-test code.
- `OperatorRunSummary.trajectory` is **derived from a substring match on the stage name**
  (`internal/readmodel/project.go:912`) and yields `parked` / `review` / `local CI` /
  `push` / `open PR` / `CI poll` / `close-out` / `implementing`. **Treat it as a display
  hint only. Never branch machine logic on it.**
- `RunEventType` is an open union (43 known literals). Unknown types must degrade
  gracefully using the `raw` field.

### 5.4 Error envelope

Every route returns the same shape on error:

```ts
{ error: { code: string, message: string } }
```

---

## 6. IPC contract

Add `IPC.GOOBERS` to `src/shared/ipc-channels.ts` (format: `kebab-domain:kebab-action`).

### 6.1 Renderer → main (invoke)

| Channel | Args | Returns | Notes |
|---|---|---|---|
| `goobers:get-state` | — | `GoobersConnectionState` | full snapshot for store hydration |
| `goobers:validate-root` | `{ path }` | `{ ok, instanceId?, error? }` | §4.2 checks; no network |
| `goobers:connect` | — | `GoobersConnectionState` | idempotent |
| `goobers:disconnect` | — | `void` | |
| `goobers:list-gaggles` | — | `GagglePage` | |
| `goobers:list-workflows` | `{ gaggle }` | `WorkflowPage` | |
| `goobers:list-runs` | `RunListQuery` | `RunList` | see §6.3 |
| `goobers:get-run` | `{ runId }` | `RunDetail` | |
| `goobers:get-run-events` | `{ runId, cursor?, limit? }` | `EventList` | |
| `goobers:get-stage-attempts` | `{ runId, stage }` | `AttemptList` | |
| `goobers:cancel-run` | `{ runId }` | `{ ok, error? }` | **mutating** |
| `goobers:daemon-status` | — | `GoobersDaemonStatus` | §7.4 |
| `goobers:daemon-start` | — | `{ ok, error? }` | **mutating**, gated on `manageDaemon` |
| `goobers:daemon-stop` | — | `{ ok, error? }` | **mutating**, gated on `manageDaemon` |
| `goobers:open-run-dir` | `{ runId }` | `{ ok, error? }` | via `POST /runs/{run}/reveal` |

Every handler wraps in `withValidatedArgs([...], …)` from `src/main/ipc/validation`.
`runId`, `gaggle`, `workflow`, and `stage` are interpolated into URL paths — **validate and
`encodeURIComponent` all of them** (§10.2).

### 6.2 Main → renderer (broadcast)

| Channel | Payload |
|---|---|
| `goobers:state-changed` | `GoobersConnectionState` — connection/daemon/health transitions |
| `goobers:data-invalidated` | `{ models: UpdateModel[], runIds?: string[], workflows?: {gaggle,name}[] }` |

Broadcast with `broadcastToAllWindows(...)` from `src/main/util/ipc-broadcast`. **Never**
`getFocusedWindow()` or `getAllWindows()[0]` — `src/main/util/ipc-broadcast-audit.test.ts`
enforces this, and popout windows depend on it.

### 6.3 `RunListQuery`

Passthrough to `GET /api/v1/runs`: `gaggle`, `workflow`, `stage`, `outcome`, `population`,
`phase`, `trigger`, `since`, `until`, `cursor`, `limit`, `latestPerWorkflow`, `showNoWork`,
`orderByActivity`. Pagination is **cursor-based** (`nextCursor` / `hasMore`), not offset.

### 6.4 `GoobersConnectionState`

```ts
type GoobersConnectionState = {
  configured: boolean;
  instanceRoot: string | null;
  rootIdentity: string | null;      // from .instance-id
  daemon: GoobersDaemonStatus;
  connection: 'idle' | 'connecting' | 'connected' | 'degraded' | 'error';
  stream: 'live' | 'reconnecting' | 'polling' | 'unavailable';
  instance: Instance | null;
  health: Health | null;
  apiCompatible: boolean;           // see §9.4
  lastError: { code: string; message: string } | null;
  lastUpdatedAt: string;            // ISO
};

type GoobersDaemonStatus = {
  state: 'running' | 'not-running' | 'starting' | 'stopping' | 'unknown';
  address: string | null;           // from scheduler/api.address
  pid: number | null;               // DISPLAY ONLY — never liveness (§2.2)
  version: string | null;           // from up.lock body
  startedAt: string | null;
  lastTickAgeMillis: number | null;
  draining: boolean;                // stop requested, lock still held
};
```

---

## 7. Main-process service design

### 7.1 Connection lifecycle

On app start, if `instanceRoot` is set and `autoConnect` is true:

1. Validate the root (§4.2). Invalid ⇒ `connection: 'error'`, stop.
2. Probe daemon liveness (§7.4).
3. If running: `GET /api/v1/health` and `GET /api/v1/instance`, check API compatibility
   (§9.4), then open the SSE stream.
4. If not running: `connection: 'idle'`, `daemon.state: 'not-running'`. **Do not poll the
   HTTP API in a loop.** Watch `<root>/scheduler/api.address` with a file watcher (already
   a pattern in `agent-config.ts`) and connect when it appears.

### 7.2 SSE stream

`GET /api/v1/events`, `Accept: text/event-stream`, budget 0 (no server deadline).

- Implement with node `http.request` + manual SSE frame parsing. **`EventSource` cannot set
  `Last-Event-ID`** (§2.4).
- Frame types:
  - `snapshot` — `{cursor, models:["instance","run","workflow"]}` ⇒ refetch everything.
  - `invalidate` — `{cursor, models, runIds, workflows}` ⇒ refetch only what's named.
  - `heartbeat` — every **15s** ⇒ liveness only.
- Persist the last `id:` and send it as the **`Last-Event-ID` request header** on reconnect.
- Cursor refusals, each with a distinct correct response:

  | Response | Action |
  |---|---|
  | `400 invalid_cursor` | drop cursor, reconnect fresh |
  | `409 epoch_changed` / `feed_truncated` / `schema_changed` | refetch all, reconnect without `Last-Event-ID` |
  | `409 stale_cursor` | same as above (generic fallback) |
  | `503 stream_unavailable` | daemon shutting down — back off, re-probe liveness |

- The stream is an **invalidation** stream, not a state stream. Never render from frame
  contents; always refetch the named models.

### 7.3 Timing constants — copy the portal's

From `portal/src/liveData.tsx:95-106`. These are tuned against the same server; do not
invent new ones.

```
invalidationWindowMs: 50        // debounce/coalesce invalidations
reconnectBaseDelayMs: 250       // backoff = 250 * 2^(n-1)
reconnectMaxDelayMs: 30_000
connectTimeoutMs: 10_000
streamIdleTimeoutMs: 45_000     // 3x the 15s server heartbeat
connectionSettledMs: 10_000
failuresBeforePolling: 3
pollingIntervalMs: 60_000       // degraded mode: poll /api/v1/health only
maxPendingInvalidations: 64
```

After 3 consecutive stream failures ⇒ `stream: 'polling'`, 60s `GET /api/v1/health`.

**Caching:** there is **no ETag/If-None-Match on any list or detail read** — only on
content-addressed artifact blobs. Freshness comes from `readState`, not HTTP caching. Do
not build a conditional-GET layer. (`api-read-cache.json` in the instance root is a *GitHub
provider* cache, unrelated to this API.)

### 7.4 Daemon liveness detection

Node has no `flock`, and we will **not** add a native dependency for it. The upstream
"correct" method is a non-blocking exclusive flock on `<root>/scheduler/up.lock`; our
equivalent, which is dependency-free and defeats the same hazards:

1. `stat <root>/scheduler/api.address`. Absent ⇒ **not running** (or not yet ready). Done.
2. Present ⇒ read `host:port`, `GET http://host:port/readyz` with a 2s timeout.
   - `ECONNREFUSED` ⇒ stale address file ⇒ **not running**.
   - 200 ⇒ candidate running. 503 ⇒ running but **not ready** (`starting`).
3. **Confirm identity:** `GET /api/v1/instance` and assert `instance.instanceRoot` matches
   our configured root (after `realpath`). Mismatch ⇒ another process owns that port ⇒
   report `unknown`, surface a clear error. *This is what makes port-probing safe;* upstream
   warns against naked port probes for exactly this reason.
4. Read `<root>/scheduler/up.lock`'s JSON body for **display metadata only** — `version`,
   `startedAt`, `livenessTimeoutMillis`. **Never treat its `pid` as liveness** (§2.2).
5. Ongoing health: `health.freshness.lastTickAgeMillis` vs `livenessTimeoutMillis`
   (default 120000). Exceeded ⇒ `connection: 'degraded'` with "scheduler not ticking".

Explicit anti-patterns to reject in review: trusting the recorded `pid`; `pgrep`; probing
8080 without the address file; using `read.db`/scheduler mtimes.

### 7.5 Daemon lifecycle control

Gated behind the `manageDaemon` setting, **default off**, with the hazards below shown in
the settings UI and in the §8.6 inline enable affordance.

**Start** — `goobers up <instanceRoot>`:

- **Must spawn with the user's login-shell environment.** Use `getShellEnvironment()` from
  `src/main/util/shell.ts` (§2.7) as the child's `env`, and spawn the **resolved absolute
  `binaryPath`** with `execFile`-style argv — not a shell command string. A daemon started
  with Electron's inherited PATH will fail `local-ci` stages in subtle ways; upstream's own
  plist comments warn about exactly this. **This is a hard acceptance criterion, not a
  nicety**, and routing it through the existing helper is what makes it unit-testable.
- Spawn **detached**, and **do not kill it when Clubhouse quits.** The daemon is an
  independent system that outlives the app.

**Start has no useful exit code — define success by observation.** A detached spawn tells us
nothing, and a daemon that dies on a bad config dies silently. The sequence:

1. Spawn with `stdio: ['ignore', 'pipe', 'pipe']`. Buffer up to **64 KiB** of stdout/stderr
   for the first few seconds, then `unref()` and stop reading. Without this, the single most
   common start failure — a config error printed to stderr — is invisible to the user.
2. Enter `daemon.state: 'starting'` immediately.
3. Success = `<root>/scheduler/api.address` appears **and** `/readyz` returns 200 **and**
   the identity check (§7.4 step 3) passes.
4. **Bound the wait at 60s.** On timeout, or if the child exits before step 3, go to
   `state: 'unknown'` and show the buffered stderr plus the path to the daemon's own log.
   "Starting…" forever is the failure mode to design against.
5. Exit 1 with a lock-contention message is **success-adjacent**, not failure — the daemon
   is already up (see below).

**Start and Stop are mutually exclusive and non-reentrant.** Hold a single in-flight
lifecycle operation in the service. A second `daemon-start` while `starting`, or a
`daemon-stop` while starting, returns `{ ok: false, error: 'lifecycle-busy' }` rather than
spawning again; the renderer disables the control for the duration. Double-clicking Start
must not produce two `goobers up` processes racing for the lock.
- The lock is acquired **non-blocking and fails fast** with *"another `goobers up` already
  holds the lock on this instance root (…; holder pid N)"*, exit 1. **Attempt and interpret
  the error — never pre-check-then-start**, which is not atomic. Treat that message as
  "already running", not a failure.
- Note `run`, `signal`, and `telemetry` take the *same* lock with `holderKind: "manual"`.
  A foreground `goobers run` blocks a start. Surface the holder kind in the error.

**Stop** — `goobers down <instanceRoot>`:

- Writes an empty `updates/stop-request` file; the daemon polls for it and drains.
- **`goobers down` returning exit 0 does NOT mean stopped.** The drain is **unbounded by
  default** and may run 30–40 minutes finishing an agentic stage. **A UI that shows
  "stopped" on exit 0 is lying.** Enter `daemon.state: 'stopping'`, `draining: true`, keep
  polling liveness until the API stops responding and `api.address` disappears, and show
  which run is draining.
- Exit 1 from `goobers down` ⇒ not held by a daemon ⇒ already stopped.

**Cancel run** — prefer `POST /api/v1/runs/{run}/cancel` over the CLI when the daemon is up.
Kills one run, tears down its worktree, releases the backlog claim, records phase `aborted`.
Does **not** stop the daemon.

### 7.6 Concurrency and caching in main

- One SSE connection per app. Popout windows share it via broadcast.
- Coalesce invalidations in a 50ms window; cap the pending queue at 64 then force a full
  refetch.
- Cache the last good `Instance`, `Health`, and gaggle list in the service so a renderer
  hydrating (or a popout opening) gets state without a round trip to the daemon.
- All requests carry a timeout (`connectTimeoutMs`) and `req.destroy()` on expiry, per the
  `annex-client.ts` pattern.

### 7.7 When the service is allowed to run

Because experimental flags never reach main (§2.5), the service must not assume the plugin
gates it. **The service starts idle and does no I/O — no validation, no watcher, no poll —
until a renderer asks for state.** The first `goobers:get-state` (which only the panel
sends, and the panel only exists when the flag is on) activates it; `autoConnect` then
governs whether it connects, as specced in §7.1.

- **The 5s poll (§12) runs only while at least one renderer is subscribed and its window is
  visible.** Panel closed, or all windows hidden/minimized ⇒ stop the interval. Resume on
  the next subscribe or `browser-window-focus`, and refetch immediately on resume rather
  than waiting out a tick.
- The `api.address` file watcher (§7.1 step 4) follows the same rule — it is cheap, but a
  user who never opts in should not have a watcher on a directory they never configured.
- Reference counting, not a boolean: popouts and the main window can each subscribe.

This is the whole flag-gating story for main. Do not plumb `ExperimentalFlags` into the main
process to solve it.

### 7.8 Platform gate

Per §2.6, on `process.platform === 'win32'`:

- The service does not register or activate; its IPC handlers return a
  `{ code: 'unsupported-platform' }` error envelope rather than throwing.
- The plugin does not contribute its rail item. Prefer filtering at registration
  (`getBuiltinPlugins`) so nothing half-appears.

### 7.9 Teardown

On `before-quit` / service dispose: clear the poll interval, close the `api.address`
watcher, `req.destroy()` every in-flight request, and close the SSE stream when Phase 2
lands. **Do not touch the daemon** (D12) — including a daemon this app started, and
including one mid-drain.

---

## 8. Plugin and UX specification

### 8.1 Manifest

```ts
// src/renderer/plugins/builtin/goobers/manifest.ts
export const manifest: PluginManifest = {
  id: 'goobers',
  name: 'Goobers',
  version: '1.0.0',
  description: 'Monitor and control the local Goobers instance — gaggles, runs, and daemon health.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'app',
  // Phase 1 set — minimal and exact. `badges` + `notifications` are added in Phase 2
  // when §8.3 lands, not before.
  permissions: ['storage', 'commands', 'logging', 'navigation'],
  contributes: {
    railItem: { label: 'Goobers', title: 'Goobers', icon: GOOBERS_ICON, position: 'top' },
    commands: [
      { id: 'goobers.open',    title: 'Goobers: Open panel' },
      { id: 'goobers.refresh', title: 'Goobers: Refresh now' },
      { id: 'goobers.start',   title: 'Goobers: Start daemon' }, // hidden unless manageDaemon
      { id: 'goobers.stop',    title: 'Goobers: Stop daemon' },  // hidden unless manageDaemon
    ],
    help: {
      topics: [
        { id: 'goobers-overview', title: 'What is Goobers?' },
        { id: 'goobers-setup',    title: 'Pointing Clubhouse at your instance' },
        { id: 'goobers-daemon',   title: 'Starting and stopping the daemon' },
      ],
    },
  },
  settingsPanel: 'declarative',
};
```

**Notable, and deliberate:**

- **`scope: 'app'`** — semantically correct (the instance is machine-level, not
  per-project), but **no existing built-in uses it**; every rail-bearing plugin today is
  `'dual'`. Accept that we are first and that no e2e path exercises a pure-app built-in
  (see §11).
- **No `contributes.tab`.** The manifest validator (`manifest-validator.ts:96-104`)
  *forbids* `tab` on app scope. Consequently `layout: 'full'` is not expressible — **app
  panels are rendered full-window unconditionally** by `App.tsx`. That is what we want.
- **No dangerous permissions.** No `process`, no `files`, no `files.external`, no
  `terminal`. All privileged work is in main, behind IPC. A reviewer seeing any of those
  appear in this manifest should reject the patch.
- **The permission list is exact, and §11 asserts it.** MVP has no badge (§8.3 is Phase 2)
  and sends no notifications, so `badges` and `notifications` are **not** requested in Phase
  1 — granting them now would bake unused capability into a test that claims to pin the set.
- `contributes.help` is **mandatory** at api ≥ 0.5 (`manifest-validator.ts:120-126`), so the
  three topics above are a Phase 1 deliverable with real prose behind them, not stubs.
  `goobers-setup` in particular is where a user lands when they have no instance root.
- Icon is an inline SVG string, sanitized by core via `sanitizeSvg`.
- **Not registered on Windows** (§7.8).

The panel body imports `goobersStore` directly — the established precedent
(`review/main.ts` imports `remoteProjectStore`; `group-project/main.ts` imports
`groupProjectStore`).

### 8.2 Layout

**MVP is the top half of this sketch only** — header, and a list of what is running right
now. No gaggle sidebar, no history list, no detail pane. Each active run carries its full
operator summary inline.

> **Do not assume the active-run list is short.** `runConditions.maxParallelRuns` is a
> per-user `instance.yaml` setting that can be raised or lowered at any time, so the number
> of concurrent runs is unbounded from our side. The active-run view **scrolls**, and the
> header shows the live ratio from `instance.concurrency` (`activeRuns` /
> `maxConcurrentRuns`) rather than a hardcoded cap. See §8.7.
The gaggle filter, the scrollable history list, and the detail pane below it all arrive in
Phase 2. The full target state, once history lands, is full-window master–detail:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ goobers-local  [dev]   ● Ready · lag 0.4s      [Stop daemon]  ⚙          │  Header
├───────────────────┬──────────────────────────────────────────────────────┤
│ INSTANCE          │  RUNS                          [filters ▾] [refresh] │
│  3 gaggles        │ ┌──────────────────────────────────────────────────┐ │
│  12 workflows     │ │ ● running   clubhouse-implementation   #1842  2m │ │
│  2 active runs    │ │ ✓ completed clubhouse-implementation   #1839 14m │ │
│  ⚠ 1 warning      │ │ ✗ failed    clubhouse-merge-review     #1840  3m │ │
│                   │ │ ⚡ escalated clubhouse-pr-remediation   #1836  8m │ │
│ GAGGLES           │ └──────────────────────────────────────────────────┘ │
│  ▸ clubhouse   2  │                                                      │
│  ▸ goobers-repo 0 │  ── run detail (on select) ─────────────────────────│
│  ▸ game-sim     0 │  phase · trigger · duration · issue → PR             │
│                   │  operator: stage, liveness, blockers                 │
│                   │  timeline (events) · stage attempts                  │
└───────────────────┴──────────────────────────────────────────────────────┘
```

**Header** — instance name, environment badge, status pill, freshness, daemon control, gear
to settings. Status pill states: `Ready` / `Starting` / `Degraded` / `Daemon not running` /
`Not configured` / `Incompatible`.

**Left column** — instance counts, `warnings[]`, maintenance state when not `none`, and the
gaggle list with per-gaggle `activeRunCount`.

> **Gaggles are a filter in v1, nothing more.** Selecting one filters the run list.
> There is no gaggle detail page, no workflow list, and no schedule display. This is a
> deliberate scope cut — run history is the thing worth building first. It does mean
> workflow *schedules* stay invisible (the `clubhouse` gaggle has 4 cron workflows,
> `goobers-repo` 1, `game-sim` none), so "why is nothing running?" is still a question you
> answer by reading the YAML. Revisit in Phase 3 if that bites.

**Run list** — virtualized. Columns: phase icon, workflow, gaggle, trigger, issue/PR ref,
started (relative), duration, current stage. `stale: true` runs get a "no heartbeat" marker.

> **Default filters matter more than usual here.** The reference instance has **5,097 runs**,
> and the dev data is *dominated by failures*: `clubhouse-merge-review` is 1,085 failed vs
> 961 completed with no completed run since 2026-09-11. Default to
> `orderByActivity=true`, `showNoWork=false`, `limit=50`. `noWork` runs are routine ticks
> that found nothing and are noise by default.

**Run detail** — header (id, workflow, gaggle, phase, trigger, duration, terminalReason),
operator block (issue link, PR link, current stage, liveness, heartbeat age, trajectory as a
muted hint, `potentialBlockers` as warning chips, `diagnosticsLimitations` as muted
footnotes), escalation/terminal cause, event timeline grouped by `category`, and stage
attempts with retry/repass counts. Actions: **Cancel run** (running only, with confirm),
**Open run folder**, **Copy run ID**.

### 8.3 Rail badge — Phase 2

Deferred out of MVP: with no history view there is nothing to pull the user *back* to, and
the failure half of the count depends on a last-viewed watermark over past runs.

The badge means **"something needs you"**, never "work is happening". Active run counts are
shown *inside* the panel, not on the rail.

```ts
api.badges.set({
  key: 'goobers-attention',
  type: 'count',
  value: escalatedCount + failedSinceLastView,
  target: { appPlugin: true },   // this is specifically how a rail item is badged
});
```

- **Escalated runs** (`phase === 'escalated'`) always count — escalation is Goobers' explicit
  "a human must decide" state.
- **Failed runs** count only if they finished after the user last opened the panel. Persist
  that watermark with `api.storage.global` — a derived value with no settings UI, which is
  exactly what global plugin storage is for.
- Clear on panel view.

> **Tuning note, and a Phase 1 acceptance check.** The reference instance fails *a lot*
> (`clubhouse-merge-review`: 1,085 failed / 961 completed, cron every 5 minutes). If the
> failure half of this makes the badge permanently non-zero, it stops meaning anything.
> **Acceptance: during normal operation with the daemon up, the badge must return to zero
> after viewing and stay there until something genuinely new happens.** If it doesn't,
> drop the failure term and badge escalations only.

### 8.4 States (this is most of the work)

| State | Trigger | UI |
|---|---|---|
| **Not configured** | `instanceRoot === ''` | Empty state: what Goobers is, an **inline** "Choose instance root…" picker (§4.1), link to `goobers init` docs |
| **Invalid root** | no `instance.yaml` | Error + re-pick; name the exact missing file |
| **Decommissioned root** | `.instance-decommissioned` exists | Explain it is a historical root; offer re-pick |
| **Binary not found** | `binaryPath` unresolvable (§4.1) | "Couldn't find the `goobers` binary" + the value tried + how to set an absolute path. Daemon control disabled; **read path still works** if a daemon is already up |
| **Daemon control off** | `manageDaemon === false` | Not an error state — a variant of the screens below. Show the exact command to copy **and** an inline "Enable daemon control" affordance (§8.6) |
| **Auth required** | 401 from any API call | "This instance requires an API credential, which Clubhouse can't supply yet." Read path disabled, daemon control still available. Do not retry in a loop (§10.1) |
| **Daemon not running** | §7.4 step 1/2 | **First-class screen**, not an error. Instance identity + config summary from disk, "Daemon is not running", `[Start daemon]` when `manageDaemon`, otherwise §8.6. History is unavailable — say so plainly and link to §13-Q2 |
| **Start failed** | §7.5 start timeout or early child exit | Show the buffered stderr and the daemon log path — never a bare "failed to start" |
| **Starting** | `/readyz` 503 | Spinner + `readyz` check breakdown (`configLoaded`, `stateOpen`, `resumeComplete`, `sweepsStarted`) |
| **Ready, live** | SSE connected | Normal |
| **Ready, degraded** | `status: 'degraded'`, or `readState.degraded`, or stale tick | Banner naming the specific degradation; keep rendering data, marked stale |
| **Stream reconnecting** | 1–2 stream failures | Subtle "reconnecting" indicator; data stays |
| **Polling fallback** | ≥3 failures | "Live updates unavailable — refreshing every 60s" |
| **No read model** | SSE unavailable, `readState` absent | Explain reduced fidelity; there is deliberately **no silent poll fallback** upstream |
| **Stopping / draining** | after `goobers down` | "Stopping — draining run X". Persist until liveness is actually gone (§7.5) |
| **Port owned by someone else** | `instanceRoot` mismatch (§7.4 step 3) | Explicit error — do **not** render another instance's data |
| **Incompatible API** | §9.4 | Banner, read-only or disabled |

**Rules that apply across every row:**

- **Every error state carries a retry.** The header's `[refresh]` is a Phase 1 deliverable,
  not part of the Phase 2 sketch: it force-refetches the four MVP endpoints and re-runs the
  liveness probe, independent of the 5s tick. Error screens get their own "Try again".
- **Theme tokens only.** Status pills, phase icons, warning chips and the degraded banner
  use the semantic `--ctp-*` slots — no hardcoded hex, no color-only status encoding (pair
  every color with an icon or label). This panel is heavy on colored status and would
  otherwise be the next thing to break under a light theme; treat it as a review gate.
- **Truncate hostile content.** Workflow names, gaggle names, issue titles and error
  messages all come from user repos. Clamp with ellipsis and a `title` tooltip; never let
  one long string blow out the layout.

### 8.6 Daemon control is off by default — make it discoverable

`manageDaemon` defaults to `false` (D13, and correctly so), but the MVP bar says the plugin
"can start and stop the daemon." Out of the box it cannot. Without an affordance, the
headline feature is invisible to anyone who never reads the settings page.

The **Daemon not running** screen, when `manageDaemon` is off, shows the copyable command
*and* a single inline control — "Enable daemon control from Clubhouse" — that flips the
setting after showing the §7.5 hazards (login-shell environment, unbounded drain on stop,
daemon outlives the app). One click, from the screen where the user is already stuck.

This is not a settings shortcut for its own sake; it is the only path on which a first-run
user discovers the capability at the moment they want it.

### 8.7 Concurrency is user configuration, not a constant

`runConditions.maxParallelRuns` lives in the user's `instance.yaml`. The reference instance
happens to run 3, tuned up over time after disk-full and cron-starvation incidents, but it
can be any value and can change between two consecutive polls. **Nothing in the UI may
assume a small or fixed number of concurrent runs.**

Rules:

- **Read the live value, never a constant.** `GET /api/v1/instance` returns
  `concurrency{activeRuns, maxConcurrentRuns}`. The header shows that ratio directly
  ("2 / 3 slots"), so it stays correct when the user edits their config.
- **The active-run list scrolls**, in its own overflow container. Virtualize it on the same
  terms as the Phase 2 history list rather than treating it as a special short case.
- **Cap the query with an explicit `limit`** (suggest 200) rather than requesting unbounded
  rows. If the response reports `hasMore`, say so plainly — *"showing first 200 of N
  running"* — and do not paginate the active view. A user running more than 200 concurrent
  runs has a capacity question, not a browsing question.
- **Poll cost scales with the list.** The 5s MVP poll (§12) carries the `limit`, so the
  worst case is bounded. If the payload becomes a problem before Phase 2's SSE lands, raise
  the interval rather than dropping the limit.
- **Handle zero.** `activeRuns === 0` with a healthy daemon is the normal resting state, not
  an error: show "Daemon running — nothing active", plus the next scheduled fire time if it
  is cheaply available. This is the state the panel will sit in most of the time.

---

## 9. Error handling and compatibility

### 9.1 Never show another instance's data

§7.4 step 3 is a correctness gate, not a nicety. If `instance.instanceRoot` does not match
the configured root, refuse to render.

### 9.2 Unknown enum values must not crash

`RunEventType` is an open union; `StageAttempt.status` includes `""`; `trajectory` is a
free-ish string. Every switch needs a default branch that renders the raw value.

### 9.3 Degradation is signal, not noise

`readState.lagSeconds`, `.completeness`, `.degraded`, and `DiagnosticsLimitations` exist
because upstream chose honesty over false confidence. Surfacing them is a requirement.

### 9.4 API compatibility check

On connect, read `Health.apiVersion` / `schemaVersion` (both `"v1"` today) and
`build.version`. Store the vendored contract's expected values in
`src/shared/goobers-api-types.ts`.

- `apiVersion !== 'v1'` ⇒ `apiCompatible: false`, banner, disable mutations.
- `build.version` differs from the vendored source version ⇒ log a warning (info only —
  patch releases are expected).

The reference instance has **no version pin anywhere** — no `.goobers-version`, no
`version:` key — so nothing on disk detects drift. This runtime check is the only guard.

---

## 10. Security review notes

Flag these to reviewers explicitly.

1. **No auth by default is acceptable here** because the API is structurally loopback-only
   (`internal/httpapi/server.go:100-113` refuses non-loopback binds without both TLS and a
   real authenticator, and config validation enforces the same at load). If a user *has*
   configured `api.auth`, our client will get 401s — detect and surface it; do not attempt
   to source a bearer token in this phase.
2. **URL path injection.** `runId`, `gaggle`, `workflow`, `stage`, and `digest` are
   interpolated into request paths. Validate shape and `encodeURIComponent` every one, in
   **main** (the renderer is not a trust boundary — see #4).
3. **Never write to the instance root.** Only `goobers down` may, and only
   `updates/stop-request`.
4. **Renderer-side permission gating is advisory.** Plugins load as native ESM into the
   renderer's own realm and `window.clubhouse` is an unfrozen global, so plugin code can
   call IPC directly without going through `createPluginAPI`. The real boundaries are
   main-process. **All validation must be in `goobers-handlers.ts`, never in the plugin.**
5. **`api.terminal` is an unallowlisted shell** and must not be used as a transport (§2.1).
6. **Command injection via settings.** `binaryPath` and `instanceRoot` come from user
   settings and are used to spawn a process. **Resolved: use `execFile`-style argv with
   `getShellEnvironment()` (§2.7) supplying only the environment — never a shell command
   string.** With no shell to parse the arguments there is no quoting hazard to get wrong.
   `binaryPath` is resolved to an absolute path once and validated executable (§4.1); a
   patch that builds a command string and passes it to a shell should be rejected on sight.
7. **`goobers dashboard` is not spawned** in this design, avoiding a second listening port.

---

## 11. Testing requirements

The bar, derived from existing conventions:

**Main process (non-negotiable — every file in these dirs has a colocated test):**
- `src/main/services/goobers-service.test.ts` — connection state machine, liveness probe
  incl. the **stale-pid case**, identity mismatch, address-file parse cases (empty/partial
  ⇒ retry not "not running"; IPv6; wildcard normalization; non-loopback rejection),
  idle-until-subscribed gating and poll suspend/resume (§7.7), settings-change transitions
  (§4.1), teardown (§7.9), and — Phase 2 — SSE frame parsing, all four cursor-refusal paths,
  reconnect backoff, polling degradation.
- `src/main/services/goobers-daemon.test.ts` — start success-by-observation and its 60s
  timeout, early-child-exit with stderr captured, lifecycle-busy reentrancy, lock-contention
  error parsing (both `daemon` and `manual` holder kinds), drain polling, `binaryPath`
  resolution failure. **Assert the spawn receives `getShellEnvironment()` and argv, not a
  shell string** — this is how the §7.5 hard criterion stops being unverifiable.
- `src/main/ipc/goobers-handlers.test.ts` — arg validation, path-injection attempts,
  broadcast targets, `unsupported-platform` on `win32`.

**Plugin:**
- `manifest.test.ts` — `validateManifest()` clean; asserts `scope: 'app'`, **absence** of
  `contributes.tab`, icon contains `<svg`, permission set exactly as specified (Phase 1:
  no `badges`, no `notifications`), help topics present, and **negative assertions that
  `process`/`files`/`terminal` are absent**.
- `GoobersSettingsView.test.tsx` — the picker writes `instanceRoot`, invalid roots surface
  the §4.2 error, `manageDaemon` shows its hazards before enabling. Modeled on
  `EditorSettingsView.test.tsx`.
- **Platform:** a test asserting the rail item is not contributed on `win32` (§7.8).
- `main.test.ts` — renders every state in §8.4 against a mocked API, using
  `createMockContext` / `createMockAPI` from `src/renderer/plugins/testing.ts`.

**Registration tests that will fail loudly if missed:**
- `src/preload/index.test.ts` — asserts **exact key-set equality** of domain slices. Adding
  `goobers` without updating this fails.
- `src/main/ipc/index.test.ts` — needs the `vi.mock('./goobers-handlers', …)` entry.
- `src/shared/ipc-channel-sync.test.ts` — add broadcast-only channels to
  `MAIN_TO_RENDERER_ONLY_CHANNELS`.
- `builtin-plugin-testing.test.ts` — auto-enrolls on registration, **but passes no
  experimental flags**, so a flag-gated plugin needs explicit flag-on assertions.

**Coverage ratchet:** `scripts/check-test-coverage-ratchet.mjs` is *not* a coverage tool —
it counts `TODO(TC-CRIT-03)` markers against a baseline of 29. **Requirement: introduce
none.**

**E2E (`e2e/plugin-system.spec.ts`)** hardcodes plugin ids and counts. A default-enabled new
built-in may need edits. Since we ship flag-gated (§12), this should be inert at first —
verify.

**Fixtures:** the reference instance is the best test fixture in existence — 5,097 runs,
31,586 change-feed rows, a stale lock with a dead pid. Capture golden JSON responses from it
into `src/shared/__fixtures__/goobers/` rather than hand-writing mocks.

---

## 12. Phased delivery

Ship behind an experimental flag `goobers` (`ExperimentalFlags` in
`src/renderer/plugins/builtin/index.ts`, plus an `EXPERIMENTAL_FEATURES` entry in
`ExperimentalSettingsView.tsx`). Gated, **not** in `BASE_DEFAULT_IDS`, matching
`agent-queue`'s pattern. Graduate later — the loader already has a migration path that
strips stale flags.

### The MVP bar

Stated from the user's side, and it is the definition of done for Phase 1:

> The plugin is available and works. You can point it at your instance without leaving the
> app. It shows current instance status. It can start and stop the daemon, and tells you why
> when that fails. When the daemon is running, it shows what is running right now.

Everything that is *history* — browsing 5,097 past runs, filters, pagination, run detail,
timelines — is deliberately **not** MVP. A rail widget that can only watch is not worth
opening; a rail widget that cannot answer "what happened three days ago" is still useful
every day.

### Phase 1 — MVP

Two work streams. Stream A is a clean handoff boundary: once it lands, B and C parallelize.

**Stream A — foundation.** Vendored `src/shared/goobers-api-types.ts` with provenance
header; `GOOBERS_SETTINGS` in `settings-definitions.ts`; **`GoobersSettingsView` with a
working directory picker for `instanceRoot`, a `binaryPath` field, and the `autoConnect` /
`manageDaemon` toggles, routed as a settings sub-page (§4.1 — this is hand-written UI, not
free)**; `binaryPath` resolution (§4.1); root validation (§4.2 steps 1–3, no network);
`IPC.GOOBERS` channels; `goobers-service.ts` + handlers + preload slice + store, all
registered, with the idle-until-subscribed gate (§7.7) and the platform gate (§7.8); the six
registration-test updates; golden fixtures captured from the reference instance.

**Stream B — connection and control (main process).** Liveness detection (§7.4) including
the stale-pid and identity-mismatch cases; defensive `api.address` parsing (§4.3); HTTP
client (`annex-client.ts` pattern); polling refresh with visibility-aware suspend/resume
(§7.7, and the note below); daemon start/stop behind `manageDaemon` — `execFile` argv with
`getShellEnvironment()`, detached, stderr buffered, success-by-observation with a 60s bound,
lifecycle-busy guard, lock-contention error parsing, drain-aware stop; settings-change
handling (§4.1); teardown (§7.9).

**Stream C — panel (renderer).** Rail item; header with instance identity, environment,
status pill, freshness, manual refresh, and the daemon Start/Stop control; **active runs**
view; the MVP subset of the state matrix (§8.4): not configured (with inline picker),
invalid root, decommissioned root, binary not found, auth required, daemon not running,
daemon-control-off with the §8.6 enable affordance, starting, start failed, ready, degraded,
stopping/draining, port-owned-by-someone-else. Theme tokens throughout (§8.4).

**MVP consumes exactly four endpoints** — `/readyz`, `/api/v1/health`, `/api/v1/instance`,
and `GET /api/v1/runs?phase=running&orderByActivity=true&limit=N`. The last one returns
`RunSummary` with `operator` already embedded, so **the active-run view needs no second
fetch per run**. Per active run, show: workflow, gaggle, current stage, issue → PR,
duration, heartbeat age, `stale`, and the blockers/limitations split (§5.2).

Concurrency is user-configurable and unbounded from our side (§8.7), so the query carries an
explicit `limit` and the view handles truncation honestly — see §8.7 for the rule.

> **Updates: poll every 5s in MVP; SSE lands in Phase 2.** This is not a shortcut that gets
> thrown away — §7.3 requires a polling path *anyway* as the permanent degraded-mode
> fallback, so MVP builds a component the finished system needs. Polling a loopback daemon
> for a bounded, `limit`-capped list of running runs costs nothing. It keeps the most intricate main-process
> work in the spec — SSE frame parsing, `Last-Event-ID` resume, and the four cursor-refusal
> paths (§7.2) — off the critical path to a plugin you can actually use. SSE earns its
> keep in Phase 2, when targeted invalidation starts beating "refetch everything."

**Acceptance:**
- Rail item appears with no project open (proves app scope works), and does **not** appear
  on Windows (§7.8).
- **A user who has never edited a JSON file can configure the instance root** — from the
  settings view and from the panel's empty state, both using the directory picker (§4.1).
- With the experimental flag **off**, the main-process service performs no I/O: no root
  validation, no file watcher, no poll (§7.7). With the panel closed, the 5s poll stops.
- Pointing at a directory without `instance.yaml` produces a clear, specific error; a valid
  root reports its `.instance-id`.
- An unresolvable `binaryPath` disables daemon control with a specific message and does not
  break monitoring of an already-running daemon.
- Against the reference instance with the daemon **down**: shows the "Daemon not running"
  screen with correct instance name and root identity, and **does not** report running
  despite `up.lock` recording pid 7027.
- **Start works, and the daemon it starts has the login-shell environment** — verified by a
  `local-ci` stage that fails under a bare Electron PATH and passes here, and pinned by a
  unit test asserting the spawn receives `getShellEnvironment()` (§11). *(Most likely
  criterion to be skipped; the failure mode is silent. Do not sign off without it.)*
- **A start that fails shows why.** Point at a root with a broken `instance.yaml`: the panel
  surfaces the daemon's own stderr, not "failed to start", and does not sit on "Starting…"
  past 60s.
- **Double-clicking Start produces one `goobers up`**, not two racing for the lock.
- **Daemon control is discoverable with `manageDaemon` off** — the not-running screen offers
  to enable it inline, with hazards shown (§8.6).
- Deleting `scheduler/api.address` mid-read, or catching it half-written during a start,
  does not flap the UI to "not running" (§4.3).
- **Stop shows "draining" until liveness is actually gone** — never "stopped" on exit 0
  alone (§7.5).
- Starting when already running surfaces the holder kind (`daemon` vs `manual`) rather than
  a generic failure.
- With the daemon **up**: instance status and active runs render; a run starting or
  finishing elsewhere is reflected within ~5s.
- **The active-run view is correct at 0, 1, and many.** Zero active runs on a healthy daemon
  reads as a resting state, not an error; a fixture with more runs than fit on screen
  scrolls, and the header ratio tracks `instance.concurrency` rather than any hardcoded cap
  (§8.7). Test with `maxParallelRuns` set well above the reference instance's 3.
- Killing the daemon mid-session degrades to the "not running" screen and recovers
  automatically when it returns.
- A second service on the API port (wrong `instanceRoot`) is refused, not rendered.
- All §11 tests present and passing; no new `TODO(TC-CRIT-03)`.

### Phase 2 — History and detail

**Deliverables:** SSE stream with resume and all four refusal paths, replacing the 5s poll
(which stays as the degraded fallback); run list over full history with default filters and
cursor pagination; run detail pane (timeline, stage attempts, escalation/terminal cause);
gaggle list as a run-list filter; rail badge (§8.3); cancel run; open run folder
(`/reveal`, loopback-only); "Find my instance" auto-detect (§4.2).
**Acceptance:**
- A run starting elsewhere updates the list within ~1s with no polling.
- Stream loss degrades within `streamIdleTimeoutMs` and recovers automatically.
- All four cursor-refusal responses are handled distinctly (§7.2).
- Cancel transitions the run to `aborted` and releases its claim.
- **Badge returns to zero after viewing and stays there** until something genuinely new
  escalates or fails (§8.3). If it can't, drop the failure term.

### Phase 3 — Depth (scope on demand)
Workflow graph rendering driven by `transitions[]` only; telemetry/cost views
(`/telemetry/costs`, `/stats`); trigger a workflow run with an explicit
spend-acknowledging confirm; escalation resolution *if and when* upstream #466/#468 ship
real gate wiring; artifact/transcript viewing; gaggle detail with workflow schedules (§8.2);
standalone offline reads via a `goobers dashboard` sidecar (D14).

---

## 13. Decisions made, and what still needs you

### Decisions I made (with rationale — push back on any of these)

| # | Decision | Why |
|---|---|---|
| D1 | Main-process service, not a plugin-only implementation | Forced: CSP + no network API (§2.1) |
| D2 | `scope: 'app'`, `railItem` only, no project tab | The instance is machine-level; a project tab would imply a per-project binding that does not exist |
| D3 | Native panel, not a webview onto the Goobers portal | No second child process; real Clubhouse integration (§3.1) |
| D4 | Direct HTTP to the daemon; no `goobers dashboard` sidecar in v1 | One fewer process and port; sidecar deferred to Phase 3 |
| D5 | Config in `settings-definitions.ts`, not plugin storage | The service reads it before any plugin exists (§4.1) |
| D6 | ~~Read-only first; control in Phase 2~~ **Superseded by D19** | Original reasoning was that the read path carries no blast radius. Correct about risk, wrong about product: a rail widget that cannot start the thing it monitors isn't worth opening. |
| D7 | No trigger-run button in v1 | It spends real money; deserves its own deliberate confirm design |
| D8 | No approve/override/rerun | Upstream calls them deliberate stubs; buttons would be lies |
| D9 | Liveness by address-file + `/readyz` + identity match, not flock | No native dep; identity check defeats the port-squatting hazard (§7.4) |
| D10 | Ship behind an experimental flag | Matches `agent-queue`; lets us land incrementally |
| D11 | Vendor the portal's TS types | Only complete contract that exists; no OpenAPI |
| D12 | Daemon is **not** killed when Clubhouse quits | It is an independent system; killing it would abort in-flight agentic runs |

### Resolved in review — 2026-09-15

All six open UX questions are settled. No blocking unknowns remain; the spec is
implementable as written.

| # | Question | Resolution |
|---|---|---|
| D13 | Daemon start/stop from Clubhouse? | **Yes, behind `manageDaemon`, default off.** Capability exists; a user who never opens settings cannot launch a badly-provisioned daemon. The login-shell spawn (§7.5) remains a hard gate before this can ever default on. |
| D14 | Read history with the daemon down? | **No in v1 — Phase 3 as specced.** v1 shows an actionable "daemon not running" screen. The `goobers dashboard` standalone sidecar stays on the roadmap; promote it if browsing history while stopped turns out to matter in practice. |
| D15 | Rail badge semantics | **Attention only** — escalations plus failures since last view. Never active-run count. Carries a Phase 1 acceptance check that it returns to zero (§8.3). |
| D16 | Run list ↔ run detail | **Master–detail**, as sketched in §8.2. Detail is a pane under the list; no navigation, no back stack. Watch the vertical budget — timeline, stage attempts, and operator diagnostics all have to fit. |
| D17 | Gaggle depth in v1 | **Filter only.** No gaggle page, no workflow list, no schedule display (§8.2). |
| D18 | Rail label | **"Goobers"** — the product's real name, matching what you'd type at a terminal when something breaks. |
| D19 | MVP = status + daemon start/stop + active runs. History, run detail, and SSE move to Phase 2. | Supersedes D6. Daemon control is what makes the widget worth opening; run *history* is not. Cuts the largest and most intricate pieces (full run list, detail pane, SSE) out of the first release without cutting anything a daily user needs. |
| D20 | MVP polls every 5s; SSE in Phase 2 | The polling path is required regardless as the permanent degraded fallback (§7.3), so it is not throwaway work. Keeps SSE frame parsing, resume, and four cursor-refusal paths off the critical path to a usable plugin. |

### Gap review — 2026-09-16

A pass over the spec against the actual codebase. Four of these were claims the spec made
that the code does not support; the rest were unspecified paths that Phase 1 would have hit
on day one.

| # | Decision | Why |
|---|---|---|
| D21 | **The settings UI is hand-written `GoobersSettingsView`, in Stream A.** | §4.1's "free Browse button" was wrong: `SettingsDefinition` has no `type` field, and `type: 'directory'` belongs to *plugin* settings — the thing §4.1 correctly ruled out. As written, MVP shipped a setting with no UI and no way to configure the root. The precedent is `EditorSettingsView.tsx`. |
| D22 | **The service is idle until a renderer subscribes; the poll is visibility-aware.** | `ExperimentalFlags` is renderer-only and never reaches main (§2.5), so flag-gating gated the plugin, not the service. Without this, flag-off users get a file watcher and a 5s poll they never asked for. Cheaper than plumbing the flag into main. |
| D23 | **v1 is macOS/Linux; the rail item is not contributed on Windows.** | The app ships signed Windows builds and §7.5 needs a login shell. "Unsupported and honest" beats "present and broken". |
| D24 | **Spawn with `execFile` argv + `getShellEnvironment()`, never a shell string.** | Core already solved this (`src/main/util/shell.ts`, §2.7). Reuse makes the §7.5 hard criterion unit-testable and deletes the §10.6 quoting hazard rather than mitigating it. |
| D25 | **Start succeeds by observation, with stderr captured and a 60s bound.** | A detached spawn's exit code says nothing, and the most common failure — a config error on stderr — was invisible. "Starting…" forever was the specced behavior. |
| D26 | **Phase 1 manifest drops `badges` and `notifications`.** | The badge is Phase 2 (§8.3) and MVP notifies nothing, but §11 pins the permission set exactly — granting unused capability would have been baked into the test that claims to prevent it. |
| D27 | **Binary-not-found and auth-required are first-class states.** | §10.1 and §10.6 both assumed handling that the state matrix never provided a screen for. Binary-not-found is the likeliest real failure of the Start button. |
| D28 | **`api.address` is parsed defensively; unparseable ≠ not running.** | The daemon writes the file live at readiness, so an empty or half-written read is a real race — one that would have flapped the UI between states during every start. |

**Consequence of D16 worth watching during implementation:** the detail pane is the tightest
real estate in the design, and §5.2 asks it to carry the operator block, the
blockers/limitations split, the event timeline, and stage attempts. If it gets cramped, the
first thing to give is the timeline — make it scroll within the pane rather than expanding
it. Do not solve crowding by dropping `diagnosticsLimitations`; that split is load-bearing
(§5.2).

---

## 14. Appendix: reference

### 14.1 Endpoints this feature uses

| Method | Path | Phase |
|---|---|---|
| GET | `/readyz` | **1** — liveness; unauthenticated, outside the auth pipeline |
| GET | `/api/v1/health` | **1** |
| GET | `/api/v1/instance` | **1** |
| GET | `/api/v1/runs?phase=running&orderByActivity=true` | **1** — `operator` is embedded, so no second fetch |
| GET | `/api/v1/events` | 2 (SSE) |
| GET | `/api/v1/runs` (full history, filters, cursor) | 2 |
| GET | `/api/v1/runs/{run}` | 2 |
| GET | `/api/v1/runs/{run}/events` | 2 |
| GET | `/api/v1/runs/{run}/stages/{stage}/attempts` | 2 |
| GET | `/api/v1/gaggles` | 2 |
| POST | `/api/v1/runs/{run}/cancel` | 2 |
| POST | `/api/v1/runs/{run}/reveal` | 2 |
| GET | `/api/v1/portal/config` | 2 (capability gating: `revealRun`, `workflowEnable`) |
| GET | `/api/v1/gaggles/{gaggle}/workflows` | 3 |
| GET | `/api/v1/telemetry/costs`, `/stats` | 3 |
| POST | `/api/v1/triggers` | 3 |

MVP is four endpoints. Daemon start/stop is not an endpoint — it is `goobers up` / `goobers
down` as subprocesses (§7.5).

Server budgets: bounded reads 8s, blobs 60s, mutations 8s, stream 0. All non-stream budgets
sit below our 10s client timeout deliberately, so a slow server returns a 503 we can act on
rather than racing our own abort.

### 14.2 Instance files we read (never write)

| Path | Use |
|---|---|
| `<root>/instance.yaml` | root validation; `api.listen` fallback |
| `<root>/.instance-id` | durable root identity (**this one**) |
| `<root>/instance-id` | runtime engine ID — **do not use** |
| `<root>/.instance-decommissioned` | historical-root check |
| `<root>/scheduler/api.address` | authoritative API address; presence ⇒ ready |
| `<root>/scheduler/up.lock` | display metadata only — never liveness |
| `<root>/updates/stop-request` | written **only** by `goobers down` |

### 14.3 Clubhouse files this feature touches

**New:** `src/shared/goobers-api-types.ts`, `src/shared/goobers-types.ts`,
`src/main/services/goobers-service.ts` (+test), `src/main/services/goobers-daemon.ts`
(+test), `src/main/ipc/goobers-handlers.ts` (+test), `src/preload/goobers.ts`,
`src/renderer/stores/goobersStore.ts`, `src/renderer/plugins/builtin/goobers/{manifest,main}.ts`
(+tests), `src/renderer/features/settings/GoobersSettingsView.tsx` (+test — D21).

**Modified:** `src/shared/ipc-channels.ts`, `src/shared/settings-definitions.ts`,
`src/shared/types.ts` (the `GoobersSettings` shape), `src/main/ipc/index.ts` (+test),
`src/preload/index.ts` (+test), `src/shared/ipc-channel-sync.test.ts`,
`src/renderer/plugins/builtin/index.ts`,
`src/renderer/plugins/builtin/builtin-plugin-testing.test.ts`,
`src/renderer/features/settings/ExperimentalSettingsView.tsx`,
`src/renderer/panels/MainContentView.tsx` (route the settings sub-page).

**Reused, not rebuilt:** `src/main/util/shell.ts` (`getShellEnvironment`, §2.7).

**Deliberately NOT modified:** `src/main/services/plugin-manifest-registry.ts` — only needed
for `allowedCommands`, which this plugin does not declare. If a patch adds it there, the
plugin has acquired `process` permission and needs re-review.

### 14.4 Reference instance snapshot (2026-09-15)

`goobers-local`, env `dev`, root `/Users/cazzone/Repos/goobers-instance`, root identity
`eaf74575d8de50fa5471027ba7fd15cb`. API defaults (127.0.0.1:8080, no auth, no TLS).
`maxParallelRuns: 3`. Binary `portal-v0.1.0-21-ga1b2ae99`, matching the daemon's last
self-report. **Daemon not running**; `up.lock` unlocked with stale pid 7027.

| Gaggle | Repo | Workflows | Schedules |
|---|---|---|---|
| `clubhouse` | `Agent-Clubhouse/Clubhouse` | 4 | all cron — the only active gaggle |
| `goobers-repo` | `Agent-Clubhouse/Goobers` | 6 | 5 manual, 1 cron |
| `game-sim-gaggle` | `C-Azzone416/tabletop-sim` | 7 | all manual, dormant |

`read.db` 54 MiB, ready, epoch `9f5a1f77…`: 5,097 runs, 13,317 stages, 31,586 change rows.
Failure-heavy — `clubhouse-merge-review` 1,085 failed / 961 completed, none completed since
2026-09-11.
