# Clubhouse Telemetry Export: OpenTelemetry Instrumentation Spec

| | |
|---|---|
| **Status** | Draft for review (scoping/design only, no implementation). Revision 2 records the maintainer's decisions (§10.1) and adds regression-informed priorities (§12). Revision 4 (2026-10-16) follows code changes since: [#1930](https://github.com/Agent-Clubhouse/Clubhouse/pull/1930) removed the Assistant, Agent Queue and Sessions features, [#1915](https://github.com/Agent-Clubhouse/Clubhouse/pull/1915) removed the Hub plugin, and structured mode is removed in favour of native chat ([#1937](https://github.com/Agent-Clubhouse/Clubhouse/pull/1937)) ([#1916](https://github.com/Agent-Clubhouse/Clubhouse/pull/1916)). Their coverage is dropped or moved to chat; §12 keeps them as history. |
| **Date** | 2026-10-16 |
| **Target** | Clubhouse 0.43+ (Electron 43, Node ≥ 22) |
| **Supersedes** | [`docs/telemetry-design/`](telemetry-design/01-overview.md) (June 2026 log-subscriber plugin design) |

## 0. Summary

Clubhouse gets an **opt-in, user-configured telemetry export**. Telemetry is off by default.

A user creates their own Azure Application Insights resource and pastes its **connection string** into Settings → Logging → Telemetry export. Clubhouse then sends traces, metrics and sanitized error records to that resource, to an OpenTelemetry (OTLP) backend, or to both at once (§6.11). No ingestion key ships in the binary. The one developer-run destination is opt-in and narrow: with Feedback connected and its host confirmed, a copy of **user activity and errors only** can go to the Clubhouse developer's Framebriar service, so feedback reports have context. It is set up on Settings → Feedback and works on its own once the user consents and confirms its host (§6.11, #2097). Ingestion with only an instrumentation key was retired in 2025, so the connection string is the only supported input.

App Insights is the default and simplest destination: one field. For the minority who run another backend, the same Settings section offers **Other (OTLP)**: an HTTPS endpoint plus headers, sent as OTLP over HTTP/JSON (§6.8).

How it works:

- It is built on **OpenTelemetry (OTel)**, set up manually in the **main process only**. The renderer forwards to main over IPC. The exporter is `@azure/monitor-opentelemetry-exporter` by default, or the OTLP/HTTP-JSON exporters when the user picks Other (OTLP). Both ship from Phase 1.
- Coverage follows **user flows**, not existing log lines. Each important flow (startup, agent spawn → run → exit, permission round trip, project switch, plugin activation, update, Annex connect, …) gets a span tree, a small set of metrics and classified error records. The existing `appLog` stream is not mirrored. It bridges in only where a call site opts in (§6.6).
- **Privacy is enforced in code, not by convention.** A typed attribute registry is an allowlist. A redaction processor drops anything outside it before export. Prompts, terminal output, file contents, paths, and repo, branch, project and agent names are never sent. Identifiers are HMAC-hashed with a per-install salt.
- **Community plugins can send telemetry** through a permissioned `api.telemetry` namespace. It is held to the same allowlist and privacy rules, rate-limited, and switched on per plugin by the user (§6.9).
- **Coverage is weighted by regression history.** 455 fix and revert commits and about 356 closed issues since 2026-03-01 (the churn peak) cluster into 14 hot spots and 4 cross-cutting patterns. Each hot spot is mapped to the signals that would have caught it, marked P0/P1/P2, and labelled as a current or superseded code path (§12).
- **A Clubhouse Workbook ships** for App Insights users: a ready-made dashboard and optional alerts built from the coverage map (§6.10).

The estimate is **8 PR-sized phases**, about 5,000–6,500 lines of production code plus tests. Phases 1–3 alone give a useful product: errors, startup, update, persistence integrity and session health. See §9.

How this differs from the June 2026 design in `docs/telemetry-design/`:

| June 2026 design | This spec | Why |
|---|---|---|
| Built-in ingestion key, maintainers' resource | **User's own destinations**; no key ships. The only developer-run destination is Framebriar, opt-in through Feedback, user activity and errors only (§6.11) | Decided by the maintainer: self-configured; the developer gets context for feedback only with the user's consent |
| `applicationinsights` SDK `trackEvent` | **OTel API + SDK, Azure Monitor exporter by default, OTLP as an alternative** | Vendor-neutral; OTLP is one exporter swap |
| Subscribe to `appLog` and filter by namespace tier | **Flow-based instrumentation**; `appLog` bridge only for opt-in call sites | The logs are 99% two debug/info namespaces (§2.2) and carry sensitive meta (§2.3) |
| In-memory ring only, drop when offline | Exporter's bounded disk retry plus a cap | Laptops go offline; user-owned data |
| Built-in plugin gated by an experimental flag | Core service plus a Settings → Logging section | Needs main-process hooks at startup and in crash handlers, before plugins load |

The data-classification ideas from that design are carried forward: the never-collect list, path scrubbing and error-type-only exceptions.

---

## 1. Goals, non-goals and principles

### Goals

1. A user can see in their own App Insights resource:
   - whether Clubhouse is healthy (crashes, error rates, startup time, update success);
   - how their agents behave (spawn latency, run duration, exit classes, permission wait time, tool-call volume);
   - where the app is slow (project switch, plugin activation, git operations, canvas load).
2. Every important flow is covered by the right signal:
   - a **trace** where there is a duration with sub-steps;
   - a **metric** where there is volume;
   - a **log or exception record** where there is a discrete failure.
3. With telemetry disabled the cost is zero: the SDK is not loaded and hot paths are untouched.
4. A user can audit exactly what is sent before and after they enable it.

### Non-goals (v1)

- Maintainer-run aggregate telemetry collected without the user's opt-in. The only developer-run destination is Framebriar (§6.11): it receives user activity and errors only, and only while Feedback is connected, the user has consented and its host is confirmed. It doesn't need one of the user's own destinations on (#2097).
- Auto-instrumentation of `http`, `fs` or `child_process`.
- Session replay, UI click tracking or per-keystroke anything.
- Microsoft Entra ID (AAD) ingestion auth. Resources with `DisableLocalAuth=true` reject connection-string ingestion; see §10 for the follow-up.
- Instrumenting the Annex iOS app. It is not Clubhouse code; see §7.
- Remote configuration or a server-side kill switch. Nothing phones home.
- OTLP over gRPC or protobuf, and plain-HTTP OTLP endpoints other than a collector on this computer (loopback).
- Build-time and CI failures such as code signing (#1836, #1838, #1846) and visual or theme regressions. Telemetry cannot see these; CI and E2E are the right tools (§12.3).

### Principles

- **P1. Allowlist, never blocklist.** Only attribute keys declared in the registry (§5) leave the process. Unknown keys are dropped, and so are values that fail their validator.
- **P2. No free text.** No user-authored or tool-generated string is exported: prompts, missions, terminal output, file contents, tool input and output, stderr, commit messages, error messages. Strings are only enums, bucketed values, versions or hashes.
- **P3. No paths, no names.** File paths, cwd, repo URLs, branch names, project, agent and canvas names, hostnames, plugin names from custom marketplaces and custom marketplace URLs are never exported, not even as hashes of paths. The `*.id_hash` attributes hash opaque internal IDs, never names or paths.
- **P4. Spans for flows, metrics for volume.** Nothing on a per-chunk, per-keystroke, per-poll or per-hook-event path creates a span or log record by default.
- **P5. The user owns the switch.** Off by default. There is a single kill switch that unloads the SDK, a preview of what will be sent, and a test-event button.

---

## 2. What the local logs tell us

The source is `~/.clubhouse/logs/session-*.jsonl` on the maintainer's machine: 49,730 lines from 2026-10-07 to 2026-10-16, Clubhouse 0.42 beta. This is **one user's usage**. It is used to find hot paths and gaps, not to define coverage.

### 2.1 Volume by namespace

| Namespace | Lines | Share | Notes |
|---|---:|---:|---|
| `core:hook-server` | 27,763 | 55.8% | "Hook event received" for every hook event: `pre_tool` 13,187, `post_tool` 12,815, `stop` 782, `notification` 607, `tool_error` 366. Logged at **info**. |
| `ui:terminal:scroll` | 21,343 | 42.9% | Debug "PTY data write (local)" per write: 21,095 lines |
| `update:check` | 128 | 0.3% | Every 4 h plus startup; 5 failures where both manifests were unavailable |
| `core:agent-config` | 103 | | Load/write agents |
| `marketplace`, `marketplace:updates` | 155 | | Registry fetch and update checks; 5 `fetch failed` |
| `core:annex-client` | 80 | | 31 warn + 7 error: identity request errors, WS errors, heartbeat timeouts |
| everything else | ~160 | | `core:agent` (13), `core:pty` (7), `core:mcp` (26), `core:permission-queue` (10), … |

Takeaways:

1. **Hook events are the highest-volume real signal** in the app: about 2,700/day here, one tool call ≈ 2 events. They must become **metrics**, such as `clubhouse.agent.tool_calls` by tool bucket and outcome. They must not become log records. If telemetry bridged `appLog`, 56% of exported records would be this one line.
2. **Terminal writes are a pure hot path** (P4). They are never instrumented, not even as metrics. A per-agent byte count is attached to the agent run span when it ends.
3. **Warnings and errors cluster in networked subsystems:** Annex client (38), update check (15), marketplace (5), permission queue "stuck pending" (8). These are exactly the flows that get spans with classified `error.type` values (§4.4, §4.8, §4.6).
4. **The two `fatal` entries are both `uncaughtException: send EADDRNOTAVAIL 224.0.0.251`.** That is the mDNS multicast socket from `bonjour-service`, thrown with no handler. This is the class of bug telemetry exists to surface: a fatal-level crash with no user-visible symptom. It is filed as a finding in §11.

### 2.2 Flows with no or almost no logging today

The code survey (§4) found many important flows with **no logging at all**, which shows why porting logs would give poor coverage:

| Area | What is missing |
|---|---|
| Startup | Window creation, `ready-to-show`, `did-fail-load`, shell pre-warm, ripgrep init. **There is no renderer → main "ready" signal.** |
| Crash handling | `render-process-gone`, `child-process-gone`, `unresponsive`; renderer `window.onerror` and `unhandledrejection`; an app-level React error boundary. Only `PluginErrorBoundary` exists. |
| Agents | Durable-create success; renderer agent slices (no `rendererLog` calls); mode-selection decision for headless/PTY; binary-lookup duration; `gracefulKill` escalation stages; `broadcastAgentExit`; queue enqueue/cancel; structured `sendMessage`, `respondToPermission`, cancel. |
| Quick agents | In the 10 days of logs there is not one "Spawning quick agent" line. Quick spawns are renderer-driven and unlogged. |
| Projects | Add, remove, update, reorder; the project switch effect (`App.tsx:132`). |
| Git | Successes, all user operations; the only `core:git` call is a generic failure warning. |
| Files and search | File-watch service (one `console.warn`); search service (no rg-missing log, no timing); editor open/save failures (swallowed into UI state). |
| Canvas | `saveCanvas` / `saveWires` are fire-and-forget. Write failures become unhandled rejections in the renderer with no handler. |
| Goobers | No `appLog` calls anywhere in `goobers-*.ts`. |
| MCP | Tool-call latency; binding-manager changes. |

### 2.3 Sensitive data already in local logs (and why we never bridge wholesale)

Today's `meta` bags contain values that P1–P3 forbid:

| Where | What leaks |
|---|---|
| `agent-system.ts:462` (`core:agent`) | Full `args`, which include **the mission and system prompt** |
| `headless-manager.ts:540` | Full `args`, which include **`-p <mission>`** |
| `acp-client.ts:103`, `codex-app-server-client.ts:60` | RPC params, which include **prompt text** |
| `core:pty` exit | `lastOutput`: the last 500 characters of terminal output |
| `core:headless` | First 200 characters of stdout |
| `core:agent-config`, `core:project-store`, `core:config-pipeline` | `projectPath`, `configPath`, `filePath` |
| `core:annex-client` | `host`, `alias` (defaults to hostname), `fingerprint` |
| `core:process` | `error` and `stack`, which contain home-directory paths |

These are fine on local disk (the user's own machine) but they confirm the decision. **The telemetry layer never reads `meta` generically.** See §11 for a related finding: prompts in local logs are worth fixing anyway.

---

## 3. Signal model

### 3.1 When to use which signal

| Situation | Signal | Example |
|---|---|---|
| A user-perceived operation with a duration and sub-steps | **Trace**: a root span plus child spans | `agent.spawn` → `provider.check_availability`, `agent.materialize`, `pty.spawn` |
| A long-lived lifecycle that must not keep a span open for hours | **Short spans at the edges plus a duration metric**, linked by `agent.run.id_hash` | `agent.run` start/end events plus `clubhouse.agent.run.duration` |
| High-frequency activity | **Counter or histogram** only | tool calls, PTY bytes, hook events, git status polls |
| A discrete failure | **Exception record** (span event or log record with `exception.*`) with an `error.type` from a closed set | `update.download` integrity mismatch |
| A discrete product event without duration | **Event log record**: a log record with `event.name`, which lands in App Insights `customEvents` | `settings.telemetry.enabled`, `onboarding.completed` |
| State at a moment in time | **Snapshot event** at startup and at most daily | `app.config_snapshot` with theme kind, project count, enabled built-ins |

### 3.2 Conventions

- **Span names** use `clubhouse.<area>.<operation>` in lower snake case, for example `clubhouse.agent.spawn`. Names are static strings, never interpolated.
- **Root user-flow spans use `SpanKind.SERVER`.** Children use `INTERNAL`. The Azure exporter maps SERVER/CONSUMER spans to the App Insights `requests` table and everything else to `dependencies`. Making flow roots "requests" lights up the Performance and Failures blades and gives `operation_Name` = flow name. This is a deliberate, documented misuse of SERVER for desktop "operations".
- **Durations:**
  - Metric durations use seconds (`s`) per OTel semantic conventions.
  - Byte counts use `By`.
  - Counts use `{thing}` annotations.
- **Error classification** uses the semconv attribute `error.type`, always with a **closed enum** per flow (listed in §4). Span status is `ERROR` only when the flow failed from the user's point of view. Expected outcomes such as user cancel or deny set `clubhouse.outcome`, not `ERROR`.
- **Outcome:** every root span ends with `clubhouse.outcome ∈ {ok, error, cancelled, timeout, skipped}`, plus a flow-specific `*.result` enum where useful.
- **Percentiles come from spans, not histograms.** The Azure exporter sends histogram metrics to `customMetrics` as count/sum/min/max, so they have no buckets and no percentiles. p50/p95 come from `requests`/`dependencies` `duration` via KQL `percentile()`. Histograms are still recorded for averages and cheap dashboards; with the OTLP destination they keep their buckets, so backends that support it get real percentiles. Every latency that needs percentiles must therefore be a span, unsampled for its flow (§6.4).

### 3.3 Telemetry levels (user-selectable)

| Level | Exceptions and crash events | Lifecycle and flow traces | Metrics | High-volume detail (tool-call spans, IPC latency spans, per-route Annex spans) |
|---|---|---|---|---|
| **Off** (default) | — | — | — | — |
| **Errors** | ✓ | only spans that end in error (tail decision, §6.4) | health counters only | — |
| **Standard** | ✓ | ✓ | ✓ | — |
| **Detailed** | ✓ | ✓ | ✓ | ✓ |

The level is the main volume and cost control. Every instrument and span in §4 is tagged with its minimum level.

**Decision (2026-10-16): the separate Errors level stays.** Errors suits users who only want crash and failure reporting at minimal cost and minimal data. It costs nothing to implement: the `FlowSampler` already needs the tail decision for error-only traces.

Two further rules apply across levels:

- Regression-informed **P0 signals** (§12) are tagged level E or S, never D, so Standard always covers them.
- Community plugin telemetry (§6.9) follows the same levels: plugin exceptions are sent at Errors and above, plugin events, spans and metrics at Standard and above.

---

## 4. Coverage map by flow

Each subsection lists the **spans** (with boundaries in code), **metrics**, **errors** (the `error.type` enum) and **level**. Flows marked P0 in §12 (regression history) take precedence when phases are cut.

- File references are to `src/` as of `f4451aaa`.
- Attribute names refer to the registry in §5. `c.` is shorthand for `clubhouse.`.
- Level codes: E = Errors, S = Standard, D = Detailed.

### 4.1 App lifecycle: startup, shutdown, windows

**Spans**

| Span | Start → end | Children | Level |
|---|---|---|---|
| `c.app.startup` (root, SERVER) | Module load in `main/index.ts`. Record `performance.timeOrigin`; backdate the span start to process start using `process.hrtime` relative to `performance.timeOrigin`. **End:** the new `telemetry:renderer-ready` IPC, sent by the renderer after `initApp()` resolves. | `c.app.startup.main_ready` (module load → `app.on('ready')`); `c.app.startup.register_ipc` (`registerAllHandlers`, `index.ts:199`); `c.app.startup.safe_mode_check` (`:227`); `c.app.startup.create_window` (`createWindow` → `ready-to-show`); `c.app.startup.renderer_init`, carried from the renderer (§6.2), with children `load_settings` (`app-initializer.ts:38`) and `plugin_system` (`plugin-loader.ts:234`). Fire-and-forget services such as hook server, MCP bridge and Annex get their own short spans parented to startup but do not gate its end. | S |
| `c.app.shutdown` (root) | `before-quit` first pass (`shutdown-guard.ts:38`) → `appQuit` | One child per cleanup in `shutdown-guard.ts:43-50`: `pty.kill_all`, `agent_config.flush`, `group_project.flush`, `queue.flush`, `update.apply_on_quit` | S |
| `c.window.create` | `CREATE_POPOUT` (`window-handlers.ts:163`) → `ready-to-show` | — | S |

**Metrics**

| Name | Kind / unit | Attributes | Level |
|---|---|---|---|
| `c.app.startup.duration` | histogram, s | `c.startup.kind` (`cold`/`after_update`/`safe_mode`) | S |
| `c.app.sessions` | counter | `c.startup.kind` | E |
| `c.app.session.duration` | histogram, s; recorded at shutdown | `c.shutdown.kind` (`clean`/`update_restart`/`restart`) | S |
| `c.app.shutdown.duration` | histogram, s | — | S |
| `c.app.unclean_exits` | counter, recorded on next startup | `c.shutdown.previous` (`unknown_exit`/`crash_loop`) | E |
| `c.window.relay.timeouts` | counter | `c.relay.kind` (`agent_state`/`canvas`; the Hub relay went with the Hub plugin in #1915) | S |
| `c.window.popouts` | counter | `c.popout.type` (`agent`/`canvas`) | S |

**Detecting unclean exits.** Write `telemetry/last-session.json` at startup containing `{session_id, started_at}`. Mark it clean in `c.app.shutdown`. If it is still unmarked at the next startup, emit `c.app.unclean_exit`. This is cheap crash detection without `crashReporter`. An OS shutdown, restart or logoff is marked clean too, with `exit: "os_shutdown"` instead of `"quit"`. Windows sends no `before-quit` then and may end the process right after `session-end`, so that path writes the marker, the local recording and the log buffer synchronously (#2335).

**Events**

- `c.app.config_snapshot`: once per startup, after settings load, and at most once per 24 h. Attributes are in §5.4.
- `c.app.safe_mode`: `c.safe_mode.trigger ∈ {crash_loop_detected, user_chosen, cli_flag}`, from `safe-mode.ts:55,68,79`. Level E.

**Errors.** `error.type` on startup children takes one of `settings_load_failed`, `plugin_system_failed`, `window_load_failed` (`did-fail-load`, which is new), `ipc_register_failed`.

### 4.2 Crashes and unhandled errors (all level E)

| Source | Hook (new unless noted) | Record |
|---|---|---|
| Main `uncaughtException` | `index.ts:90` (exists; add the telemetry call) | exception record, `c.error.origin=main`, `c.error.handled=false`; force-flush with a 2 s timeout because the process may be unstable |
| Main `unhandledRejection` | `index.ts:95` (exists) | exception record, `origin=main` |
| Renderer crash | `webContents.on('render-process-gone')` on every window | event `c.renderer.gone` with `reason` (the Electron enum: `crashed`, `oom`, `killed`, `launch-failed`, …), `exitCode`, `c.window.kind` |
| Renderer hang | `BrowserWindow.on('unresponsive'/'responsive')` | span `c.renderer.unresponsive` (unresponsive → responsive); counter |
| GPU/utility crash | `app.on('child-process-gone')` | event with `type` and `reason` |
| Renderer uncaught error | `window.addEventListener('error')` in the renderer bootstrap | forwarded over IPC (§6.2), `origin=renderer` |
| Renderer unhandled rejection | `window.addEventListener('unhandledrejection')` | forwarded; this catches the canvas save rejections (§2.2) |
| React render error (app) | **New `AppErrorBoundary`** around `App`/`PopoutWindow` | forwarded, `c.error.boundary=app` |
| React render error (plugin) | `PluginErrorBoundary.componentDidCatch` (`PluginContentView.tsx:25`) | forwarded, `c.error.boundary=plugin`, `c.plugin.ref` |
| Plugin activation failure | `plugin-loader.ts:695` | see §4.10 |

**Exception record shape.** This applies to every exception in the spec.

- `exception.type`: the constructor name (`TypeError`, `Error`, `AbortError`, …). For Node system errors, append the code: `Error[EADDRNOTAVAIL]`.
- `exception.message`: **omitted.** A synthetic message is built instead as `${type} at ${top_app_frame}`. App Insights requires a message for exception items.
- `exception.stacktrace`: **sanitized frames only.**
  - Keep the function name.
  - Rewrite the file to a path relative to the app root, e.g. `app.asar/.webpack/main/index.js:1234:56` becomes `main/index.js:1234:56`.
  - Drop frames outside the app bundle, replaced with `<external>`.
  - Run the path scrubber (§5.3) over the whole result.
  - Bundled frames are only useful with source maps. Generating `.map` files at release time (not shipped) gives the user a symbolication path later; see the Phase 7 option.
- `c.error.fingerprint`: an HMAC of `type + top 3 sanitized frames`, for grouping. App Insights `problemId` grouping works from type and stack as well.

### 4.3 Auto-update (`main/services/auto-update-service.ts`)

| Span | Boundaries | Attributes | Level |
|---|---|---|---|
| `c.update.check` (root) | `checkForUpdates` `:577` → state set | `c.update.trigger` (`startup`/`periodic`/`manual`), `c.update.channel` (`stable`/`preview`), `c.update.result` (`up_to_date`/`available`/`dismissed`/`no_artifact`/`skipped_busy`/`disabled`), `c.retry.count` | S (E if failed) |
| ↳ `c.update.fetch_manifest` | `fetchJSON` `:384`, per channel | `http.response.status_code`, `error.type` | S |
| `c.update.download` (root) | `downloadUpdate` `:674` → ready/error | `c.update.result` (`downloaded`/`already_downloaded`), `c.size_bucket`, `c.retry.count` | S |
| ↳ `c.update.verify` | `verifySHA256` `:514` | — | S |
| `c.update.apply` (root) | `applyUpdate` `:925`. **Must end and flush before `app.exit`** at `:826`, `:852`, `:887`. | `c.update.apply.mode` (`relaunch`/`on_quit`), `os.type` | E/S |
| `c.update.session_resume` | `loadPendingResume` (`restart-session-service.ts:112`) → renderer `processResumeQueue` done | `c.resume.result` (`none`/`resumed`/`partial`/`discarded_version`/`discarded_stale`/`discarded_corrupt`), counts by per-agent status | S |

**Metrics.** `c.update.checks` counter (by `result`, `channel`), `c.update.failures` counter (by `phase`, `error.type`), `c.update.download.duration` histogram (s).

**`error.type` values:**
- network: `network_transient`, `network`
- HTTP: `http_4xx`, `http_5xx`
- `manifest_invalid`, `manifests_unavailable`, `integrity_mismatch`, `redirect_blocked`, `apply_spawn_failed`, `apply_failed`

**Post-update correlation.** At the next startup, `c.app.startup` carries `c.startup.kind=after_update` and `c.update.from_version`, both release versions, which are allowed. The "previous attempt failed" path at `:1256` emits `c.update.apply_detect_failed`.

### 4.4 Agents: create, spawn, run, exit

This is the most important flow tree. An agent's life is long, so it is modelled as **short spans at each edge plus metrics**, joined by a hashed run ID. Spans are not held open for hours.

```
c.agent.create            (durable only; root)
c.agent.spawn             (root; ends when process launched)
  ├─ c.provider.resolve
  ├─ c.provider.check_availability   [binary lookup tier, cache hit]
  ├─ c.agent.materialize             (durable + Clubhouse Mode)
  ├─ c.agent.prepare_pty             (PTY only; 3 parallel children)
  │    ├─ c.hooks.configure
  │    ├─ c.mcp.inject
  │    └─ c.provider.build_command
  └─ c.pty.spawn | c.headless.spawn | c.chat.start
c.agent.run               (root; spawn → exit, replayed at exit; carries the exit class)
c.agent.turn              (chat runtime; one per turn; mapped from the chat event bus, §9.1)
c.agent.permission        (root per permission request)
c.agent.kill              (root; user/system kill trigger; Phase 4b)
```

#### Create and delete (`ipc/agent-handlers.ts`)

Both flows start in the IPC handlers, so the git and config work below them (`agent-config.ts`) nests through the active context without that file knowing about the parent.

| Span | Children | Attributes / result | Level |
|---|---|---|---|
| `c.agent.create` | `c.git.worktree_create` (Phase 5, in `agent-config.ts`), `c.agent.persona_inject` | `c.agent.uses_worktree`, orchestrator; `error.type ∈ {worktree_failed, write_failed}`. A persona failure is non-fatal: the child span records it, the create stays `ok` | S |
| `c.agent.delete` | `c.git.worktree_remove` (Phase 5) | `c.agent.delete.mode` (`standard`/`commit_push`/`cleanup_branch`/`save_patch`/`force`/`unregister`); a throw or a result with `ok: false` is `error.type = delete_failed` (cancelling the save-patch dialog returns before the flow and is not recorded) | S |

Quick agents have no main-process create step. The renderer `spawnQuickAgent` (`agentLifecycleSlice.ts:25`) starts a renderer span `c.agent.quick_launch` that is propagated into `SPAWN_AGENT` (§6.2). That is how the renderer-side work (summary instruction fetch, template expansion) gets measured.

#### Spawn (`agent-system.ts:98`)

- **Boundaries:** `spawnAgent` entry to the process launched (after `AGENT_AWOKE`), or the throw. Recorded with `tel.flow` around the whole function; the children are `tel.step`s.
- **Children:** `c.provider.resolve`, `c.provider.check_availability`, `c.agent.materialize` (Clubhouse Mode, non-fatal), then for PTY `c.agent.prepare_pty` with its three parallel children (`c.hooks.configure`, `c.mcp.inject`, `c.provider.build_command`) and `c.pty.spawn`, or `c.headless.spawn` for headless. `c.chat.start` covers a chat start from the moment a driver and CLI are found (`tryStartChatAgent`'s `onStarting`) to started, fallen back or cancelled; a fallback to the terminal is `error.type = chat_start_failed`, a cancel is outcome `cancelled`, and spawns that were never chat record no chat span. Its attributes (#2304): `c.chat.start.result` (`chat`, `fallback` for chat on a lower driver, `terminal`, `cancelled`, `failed`), `c.chat.start.reason` (a closed set), the driver it ended on, `c.chat.drivers_tried`, `c.chat.check_ms`, `c.chat.session_start_ms`, `c.chat.cli_version.status`, `c.agent.resume`, `c.chat.resume_honored` and, for ACP, `c.chat.resume.load_ms` / `.first_reply_ms`. Each driver a start leaves, and a chat agent sent to the terminal before any driver was checked (no driver, binary missing), is a `c.chat.fallback` event (Standard) with the driver, `c.chat.fallback.to` (`driver` or `terminal`), the reason and a registered `error.type`; the reason's text stays in the local log. Turns and the rest of chat come from the chat event bus (§9.1). `provider.check_availability` matters most: it can run a **synchronous `execFileSync(shell -ilc which)` for up to 5 s on the main thread** (`orchestrators/shared.ts:100`), and Codex also runs `codex --version` on every spawn. The lookup tier is recorded on every lookup as `c.provider.binary_lookup.duration` (§4.4 metrics), not on the span.
- **Attributes:**
  - `c.agent.kind` (`durable`/`quick`/`companion`)
  - `c.orchestrator` (`claude-code`/`codex-cli`/`copilot-cli`/`other`)
  - `c.agent.runtime` (`pty`/`headless`/`chat`)
  - `c.chat.driver` (`claude_agent_sdk`/`claude_stream_json`/`codex_app_server`/`copilot_acp`/`acp` for other ACP agents, later `copilot_sdk`), from chat's capability record, added by the chat telemetry work (§9.1). Claude chat is designed to default to the Agent SDK, with raw `-p` stream-json as a second mode.
  - `c.agent.resume` (bool)
  - `c.model.family` (bucketed from the model string: `opus`/`sonnet`/`haiku`/`gpt-5`/`default`/`other`; the raw model is never sent)
  - `c.clubhouse_mode`, `c.mcp.enabled`, `c.hooks.enabled`, `c.profile.active`, `c.wrapper.applied` (all bool; each only once the spawn reached the step that decides it)
  - Not recorded: `c.agent.runtime.reason` (the fallback decision is implicit in the runtime) and per-agent hashed IDs on spawn spans.
- **`error.type`:** `orchestrator_unknown`, `preflight_failed` (CLI missing or unauthenticated), `cwd_invalid`, `pty_spawn_failed`, `headless_no_pid` (the span ends `error` though the call returns), `chat_start_failed`; `materialize_failed` on the non-fatal child only. Errors are typed with `tagError` / `withErrorType` at the throw site (§6.5); anything untagged is `unknown`.
- **Metrics:** `c.agent.spawns` (counter: kind, orchestrator, runtime, outcome, `error.type`) and `c.agent.spawn.duration` (histogram, s, successful spawns only).

#### Run, first output and readiness

`c.agent.run` (S, root) covers one PTY or headless process from spawn to exit. Nothing holds it open: `agent-telemetry.ts` keeps a small per-run record and **replays the span with explicit times when the run ends** (§6.5), so a run that never ends (app crash) is simply never exported, and a run lasting days costs nothing. The exit is folded into this span rather than a separate `c.agent.exit` span: it carries `c.agent.exit.class`, `process.exit.code` and, for killed runs, `c.kill.stage_reached`. Outcome is `error` for `failed`/`early_failure`, `ok` for `completed`, `cancelled` otherwise.

A run ends on `broadcastAgentExit` (`onAgentExit`), or directly where a session is removed without one: a hard kill (`pty-manager.ts` `kill()`) and the post-grace sweep in `killAll()` both end it as `killed_user` at `sigkill`. A respawn under the same agent ID ends the previous run as `replaced`.

There is no CLI "ready" signal. The proxies below are recorded as **histograms**, not span events, so they aggregate without span queries:

- `c.agent.time_to_shell_ready`: spawn → the PTY shell accepting the pending command (`flushPendingCommand`). PTY only.
- `c.agent.time_to_first_output`: spawn → the first data after the flush (PTY) or the first stdout chunk (headless). Chat maps its first assistant-text event later (§9.1).
- `c.agent.first_hook` is not recorded; `c.agent.hook_events` covers liveness for hook-capable providers.

**Metrics (level S)**

| Name | Kind / unit | Attributes |
|---|---|---|
| `c.agent.spawns` | counter | kind, orchestrator, runtime, `clubhouse.outcome` |
| `c.agent.spawn.duration` | histogram, s | kind, orchestrator, runtime |
| `c.agent.runs` | counter; one per ended run | orchestrator, runtime, `c.agent.exit.class` (kind joins in Phase 4b) |
| `c.agent.time_to_shell_ready` | histogram, s | orchestrator |
| `c.agent.time_to_first_output` | histogram, s | orchestrator, runtime |
| `c.agent.run.duration` | histogram, s | orchestrator, runtime, `c.agent.exit.class` (kind joins in Phase 4b) |
| `c.agent.kill.escalations` | counter; one per stage a kill escalates to. The stage a kill starts at (exit command for PTY, SIGTERM for headless, SIGKILL for a hard kill) is not counted | `c.kill.stage_reached` |
| `c.provider.binary_lookup.duration` | histogram, s; every `findBinaryInPath` call | `c.binary.lookup_tier` (`cache`/`well_known`/`path_scan`/`login_shell`/`not_found`) |
| `c.agent.active` | UpDownCounter (or observable gauge from `agentRegistry`) | kind, runtime |
| `c.pty.output.bytes` | counter, By; **incremented at exit from a per-session byte total, never per chunk** | orchestrator, runtime |
| `c.agent.tool_calls` | counter, fed from hook-server `pre_tool`/`post_tool`/`tool_error` and from chat/headless tool start and end events | orchestrator, `c.tool.bucket`, `c.tool.result` (`ok`/`error`) |
| `c.agent.hook_events` | counter | orchestrator, `c.hook.kind` (`pre_tool`/`post_tool`/`stop`/`notification`/`tool_error`/`permission_request`) |

**Tool name bucketing.** `c.tool.bucket` reports the provider's built-in tool name, from a static list per orchestrator: `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`, `Agent`, …. Otherwise it reports `mcp_clubhouse`, `mcp_other` or `other`. **MCP tool names are never sent**: they embed server names and hashes, and are user-defined.

**Tool-call spans (level D only).** A span `c.agent.tool_call` pairs `pre_tool` with `post_tool`/`tool_error`, matched by agent ID and tool-use ID where the hook payload carries one. For headless and structured runs the pairing uses `tool_use.id` → `tool_result.tool_use_id`. The adapters hard-code `durationMs: 0`, so the duration comes from timestamps. At about 1,300 tool calls a day for this user, the volume is acceptable as opt-in only.

#### Chat turns (mapped from the chat event bus, §9.1)

Structured mode (`structured-manager.ts` and its StreamJson, ACP and Codex adapters) is removed by [#1937](https://github.com/Agent-Clubhouse/Clubhouse/pull/1937) and was never instrumented; it is not a hook point. Native chat ([#1916](https://github.com/Agent-Clubhouse/Clubhouse/pull/1916)) publishes normalized events on a main-process bus it owns. Telemetry maps them as follows once both exist; whichever lands second owns this mapping.

| Span | Boundaries | Attributes / errors | Level |
|---|---|---|---|
| `c.agent.turn` | chat bus turn-start → turn-end event | `c.turn.end_reason` (`complete`/`error`/`cancelled`/`timeout`); `c.turn.time_to_first_token` (s, also an event); `c.turn.tool_calls` (count); token usage as `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (numbers only); `c.chat.driver`; `error.type` from chat's closed error set (for example `max_tokens`, `refusal`, `rpc_timeout`, `process_exited`, `unhandled_server_request`) | S |
| ↳ `c.chat.rpc` | per-driver protocol calls (Codex `thread/start` / `turn/start`, ACP `session/prompt`, …), if chat exposes them on the bus | `rpc.method` from a fixed list | D |

Metrics: `c.agent.turn.duration` (s), `c.agent.tokens` counter (unit `{token}`, split by `gen_ai.token.type` = `input`/`output`), `c.agent.cost` (USD, from headless `result.total_cost_usd` or chat usage events where present).

**As built** (`src/main/telemetry/chat-telemetry.ts`, one subscriber on the chat event bus; chat imports nothing from telemetry):

- `c.agent.turn` is replayed at `turn_ended` with explicit times. Span attributes are integers, so time to first token is `c.turn.time_to_first_token_ms` on the span and `c.agent.turn.time_to_first_token` (s) as a histogram. The first token is the main agent's first streamed reply or thinking text. Subagent text doesn't count.
- `error.type` for a failed turn is the stop reason when it is `max_tokens` or `refusal`, otherwise the last chat `error` code in the turn. Chat's closed `ChatErrorCode` set is part of `ERROR_TYPES`.
- `c.agent.cost` carries `c.cost.estimate` (bool), because Claude on a subscription reports an API-price estimate.
- Tool calls feed `c.agent.tool_calls` once per call when it completes or fails, through the same built-in bucket list as hooks.
- Chat permissions reuse `c.agent.permission` and `c.agent.permission.wait` with `c.permission.path=chat` and `c.permission.source` (`desktop`/`annex`). A `cancelled` decision is reported as `deny`.
- `c.chat.protocol.unknown` is a counter by `c.chat.driver` and `c.chat.protocol.kind`. The native method or field name isn't sent, because attributes are closed enums and there is no per-driver allowlist yet.
- `c.agent.turn.stalled` counts a turn with no event for 5 minutes, once per turn. Time spent waiting on a permission or a question doesn't count.
- `session_started` opens a `chat` agent run (`c.agent.runtime=chat`) that the exit broadcast closes. A context clear stays in the same run.
- `c.chat.start` is not from the bus. It's a child of `c.agent.spawn` added in Phase 4b (#1978), recorded only when a chat driver actually starts. `c.chat.fallback` (#2304) comes from the same spawn path, not from the bus's `session_ended` with reason `fallback`, which only discards the run.
- Not mapped yet: `c.chat.rpc`, because the bus carries no protocol calls.
- The Workbook has a Chat tab for these signals.

#### Permissions (hook path and chat path)

| Span | Boundaries | Attributes | Level |
|---|---|---|---|
| `c.agent.permission` (root) | `permissionQueue.createPermission` (`hook-server.ts:162`) → `res.end` (`:194`). For chat runs: the chat bus's permission-request event → its decision event. | `c.permission.decision` (`allow`/`deny`/`ask`), `c.permission.result` (`resolved`/`timeout`/`expired`/`agent_mismatch`/`not_found`), `c.permission.source` (`desktop`/`annex`), `c.permission.path` (`hook`/`chat`), `c.tool.bucket`, orchestrator | S |

Metrics: `c.agent.permission.wait` histogram (s; already computed as `elapsedMs`), `c.agent.permission.stuck` counter (the 30 s stuck scan, `hook-server.ts:358`).

#### Exit and kill

Exits are classified on the `c.agent.run` span (above), not a separate span. Chat exits must also go through `broadcastAgentExit` (the structured-mode bypass, F1, was fixed in [#1928](https://github.com/Agent-Clubhouse/Clubhouse/pull/1928)).

| Span | Boundaries | Attributes | Level |
|---|---|---|---|
| `c.agent.kill` | `killAgent` (`agent-system.ts`) → the run's exit; replayed when the run ends, like `c.agent.run`. PTY and headless only | `c.kill.trigger`: `user` (agent IPC, which includes the renderer's quick-agent auto-stop), `agent_tool` (the `sleep_agent` MCP tool), `annex` (Annex kill and delete), `shutdown` (`killAll` at quit), `other` (a kill that reached the runtime managers without a known caller: terminal IPC, force-kill). Also `c.kill.stage_reached` (`exit_command`/`eof`/`sigterm`/`sigkill`) and `c.agent.exit.class` | S |

The trigger is recorded where the caller is known, before the runtime manager is asked; the managers record `other` only when no trigger was set. Replacement and the stale sweeper are not kills; they show up as the run's exit class (`replaced`, `stale_swept`).

`c.agent.exit.class` takes one of:

| Value | Meaning |
|---|---|
| `completed` | exit 0, not killed |
| `failed` | non-zero, not killed |
| `early_failure` | exit within 3 s of spawn; mirrors `agentStatusSlice.ts:41` |
| `killed_user` | user kill |
| `killed_escalated` | SIGKILL reached |
| `stale_swept` | removed by the stale sweeper |
| `chat_error` | chat turn ended with `end_reason=error` and the session closed |
| `replaced` | a new run started under the same agent ID before the old one reported an exit |

#### Group projects and shoulder taps

- `c.group.shoulder_tap` (S): `executeShoulderTap`. Attributes: `c.tap.broadcast`, `c.targets.count`. No targets is `skipped`; every target failing is `error.type = tap_undelivered`. Per-target results are a counter, not child spans: `c.group.shoulder_tap.deliveries` by `c.delivery.result` (`delivered`/`not_running`/`unsupported_runtime`) and target `c.agent.runtime`.
- `c.group.membership_sync`: not instrumented yet.
- `c.group.bulletin.posts` (S) counts every post, from MCP or the UI, by `c.bulletin.post.result`: `ok`; `evicted_message` when the topic's own cap dropped older messages; `evicted_topic` when the board-wide cap dropped messages from other topics; `rejected` for an oversized body (Phase 5b, §12 H8). `c.mcp.tool_calls` with `c.mcp.tool = post_bulletin` still shows the MCP share, but without the eviction result.

### 4.5 Clubhouse MCP bridge (`clubhouse-mcp/`)

| Instrument | Boundaries / attributes | Level |
|---|---|---|
| `c.mcp.bridge.start` span | `bridge-server.ts:302` | S |
| `c.mcp.tool_call` span | `handleToolsCall` → JSON-RPC return. Attributes: `c.mcp.tool_kind` (`clubhouse`/`browser`/`terminal`/`group`/`plugin`/`global`/`other`, from the tool-name prefix or global-tool membership), `c.mcp.tool` (the **built-in Clubhouse tool suffix or global tool name only**, from a fixed list kept in sync with `clubhouse-mcp/tools` by a test; plugin tools are always `other`; the binding segment of the name is never sent), `c.mcp.result` (`ok`/`tool_error`/`threw`), `error.type ∈ {mcp_tool_error, mcp_tool_threw}`, `c.agent.id_hash` (the calling agent), `c.mcp.refusal.reason` (`group_off`/`unparseable`/`no_binding`/`unknown_tool`/`invalid_args`/`tool_denied`, only when the registry refused the call before a handler ran) (#2308). Tool arguments are never recorded in any tier; the local `core:mcp` line keeps only their names. | S |
| `c.mcp.tool_calls` counter | tool kind, tool, result | S |
| `c.mcp.tool_call.duration` histogram | tool kind | S |
| `c.mcp.auth_rejected` counter | nonce 403s (`:71-82`) | E |
| `c.mcp.sessions` gauge | SSE connections | D |

`c.mcp.tools_list` event (S, Phase 5b): on every `tools/list`, with `c.mcp.tools.count_bucket` and `c.mcp.tools.empty`, never tool names (§12 H8, the empty-list bug #1544).

The stdio relay `bridge/clubhouse-mcp-bridge.js` runs in the agent's process tree. It is **not** instrumented; there is nowhere safe for it to export from.

### 4.6 Hook server and permission queue health

These are covered by §4.4 metrics (`hook_events`, `tool_calls`, `permission`). Additional instruments:

- `c.hook_server.requests` counter by `http.response.status_code` class and `c.hook.result` (`ok`/`bad_nonce`/`too_large`/`not_found`/`disabled`).
- `c.hook_server.start` span (S).
- Bad-nonce rejections are an **E-level counter**: they indicate stale hook configs or a hostile local process.

### 4.7 Projects (`project-handlers.ts`, `project-store.ts`, `renderer/stores/projectStore.ts`)

| Instrument | Notes | Level |
|---|---|---|
| `c.project.switch` (root, renderer-originated) | Effect at `App.tsx:132-221`, ending when `handleProjectSwitch` (`plugin-loader.ts:774`) resolves. Children: `restore_view`, `await_plugin_system`, `load_plugin_config`, `plugins.deactivate`, `plugins.activate` (one child per plugin). Attributes: `c.outcome` (`ok`/`cancelled`/`error`), `c.project.is_remote`, `c.plugins.activated.count`. | S |
| `c.project.add` / `c.project.remove` | `add()` `:371` with child `ensure_gitignore`; `remove()`. Attributes: `c.project.has_git`, `c.project.source` (`picker`/`dashboard`/`palette`/`assistant`) | S |
| `c.project.store.recovery` event | corrupt → quarantine / recovered from `.bak` / backup also corrupt (`project-store.ts:262-296`) | E |
| `c.projects.count` | observable gauge, plus in the config snapshot | S |
| `c.project.git_init` | `execSync('git init')` blocks main: span, `error.type` | S |

Failures here often come back as return values (`false`, `[]`) rather than exceptions. The instrumentation helper must accept a `classify(result)` callback (§6.5).

**As implemented (Phase 5a).** `c.project.add` does not set `c.project.has_git` (it would cost an extra git call) or `c.project.source` (which surface added the project is renderer knowledge, owned by the refresh, §9.1). Store recovery is sent as `c.persist.recovery` with `c.persist.store=projects` (Phase 3c), not a separate project event. A failed `git init` is `error.type=git_init_failed`.

### 4.8 Git and worktrees (`git-service.ts`, `agent-config.ts`)

- **User-initiated operations** get spans (`c.git.op`, S). The operations are checkout, stage/unstage (all), discard, commit, push, pull, create branch, stash/pop, diff, show commit, worktree list.
  - Span name: `c.git.<op>`.
  - Attributes: `c.git.op`, `c.outcome`, `process.exit.code`, `c.git.timed_out`.
  - `error.type ∈ {timeout, not_a_repo, validation, nonzero_exit, no_remote, conflict, auth}`, classified from exit codes and stderr **patterns matched locally**. Stderr is never sent.
- **Worktree create/remove** spans are children of `c.agent.create` and `c.agent.delete`. `c.agent.delete` carries `c.agent.delete.mode ∈ {commit_push, cleanup_branch, save_patch, force, unregister}`.
- **Polled `getGitInfo`**, every 3 s per widget (`builtin/git/main.ts:107`, `GitCanvasWidget.tsx:84`), **never gets a span.** It feeds histogram `c.git.status.duration` (s), dimension `c.size_bucket` (from file count), plus counter `c.git.status.polls`. A span is emitted only when one poll exceeds 2 s, as a slow-operation exemplar at level D.
- `c.git.subprocess.duration` histogram by `c.git.op` covers both of the above.
- **As implemented (Phase 5a).** The status histogram's dimension is `c.git.status.file_count_bucket`, on the shared count buckets (`0`, `1-9`, `10-99`, `100-999`, `1000-9999`, `>=10000`), not `c.size_bucket`, whose values are byte sizes. The slow-poll exemplar is `c.git.status.slow`. `c.git.worktree_add` and `c.git.worktree_remove` are only emitted while a root flow is active, so they never appear as orphans before the agent create/delete flows exist.

### 4.9 Files, editor and search

| Instrument | Notes | Level |
|---|---|---|
| `c.file.open` (renderer span) | `FileViewer.ts:170-212`. Attributes: `c.file.kind` (`binary`/`image`/`svg`/`markdown`/`text`/`too_large`/`none`), `c.file.ext_bucket` (from a static list of ~40 common extensions, else `other`), `c.size_bucket`, `error.type` (errno code: `ENOENT`/`EACCES`/`EISDIR`/…/`path_denied`) | S |
| `c.file.save` | `saveFile` `:314`; same attributes | S |
| `c.file.ops` counter | main `file-handlers.ts`, by `c.file.op` (`read`/`write`/`read_tree`/`mkdir`/`delete`/`rename`/`copy`/`stat`) and result. **Path-sandbox denials** (`assertAllowedPath`) are an E-level counter. | S |
| `c.file.tree.read` span | `readTree`. Attributes: `c.tree.node_count_bucket`, `c.tree.hit_cap` (10,000-node limit) | S |
| `c.search.query` span | `searchFiles` (`search-service.ts:88`). Attributes: `c.search.engine` (`rg`/`node`), `c.search.truncated`, `c.search.match_count_bucket`, option flags. `error.type ∈ {timeout, max_buffer, bad_regex, rg_failed}`. **The query text is never sent.** | S |
| `c.file_watch.active` | observable gauge, from `getActiveWatchCount()` | S |
| `c.file_watch.errors` | counter by `error.type` (`base_missing`/`create_failed`) | E |
| `c.editor.open_external` | `OPEN_IN_EDITOR`. Attributes: `c.editor.bucket` (`vscode`/`cursor`/`zed`/`jetbrains`/`other`) | S |
| `c.file.path_denied` | counter of paths refused by `assertAllowedPath` (Phase 5a) | E |
| `c.editor.monaco_load` | first load of the Monaco editor chunk (Phase 5a) | S |
| `c.editor.save_conflict` event | a file changed on disk while its editor tab had unsaved edits (Phase 5a) | E |

**As implemented (Phase 5a).** `c.file.ops` carries `c.file.result` (`ok`/`error`) and, on error, `error.type` as the errno code (`ENOENT`, `EACCES`, ...) or `path_denied`. `c.tree.node_count_bucket` and `c.search.match_count_bucket` use the shared count buckets (see §4.8). Search flags are `c.search.regex`, `c.search.case_sensitive` and `c.search.whole_word`.

### 4.10 Plugins: built-in and community (`renderer/plugins/plugin-loader.ts`)

**Plugin identity attribute.** `c.plugin.ref` is the raw plugin ID **only** when the plugin is built-in, or listed in the cached official registry with `official:true` and no `marketplaceId`. Otherwise it is `hmac(id)`. `c.plugin.origin ∈ {builtin, official_registry, custom_marketplace, preview, sideloaded}` always accompanies it. The built-ins are `terminal`, `files`, `browser`, `git`, `canvas`, `review`, `group-project`, `sticky-note`, `goobers`.

**As implemented (Phase 5a).** `c.plugin.ref` is an enum: a built-in ID, or `other`. Any other plugin is identified by `c.plugin.id_hash` (salted HMAC, spans only), so hashes never share a key with raw IDs. `c.plugin.origin` is `builtin`, `marketplace` or `sideloaded` for now. The renderer knows the plugin source but not the registry flags, so the official-registry split, and raw IDs for official plugins, follow when the marketplace instrumentation lands (Phase 5b). `c.plugin.api_version` is the manifest's `engine.api` as a string (`0.9`); unsupported versions report `other`. `c.plugin.activate` is only emitted for real attempts: not for already-active contexts, blocked statuses, or an errored plugin whose retry is still backing off. `c.plugin.protocol.requests` carries `c.plugin.protocol.result`.

| Instrument | Boundaries / attributes | Level |
|---|---|---|
| `c.plugin_system.init` | child of startup renderer init. Attributes: `c.plugins.registered.count`, `c.plugins.active.count`, `c.safe_mode`, `c.plugins.external_enabled` | S |
| `c.plugin.activate` | `activatePlugin` `:455` → `activated`/`errored`. Children: `settings_read`, `module_import` (main-side `plugin-protocol.ts` resolution is counted, not spanned), `mod_activate` (20 s timeout). Attributes: `c.plugin.ref`, `c.plugin.origin`, `c.plugin.scope`, `c.plugin.api_version`, `c.attempt`. `error.type ∈ {activation_timeout, module_resolve_failed, invalid_export, activate_threw, manifest_invalid, incompatible_api, permission_violation}` | S (E on failure) |
| `c.plugin.deactivate` | `:708` | D |
| `c.plugin.render_error` | from `PluginErrorBoundary` (§4.2) | E |
| `c.plugin.permission_violation` | counter (`plugin-api-shared.ts:38`) by `c.plugin.ref` and API namespace | E |
| `c.plugin.api_calls` | counter on the `gated()` proxy by API namespace. **Aggregated in-process and flushed with metrics; no per-call work beyond an increment.** | D |
| `c.plugin.protocol.requests` | counter by result (`ok`/`denied`/`not_found`) | S |

#### Canvas (`builtin/canvas/canvas-store.ts`)

| Instrument | Notes | Level |
|---|---|---|
| `c.canvas.load` | `loadCanvas` `:360` + `loadWires`. `c.canvas.load.result ∈ {ok, recovered_from_backup, degraded, unreadable, failed, remote_hydrated}`. Attributes: `c.canvas.count`, `c.canvas.view.count_bucket`, `c.canvas.wire.count_bucket`. As implemented (Phase 5a): `loadCanvas` only, with an added `new` result for a first canvas; wire counts and `remote_hydrated` are not set yet, and `error.type` is `canvas_unreadable` or `canvas_load_failed` | S (E for `unreadable`/`failed`) |
| `c.canvas.save` | **no per-autosave span.** Histogram `c.canvas.save.duration` plus counter `c.canvas.saves` by `c.canvas.persist_gate` (`ok`/`blocked`/`verify_empty`/`snapshot_first`) and result. Covered by Phase 3c's persist signals instead (`c.persist.write.duration` for plugin storage, `c.persist.guard_blocks` with `c.persist.store=canvas`) | S |
| `c.canvas.save.failed` | exception record; the currently unhandled rejection at `main.ts:253` must get a `.catch` | E |
| `c.canvas.command` | MCP canvas commands (`canvas-command-handler.ts:798`), named by command (`add_view`, `connect_views`, …; a static list) | S |
| `c.canvas.views` | counter of views added, by `c.canvas.view.type` (`agent`/`anchor`/`plugin`/`sticky-note`/`zone`) | S |

### 4.11 Marketplace and plugin updates

| Instrument | Notes | Level |
|---|---|---|
| `c.marketplace.fetch_registry` | `fetchRegistry` (`marketplace-service.ts:54`). Attributes: `c.registry.kind` (`official`/`featured`/`preview`/`custom`), `c.cache.hit`, `http.response.status_code`. `error.type ∈ {network, http_4xx, http_5xx, timeout, invalid_json}` | S |
| `c.plugin.install` | `installPlugin` `:225` → `{success}`. Children: `download`, `verify`, `extract`, `swap`. Attributes: `c.plugin.ref`, `c.plugin.origin`, `c.size_bucket`, `c.install.failure_stage ∈ {invalid_id, download_http, integrity, extract, no_manifest, swap, restore}` | S |
| `c.plugin.update_check` | `checkForPluginUpdates` `:93`. Attributes: `c.trigger`, `c.updates.available.count`, `c.updates.incompatible.count` | S |
| `c.plugin.update` | `updatePlugin` `:174`; phases as children | S |
| `c.plugin.uninstall` | `plugin-discovery.ts:120` | S |

Custom marketplace names and URLs are never sent. The config snapshot carries only `c.marketplace.custom.count`.

**As implemented (Phase 5b).** Install failures before the staging steps (creating the plugins or staging directory) throw before any stage is tracked, so they are recorded as an `install_failed` span without `c.install.failure_stage`. `c.registry.kind` is `official` or `custom`; the featured list is fetched inside the official span. `c.plugin.install` records `c.install.failure_stage` and `c.size_bucket` (download size) as attributes, with `error.type=install_failed`, and no child spans. A plugin update's install runs as its child. Plugins are identified as `c.plugin.ref=other` plus `c.plugin.id_hash`, as in Phase 5a. `c.plugin.update_check` uses `c.update.trigger` (`startup`/`periodic`/`manual`) and the two counts. A check requested while one is running is not measured.

### 4.12 Annex (satellite / controller)

The architecture and the telemetry stance on Annex are in §7. Instrumentation:

| Instrument | Side | Notes | Level |
|---|---|---|---|
| `c.annex.server.start` | satellite | `pairing_listen`, `main_listen`, `mdns_publish`. `error.type ∈ {tls_fallback_http, listen_failed, mdns_publish_failed}`. **A TLS fallback to plain HTTP is an E-level event** (security-relevant). | S |
| `c.annex.discover` | controller | mDNS resolve + `GET /identity` (`annex-client.ts:334`) | S |
| `c.annex.pair` | both | client `pairWithService` `:1494` / server `handlePairingRequest` `:1152`. `c.annex.pair.result ∈ {ok, invalid_pin, rate_limited, locked, invalid_key, identity_not_ready, timeout}` | S |
| `c.annex.connect` | controller | `connectToSatellite` → first `snapshot` received. Children: `tls_handshake`, `ws_open`, `snapshot`. `c.annex.auth_mode ∈ {mtls, bearer}`. `error.type ∈ {cert_missing, cert_mismatch, protocol_incompatible, ws_error, auth_rejected, handshake_timeout}` | S |
| `c.annex.reconnects` counter, `c.annex.reconnect.delay` histogram | controller | by `c.attempt_bucket` | S |
| `c.annex.disconnects` counter | both | `c.annex.disconnect.reason ∈ {heartbeat_timeout, ws_error, server_stop, user, power_resume}` | S |
| `c.annex.heartbeat.rtt` histogram | controller | from the ping/pong already performed (`annex-client.ts:602`) | S |
| `c.annex.snapshot.build` | satellite | `buildSnapshot()` (`annex-server.ts:472`) | S |
| `c.annex.rest` span | satellite | **level D only**, per route **template** from `ANNEX_HTTP_ROUTE_TABLE` (`/agents/:id/buffer`, never a concrete path) | D |
| `c.annex.events` counter, `c.annex.events.bytes` | satellite | per event type, **incremented in `broadcastAndBuffer`, never per-event spans**; plus `c.annex.send_failures` | S |
| `c.annex.remote_spawn` | controller → satellite | `agent:spawn`/`wake` send → ack; **carries trace context** (§7) | S |
| `c.annex.replay` | satellite | `replay:start` → `end`/`gap` (iOS clients only today) | S |
| `c.annex.clients` gauge | satellite | by `c.annex.client.kind` (`desktop`/`mobile`) | S |

The 7 errors and 31 warnings in §2.1 (identity request errors, WS errors, heartbeat timeouts) map to `c.annex.discover`/`connect` errors and `c.annex.disconnects` respectively.

**As shipped in Phase 6a** (where it differs from the table above):

- `c.annex.server.start` is replayed when both listeners are up and carries `c.annex.tls` (bool). The TLS fallback is the E-level event `c.annex.tls_fallback`, not an `error.type`. mDNS publish failures and listen failures are not instrumented: neither server has an `'error'` listener today.
- `c.annex.connect` runs from `connectToSatellite` to the next `snapshot`, without child spans. It carries `c.net.addr_family` (`ipv4`/`ipv6`/`hostname`), `c.annex.auth_mode` on success, and `error.type ∈ {cert_missing, cert_mismatch, protocol_incompatible, auth_rejected, handshake_timeout, ws_error}`. A connect the user cancels records nothing. `c.annex.discover` carries the address family and `identity_unreachable` / `identity_invalid`.
- `c.annex.pair` on the controller wraps `pairWithService`. On the satellite it is replayed per `POST /pair` reply, with `error.type = pair_rejected` and the reason in `c.annex.pair.result`.
- `c.annex.disconnects` is controller-side only. Its reasons are `heartbeat_timeout`, `heartbeat_failed`, `connection_closed`, `ws_error`, `user` and `other`. The client ignores close codes, so a satellite stop shows as `connection_closed`; a power resume reconnects sockets that were already down, so it is not a disconnect.
- Recorded as metrics, not spans: `c.annex.snapshot.build.duration` (histogram) and `c.annex.replays` (counter by `ok`/`gap`/`send_failed`).
- `c.annex.clients` (gauge) treats mTLS clients as `desktop` and bearer clients as `mobile`.
- No permission scopes exist, so `c.annex.control.denied` is counted by channel (`ws`/`rest`): control messages and destructive routes that require mTLS.
- `c.annex.remote_spawn` covers the send. The satellite's ack isn't correlated today, so the satellite's own `c.agent.spawn`, continued from the same trace, is the end-to-end view.
- `c.annex.rest` (Detailed) carries `c.annex.route` (40 templates kept in sync with `ANNEX_HTTP_ROUTE_TABLE` by a test) and `c.http.class`. It continues an inbound `traceparent` header from mTLS controllers only.
- `c.annex.events.bytes` counts UTF-8 bytes of the serialized message.

### 4.13 Goobers (`goobers-*.ts`)

| Instrument | Notes | Level |
|---|---|---|
| `c.goobers.activate` | `subscribe()` → first liveness result | S |
| `c.goobers.liveness` state-change event | only **on transition**, not per poll. `c.goobers.state ∈ {not_running, starting, unknown, running, recovering}`; `error.type ∈ {non_loopback_address, unexpected_readyz_status, identity_check_failed, auth_required, recovery_stalled, degraded}` | S |
| `c.goobers.polls` counter, `c.goobers.poll.skipped` counter, `c.goobers.poll.duration` histogram | the 5 s / 30 s poll loop. **No spans.** | D |
| `c.goobers.daemon.start` / `.stop` | `goobers-daemon.ts:133`, `:197`. `c.outcome`; `error.type ∈ {lock_contention, exited_before_ready, ready_timeout, binary_not_found, binary_not_executable, invalid_root}` | S |
| `c.goobers.sse.connect` | with `c.sse.terminal_reason ∈ {auth_required, no_read_model, schema_changed}`; reconnect counter | S |

**As shipped in Phase 6b:**

- **Codes keep the code's spelling.** Enum values use hyphens (`not-running`, `auth-required`, `recovery-stalled`). There is no `recovering` daemon state: recovery is `starting` with error code `recovering`. Only codes are exported, never messages, because those interpolate the instance root, the daemon address and instance ids.
- **`c.goobers.liveness`** is an event on any change of (`c.goobers.state`, `c.goobers.connection`, `c.goobers.error`), measured around every liveness probe (`refreshConnectionOnce`).
- **`c.goobers.activate`** runs from activation to the end of the first reconcile.
- **`c.goobers.daemon.start` / `.stop`** are flows. A ready timeout is `timeout`; a failure is `error.type = goobers_daemon_failed`, with the service's code in `c.goobers.error` (free-text start errors become `daemon-start-failed`).
- **The SSE stream** is metrics plus an event:
  - `c.goobers.stream.mode` event on every stream-status change (`live`/`reconnecting`/`polling`/`unavailable`)
  - `c.goobers.sse.reconnects` counter
  - `c.goobers.sse.terminals` counter by `c.sse.terminal_reason` (`auth-required`/`no-read-model`/`schema-changed`)
- **`c.goobers.data.age`** (gauge, s) is sampled per model (`instance`/`run`/`workflow`) at each poll tick, so only while the panel is watched. Freshness resets when the instance root changes. A model counts as fresh on a successful running probe (instance), a 200 from `listRuns` (run), or a stream invalidation naming it.
- **The poll loop** (Detailed only) is `c.goobers.polls`, `c.goobers.poll.skipped` (the previous tick was still running) and `c.goobers.poll.duration`.

### 4.14 Settings and feature usage

These are low-volume **event records** (level S) and land in `customEvents`:

| Event | Attributes |
|---|---|
| `c.settings.changed` | `c.settings.key` (the managed-settings key, e.g. `editor`, `mcp`, `goobers`, `logging`, `annex`, `theme`, …; a static list), `c.settings.field` (top-level field name from a per-key allowlist, otherwise omitted). Never the value, except for allowlisted enum/bool fields. |
| `c.settings.page_viewed` | `c.settings.page` (`SettingsSubPage` union, `shared/types.ts:570`) |
| `c.command_palette.executed` | `c.command.prefix` (text before the first `:`, e.g. `toggle-settings`, `project`, `agent`, `plugin-cmd`), `c.command.category` |
| `c.onboarding.*` | `started`/`cohort_selected` (`new-dev`/`experienced-dev`/`seasoned-dev`)/`completed`/`dismissed` |
| `c.help.topic_viewed` | `c.help.topic` (static IDs from `help-content.ts`). **Search text is never sent.** |
| `c.blueprint.*` | `export` (destination enum), `import` (match-status counts), `create_from_builtin` (`small-squad`/`large-squad`) |
| `c.theme.changed` | `c.theme.kind` (`builtin`/`plugin`), `c.theme.builtin_id` if built-in |
| `c.popout.opened` | `c.popout.type` |
| `c.telemetry.*` | `enabled`, `level_changed`, `disabled` (sent as the last record before shutdown of the exporter), `test` |

**As implemented (Phase 5b, main-process call sites).** `c.settings.changed` carries `c.settings.key` only, from a static list covering the managed settings and the legacy settings handlers, with no field names or values. `c.theme.changed` adds `c.theme.builtin_id=other` for plugin themes. `c.popout.opened` and `c.blueprint.exported` / `c.blueprint.imported` (with `c.outcome`) come from main. Page views, the command palette, onboarding and help topics are renderer call sites, owned by the refresh (§9.1).

### 4.16 Feedback (`framebriar/feedback-service.ts`, [#2309](https://github.com/Agent-Clubhouse/Clubhouse/issues/2309))

Event records only. Booleans, counts, states and codes: never notes, screenshots, invitations, error messages or the report id.

| Event | Attributes | Level |
|---|---|---|
| `c.feedback.captured` | `c.feedback.screenshot`, `c.feedback.shots`, `c.feedback.windows`, `c.feedback.trigger` (`button`/`shortcut`) | S |
| `c.feedback.submitted` | saved to the outbox: `c.feedback.screenshot`, `c.feedback.annotated`, `c.feedback.shots`, `c.feedback.access.state` | S |
| `c.feedback.delivered` | none (Framebriar's receipt) | S |
| `c.feedback.failed` | `c.feedback.stage` (`start`/`connect`/`capture`/`submit`/`deliver`), `c.feedback.error` (the SDK or outbox code, a send check, the connect failure class, `undeliverable`, else `unknown`) | E |
| `c.feedback.connected` | none | S |
| `c.feedback.access` | settled access transitions only (not `checking`/`connecting`/`disconnecting`): `c.feedback.access.state`, `.from`, `c.feedback.notice` | S |
| `c.feedback.request_refused` | `c.feedback.refusal` (`not-configured`/`no-main-window`/`unauthorized-caller`) | S |

**Report id.** Maintainers match a Framebriar report to the user's local record by its id. The id is not an attribute, so it stays in the local `core:feedback` log lines (`Feedback saved for delivery`, `Feedback delivered`) until the local-only diag tier ([#2299](https://github.com/Agent-Clubhouse/Clubhouse/issues/2299)) can carry it.

### 4.15 Process health, renderer performance and pipeline health (added in revision 2)

The first draft left these as gaps. The maintainer set the goal as broad coverage of critical paths, and the regression history (§12) shows main-thread starvation (#1528), canvas render cost (#1693, #1694) and silent stalls. All of the following are in Phase 3.

| Instrument | Source | Attributes | Level |
|---|---|---|---|
| `c.process.eventloop.delay.p99`, `.max` (observable gauges, s) | `perf_hooks.monitorEventLoopDelay`, read and reset every 60 s. These are gauges because App Insights histograms have no percentiles (§3.2). Both are lateness past the histogram's resolution, so an idle loop reads about 0 in either sampler mode (below). | — | S |
| `c.process.eventloop.blocked` (event) | a stall of 2 s or more: the watchdog timer fired that late, or the histogram recorded it since the watchdog's last tick. At most one a minute. | `c.blocked.flow`: the name of the root span active when the watchdog noticed the stall. That points at the culprit, e.g. `c.agent.spawn` during a `which` lookup. | E |

**Sampler modes** ([#2291](https://github.com/Agent-Clubhouse/Clubhouse/issues/2291)). The health sampler runs for every install with logging on, so it backs off when nobody is looking:

| Mode | When | Histogram resolution | Watchdog (one `setTimeout`, lateness = stall) | Detects |
|---|---|---|---|---|
| `active` | a Clubhouse window is focused and `powerMonitor.getSystemIdleState(300)` is `active` (or `unknown`, common on Linux/Wayland, where focus alone decides) | 100 ms | 1 s | every stall of 200 ms or more in the minute's max; every stall of 2.1 s or more as an event |
| `idle` | otherwise (app in the background, user away 5 min, screen locked) | 500 ms | 2 s | every stall of 1 s or more in the max, shorter ones only when they span a histogram tick by enough to show (measured: about 1 in 4 stalls of 200–250 ms reported at 100 ms or more); every stall of 2.5 s or more as an event |

Window focus, unlock and resume switch to `active` at once; backing off waits for the next watchdog tick, so moving between two Clubhouse windows does not flap. A switch keeps the minute's p99 (the larger segment's) and max; a ramp-up first takes the pending watchdog's lateness, so a click on a hung window doesn't lose the stall. Resume and unlock start a fresh histogram, so a sleep gap is never measured as a stall. `app.getAppMetrics()` stays once a minute in both modes: it costs about 0.2 ms per call. The mode never depends on export.
| `c.process.memory` (observable gauge, By) | `app.getAppMetrics()` every 60 s: `workingSetSize`, `privateBytes` | `c.process.type` (`browser`/`renderer`/`gpu`/`utility`), `c.window.kind` | S |
| `c.process.cpu` (observable gauge, %) | `app.getAppMetrics()` `percentCPUUsage` | `c.process.type` | S |
| `c.renderer.long_frames` (counter) + `c.renderer.long_frame.duration` (histogram, s) | `PerformanceObserver` for `long-animation-frame` (Chromium LoAF), aggregated in the renderer facade and sent once a minute | `c.view` (the active main view: `agent`/`terminal`/`canvas`/`files`/`git`/`settings`/`plugin`/`other`) | S |
| `c.ui.hang` (event) | the same LoAF observer: one event per coalesced burst of frames over the hang threshold (200 ms) (#2126) | `c.view`, `c.ui.surface`, `c.ui.hang.duration_ms` (longest frame), `c.ui.hang.frames`, `c.ui.hang.script_source` (`app`/`plugin`/`extension`/`none`, never the URL), `c.ui.interaction.type` (the input just before it) | S |
| `c.ui.slow_interaction` (event) | the Event Timing observer: one event per coalesced burst of interactions over the same threshold, sharing `c.ui.hang`'s six-a-minute cap (#2307) | `c.view`, `c.ui.surface`, `c.ui.slow_interaction.duration_ms` (slowest interaction), `c.ui.slow_interaction.count`, `c.ui.interaction.type` (the slowest interaction's type). The target id stays in the local `ui:perf` line. | S |
| `c.ui.interaction.duration` (histogram, s) | Event Timing API: input to next paint per interaction, its longest entry. The browser only reports interactions of 16 ms and over, so faster ones are missing and the percentiles lean slow. | `c.view`, `c.ui.surface`, `c.ui.interaction.type` (`click`/`keydown`/`wheel`) | S |
| `c.telemetry.export.failures` (counter) | exporter result callbacks | `c.telemetry.signal` (`traces`/`metrics`/`logs`), `c.http.class` | E |
| `c.telemetry.offline.items` (observable gauge) | offline queue size; exported once connectivity returns | — | E |
| `c.shell.spawn` (span) | non-agent PTYs (`ShellTerminal`, utility terminals) | `error.type` (`pty_spawn_failed`, `cwd_invalid`, `spawn_helper_not_executable`) | S |

**Local hang log (#2126).** Hangs are also written to the local session log under `ui:perf`, whether or not telemetry is on (`src/renderer/telemetry/ui-perf.ts`):
- **What is logged.** Frames and interactions at or over the hang threshold (200 ms; `localStorage clubhouse.uiPerf.hangMs` overrides it, minimum 50) are coalesced per second into one line. A line has the count, the max and total ms, view and surface, the last interaction (its type, a stable target id from `data-testid` or `data-tree-key`, named keys only, never text), and the top three LoAF scripts with the URL cut to `scheme:basename`.
- **Limits.** At most six lines a minute; anything held back is counted as `suppressed` on the next line. The cap covers `c.ui.hang` and `c.ui.slow_interaction` too, so a hang storm sends at most six events a minute between them.
- **Scrubbing.** LoAF `sourceURL`, and `invoker` when it's a script URL, are cut to `scheme:basename`.
- **Unresponsive windows.** Main logs the `unresponsive` / `responsive` pair under the same namespace with `durationMs`.
- **Breadcrumbs.** `ui:perf` lines become performance breadcrumbs on feedback reports regardless of log settings (`services/breadcrumbs.ts`, #2098).
- **Idle cost.** The LoAF and Event Timing observers fire only for long frames and interactions. Three passive capture listeners (pointerdown, keydown, wheel) store one small object per input.

---

## 5. Attribute schema and privacy enforcement

### 5.1 The registry

All attribute keys are declared in **one file**, `src/shared/telemetry/attributes.ts`, as a typed registry:

```ts
export const ATTR = {
  agentKind:     enumAttr('clubhouse.agent.kind', ['durable', 'quick', 'companion']),
  orchestrator:  enumAttr('clubhouse.orchestrator', ['claude-code', 'codex-cli', 'copilot-cli', 'other']),
  agentRuntime:  enumAttr('clubhouse.agent.runtime', ['pty', 'headless']),   // 'chat' added by whichever of chat/telemetry lands second
  exitCode:      intAttr('process.exit.code'),
  agentIdHash:   hashAttr('clubhouse.agent.id_hash'),
  sizeBucket:    enumAttr('clubhouse.size_bucket', ['0', '<1KB', '<100KB', '<1MB', '<10MB', '<100MB', '>=100MB']),
  errorType:     enumAttr('error.type', ERROR_TYPES),   // union of every flow's closed enum
  // ...
} as const;
```

- Instrumentation code can only set attributes through `ATTR.x(value)`. TypeScript rejects values outside an enum, and the helper normalizes anything unknown to `'other'`.
- A lint rule (`no-restricted-imports`) forbids importing `@opentelemetry/api` outside `src/main/telemetry/` and `src/renderer/telemetry/`, so nobody can call `span.setAttribute('cwd', …)` directly.
- **Runtime enforcement** is a `RedactionSpanProcessor` / `RedactionLogProcessor` and a metric `View` with `attributeKeys` allowlists. It runs in the export pipeline and:
  1. drops any key not in the registry;
  2. re-validates enum, int, bool and hash formats;
  3. runs the path, URL and email scrubber over every string;
  4. caps string length at 128.

  This is a safety net for bugs in the typed layer and for third-party spans (the Azure exporter's own).
- **Tests:**
  - (a) every registry key has a test;
  - (b) a fuzz test feeds random `meta`-like objects containing paths, URLs, emails, prompts and stack traces through the processors and asserts that nothing survives;
  - (c) a snapshot test of the full key list, so adding a key shows up in review.

### 5.2 Identifiers

| ID | Generation | Lifetime | Exported as |
|---|---|---|---|
| `service.instance.id` | `randomUUID()` per app run | one run | resource attribute; maps to App Insights `cloud_RoleInstance`. **Must be set explicitly**, otherwise the Azure exporter falls back to `os.hostname()`. |
| `clubhouse.install.id` | `randomUUID()` (v4, from `crypto`), generated locally the first time telemetry is enabled, stored in `telemetry-settings.json` | until the user clicks **Reset telemetry ID**, or turns telemetry off and chooses **Delete local telemetry data** | resource attribute on every item; maps to App Insights `user_Id` via `enduser.pseudo.id`. **Sent by default** (decision 2026-10-16). Lets the user tell their own machines apart on one resource and follow one install across restarts and updates. |
| Hash salt | 32 random bytes, stored with the install ID | rotated with **Reset telemetry ID** | never exported |
| `*.id_hash` | `HMAC-SHA256(salt, rawId)` truncated to 16 hex characters | stable per install | span attributes only, **never metric dimensions** (cardinality) |

Hashes are applied only to opaque internal IDs: agent ID, project ID (`proj_<ts>_<rand>`), run ID, canvas ID, request ID. They are **never applied to names or paths** (P3). Low-entropy inputs such as a project name would be guessable even with a salt, and a path hash still says "same repo".

**Install ID privacy properties.** These are documented in the help topic and shown next to the Reset button:

- **Random, not derived.** It does not come from any hardware, OS, account, MAC address, hostname or Annex identity. Two installs on one machine get different IDs; reinstalling with fresh user data gets a new one.
- **Local until you export.** It is created only when telemetry is first enabled, is never sent anywhere except the destination you configured, and is never shared over Annex or with plugins. Plugins see only `c.plugin.ref`, never the install ID.
- **Resettable.** Reset generates a new ID **and a new hash salt** at the same time. After a reset, nothing sent before can be linked to anything sent after: neither the install ID nor any `*.id_hash` value carries over.
- **Linkable within the destination.** While unchanged, it links every session from this install inside your resource. That is its purpose. If you share a resource with a team, everyone can see per-install activity patterns: counts, versions and timings, never content.
- **Removed with local data.** Turning telemetry off keeps the ID, so turning it back on continues the same series. **Delete local telemetry data** removes the ID, the salt and the offline queue.

### 5.3 Scrubber (last line of defense)

Applied to every string attribute and to sanitized stack traces:

| Pattern | Replacement |
|---|---|
| POSIX absolute paths `(?:/[^\s/:]+){2,}`, `~/…` | `<path>` |
| Windows paths `[A-Za-z]:\\…`, UNC `\\\\server\\…`, `\\?\…` | `<path>` |
| `file://…`, `https?://…` | `<url>` (version strings untouched) |
| emails | `<email>` |
| the user's home directory and username (resolved at init, both literal and escaped) | `<home>` / `<user>` |
| IPv4 / IPv6 literals | `<ip>` |
| `os.hostname()` literal | `<host>` |

The Windows path patterns are tested on the Windows CI runner with real `C:\Users\…` values from `os.homedir()`. See the memory note on Windows path test literals: hardcoded POSIX literals have hidden Windows-only failures before.

### 5.4 Resource and config-snapshot attributes

**Resource**, set once per run:

| Attribute | Value |
|---|---|
| `service.name` | `clubhouse` (App Insights `cloud_RoleName`) |
| `service.version` | `app.getVersion()` |
| `service.instance.id` | per-run UUID |
| `clubhouse.install.id` | see §5.2 |
| `clubhouse.channel` | `stable` / `preview` |
| `deployment.environment.name` | `production` / `development` (`app.isPackaged`) |
| `os.type` | `darwin` / `windows` / `linux` |
| `os.version` | major.minor only. Windows 11 reports `10.0` like Windows 10, so a Windows build of 22000 or later is sent as `11.0` (this includes Server 2025) |
| `host.arch` | `arm64` / `amd64` |
| `process.runtime.version` | Node version |
| `clubhouse.electron.version` | Electron version |
| `clubhouse.telemetry.schema` | integer, starts at `1`; bump on breaking attribute changes |
| `clubhouse.annex.role` | `none` / `satellite` / `controller` / `both` |

`clubhouse.telemetry.level` (`errors` / `standard` / `detailed`) is not on the shared resource: with several destinations it differs per destination, so each destination stamps its own level onto every span and log record it receives (§6.11).

Explicitly **not set**: `host.name`, `os.description`, `process.command_args`, `process.executable.path`, `process.owner`, `service.namespace` (all would leak). Resource detectors are **not** used. `@opentelemetry/resources` default detectors include `host.name` and process args.

**Config snapshot event** `c.app.config_snapshot`:

| Area | Attributes |
|---|---|
| Counts | `c.projects.count`, `c.projects.git.count`, `c.projects.remote.count`, `c.agents.durable.count`, `c.profiles.count` |
| Orchestrators | `c.orchestrators.used` (sorted CSV from the enum) |
| Theme | `c.theme.kind`, `c.theme.builtin_id` |
| Feature flags | `c.clubhouse_mode`, `c.headless.enabled`, `c.mcp.enabled`, `c.annex.server`, `c.annex.client`, `c.annex.satellites.count` |
| Experimental | `c.experimental.*` (known keys only: `goobers`, `themeGradients`, plus chat's flag once it exists) |
| Plugins | `c.plugins.builtin_enabled` (CSV of built-in IDs), `c.plugins.community.count`, `c.marketplace.custom.count`, `c.plugins.external_enabled` |
| Logging | `c.logging.enabled`, `c.logging.min_level` |
| Notifications | notification booleans |
| Other | `c.editor.bucket`, `c.onboarding.cohort` |

### 5.5 Never sent (explicit list, enforced by §5.1 tests)

Never sent:

- prompts, missions, system prompts, persona content, assistant messages, bulletin and shoulder-tap message bodies;
- terminal output, `lastOutput`, stdout/stderr previews, tool input/output, text and thinking deltas;
- file contents, diffs, commit messages, search queries, glob patterns;
- file paths, cwd, worktree paths, binary paths, config paths;
- repo URLs, remote names, branch names;
- project, agent, canvas, view, zone, profile, sound-pack and custom-theme names;
- custom marketplace names and URLs, plugin asset URLs, community plugin IDs (they are hashed; see §4.10);
- MCP tool names other than Clubhouse built-ins; MCP server names;
- error messages and raw stacks (only sanitized frames are sent);
- hostnames, device names and aliases, IPs, Annex fingerprints, bearer tokens, PINs, nonces;
- environment variables and profile env;
- model strings other than the bucketed `c.model.family`.

---

## 6. Architecture

### 6.1 Process topology

```
┌──────────────── Renderer(s) ────────────────┐      ┌─────────────────────── Main process ───────────────────────┐
│ telemetry facade (no OTel SDK)              │      │ src/main/telemetry/                                        │
│  • span/metric/event calls → batched queue  │ IPC  │  facade.ts      no-op until enabled; typed ATTR helpers    │
│  • window error / unhandledrejection        │─────▶│  bootstrap.ts   lazy import() of SDK chunk when enabled    │
│  • AppErrorBoundary                         │      │  ┌─ TracerProvider ─ Redaction ─ Batch ─ AzureTraceExporter │
│  • traceparent for flows that cross to main │      │  ├─ MeterProvider  ─ Views(allowlist) ─ Periodic(60s) ─ AzMetric│
└─────────────────────────────────────────────┘      │  └─ LoggerProvider ─ Redaction ─ Batch ─ AzureLogExporter   │
                                                     │  preview-tee.ts ring buffer of last 200 exported items      │
                                                     │  appLog bridge (opt-in call sites only)                    │
                                                     └──────────────────────────┬─────────────────────────────────┘
                                                                                │ HTTPS (Node https via
                                                                                ▼ @azure/core-rest-pipeline)
                                                              <IngestionEndpoint from the user's connection string>
```

- **The SDK runs in main only.** That gives one exporter, one buffer and one flush point, keeps the renderer bundle unchanged, and keeps CSP untouched: renderers make no network calls. The renderer facade is about 1–2 KB.
- **No auto-instrumentation and no Azure distro.** This is a hard requirement:
  - `@azure/monitor-opentelemetry` brings `instrumentation-http` and require-in-the-middle.
  - That would record the hook server (every tool call), the MCP bridge, the Goobers 5 s poll, Annex REST/WS and the update and marketplace fetches. Those carry loopback URLs, LAN peer IPs, ports, nonces in paths and query-string tokens (`?token=`, `annex-server.ts:2567`).
  - The hardened Electron fuses (`RunAsNode:false`, `EnableNodeOptionsEnvironmentVariable:false`) rule out `--require` preloading anyway.
  - webpack bundling means `ws` and `undici` could not be patched even if we wanted to.
  - So we use `@opentelemetry/sdk-trace-base` `BasicTracerProvider`, `@opentelemetry/sdk-metrics` and `@opentelemetry/sdk-logs`, constructed by hand, plus `@opentelemetry/context-async-hooks` for context.
- **Self-telemetry suppression.** Exporter HTTP calls run under `suppressTracing(context.active())`, so they never generate spans even if someone adds instrumentation later.

### 6.2 Renderer → main forwarding

- **One channel.** The new `telemetry:emit` channel is `ipcRenderer.send`, fire-and-forget. It carries **batches** that the renderer facade flushes every 2 s or every 50 items. Each item is one of:
  - a span: name, start/end time, attributes, status, `traceparent`/`parentId`;
  - a metric delta: name, value, attributes;
  - an event or exception record.
- **Validation in main.** Main validates each item with `withValidatedArgs` and then runs the same registry check as main-side calls. **The renderer is not trusted to redact.** Main drops unknown span names, metric names and attribute keys.
- **Renderer spans are reconstructed in main** with explicit timestamps. They become ordinary spans in the provider, with `c.process=renderer` and `c.window.kind` (`main`/`popout`).
- **Cross-boundary flows.** For flows such as project switch, quick launch and file save, the renderer creates the root span and passes `traceparent` in an optional trailing IPC argument, so the main-side spans join the same trace. This is opt-in per IPC call, not global.
- **Renderer readiness.** A new `telemetry:renderer-ready` IPC is sent once after `initApp()`. It also benefits non-telemetry code: the startup survey found that no such signal exists today.
- **Renderer errors** (§4.2) go through the same channel with sanitized stacks. The sanitization is redone in main.
- **Disabled state.** While telemetry is off, the renderer facade drops calls before queueing. Main broadcasts the enabled/level state so this costs nothing.
- **Plugins** reach telemetry through their own `api.telemetry` namespace (§6.9). Calls go over the same `telemetry:emit` channel, tagged with the calling plugin's identity by the host, never by the plugin. The host also observes plugin errors and activation independently (§4.10).

### 6.3 Packages, versions and bundling

| Package | Version (2026-10-16) | Notes |
|---|---|---|
| `@opentelemetry/api` | 1.9.x | stable |
| `@opentelemetry/sdk-trace-base`, `sdk-metrics`, `resources`, `core` | **2.10.0, pinned exactly** | stable line. The OTLP exporters 0.221.x depend on **exactly** 2.10.0 (not a caret), and the Azure exporter accepts `^2.10.0`. So 2.10.0 is the only version that satisfies both without duplicate copies. Move to 2.12 only together with OTLP 0.223 or later. |
| `@opentelemetry/sdk-logs`, `api-logs` | **0.221.x** | **must match the exporter's `^0.221.0` caret**. On 0.x a caret pins the minor, so 0.223 would install a second copy. Pin exact versions, and have Dependabot group all `@opentelemetry/*` packages together. |
| `@opentelemetry/context-async-hooks` | 2.10.0 | `AsyncLocalStorageContextManager` |
| `@opentelemetry/semantic-conventions` | 1.43.x | import only `/incubating`-free stable constants, or copy the ~15 constants we use into `attributes.ts`. The package is 12 MB unpacked, so check that tree-shaking works under CJS webpack. |
| `@azure/monitor-opentelemetry-exporter` | **1.0.0-beta.46** | **the `latest` dist-tag is stale (beta.32, which depends on OTel 0.200).** Install `@beta` or the exact version. It is still pre-1.0, so pin exactly. Requires Node ≥ 22; Electron 43 is fine. Sends JSON via `@azure/core-rest-pipeline`, with **no protobufjs**. |
| `@opentelemetry/exporter-trace-otlp-http`, `exporter-metrics-otlp-http`, `exporter-logs-otlp-http` | **0.221.x** | **Phase 1** (decision 2026-10-16). In 0.221 these and `otlp-transformer` no longer depend on protobufjs. The `-http` variants send JSON. Avoid `-proto` and `-grpc`, which bring protobuf or grpc back and trip the asset relocator. |

**Release-train rule.** Every OTel package moves as one set: `api` 1.9.x, stable SDKs 2.10.0 and experimental 0.221.x, aligned with the Azure exporter beta.46.

- One Dependabot group covers `@opentelemetry/*` and `@azure/monitor-opentelemetry-exporter`, with an ignore rule for majors.
- **OTel JS 3.0 / 0.300 is already at release candidate.** Adopt it only after the Azure exporter publishes a compatible beta. Track it alongside the other blocked majors.

Bundling notes (`webpack.main.config.ts`):

- The only external is `node-pty`. Every runtime dependency must bundle cleanly through `@vercel/webpack-asset-relocator-loader` (`webpack.rules.ts:11`).
- **Phase 1 starts with a spike:** build a packaged app (in CI; local packaged launch crashes on code signing) and assert that the exporter loads and exports.
- **The SDK goes in a separate chunk** via `await import('./telemetry/sdk')`. That code is never evaluated unless telemetry is enabled, so startup cost when disabled is zero. Chunked dynamic imports already work in main (`ipc/agent-handlers.ts:66`).
- Expected size: about 0.6–1.2 MB minified for the OTel SDKs, the Azure exporter and `@azure/core-*`, plus about 100–200 KB for the OTLP exporters. That is about 1% of the roughly 97 MB `app.asar`. Add a CI check that fails if the telemetry chunk exceeds 2 MB.
- **Destination abstraction.** `src/main/telemetry/destinations/` holds `azure.ts` and `otlp.ts`. Each returns a span exporter, a metric exporter and a log exporter. Each destination is its own lazy chunk, so only the chosen one is loaded.

### 6.4 Sampling and volume

- **Errors are always kept.** Exceptions and E-level events are log records and are never sampled.
- **Traces use a custom `FlowSampler`:**
  - Errors level: root spans are recorded but only exported if they end in error. This is a tail decision, done by a processor that buffers each trace (max 64 spans) until the root ends.
  - Standard: flow roots sampled at 100%. Volume per user is low, roughly 100–1,000 roots a day, because hot paths have no spans (P4).
  - Detailed: also 100%, with tool-call, IPC and Annex REST spans enabled.
  - An **advanced "trace sample rate"** (1.0 by default) applies a `ParentBased(TraceIdRatioBased)` on top, for heavy users who want to cut cost. The sample rate is stamped on spans as `microsoft.sample_rate` so App Insights `itemCount` stays correct.
- **Metrics** are exported every 60 s with delta temporality, which the Azure exporter expects. A metric `View` caps cardinality at 200 attribute sets per instrument.
- **A per-session hard cap** of 50,000 spans and 10,000 log records **per destination**, counted after that destination's filter, after which its items are dropped and counted in `c.telemetry.dropped`. This protects against a runaway loop billing the user's Azure subscription, and high-volume export to one destination never uses up another's budget (§6.11).
- **Settings shows a cost hint:** "Typical Standard usage: <10 MB/day. Set a daily cap on your App Insights resource." It links to the Azure doc.

### 6.5 Instrumentation API (what feature code writes)

```ts
import { tel, ATTR } from '../telemetry';

return tel.flow('clubhouse.agent.spawn', { level: 'standard', attrs: [ATTR.agentKind(kind), ATTR.orchestrator(id)] },
  async (span) => {
    const provider = await tel.step('clubhouse.provider.check_availability', () => checkAvailability());
    span.set(ATTR.agentRuntime(runtime));
    return result;
  },
  { classify: (r) => r.ok ? 'ok' : { error: 'binary_not_found' } },   // for return-value failures
);

tel.count('clubhouse.agent.tool_calls', 1, [ATTR.orchestrator(o), ATTR.toolBucket(name)]);
tel.event('clubhouse.app.safe_mode', [ATTR.safeModeTrigger('crash_loop_detected')]);
tel.exception(err, { origin: 'main', handled: false });
```

- **Detailed level (Phase 6b).** Three span types exist only at Detailed:
  - `c.agent.tool_call`: hook-server `pre_tool` paired with the next `post_tool`/`tool_error` for the same agent and tool name, since hook payloads carry no tool-use id; at most 32 pending per agent, cleared at exit.
  - `c.ipc.invoke`: every app `ipcMain.handle` invoke, wrapped once at startup (telemetry's own handlers stay untimed), with `c.ipc.channel` from the fixed IPC constants; channels built at runtime are `other`. The span is replayed, not run as a flow: a rejected invoke gets an error outcome but no `c.exception` record (it is the handler's answer, not a crash), and a long async invoke is never blamed by the event-loop watchdog. Below Detailed the wrapper is a level check and a direct call.
  - `c.annex.rest` (§4.12).
  Arguments, results and paths are never recorded.
- When telemetry is disabled, `tel.*` are no-op functions that run `fn` directly. That is one property read and a branch, so hot-adjacent code (hook server) pays nothing measurable.
- `tel.flow` also accepts an existing `AbortSignal` and marks `cancelled` on abort.
- Thrown errors are recorded via `tel.exception` (sanitized) and rethrown unchanged. Instrumentation never changes control flow.
- A flow on a registered root span (`root: true`) and every replayed span or tree always start a new trace, whatever context is active; only `tel.step` nests under the active span. Process callbacks registered inside a flow (a PTY's `onExit`) keep that flow's context for the life of the process, so without this a run or kill replayed at exit would hang off a spawn trace that ended long before. `tel.exception` likewise attaches only to a span that is still recording.
- A thrown error's `error.type` is `unknown` unless the error was typed at the throw site: `throw tagError(err, 'preflight_failed')`, or `withErrorType('pty_spawn_failed', () => spawn(...))` around a call. The tag is a non-enumerable symbol property, so the error the caller sees is otherwise unchanged. The first tag wins, so an inner, more specific type (`cwd_invalid`) survives an outer wrapper (`pty_spawn_failed`), and every span the error passes through records the same type.

### 6.6 Bridging `appLog` into OTel logs

The user asked for no straight port, so the bridge is **opt-in per call site**:

1. **`appLog` gains an optional `telemetry` field:**
   ```ts
   appLog('core:annex-client', 'warn', `Heartbeat pong timeout — closing connection`, {
     meta: { fingerprint, host },                                   // local only, unchanged
     telemetry: { event: 'clubhouse.annex.heartbeat_timeout', attrs: [ATTR.attemptBucket(n)] },
   });
   ```
   Only entries with `telemetry` are exported. The export uses the **event name as the body**, never `msg`, plus the declared attributes, never `meta`. The local JSONL behavior is unchanged.
2. **Severity mapping** to the OTel `SeverityNumber`:

   | `LogLevel` | OTel `SeverityNumber` | App Insights `severityLevel` |
   |---|---|---|
   | `debug` | `DEBUG` (5) | Verbose (0) |
   | `info` | `INFO` (9) | Information (1) |
   | `warn` | `WARN` (13) | Warning (2) |
   | `error` | `ERROR` (17) | Error (3) |
   | `fatal` | `FATAL` (21) | Critical (4) |

   `debug` is never exported, even when opted in.
3. **Trace correlation, both ways:**
   - Bridged records carry the active span's `trace_id` and `span_id` through the OTel context, so App Insights joins them to the operation.
   - **The local JSONL also gains optional `traceId`/`spanId` fields when telemetry is on.** A user can then match a local log line to a remote trace when debugging, without any log content leaving the machine. This is a `LogEntry` type addition and is backward compatible.
4. **Interaction with the logging settings.** The bridge sits **before** the logging `enabled`/namespace/min-level filters in `log()` (`log-service.ts:115`). Turning off local logging does not silently disable telemetry, and vice versa. Each has its own switch, and the UI says so.
5. **Initial opt-in call sites** are the warn/error sites that map to §4 error classes without an existing span: Annex heartbeat timeout, permission stuck, project-store recovery, canvas unreadable, config-pipeline restore failure. Most other appLog errors are superseded by the flow spans' `error.type` and are not bridged.

**As implemented (Phase 7).** `appLog(ns, level, msg, { meta, telemetry: { event, attrs } })`. `event` must be a registered event name and `attrs` registry attributes. The bridge runs in `log()` before the local filters, through `tel.event` with the mapped severity. `debug` is dropped. `meta` and `msg` are never read by the bridge. Local JSONL lines carry `traceId`/`spanId` while a span is active. The opt-in sites are Annex heartbeat timeout (`c.annex.heartbeat_timeout`), stuck permission (`c.agent.permission.stuck`, with `c.agent.id_hash`) and config restore failure (`c.config.restore_failed`, with `c.config.format`). Project-store recovery and canvas unreadable are already exported as `c.persist.recovery` (Phase 3c), so bridging them again would double-count.

### 6.7 Lifecycle: enable, disable, flush, offline

- **Startup.** `bootstrap.ts` runs synchronously at the very top of `main/index.ts`, after the userData override (`:48-55`) and before handler registration:
  1. Read `telemetry-settings.json`.
  2. If enabled, decrypt the connection string (§6.8) and `import()` the SDK chunk.
  3. Spans created before init completes are buffered by the facade and replayed. They are capped at 500 and only exist during startup.
  4. The SDK must not block `ready`: init is async, and `c.app.startup` is backdated.
- **Toggle at runtime.**
  - Enable: start the providers.
  - Disable: `forceFlush()` with a 3 s timeout, `shutdown()` the providers, drop references, delete the offline queue and stop all renderer emission.
  - No restart is needed in either direction.
- **Flush on quit.** Add `telemetry.flush` to the `cleanups` array in `shutdown-guard.ts:43-50`, wrapped in `Promise.race` with a 3 s timeout. Add a shared `flushBeforeExit(timeoutMs)` and call it before every `app.exit` site: restart IPC (`app-handlers.ts:421`), macOS/Windows/Linux update relaunch (`auto-update-service.ts:826,852,887,899,969`). Today those paths skip `before-quit` and even an unawaited log flush. This spec also recommends adding a global timeout to `awaitShutdownCleanup` (§11).
- **Offline buffering.** The Azure exporter persists failed batches to disk and retries them. Configure:
  - `storageDirectory: ~/.clubhouse/telemetry/offline` (the default is the OS temp directory);
  - a size cap: a periodic prune to 20 MB / 48 h every 15 min (beta.46 hardcodes its own limit at 50 MB / 48 h and has no option for it);
  - deletion on disable.

  Offline data is post-redaction, so the disk copy contains nothing more sensitive than what would be sent.
- **Exporter self-telemetry ("Statsbeat").** The Azure exporter can send its own SDK health metrics to a **Microsoft-owned** endpoint, separate from the user's resource. **It must be disabled.** Phase 1 verifies the exact mechanism (environment flag or option for the pinned version). Phase 1 also adds a CI test that runs **each destination** (Azure and OTLP) against a mock HTTP server, intercepts all outbound requests, and asserts that **only the configured host is ever contacted.** This test is a release blocker. The OTLP exporters have no Statsbeat equivalent; the test still covers them.

  Verified for beta.46 in Phase 1: only the legacy `APPLICATION_INSIGHTS_NO_STATSBEAT` env var stops the exporter from creating its Statsbeat manager. `APPLICATIONINSIGHTS_STATSBEAT_DISABLED` only disables "non-essential" Statsbeat. Clubhouse sets the variables only while the exporters are constructed, so agent PTYs never inherit them.
- **Exporter remote configuration ("OneSettings").** Every Azure exporter constructor also starts a poller that fetches `https://settings.sdk.monitor.azure.com` 5–15 s later and periodically after that. Its settings can remotely turn offline storage and SDK stats on or off. beta.46 has **no option or env var** to disable it. Phase 1 pre-seeds the exporter's process-wide `ConfigurationManager` with an inert worker before any exporter is built, so no poll is ever scheduled. The egress test and the chunk-size check (exactly one bundled `ConfigurationManager`, no ESM copy) guard this. Re-verify on every exporter upgrade.
- **Proxy.** `@azure/core-rest-pipeline` honors `HTTPS_PROXY`/`NO_PROXY`. Document this. Electron's system proxy is not used.

### 6.8 Settings UX (Settings → Logging)

The existing **Logging** page (`LoggingSettingsView.tsx`) gets a second section, **Telemetry export**. It is not a new nav item: it shares the privacy context and avoids touching the four places a new page needs (`SettingsSubPage`, `AccessoryPanel`, `MainContentView`, command palette).

```
Logging                                         ← existing section unchanged
  ...
  "Logs are stored on your local disk only and are never transmitted."   ← text stays true

Telemetry export                                ← new (v1 layout; see §6.11 for the current per-destination panels)
  Send anonymized diagnostics to your own Azure Application Insights.
  Off by default.                                                       [Learn what's sent]

  ┌ Azure Application Insights ────────────────────────────────────────┐
  │ [●] Send telemetry                                                  │
  │ Connection string  [ •••••••••••••••••••••••••• ]  [Paste] [Clear]  │
  │                    ✓ IKey …1a2b · westus2-1.in.applicationinsights… │
  │ [Send test event]  ✓ Accepted (HTTP 200, 412 ms)                    │
  └─────────────────────────────────────────────────────────────────────┘
  Level  ( ) Errors only  (•) Standard  ( ) Detailed   ·  [Preview data]  ·  [Get the Clubhouse Workbook]

  Plugins             2 plugins can send telemetry · [Manage]          ← §6.9

  ┌ Other destinations ────────────────────────────────────────────────┐   ← its own panel, visible,
  │ Send to an OpenTelemetry (OTLP) backend instead of App Insights.    │     not mixed into the
  │ [ ] Send to OTLP                                                    │     App Insights flow
  │ Endpoint   [ https://otlp.example.com            ]                  │
  │ Headers    [ x-api-key ] [ •••••••• ]  [+ Add header]               │
  │ Protocol   [ HTTP/JSON ▾ ]   (only option in v1)                     │
  │ [Send test event]                                                   │
  └─────────────────────────────────────────────────────────────────────┘

  ▸ Advanced
      Trace sample rate  [1.0]
      OTLP metric temporality  (•) Cumulative  ( ) Delta
      Reset telemetry ID (rotates install ID and hash salt)
      Offline queue: 0 items · [Clear]
      Delete local telemetry data
```

**Collapsible panels (#2097).** The Azure, Other destinations and Advanced panels fold away. A destination panel starts open when it is on or has an error, otherwise closed, and its header always shows the state (On, Off, Not set up, On, not sending). The developer destination has no panel here: a line states whether it is on and links to Settings → Feedback, where its switch, level and filter live next to the connection it depends on. Collapsing was chosen over splitting telemetry into its own page because it keeps the one privacy page (local logs and export together) without adding a nav item, and a returning user sees only what's on.

**Layout** (decisions 2026-10-16: keep App Insights easy and simple; put other options in their own panel).

- **The App Insights panel leads and holds only three things:** the on/off toggle, the connection string and **Send test event**. Turning the toggle on with a valid connection string starts telemetry at the Standard level. The Level row, Preview and the Workbook link sit just below the panel, outside the setup path.
- **Other destinations is a separate panel** further down the same page. It is visible, but its fields never appear inside the App Insights flow. In v1 it offers generic OTLP: endpoint, headers and protocol. The protocol selector shows only HTTP/JSON in v1; `http/protobuf` could be added later if it bundles cleanly (§6.3).
- **One active destination at a time** (v1; superseded by multi-destination export, [#2005](https://github.com/Agent-Clubhouse/Clubhouse/pull/2005), §6.11).
  - In v1, turning on OTLP while App Insights was on (or the reverse) showed a confirm step and switched destinations, clearing the offline queue.
  - Today several destinations can be on at once, each with its own panel, level, preset, health and test event. The "where does my data go" question is answered by the consent dialog, which lists every host that will receive data, and by confirming each destination's host before it sends.

- **Connection string handling:**
  - It is parsed locally. `InstrumentationKey` must be a GUID and `IngestionEndpoint` must be an `https:` URL whose host ends in `.applicationinsights.azure.com` or a sovereign-cloud equivalent. The allowlist lives in code. Any other host requires the Other (OTLP) destination.
  - Bare instrumentation keys are rejected with a message that IKey-only ingestion was retired in 2025.
  - It is stored with **`safeStorage.encryptString`** in `userData/telemetry-secret.bin`, mode 0600. This is the first use of `safeStorage` in the codebase.
  - On Linux, if `safeStorage.getSelectedStorageBackend()` returns `basic_text`, the UI warns that the string will be stored with weak protection, and asks the user to confirm. Electron reports encryption as unavailable on `basic_text` until the app calls `safeStorage.setUsePlainTextEncryption(true)`, so the backend is checked first and the app opts in before reading or writing (#2336).
  - After saving, **the renderer only ever receives a masked form** (the last 4 characters of the IKey plus the ingestion host). The full string never crosses back into the renderer.
  - The connection string is not truly secret: it is an ingestion-only credential and cannot read data. It is still treated as one, because it lets anyone write into the user's resource and bill them.
- **OTLP endpoint and headers handling:**
  - **HTTPS is required, except for a collector on this computer** (decision 2026-10-16).
    - Plain `http:` is accepted only when the host is literally `localhost`, `127.0.0.1` or `[::1]`, on any port. The UI suggests `http://localhost:4318`, the OTLP/HTTP default. Every other `http:` URL is rejected with an explanation.
    - `localhost` is resolved with a pinned `lookup` that only returns `127.0.0.1` or `::1`. A hosts-file entry therefore cannot redirect plaintext traffic off the machine. Hostnames that merely resolve to loopback are treated as remote and need HTTPS.
    - The exporter refuses ports that Clubhouse's own loopback servers are using: the hook server, the MCP bridge and Annex. That avoids feedback loops and accidental POSTs into them.
    - The confirm step says "Telemetry will be sent to a collector on this computer (localhost:4318)". The egress test (§6.7) covers the loopback case too.
  - Signal paths follow the OTLP/HTTP spec: `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended to the base URL. Encoding is JSON only.
  - Header names are validated as HTTP tokens. A short list of reserved names (`content-type`, `content-length`, `host`) is refused. Header **values** are stored with `safeStorage` beside the connection string, under the same Linux `basic_text` warning, and are masked in the renderer after save. Only names and the last 4 characters of each value are shown.
  - **Destination confirmation.** On first save, and whenever the host changes, a confirm step names the host in plain text: "Telemetry will be sent to otlp.example.com. Clubhouse can't see or control what this service does with it." Nothing is sent until the user confirms.
  - The Azure-specific allowlist of ingestion hosts does not apply to OTLP. The **egress test (§6.7) does**: the exporter may contact only the configured host.
  - Metric temporality defaults to cumulative for OTLP, which most OTLP backends expect, with delta available. Azure always uses delta.
  - No other OTLP options in v1: no gRPC, no protobuf, no custom TLS or CA settings, no compression toggle (gzip is always on).
- **Test event:** emits `c.telemetry.test` as a span and an event, calls `forceFlush()`, and reports the exporter's `ExportResult` plus the HTTP status and latency. Common failures get explicit text:
  - Azure: 400 invalid IKey; 401/403 when local auth is disabled (points to the Entra ID follow-up); DNS or proxy failure.
  - OTLP: 401/403 (check headers), 404 (check the base path), 415 (the backend does not accept JSON), TLS failure.
- **Preview:** a tee exporter keeps a ring buffer of the last 200 items **after redaction**, exactly as sent. A dialog shows them as JSON with the type (span/metric/log) and the destination table. The same buffer is filled even when the level is Off: in that case nothing is exported, but the user can see what *would* be sent. This uses a separate dry-run pipeline with no network.
- **Learn what's sent:** a help topic `settings-telemetry` in `features/help/content/`, generated partly from the attribute registry so it cannot drift.
- **Storage:** `TELEMETRY` is added to `settings-definitions.ts` via `createManagedSettings`, with `{ destination: 'azure' | 'otlp', otlpEndpoint, otlpHeaderNames, otlpTemporality, level, sampleRate, installId, consentVersion, pluginGrants: Record<pluginRef, boolean> }`. Secrets (the connection string and OTLP header values) are kept separately in `telemetry-secret.bin`, as above.
- **Consent:** choosing a non-Off level for the first time shows a one-time confirmation listing the "never sent" categories. `consentVersion` is bumped if the schema widens materially, which forces re-confirmation.
- **The local logging banner text stays true:** logs are still never transmitted. Bridged events (§6.6) are telemetry, not logs, and the telemetry section says so explicitly.

### 6.9 Community plugin telemetry API (decision 2026-10-16)

Community plugins can send their own telemetry to the user's destination, under the same privacy rules as the host. Built-in plugins don't use this API; the host instruments them directly.

**Declaration.** A plugin needs:
- the new `telemetry` permission (elevated tier, shown in the install and permission-approval dialog as "Can send usage data to your telemetry destination if you allow it in Settings");
- a `telemetry` block in `manifest.json` that declares every name and attribute it will use:

```json
"telemetry": {
  "events":  { "sync_completed": { "attributes": { "result": { "enum": ["ok", "conflict", "error"] }, "items": { "type": "int" } } } },
  "spans":   { "sync": { "attributes": ["result"] } },
  "metrics": { "sync_duration": { "kind": "histogram", "unit": "s", "attributes": ["result"] } }
}
```

**API** (`api.telemetry`, plugin API ≥ 0.9; added to the API surface check):

| Call | Notes |
|---|---|
| `enabled: boolean` | false unless the user granted this plugin **and** the level allows it. Lets plugins skip work. |
| `event(name, attrs?)` | → `customEvents` |
| `span(name, fn, attrs?)` | wraps `fn`; records duration, outcome and a sanitized exception |
| `count(name, n?, attrs?)` / `record(name, value, attrs?)` | metrics, aggregated in-process |
| `exception(err)` | sanitized type and plugin-relative frames only |

**What the host enforces.** All of this happens in main, never trusting the plugin:

- **Schema allowlist.**
  - Names and attribute keys must appear in the manifest, and are validated at load and on hot reload.
  - Attribute types are limited to `enum` (≤ 32 values, each `^[a-z0-9_.-]{1,32}$`), `int`, `bool` and host-defined size or duration buckets.
  - **No free strings and no IDs or hashes**, so a plugin cannot send paths, names or identifiers.
  - Anything undeclared is dropped and counted in `c.plugin.telemetry.rejected`.
  - The validated schema extends the attribute registry at runtime. The redaction processors and scrubber run on plugin items exactly as on host items.
- **Namespacing.**
  - Exported names become `clubhouse.plugin.<name>` and attribute keys `plugin.<key>`. Reserved prefixes (`clubhouse.`, `error.`, `exception.`, `service.`, …) cannot be used.
  - Every item carries `c.plugin.ref` and `c.plugin.origin`. The ref is the raw ID only for official-registry plugins; otherwise it is hashed (§4.10).
  - Plugin spans are roots of their own traces. Plugins never see or set trace context, the install ID or any host attribute.
- **Rate limits**, as per-plugin token buckets:
  - events: 60/min, burst 120;
  - spans: 30/min;
  - exceptions: 10/min, deduped by fingerprint;
  - metrics: at most 10 instruments and 50 attribute sets each;
  - at most 5,000 records per plugin per session.
  - Over-limit items are dropped and counted in `c.plugin.telemetry.throttled`. Sustained overflow (3 windows in a row) pauses that plugin's telemetry for the session, with a notice in the Plugins list.
- **Levels.** Off: `enabled` is false and calls are no-ops. Errors: `exception` only. Standard and Detailed: everything.

**User control.**

- **Settings → Telemetry export → Plugins** lists every plugin holding the `telemetry` permission. Each row shows:
  - its local name (resolved locally, never exported);
  - its declared events, spans and metrics;
  - its records in the last hour;
  - a toggle.
- **Every toggle defaults to off for every plugin, official-registry plugins included** (decision 2026-10-16), even after the permission is granted. The same toggle appears on the plugin's detail settings page. Grants are stored as `pluginGrants` in the `TELEMETRY` settings (§6.8).
- Revoking a grant takes effect immediately, and that plugin's queued items are dropped.

**Today's official registry** (`Clubhouse-Workshop/registry/registry.json`, updated 2026-04-25, fetched 2026-10-16). It lists 16 plugins, all `official: true`, all by Clubhouse Workshop:

| Kind | Plugins | Could use `api.telemetry`? |
|---|---|---|
| Code plugins (9) | `bug-report`, `automations`, `github-issues`, `kanboss`, `ado-work-items`, `wiki`, `pomodoro`, `daily-admin`, `lounge` | Yes, once they declare the `telemetry` permission and a schema |
| Theme packs (7) | `fall-themes`, `neon-themes`, `ocean-themes`, `spring-themes`, `summer-themes`, `winter-themes`, `tech-modern` | No: they declare no permissions and run no code |

The preview registry holds 8 of the same IDs (`pomodoro` and the 7 theme packs). Nothing in either registry is marked unofficial. Every plugin that qualifies for a raw `c.plugin.ref` (§4.10) is therefore currently a maintainer-authored Workshop plugin. Even so, grants default to off for official plugins too (decision 2026-10-16, §10.1).
- The preview dialog labels plugin items with their source plugin.

### 6.10 The Clubhouse Workbook (decision 2026-10-16: planned deliverable)

An **Azure Monitor Workbook** is an interactive report saved inside the user's Azure resource: tabs of charts and tables driven by KQL queries over their App Insights data. Clubhouse ships one so users get useful dashboards the moment data arrives, without writing queries. It only applies to the App Insights destination; OTLP users build dashboards in their own tool.

**What ships:**

- **The template.** `docs/telemetry/workbook/clubhouse.workbook.json` holds the gallery template. Next to it, `azuredeploy.json` is an ARM template that wraps the workbook, so the docs can carry a **Deploy to Azure** button pointing at the raw GitHub URL. The user picks their App Insights resource in the portal and the workbook is created there.
- **Settings link.** **Get the Clubhouse Workbook** opens that docs page in the browser. That is a user-initiated `shell.openExternal`; Clubhouse itself makes no request.
- **Versioning.** The workbook carries `clubhouse.telemetry.schema` in its parameters. Panels filter on it, so a schema bump never silently breaks a chart.
- **Alerts.** A companion `alerts.json` (ARM) defines optional scheduled-query alert rules for the P0 signals in §12. They are off until the user deploys them.

**Panels.** Each tab maps to the coverage map. Shared parameters: time range, app version, OS, install (`user_Id`), and `c.install.kind`.

| Tab | Panels | Source (§) |
|---|---|---|
| **Overview** | active installs (`dcount(user_Id)`); sessions; version and OS mix; crash-free session rate; unclean exits; telemetry level mix | 4.1, 4.2 |
| **Reliability** | exceptions by `exception.type` and fingerprint (App Insights problem grouping); renderer-gone reasons; main-thread stalls by `c.blocked.flow`; top `error.type` per flow; `c.ui.action_failed` by action | 4.2, 4.15, 12 |
| **Startup and updates** | startup p50/p95 by kind, version and OS; shutdown duration; update funnel check → download → apply → **verified**; `apply_not_taken` by install kind; download failures by `error.type` | 4.1, 4.3 |
| **Agents** | spawns by orchestrator, runtime and outcome; spawn p95; **early-failure rate by `c.provider.cli_version`**; exit-class mix; time to first output; silent-hooks runs; stalled turns; structured end reasons and error codes; tokens and cost | 4.4 |
| **Permissions and tools** | permission wait p50/p95; timeouts; requests with no prompt shown; tool calls by bucket with error rate; MCP tool-call failures; injection delivery results | 4.4, 4.5 |
| **Data integrity** | persistence write failures, recoveries and guard-blocked autosaves by store; canvas load results; editor save conflicts; bulletin evictions | 4.10, 12 (H1, H11) |
| **Plugins** | activation failures by plugin ref and `error.type`; module-load results by kind; Monaco load timeouts; marketplace install failure stages; plugin telemetry throttled or rejected | 4.10, 4.11, 6.9 |
| **Workspace and performance** | project switch p95; git operation failures; search engine and timeouts; long frames by view; memory and CPU trend per process type | 4.7–4.9, 4.15 |
| **Annex and Goobers** | pair results; connect failures by `error.type` and address family; reconnects; heartbeat RTT; identity regenerations; Goobers data age and stream mode | 4.12, 4.13 |

**Example query** (Agents tab, spawn health by CLI version):

```kusto
requests
| where name == "clubhouse.agent.spawn"
| extend orch = tostring(customDimensions["clubhouse.orchestrator"]),
         cli  = tostring(customDimensions["clubhouse.provider.cli_version"])
| summarize spawns = sum(itemCount),
            failures = sumif(itemCount, success == false),
            p95_ms = percentile(duration, 95)
          by orch, cli, bin(timestamp, 1d)
| extend failure_rate = round(100.0 * failures / spawns, 1)
```

**How it is built.** The workbook grows with the phases (§9). Phase 3 ships Overview, Reliability, Startup and updates, and Data integrity. Phases 4–6 each add their tab in the same PR as the instrumentation it charts. Phase 7 finishes the alert rules and the Deploy to Azure docs page.

**How it is tested.**
- A vitest checks that every KQL query in the template references only span, metric and attribute names that exist in the registry (§5.1). Renaming an attribute therefore fails the build instead of blanking a chart.
- A manual checklist covers importing the template into a scratch App Insights resource once per release.

---

### 6.11 Multiple destinations and per-destination filters

Telemetry can go to several destinations at once, for example everything to the user's own App Insights and only user activity and errors to the developer's Framebriar service (below). Sampling and redaction stay global: an item is sampled and scrubbed once, then fans out. Session caps are per destination.

**Settings.** `telemetry-settings.json` holds a `destinations` list with one entry per kind, in display order. Each entry has:

- `id` (the kind, while there is one destination per kind);
- `kind`;
- `enabled`;
- `level` (Errors / Standard / Detailed);
- `preset` (below);
- `confirmedHost`: the host the user last confirmed for this destination (every kind; from the adapter's `validate().host`);
- the kind's own non-secret settings (`otlp: { endpoint, headerNames, temporality }`).

`sampleRate`, consent, the install id and the salt stay global. A Phase 2 file, with its single `enabled` + `destination` + `level` and flat `otlp*` fields, migrates on load to the same destination enabled at the same level, and every other entry off, so what is sent does not change. The settings store merges the defaults over the file before migrating, so the Phase 2 keys, not the absence of `destinations`, mark an older file. Phase 1 files migrate through the Phase 2 step.

**Pipeline** (`sdk.ts`, `processors.ts`). The SDK records at the most verbose enabled level. After the global Redaction, each destination has:

- **Spans:** ErrorTail (only if that destination is at Errors) → Filter → SessionCap → Batch → Stamp → Observed exporter. The tail runs before the filter, so a failing trace is kept even when the filter drops its root (a Detailed root, or one the preset doesn't take); the filter then keeps the failing children.
- **Logs:** Filter → SessionCap → Batch → Stamp → Observed exporter.
- **Stamp** adds the destination's own `clubhouse.telemetry.level` and any `copyResourceAttributes` to a plain per-destination copy of each span and log record, so exporters that spread, clone or serialize items keep them, and other destinations see the originals.
- **Preview** keeps one buffer per destination; items carry the destination they went to.
- **Metrics:** its own `PeriodicExportingMetricReader` with a metric-stream filter. Each reader takes its temporality from its own exporter, so Azure stays delta, OTLP follows its setting, and a delta-only backend gets delta.

One destination failing never shortens another's flush or shutdown. Export results are tagged with the destination id, which drives per-destination health and the test event. An export with no result after 30 s is recorded as a failure (`ETIMEDOUT`), so a hanging destination shows as failing rather than staying ok.

**Filters** (`filters.ts`). A destination's level is applied to every item first, as for a single destination; Detailed spans need Detailed. The `preset` then narrows it:

| Preset | Spans | Events | Metrics |
|---|---|---|---|
| `all` | everything the level allows | everything the level allows | everything the level allows |
| `user_activity` ("User activity and errors") | `c.agent.spawn`, `.kill`, `.create`, `.delete`, `c.agent.turn` (chat turn start to end), `c.agent.permission` (permission decisions), plus any span that ended in error. Never a Detailed span (`c.agent.tool_call`, `c.ipc.invoke`, `c.annex.rest`), whatever the level. | every Errors-level event (exceptions, `c.app.unclean_exit`, `c.renderer.gone`, `c.child_process.gone`, `c.ui.action_failed`, …), `c.telemetry.enabled` / `.disabled`, plus feature and navigation events: `c.ui.feature_used` (also carries view and surface changes; there is no separate navigation event), `c.popout.opened`, `c.settings.changed`, `c.theme.changed`, `c.blueprint.exported` / `.imported` | `c.app.sessions` and `c.telemetry.dropped` (so a gap can be told from silence) |

The Goobers poll counters are Detailed metrics, so the preset never sends them. The test event (`c.telemetry.test`) passes every preset, but carries its target's id in `c.telemetry.destination` and reaches only that destination.

**Destination interface** (`destinations/types.ts`, `destinations/registry.ts`). An adapter per kind supplies:

- `label`;
- `resolve(entry, settings, secrets)` → its config, or null when unconfigured;
- `validate(config)`, whose `host` is what consent names;
- `createExporters(config, entry, ctx)`, which loads the kind's lazy chunk;
- optionally `copyResourceAttributes`, `usesOfflineQueue` and `describeFailure(record)`.

The SDK receives `SdkDestination { id, kind, exporters, filter, copyResourceAttributes? }`. A kind that speaks OTLP builds its exporters with `createOtlpExportersWith({ options: (signal) => ({ url, headers }), temporality, reservedPorts })`, where `headers` may be an async factory. Plaintext stays pinned to loopback and off Clubhouse's own ports.

To add a kind:

1. add it to `TelemetryDestinationKind` / `TELEMETRY_DESTINATION_KINDS`;
2. add it to the `c.telemetry.destination` enum;
3. write one adapter;
4. add a Settings panel if it has user settings.

Fan-out, filters, consent, health and the test event are shared.

**Resource attributes on events.** Some backends keep only a few resource attributes. `copyResourceAttributes` copies chosen resource keys (for example `service.version`) onto that destination's spans and log records only. It works on a per-destination view of the shared item, so other destinations are unaffected.

**Consent, UI and health.**

- **Panels:** each destination's panel has the same order: switch, its own settings (OTLP's include metric temporality), level and "What to send" preset, health line (start errors appear here, under the destination that failed), then Send test event.
- **Consent and host confirmation:** every kind's host is confirmed before it receives anything. Turning a destination on asks again when its host was never confirmed, when it changed, and always when another destination is already on, so adding a second destination never starts sending without a dialog. A running Azure destination asks again before a new connection string sends to a different ingestion host. The consent dialog lists every host that will receive data once confirmed: the destination being turned on plus every other enabled one. As a second line of defence, `start()` refuses an enabled destination whose host isn't the confirmed one; a lone destination from a file that predates per-kind confirmation (and has consent on record) is adopted as confirmed.
- **Turning destinations on and off:** turning one on or off restarts the exporter with the others still running. Turning Azure off, or changing its resource, clears its offline queue. The offline queue is Azure's alone.
- **Health:** `ok`, `pending`, `failing` (with the plain-words reason) or `error` (could not start). It comes from each destination's own export results. A destination counts as failing while any signal's latest export failed.
- **Signals:** `c.telemetry.enabled` is emitted once per active destination kind, with `c.telemetry.destination`. `c.telemetry.export.failures` carries the destination kind.

**The Framebriar destination** ([#2006](https://github.com/Agent-Clubhouse/Clubhouse/pull/2006)). This is the one developer-run destination: the Clubhouse developer's Framebriar service, which also receives Feedback reports. It exists so that a feedback report comes with context about what the user was doing. It has no URL or key fields; it rides on Feedback's enrollment.

- **What it gets:** its default preset is "User activity and errors" at Standard, so never prompts, terminal output, paths or Detailed high-volume spans (§5, the preset table above). Its exporter is OTLP with delta temporality. It sets `session.id` to the Feedback session on a per-destination view of the resource, which is how reports and telemetry correlate. It copies `clubhouse.install.id`, `clubhouse.ui.chrome` and `clubhouse.channel` onto items, because Framebriar keeps few resource attributes.
- **When it runs:** it is derived, not a sticky switch. It is on exactly while Feedback is connected, telemetry is allowed (the experiment and consent), its host is the one the user confirmed, and the user hasn't switched it off. It doesn't need any of the user's own destinations on (#2097: with that rule, feedback reports came with no telemetry), and turning those off or clearing them leaves it on. **Upgrade:** a one-time migration (`developerRule: 2` in the settings file) records it as switched off for anyone who had confirmed its host while none of their own destinations was on, since under the old rule it sent nothing for them; it starts only when they turn it on. Users whose own export was on keep it. Delete local data also records it as switched off, so reconnecting Feedback doesn't bring it back. Before every batch it re-reads Feedback's state, and with Feedback disconnected, switched off, in another session, or without a token, nothing is sent.
- **Consent:** its host is listed in the export consent dialog when Feedback is connected. After connecting Feedback, the Feedback page asks "Share telemetry with the developer?", naming every host; when no consent was given yet, the prompt is the consent and lists what is never sent. Not now records it as off. Settings → Feedback → "Telemetry for the developer" has its switch, level, preset, health and test event; user-facing text calls it "Clubhouse developer", never by the service's name.

### 6.12 Local recording without an exporter ([#2278](https://github.com/Agent-Clubhouse/Clubhouse/issues/2278))

The `tel.*` signals are also written to local files, so flow timings and classified failures are available for local diagnosis without turning on export.

**Parity rule** (maintainer decisions on [#2289](https://github.com/Agent-Clubhouse/Clubhouse/pull/2289)). Local recording is the only gate on what is produced, measured and exported. Export is a background uploader of exactly what local recording produces, at its level: turning export on or off starts or stops no producer, changes no producer level, and so changes no cost. With local logging or local recording off, no producer runs and a configured exporter sends nothing.

**Behavior change for release notes.** Telemetry export used to run independently of local logging. Now it sends only what local recording produces. With **Record locally** or **Record telemetry signals** off, an enabled destination sends nothing, and a destination's level can no longer exceed the local **Telemetry detail** level. Installs already exporting at Detailed are migrated to local Detailed once, so they keep their data.

- **Producer gates.** `isTelemetryActive()` is true exactly while local recording is on, and `telemetryLevel()` is local recording's level. Neither reads export state. Every producer (§4: health sampler and watchdog, workspace gauges, lifecycle trees, session marker, agent, chat, Annex, Goobers, update and git signals, and the renderer's long-frame and perf observers) gates on them. Renderers get a separate `producers` flag in the telemetry state for the same reason.
- **Policy switch.** `EXPORT_WITHOUT_LOCAL_RECORDING` in `facade.ts` is the one place that decides what a running exporter gets while local recording is off.
  - `false` (shipped): local recording is the sole gate for everything, and the exporter receives nothing.
  - `true` (kept for tests and a possible reversal): feature `tel.*` calls made directly by feature code still reach the exporter, but no producer runs.
  - The renderer bridge reads the same switch. "Send test event" goes straight to the runtime, so a destination can be checked even with local recording off.
- **Levels.** Settings → Logging → **Telemetry detail** (`telemetryLevel` in `logging-settings.json`: `standard` by default, `detailed` opt-in) is the local recording level.
  - It drives the producers: the Detailed-only per-IPC spans and agent tool-call spans run only at local Detailed.
  - It is also the most any exporter receives. The facade forwards a span, event or metric to the runtime only when the local level allows it, and drops replayed children above it. A destination's own level only filters further down.
  - Changing the level restarts the recorder (a new file) at the new level.
- **Migration.** Runs once per install, on the first start with this build. If export was set up to send Detailed data (the experiment on, consent recorded, and an enabled destination at Detailed), the local level becomes Detailed, so nobody silently loses data. Either way the run is recorded in `telemetryLevelMigrated: true`, so a later choice by the user is never overridden.

- **Setting.** Settings → Logging → **Record telemetry signals** (labelled **Record telemetry locally** before #2312), stored as `telemetryRecording` in `logging-settings.json`. On by default (a file without the key counts as on). It only runs while **Record locally** (`enabled`, labelled **Write logs** before #2312) is on; turning either off stops recording the signals at once, flushing what was queued. The namespace and minimum-level filters do not apply to signals: those are for diag lines. The recorder itself runs while **Record locally** is on, for diag lines (below); with **Record telemetry signals** off it records diag lines only, is not installed in the facade, and its file starts at the first diag line. Switching **Record telemetry signals** restarts the recorder (a new file); a level change restarts it only while it records signals. Since the recorder runs with signals off too, so does the hourly retention pass.
- **No SDK, no network.** `local-recorder.ts` is part of the main bundle and imports no OpenTelemetry. `local-control.ts` installs it in the facade synchronously from `initTelemetry()`, so startup signals are recorded too. It never creates an install id or `telemetry-settings.json`: it uses the install's hash salt when one exists (local hashes then match exported ones) and a per-run random salt otherwise. `recordAppSession` takes the previous version from the session record (`telemetry-session.json`, written whenever signals are produced), so the startup kind is the same with export on or off.
- **Same protections as export.** Attributes go through `sanitizeAttribute` (registry keys only, enum/int/bool/hash/version formats, the scrubber, the 128-character cap), `hash` attributes through `hashId`, exception types through the same identifier check, and stacks through `sanitizeStack`. Exception messages, log messages and `meta` are never written in signal lines (diag lines, below, carry redacted text and are never exported). Metric dimensions are limited to each metric's declared attributes, as the SDK's views do.
- **Level.** Standard by default (`LOCAL_RECORDING_LEVEL`), Detailed opt-in; see Levels above.
- **Facade.** The recorder is a second consumer next to the SDK runtime (`setLocalSink`). Flows and steps are wrapped inside the SDK's span, so the SDK sees the same callback result and its span handle still receives every attribute. The unclean-exit check keeps its `telemetry-session.json` while recording. A sink that throws is caught in the facade and never stops the SDK call after it. `currentTraceIds()` returns the SDK's ids while it runs and the local ones otherwise, so local log lines carry `traceId`/`spanId` that match the telemetry file.
- **Renderers.** No new IPC: renderers record while main reports the state as enabled (§6.2) and keep batching (every 2 s or 50 items). Their producers run only while the state's `producers` flag is on. `telemetry:emit` batches are accepted while the state is enabled and go through the same re-validation.
- **Idle cost** (measured on #2289, each producer alone in Node 24 with Electron stubbed, 180 s idle, 2–3 runs; baseline idle Node 3–11 ms CPU/min; health sampler re-measured on #2291). These costs are the same with export on or off.

  | Producer | Wakeups/min | CPU over baseline | fs ops/min idle |
  |---|---|---|---|
  | Local recorder (2 s flush) | 30 | about 3 ms/min | 0 (an empty queue skips the write) |
  | Workspace gauges | 1 | about 3–5 ms/min with the recorder | 1 append for the metric window |
  | Session marker | 0 | about 0 | 0 (1 read and 1 write at start, 1 write at clean exit) |
  | Health sampler, `idle` mode (500 ms histogram, 2 s watchdog, 1/min sample) | 151 | about 5.5 ms/min in Node, about 25 ms/min in a real Electron 43 main process | 0 |
  | Health sampler, `active` mode (100 ms histogram, 1 s watchdog, 1/min sample) | 661 | about 18.5 ms/min in Node, about 72 ms/min in Electron | 0 |

  Before #2291 the sampler always ran a 100 ms histogram and a 500 ms watchdog: about 20 ms/min in Node and about 77 ms/min in Electron. Electron's main process pays more per wakeup than plain Node.
- **Correlation.** Spans carry random `traceId` (32 hex) and `spanId` (16 hex) and, for children, `parentSpanId`. A registered root span starts a new trace; anything else joins the active span through an `AsyncLocalStorage` context. Events and exceptions carry the active span's ids. Renderer spans arrive replayed and start their own traces, as in export.
- **Volume.** Metrics are aggregated in memory and written once a minute (and on every exit flush) as one line per attribute set, at most 200 sets per metric plus an overflow line. The §6.4 caps (50,000 spans, 10,000 events and exceptions) apply per hour rather than per run, so a long run keeps recording its tail. At most 1,000 lines wait in memory; lines are flushed every 2 s or at 100 lines. Files rotate at 2 MB.
- **Rolling eviction** ([#2297](https://github.com/Agent-Clubhouse/Clubhouse/issues/2297)). A run keeps at most its newest 10 MB. Past that budget, recording continues and the run's oldest chunks are deleted, never the one being written, with an `evicted` line reporting what went. The tail of a long run, where hangs and failures show up, is what stays. Metric aggregates and drop summaries skip the pending limit. A `dropped` line at each exit flush and at stop reports what the caps dropped since the last one.
- **Retention.** Files are `~/.clubhouse/logs/telemetry-<recorder start, ms precision>.jsonl`, then `.1.jsonl`, `.2.jsonl` for later chunks. Turning recording off and on starts a new file. "Delete local telemetry data" restarts the recorder so it drops the deleted salt; existing files stay until retention prunes them. The log retention tier's age and total-size limits (`LOG_RETENTION_TIERS`) prune them together with the legacy `session-*.jsonl` logs ([#2298](https://github.com/Agent-Clubhouse/Clubhouse/issues/2298)). `local-retention.ts` runs at startup (from log-service), hourly while recording, and after every rotation, and never deletes a file being written.
- **Exit.** `flushBeforeExit` and `forceFlushTelemetry` flush the recorder alongside the SDK, within the same timeout, including a diag-only recorder.

**Diagnostic lines** ([#2299](https://github.com/Agent-Clubhouse/Clubhouse/issues/2299), part of [#2295](https://github.com/Agent-Clubhouse/Clubhouse/issues/2295)). A local-only tier for the text that signals can't carry: error messages, paths, raw ids, stderr. `t:"diag"` lines share the file, chunking, rolling eviction and retention with the signals, but are not telemetry.

- **API.** Main: `diag(ns, level, msg, meta?)` from `src/main/telemetry/diag.ts` (also exported from `telemetry/index.ts`). Renderer: `diag(ns, level, msg, meta?)` from `src/renderer/telemetry`, batched with the signals over `telemetry:emit` as a `diag` item. `level` is `debug`, `info`, `warn`, `error` or `fatal`. Neither ever throws. The legacy `appLog`, `rendererLog`, `log:write` and plugin `api.logging` are not pointed at it yet (#2301, #2302).
- **Local only, by construction.** `diag.ts` and `diag-sink.ts` import nothing from the facade, the SDK runtime or an exporter. Their only sink is the local recorder, installed by `local-control.ts`. Renderer diag items go from the bridge to `diag.ts`, never to the facade. So no diag line reaches an exporter under either `EXPORT_WITHOUT_LOCAL_RECORDING` value, and none is added to feedback reports. `diag.test.ts` (fake runtime, both policy values, signals on and off) and `telemetry-egress.test.ts` (real SDK, mock collector) assert it.
- **Gating.** Exactly the legacy log's: `enabled`, then `namespaces[ns] !== false`, then `minLogLevel`, read on every call. Independent of `telemetryRecording` and of the telemetry level. Namespaces seen while logging is on are listed in Settings → Logging → Namespaces with the known and legacy ones (`getDiagNamespaces()`).
- **Redaction, not scrubbing** (`diag-redaction.ts`). Paths, error text, stderr, exit codes and raw ids stay. Removed before the line is queued, in `msg` and at every depth of `meta`:
  - the home directory, replaced by `<home>` in every spelling (case, slashes, JSON escapes, URL encoding), ending at a path boundary; the rest of the path stays;
  - secrets: the values of keys named `auth`, `sig` or `signature`, or containing `token`, `secret`, `password`, `apiKey`, `authorization`, `cookie`, `credential`, `privateKey`, `accessKey` or `accountKey` (numbers and booleans, like `maxTokens`, stay); `Bearer`/`Basic` credentials, `key=value` and `"key": "value"` pairs with those names (Azure `AccountKey=` and SAS `sig=` included), `--api-key`/`--token` flags, URL userinfo, and well-known token formats (`sk-…`, GitHub, Slack, AWS and Google keys, JWTs, PEM private keys). Object keys go through the same text redaction;
  - content ([#1919](https://github.com/Agent-Clubhouse/Clubhouse/issues/1919)): the values of any key containing `prompt`, `mission`, `transcript` or `completion`, and of `instructions`, `messages`, `userMessage`, `assistantMessage`, `messageText`, `content`, `text`, `body`, `data`, `payload`, `chunk`, `input`/`toolInput`, `args`/`argv`/`arguments`, `params`/`parameters`, `query`, `response`, `result`, `reply`, `answer`, `delta`, `stdin` and `stdout`, are replaced by their size (`<redacted: 412 chars>`); `env` keeps its variable names with every value redacted. `stderr` and `lastOutput` stay, redacted and capped: they carry the failure. Two error texts that quote content are cut too: `Command failed: <cmd> …` keeps only the executable, and V8's `"…"... is not valid JSON` loses the quoted input. Free text a call site interpolates into `msg` can't be recognized, so call sites must never put prompt or response text there;
  - size: `msg` and every string are cut at 2,000 characters, objects at 64 keys, arrays at 64 items, nesting at depth 6, and `meta` at 8 KB of JSON (first keys kept, a `<truncated>` key says what went). Errors keep `name`, `message`, `code` and `stack`, redacted the same way.
- **Budget.** Diag lines have their own byte budget per hourly cap window (`LOCAL_DIAG_WINDOW_BYTES`, 2 MB): debug lines stop at half of it, info at 80 %, and warn and above use the rest. At most 500 diag lines wait in memory, apart from the 1,000 signal lines, so neither can starve the other. Drops are reported in the `dropped` line's `diag` count. While the minimum level is debug, Settings → Logging → Diagnostic log shows a one-time note that debug lines share this budget and go first; dismissing it sets `diagBudgetNoteDismissed` in `logging-settings.json`.
- **Renderer items.** Main re-checks each `diag` item: the namespace (`^[\w@][\w.@/-]*(:[\w.@/-]+)*$`, at most 128 characters), the level, `msg` (cut at 4,000 characters, so redaction runs before the final 2,000-character cut and never sees a secret split in two) and `meta` (a plain object, dropped if its JSON is over 32 KB); then it is gated and redacted like a main line, tagged with the window kind main decides. Each window may send 500 diag items per 10 s; the rest are dropped and counted, before any parsing. Renderers send diag items while the telemetry state's `diag` flag is on, which follows diag recording, not `enabled`. The renderer turns `meta` into plain JSON data first, so a value IPC can't clone never fails a batch.
- **Trace correlation.** A diag line carries the active local span's `traceId` and `spanId` (the recorder's AsyncLocalStorage), so it sits inside its `agent.spawn` or `chat.start` span in the same file. Renderer lines carry none.
- **Breadcrumbs.** `addDiagTap(tap)` (in `diag.ts`, not the public telemetry index) sees every diag call, whatever the settings, in memory, as the same redacted record the file gets, for the feedback breadcrumb ring ([#2303](https://github.com/Agent-Clubhouse/Clubhouse/issues/2303)). A tap may take structured fields only and must never forward `msg` or `meta` wholesale. Redaction runs only when a tap or the file will see the line.

**File format** (JSON Lines, one record per line; `ts` is ISO 8601, `*Ms` fields are epoch or elapsed milliseconds):

| `t` | Fields |
|---|---|
| `session` | `v` (format version, 2), `ts`, `appVersion`, `platform`, `arch`, `level`, `signals?` (`false` when only diag lines are recorded). First line of the first file. |
| `span` | `ts` (end), `name`, `traceId`, `spanId`, `parentSpanId?`, `startMs`, `durationMs`, `outcome` (`ok`/`error`/`cancelled`/...), `errorType?`, `attrs` |
| `event` | `ts`, `name`, `severity` (`info`/`warn`/`error`/`fatal`), `traceId?`, `spanId?`, `attrs` |
| `exception` | `ts`, `type` (class name only), `stack` (sanitized frames), `traceId?`, `spanId?`, `attrs` (origin, handled, extras) |
| `metric` | `ts` (window end), `name`, `kind`, `unit?`, `startMs`, `durationMs`, `attrs`, `overflow?`; counters `sum`; histograms `count`, `sum`, `min`, `max`; gauges `value` (last) |
| `diag` | `ts`, `ns`, `level` (`debug`/`info`/`warn`/`error`/`fatal`), `msg`, `meta?`, `window?` (`main`/`popout`, renderer lines only), `traceId?`, `spanId?`. Local only and redacted, see Diagnostic lines. |
| `evicted` | `ts`, `files`, `bytes`, `maxBytes`. This run's oldest chunks were deleted to stay within its rolling budget; recording continues. |
| `dropped` | `ts`, `traces`, `logs`, `lines`, `diag`: counts dropped since the previous `dropped` line. Written when an hourly cap window ends, at exit flushes and at stop, only when non-zero. |

## 7. Annex satellites and controllers

**The facts** (from the survey):

- A **satellite** is a Clubhouse install running `annex-server`. A **controller** is a Clubhouse install running `annex-client`, and it dials the satellite.
- The Annex **iOS app** is a separate, non-Clubhouse client that uses bearer tokens.
- Desktop controllers send `agent:spawn`/`wake`/`kill`/`pty:input` over WS, plus about 40 REST routes. Satellites stream `pty:data`, hook, chat and permission events back to every client.

**Rules:**

1. **Each install has its own telemetry config.** A satellite never exports on behalf of a controller, or the reverse. Telemetry data never travels over Annex. There is no "forward my telemetry to the controller", because that would create a channel for data the other user didn't consent to.
2. **Trace context propagates only if both sides opt in.**
   - A controller with telemetry on adds `traceparent` to the WS JSON envelope (`{type:'agent:spawn', …, tc:'00-…'}`), since WS frames have no headers, and to REST request headers.
   - A satellite continues the trace only if *its own* telemetry is on. Otherwise it ignores the field.
   - `traceparent` contains only random IDs and a sampled flag, so receiving it reveals nothing.
   - If both installs point at the **same** App Insights resource (the common one-person, two-machines case), `c.annex.remote_spawn` on the controller and `c.agent.spawn` on the satellite appear as one end-to-end transaction. `clubhouse.annex.role` and `service.instance.id` tell them apart.
   - Protocol compatibility: `tc` is an optional field. Old satellites ignore unknown fields (they parse JSON loosely). Confirm this in Phase 6 against the dual-instance E2E.
   - As shipped: the controller adds `tc` to `agent:spawn` / `agent:wake` (inside `c.annex.remote_spawn`) and a `traceparent` header to `satelliteHttpsRequest` while a span is recording. The satellite accepts only version `00` with the sampled flag set; an unsampled parent would make ParentBased sampling drop the satellite's own spans, so the satellite starts its own trace instead. A sampled parent is kept at the **satellite's own** sample rate: a declined one is continued unsampled, so it is dropped rather than recorded with the wrong `microsoft.sample_rate`, and the satellite records exactly its configured share. The REST header is honoured only from mTLS controllers, never from bearer (mobile) clients. The remote parent applies to the **next root flow only**: process callbacks registered under it can't hang later flows off the controller's trace.
3. **No per-event spans for the event stream.** That includes PTY data fan-out, hook and chat event fan-out (`broadcastAndBuffer`), and controller-side `handleSatelliteMessage`. These are counters with byte totals (§4.12).
4. **Peer identity is never an attribute.** No fingerprints, aliases, hostnames, IPs or ports. `c.annex.client.kind` (desktop/mobile) and peer counts are allowed.
5. **The iOS app is out of scope.** If it later adopts OTel, it should reuse this registry's names for the shared flows (pair, connect, permission) and honor rule 2. Satellite-side spans already cover its server interactions.
6. **The `?token=` query auth** (`annex-server.ts:2567`) is one more reason never to record URLs. The registry has no URL attribute at all.

---

## 8. Performance budget

| Path | Budget | How |
|---|---|---|
| Telemetry disabled | 0 module loads, no allocations on hot paths | SDK chunk not imported; facade is a constant-false branch |
| Local recording (§6.12) | no SDK load, no IPC per item, no write per metric call | in-memory aggregates; one append every 2 s; renderers keep batching |
| PTY `onData` (`pty-manager.ts:350`) | **no telemetry code inside**; a single `bytes += data.length` on a per-session counter that already exists in spirit (`appendToBuffer`) | totals attached at exit |
| Hook server request | ≤ 1 counter increment (two with tool bucketing); no span below Detailed | `Counter.add` is about 100 ns |
| Chat/headless event loops | no telemetry per delta; first-token event fires once per turn via a flag | |
| Git status poll | 1 histogram record per poll | |
| Main-thread export work | batching every 5 s (spans/logs) or 60 s (metrics); serialization off hot paths | `BatchSpanProcessor` `maxExportBatchSize: 256` |
| Startup when enabled | < 30 ms added before `ready`, measured in Phase 1 | lazy chunk, async init, backdated span |

---

## 9. Phased plan and estimates

Sizes: **S** ≈ ≤ 400 LOC, **M** ≈ 400–1,000, **L** ≈ 1,000–1,800, counting production code plus tests. Every PR is validated with `npm run typecheck`, `npm run lint` and vitest. E2E specs are written but run in CI only.

| # | Phase / PR | Contents | Size | Depends on |
|---|---|---|---|---|
| 1 | **Foundation: SDK, pipeline, both destinations** | <ul><li>Spike: bundle the OTel SDK, the Azure exporter **and the OTLP/HTTP-JSON exporters** in lazy main chunks; packaged-build smoke test in CI; size check.</li><li>`src/main/telemetry/`: facade, bootstrap, destination abstraction (`azure.ts`, `otlp.ts`), providers, resource, attribute registry, redaction processors, scrubber, HMAC IDs, `FlowSampler`, session caps, preview tee, offline dir, flush-on-quit and `flushBeforeExit()` at all `app.exit` sites.</li><li>Statsbeat off; **egress-allowlist CI test for both destinations**.</li><li>Only instrumentation: `c.app.sessions`, `c.telemetry.test`.</li><li>Feature flag `experimental.telemetry` until Phase 3 lands.</li></ul> | **L** | — |
| 2 | **Settings UX** | `TELEMETRY` managed settings; `safeStorage` secret store (connection string and OTLP header values) with the Linux backend warning, **migrating any Phase 1 plaintext secret out of `telemetry-settings.json` and wiping it from the file**; **App Insights panel (toggle, connection string, test event) plus a separate Other destinations panel (OTLP endpoint, headers, protocol)**; one-active-destination switching; connection-string and OTLP endpoint/header validation; destination confirmation step; level picker incl. Errors; test event; preview dialog; consent confirm; help topic incl. install-ID privacy; reset ID; delete local telemetry data | **M** | 1 |
| 3 | **Errors, lifecycle, health, persistence integrity** | <ul><li>**Workbook v1** (§6.10): Overview, Reliability, Startup and updates, and Data integrity tabs, plus the KQL-vs-registry test.</li><li>Crash and error handlers (main, renderer, `AppErrorBoundary`), renderer facade and `telemetry:emit`, `telemetry:renderer-ready`.</li><li>Startup and shutdown span trees, unclean-exit detection, safe-mode events, config snapshot.</li><li>**Auto-update spans plus `c.update.apply.verified` and `c.install.kind`** (§12, H6).</li><li>**Process health, renderer long frames, pipeline health** (§4.15).</li><li>**Persistence integrity across all JSON stores** (§12, H1).</li></ul> **First "useful" release.** | **L** (could split 3a errors/lifecycle/update, 3b health/persistence) | 1 (2 for user-facing) |
| 4 | **Agents** (main-process half now; chat turns via the chat event bus, §9.1) | Create/spawn span trees across all three runtimes; run and first-output events; exit classification incl. the structured path; kill escalation; permissions; hook-event and tool-call metrics; MCP tool calls; shoulder taps; Workbook Agents and Permissions tabs. **Plus the regression signals:** CLI version on spawn, structured protocol-unknown counter, turn-stall watchdog, silent-hooks run, session-listing span, inject-delivery span, hook teardown, ID-collision repair, status reconcile, `c.ui.action_failed` for agent flows (§12, H2, H3, H7) | **L** (split 4a spawn/exit/drift, 4b permissions/turns/MCP/queue) | 3 |
| 5 | **Workspace** (main-process half now; UI call sites owned by the refresh, §9.1) | Project switch, add/remove, store recovery; git user-op spans and poll histogram; worktree spans; files, search and watch gauges; plugin system, activation and module-load results; Monaco load span; editor save conflicts; canvas load/save; marketplace; bulletin post results; MCP tools-list; settings and feature-usage events; Workbook Plugins and Workspace tabs (§12, H5, H8, H10, H11) | **L** (split 5a projects/git/files/editor, 5b plugins/canvas/marketplace/features) | 3 |
| 6 | **Annex, Goobers and Detailed level** | Annex spans and metrics with address family and identity-regeneration events; `traceparent` over the WS envelope and REST (dual-instance E2E spec); Goobers lifecycle, data-age gauge and stream-mode events; Detailed-level tool-call, IPC latency and Annex route spans; Workbook Annex and Goobers tab (§12, H9, H12). **H9 is P0 after the March pass, so the Annex connect, pair and reconnect spans may move into Phase 4 if Phase 6 slips.** | **M** | 4 |
| 7 | **Workbook completion, appLog bridge, source maps** | **Workbook:** Deploy to Azure ARM wrapper and docs page, alert rules for every P0 signal (§12), import checklist. **appLog:** `telemetry` field, severity mapping, trace IDs in local JSONL, initial opt-in sites. **Optional:** release source maps for stack symbolication. | **M** | 3–6 |
| 8 | **Community plugin telemetry API** | `telemetry` permission, manifest schema and validation, `api.telemetry`, host-side namespacing, rate limiting and throttling, per-plugin grants UI (Settings and plugin detail page), preview labelling, plugin API docs and API surface check, fuzz tests for plugin-supplied schemas | **M** | 2, 5 (plugin loader instrumentation) |

**Rough total:** 8–11 PRs, about 5,000–6,500 LOC including tests. Phases 4 and 5 can run in parallel after Phase 3; they touch disjoint files except the registry, where conflicts are append-only. Phase 8 can start as soon as Phase 5b lands.

**Why OTLP moved from Phase 7 to Phase 1.** It is an exporter swap behind the destination abstraction, adds about 150 KB, and needs no new instrumentation. Building both destinations in Phase 1 keeps the abstraction honest and lets the egress test cover both from the start.

### 9.1 Sequencing with the UI refresh and native chat (decisions 2026-10-16)

Two large changes are planned alongside telemetry:

- the **chrome refresh**: project rail, explorer, agent list, title bar, panels and command palette (mockups in the refresh session's artifact);
- **native chat** ([#1916](https://github.com/Agent-Clubhouse/Clubhouse/pull/1916)): chat over the coding CLIs, with one Clubhouse event model, real session and turn IDs and multi-turn sessions. It replaces structured mode, which [#1937](https://github.com/Agent-Clubhouse/Clubhouse/pull/1937) removes along with the `core:structured*` log namespaces.

Telemetry is split **by layer**. It does not wait for either change, and they do not wait for it.

**1. Land now, before both changes.** This work is UI-independent and will not be thrown away:

- Phases 1–3 as written: pipeline, both destinations, the settings section, errors and lifecycle, update, process health, persistence integrity, and Workbook v1.
- **Phase 4, main-process half.** Spawn, run, exit and kill classification, permissions, hooks, MCP, shoulder taps, CLI-version drift signals, hook teardown, ID-collision repair and status reconcile. The PTY path stays in use while chat rolls out, and the hook and permission paths are shared.
- **Phase 5, main-process half.** Git and worktrees, the file, search and watch services, plugin activation and module loading, Monaco load, canvas load and save, the marketplace, and project-store recovery.
- **Renderer foundation.** The renderer facade, `telemetry:emit`, `AppErrorBoundary`, window `error` and `unhandledrejection` handlers, long-frame collection and the swallowed-catch lint rule. These wrap the root, so any layout keeps them.

Landing this first gives a **baseline** before the refresh and chat ship: crash-free rate, startup p95, slow frames, persistence failures and spawn failures by orchestrator. The refresh can then be measured against it. History says this is when it matters: the March churn peak (§12.1) produced the most regressions, and canvas UI was the largest cluster.

**2. Owned by the refresh.** The UI-coupled call sites are built as part of the refresh, not before it:

- the `c.view` values for the new layout, which feed slow-frame tracking and render errors;
- the project-switch span, which moves out of `App.tsx`;
- file open and save spans in the new viewer;
- command-palette and feature-usage events;
- `c.ui.action_failed` actions for new UI catch sites. The lint rule already forces these.

These were roughly 15–20% of the planned telemetry work. That is an estimate from the coverage map, not a measurement. Building them once, on the new UI, avoids doing them twice.

**3. Chat and telemetry are independent.** This matches [#1916](https://github.com/Agent-Clubhouse/Clubhouse/pull/1916) §7.3 and §8.1.

- **Neither waits for the other.** Chat ships as experimental without waiting for telemetry, and telemetry doesn't wait for chat.
- **Chat owns its event bus.** Chat publishes its normalized events on a main-process bus that it owns: turn start and end, tool start and end, permission request and decision, usage, and errors. Chat imports nothing from telemetry.
- **Telemetry subscribes when it lands.** It maps those events onto `c.agent.turn`, `c.agent.tool_call`, `c.agent.permission` and the token metrics (§4.4). It adds the driver-boundary signals under `c.chat.*`: `c.chat.driver` and `c.chat.protocol.unknown`, plus `c.agent.turn.stalled`. New code uses `chat`, not `structured`.
- **Whichever lands second owns the mapping** code and its tests, and adds `chat` to `c.agent.runtime` in the registry.
- **Structured mode is not instrumented.** It is removed by [#1937](https://github.com/Agent-Clubhouse/Clubhouse/pull/1937). PTY and headless values stay while those paths exist.

**Ownership.**

| Area | Owner |
|---|---|
| Pipeline, exporters, destinations, sampling, privacy enforcement | Telemetry |
| Attribute registry (`src/shared/telemetry/attributes.ts`) | Telemetry, via CODEOWNERS review on every addition |
| Workbook and alert rules | Telemetry |
| Call sites in new UI views | Refresh |
| Chat event bus | Chat |
| Mapping chat events to telemetry, and the `c.chat.*` signals | Whichever of chat or telemetry lands second, with telemetry reviewing the registry entries |

**Parity checklist (required in both specs).** The refresh spec and the chat spec must each include this telemetry parity checklist.

- **Refresh:** the checklist gates shipping.
- **Chat:** it applies once both chat and telemetry exist, and gates only chat's promotion from experimental to stable or default.

The checklist:

1. Every span, metric and event the replaced UI or runtime emits has a named equivalent in the new code, or is explicitly retired in the registry with a reason.
2. Every Workbook panel that charted the old signal still has data. The KQL-vs-registry test (§6.10) enforces names; a manual import against a scratch resource confirms the panels render.
3. New views and drivers add their `c.view` / `c.agent.runtime` values and their `c.ui.action_failed` actions to the registry in the same PR.
4. P0 signals from §12 keep their level (Errors or Standard) and their alert rules.

---

## 10. Risks and open questions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OTel/Azure packages fail under webpack + asset relocator (dynamic requires, optional peers) | Medium | High (blocks everything) | Phase 1 spike in a packaged CI build first; avoid protobuf/grpc exporters; the lazy chunk keeps a failure contained to "telemetry unavailable", reported in Settings |
| Azure exporter is pre-1.0 (beta.46) with frequent breaking changes and version lockstep with OTel 0.2xx experimental packages | High | Medium | Pin exact versions; Dependabot group for `@opentelemetry/*` + `@azure/monitor-opentelemetry-exporter`; a contract test that exports one of each signal to a mock ingestion server and snapshots the payload shape |
| Exporter contacts endpoints other than the user's (Statsbeat, AAD discovery) | Medium | **High (trust)** | Disable Statsbeat; egress-allowlist test is a release blocker (§6.7) |
| Privacy regression: a new attribute or call site leaks a path or name | Medium | High | Typed registry + lint import restriction + runtime redaction + fuzz test + key snapshot test; CODEOWNERS on `src/shared/telemetry/attributes.ts` |
| Hot-path performance (PTY, hook server, chat deltas) | Low (by design) | Medium | §8 budget; vitest micro-benchmark around hook-server `handleRequest` with telemetry on/off; no spans below Detailed |
| Bundle size | Low | Low | ~1 MB lazy chunk vs ~97 MB asar; CI size guard at 2 MB |
| Windows: path scrubbing (`C:\`, UNC, `\\?\`), `safeStorage` (DPAPI, fine), `app.exit` paths during Squirrel update | Medium | Medium | Scrubber tests on the Windows CI runner using `os.homedir()`; `flushBeforeExit` covers Squirrel relaunch |
| Linux `safeStorage` falls back to `basic_text` without a keyring | Medium | Low | Detect the backend and warn the user; the ingestion-only credential limits the blast radius |
| User's App Insights bill | Low | Medium | Levels, sampling, session caps, a cost hint, a recommended daily cap |
| Resources with local auth disabled reject connection strings | Medium in enterprises | Medium | Clear error in the test button; **follow-up:** Entra ID via `DefaultAzureCredential` is out of scope for v1 because it needs an interactive sign-in flow in the app |
| Histograms give no percentiles in App Insights | Certain | Low | Percentile-critical latencies are spans (§3.2); histograms remain for averages and future OTLP |
| A long-lived `c.agent.run` span is never exported if the app crashes | Certain | Low | Metrics recorded at edges; unclean-exit event; run duration recomputed at the next exit where possible |
| Clock skew between renderer and main timestamps | Low | Low | Renderer sends `performance.timeOrigin`-relative times; main converts using an offset measured at IPC handshake |
| OTLP widens where data goes: wrong or hostile endpoint, leaked header token | Medium | Medium | HTTPS only; explicit destination-confirmation step naming the host; header values in `safeStorage` and masked; egress test; switching destination clears queued data |
| OTel JS 3.0 / 0.300 (already at RC) breaks the pinned 2.10.0 / 0.221.x train | High (within months) | Medium | Release-train rule (§6.3); hold majors until the Azure exporter supports 3.0; contract test catches payload changes |
| Community plugin telemetry used to exfiltrate data or flood the user's bill | Medium | High | Enum/int/bool-only manifest schemas, no free strings or IDs, host-side namespacing, rate limits plus auto-pause, per-plugin grants default off, elevated permission shown at install |
| Install ID makes one install's activity linkable inside a shared resource | Certain (by design) | Low | Random and local, resettable together with the hash salt, documented in the help topic and Settings; content is never sent |

### 10.1 Decisions (maintainer, 2026-10-16)

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Separate **Errors** level? | **Yes.** Off / Errors / Standard / Detailed. | §3.3 |
| 2 | Install ID sent by default? | **Yes.** A random, local, resettable `clubhouse.install.id`, rotated together with the hash salt, with its privacy properties documented. | §5.2, §6.8 |
| 3 | Community plugin telemetry? | **Yes.** A permissioned `api.telemetry` with a scoped namespace, a declared schema, the same allowlist and redaction, rate limits and per-plugin grants that default to off. | §6.9, Phase 8 |
| 4 | Where does OTLP go? | **In the main Settings UI** as a Destination choice. App Insights stays the preselected, one-field default. OTLP is HTTP/JSON only, HTTPS only, with headers in `safeStorage` and a destination confirmation. It moves from Phase 7 to Phase 1. | §6.3, §6.8, §9 |
| 5 | Ship an Azure Monitor Workbook? | **Yes, a planned deliverable.** A gallery template, a Deploy to Azure ARM wrapper and optional alert rules. It grows tab by tab with Phases 3–6 and is finished in Phase 7. | §6.10, §9 |
| 6 | How should Settings be laid out? | **App Insights first and simple:** a panel with the toggle, connection string and test event, nothing else. **Other destinations** (generic OTLP: endpoint, headers, protocol) sit in their own panel on the same page. One destination is active at a time. *(2026-10-17: multi-destination export, [#2005](https://github.com/Agent-Clubhouse/Clubhouse/pull/2005), lets several run at once, and the Framebriar destination, [#2006](https://github.com/Agent-Clubhouse/Clubhouse/pull/2006), adds an opt-in developer panel; §6.11.)* | §6.8 |
| 9 | Plugin telemetry default for official-registry plugins? | **Off for every plugin, official ones included.** A plugin sends nothing until the user switches on its toggle. | §6.9 |
| 8 | Local OTLP collector? | **Allowed.** Plain HTTP to `localhost`, `127.0.0.1` or `[::1]` only, with pinned resolution and Clubhouse's own ports refused. Everything else needs HTTPS. | §6.8 |
| 7 | Coverage goal and history window | **Broad coverage of critical paths**, weighted by regressions from **March 2026 onward**. That window covers the churn peak. Each hot spot is marked as a current or superseded code path. | §4.15, §12 |

No open questions remain.

---

## 11. Findings discovered while scoping

These came out of the code survey and log analysis. They are independent of telemetry, but several would make telemetry data wrong or misleading if not fixed first. All are filed under the `telemetry-scoping-2026-10-16` label. F4 extends the existing [#1575](https://github.com/Agent-Clubhouse/Clubhouse/issues/1575) as a comment rather than a new issue. **Fix F1, F2 ([#1917](https://github.com/Agent-Clubhouse/Clubhouse/issues/1917), [#1918](https://github.com/Agent-Clubhouse/Clubhouse/issues/1918)) before Phase 4 ships, and F4/F5 ([#1575](https://github.com/Agent-Clubhouse/Clubhouse/issues/1575), [#1920](https://github.com/Agent-Clubhouse/Clubhouse/issues/1920)) before Phase 3's safe-mode and update data is trusted.**

| # | Issue | Finding | Where | Telemetry impact |
|---|---|---|---|---|
| F1 | [#1917](https://github.com/Agent-Clubhouse/Clubhouse/issues/1917) · **closed**: fixed in [#1928](https://github.com/Agent-Clubhouse/Clubhouse/pull/1928); the code is removed by [#1937](https://github.com/Agent-Clubhouse/Clubhouse/pull/1937) | **Structured exits bypass `broadcastAgentExit`.** `onAgentExit` listeners (the queue runner) never see them, so structured queue tasks never complete. | `structured-manager.ts:125-126`, `agent-queue-runner.ts:252` | exit metrics would undercount structured runs |
| F2 | [#1918](https://github.com/Agent-Clubhouse/Clubhouse/issues/1918) · **closed**: fixed in [#1928](https://github.com/Agent-Clubhouse/Clubhouse/pull/1928) | **A headless exit by signal is reported as code 0** (`code ?? 0`, signal dropped). Killed headless queue tasks are marked "completed". | `headless-manager.ts:486,488` | exit class would be wrong |
| F3 | [#1919](https://github.com/Agent-Clubhouse/Clubhouse/issues/1919) | **Prompts and missions are written to local logs** through `args` and RPC params | `agent-system.ts:462`, `headless-manager.ts:540`, `acp-client.ts:103`, `codex-app-server-client.ts:60` | no export impact (never bridged), but a local privacy issue |
| F4 | [#1575](https://github.com/Agent-Clubhouse/Clubhouse/issues/1575) · **closed**: fixed in [#1929](https://github.com/Agent-Clubhouse/Clubhouse/pull/1929) (comment) | **Safe-mode logic appears inverted.** "Safe Mode" clears the marker so the renderer loads plugins; "Try Again Normally" keeps it, so the renderer enters safe mode. Also, `CLUBHOUSE_SAFE_MODE` is read in `initializeTrustedManifests` before it is set. | `safe-mode.ts:58-83`, `plugin-loader.ts:239`, `plugin-handlers.ts:30` | safe-mode events would be mislabeled |
| F5 | [#1920](https://github.com/Agent-Clubhouse/Clubhouse/issues/1920) · **closed**: fixed in [#1929](https://github.com/Agent-Clubhouse/Clubhouse/pull/1929) | **The update apply-attempt marker is never written on macOS/Windows relaunch**, because `app.exit(0)` runs before `recordSuccessfulApply`, so `update:apply-detect` cannot fire there | `auto-update-service.ts:826,852,945` | the update failure funnel would be blind on two OSes |
| F6 | [#1921](https://github.com/Agent-Clubhouse/Clubhouse/issues/1921) | **Uncaught `send EADDRNOTAVAIL 224.0.0.251`** from the mDNS socket. It happens twice in 10 days of logs, at fatal level, and the process continues. | `bonjour-service` via `annex-server.ts:2777` / `annex-client.ts:706` | first real crash class telemetry would report |
| F7 | [#1922](https://github.com/Agent-Clubhouse/Clubhouse/issues/1922) | **Canvas `saveCanvas`/`saveWires` are fire-and-forget.** Write failures become unhandled renderer rejections, and there is no renderer `unhandledrejection` handler. | `canvas/main.ts:253-254` | lost canvas writes are invisible today |
| F8 | [#1923](https://github.com/Agent-Clubhouse/Clubhouse/issues/1923) | **Shutdown has no global timeout**, and the log flush at quit is not awaited. Several `app.exit` paths skip all flushing. | `shutdown-guard.ts:17-22`, `log-service.ts:168`, `app-handlers.ts:421`, `auto-update-service.ts:887,899,969` | telemetry would need `flushBeforeExit` anyway (Phase 1) |
| F9 | [#1924](https://github.com/Agent-Clubhouse/Clubhouse/issues/1924) | **Pending permissions appear not to be cleared on agent exit when Annex is inactive** (`clearForAgent` is only called from the Annex exit subscription and the hook toggle). Not verified at runtime. | `annex-permission-queue.ts:226`, `annex-server.ts:2689` | stuck-permission counter would include dead agents |
| F10 | [#1925](https://github.com/Agent-Clubhouse/Clubhouse/issues/1925) | **`node-forge` is imported but not a declared dependency**; it resolves only through `selfsigned` from the dev tree | `annex-tls.ts:16`, `package.json` | none; a build fragility found while checking bundling |
| F11 | [#1926](https://github.com/Agent-Clubhouse/Clubhouse/issues/1926) | **`provider.checkAvailability` can block the main thread** for up to 5 s (`execFileSync` login shell `which`), and Codex runs `codex --version` on every spawn | `orchestrators/shared.ts:100`, `codex-cli-provider.ts:279` | `c.provider.check_availability` will show this; worth fixing independently |
| F12 | [#1927](https://github.com/Agent-Clubhouse/Clubhouse/issues/1927) | `hook-server` logs every hook event at **info**, which is 56% of all log lines | `hook-server.ts:323` | none; suggests demoting it to debug |

## 12. Regression-informed priorities

The coverage map in §4 was built from the code. This section weights it by **where Clubhouse has actually regressed**, so the flows with a track record of breaking get the strongest signals first.

### 12.1 Method and window

**Window:** 2026-03-01 to 2026-10-16. The maintainer asked to start in March because that is where churn peaked; the repository's first commit is 2026-02-15.

| Month (2026) | Feb* | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct* |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Non-merge commits | 259 | **627** | 124 | 54 | 38 | 19 | 16 | 155 | 13 |
| `fix`/`revert` commits | 114 | **284** | 69 | 39 | 15 | 13 | 9 | 15 | 11 |

\*Feb starts 2026-02-15; Oct runs to the 16th.

**Sources:**
- **455 fix and revert commits** on `main`: 337 from 2026-03-01 to 04-15 and 118 since.
- **About 356 closed issues:** 205 closed 2026-03-01 to 04-15 and 151 since.
- **31 open bugs.**

**How commits were grouped.** Each fix commit was assigned to a hot spot from the **source files it touched** (tests excluded), with the commit subject as a tie-breaker. Pure visual, theme and CI commits (about 28) are counted separately in §12.3.

**Current vs superseded.** For every fix commit, I took the non-trivial lines it added (25 characters or more) and measured the share still present in the same file at HEAD (`f4451aaa`). This is **line survival**.
- A fix with under 30% survival is **superseded**: that code path has since been rewritten.
- A hot spot is **Current** when its median survival is 80% or more and few of its fixes are superseded.

Line survival is a heuristic: a moved or reformatted line counts as lost. It is accurate enough to separate rewritten subsystems from live ones. The result is that most of the March code is still live: hot-spot medians range from 74% to 99%. Older incidents therefore remain mostly direct evidence, not just ideas.

**Reading the table:**
- **Silent:** the failure produced no user-visible error and no warn-level log. These are weighted highest.
- **P0:** must ship in Phases 3–5 (or Phase 6 for H9) at level E or S, with an alert-ready query in the Workbook.
- **P1:** ships in its normal phase.
- **P2:** best effort.

### 12.2 Hot spots

The **Fixes** column counts fix commits by files touched, before and after 2026-04-16. **Survival** is the median line survival, with the number of superseded fixes in brackets. **Incidents** are curated examples, March first.

| # | Hot spot (code path) | Fixes Mar–mid-Apr / since | Survival · code path | Incidents | How it failed | Signals that would have caught it (existing → **new**) | Priority |
|---|---|---|---|---|---|---|---|
| H1 | **Persistence and data integrity**: canvas KV, `agents.json`, `projects.json`, plugin KV, settings stores, group-project registry and bulletin | 12 / 10 | 99% (2) · **Current** | [#665](https://github.com/Agent-Clubhouse/Clubhouse/issues/665) (lost updates in file-based stores), [#706](https://github.com/Agent-Clubhouse/Clubhouse/issues/706), [#1225](https://github.com/Agent-Clubhouse/Clubhouse/issues/1225) (canvas autosave overwrote wires on boot); then [#1561](https://github.com/Agent-Clubhouse/Clubhouse/issues/1561), [#1548](https://github.com/Agent-Clubhouse/Clubhouse/issues/1548) (reverted in [#1551](https://github.com/Agent-Clubhouse/Clubhouse/issues/1551)), [#1909](https://github.com/Agent-Clubhouse/Clubhouse/issues/1909), [#1907](https://github.com/Agent-Clubhouse/Clubhouse/issues/1907), [#1906](https://github.com/Agent-Clubhouse/Clubhouse/issues/1906), [#1630](https://github.com/Agent-Clubhouse/Clubhouse/issues/1630), [#1644](https://github.com/Agent-Clubhouse/Clubhouse/issues/1644), [#1629](https://github.com/Agent-Clubhouse/Clubhouse/issues/1629), [#1627](https://github.com/Agent-Clubhouse/Clubhouse/issues/1627), [#1628](https://github.com/Agent-Clubhouse/Clubhouse/issues/1628), [#1660](https://github.com/Agent-Clubhouse/Clubhouse/issues/1660), [#1631](https://github.com/Agent-Clubhouse/Clubhouse/issues/1631) (open), [#1645](https://github.com/Agent-Clubhouse/Clubhouse/issues/1645), [#1639](https://github.com/Agent-Clubhouse/Clubhouse/issues/1639), [#1462](https://github.com/Agent-Clubhouse/Clubhouse/issues/1462), [#1659](https://github.com/Agent-Clubhouse/Clubhouse/issues/1659), [#1661](https://github.com/Agent-Clubhouse/Clubhouse/issues/1661) | **Mostly silent data loss.** Examples: autosave over a failed hydration, a good `.bak` overwritten by auto-recovery, non-atomic writes, a flush racing mutations. | `c.canvas.load` result, `c.project.store.recovery` → **`c.persist.writes` {store, result: ok/failed/skipped_guard}, `c.persist.write.duration`, `c.persist.recovery` event {store, action: quarantined/restored_from_backup/backup_corrupt/reset_to_default/backup_overwritten}, `c.persist.guard_blocked` {store, reason: degraded_hydration/verify_empty/barrier}, `c.persist.flush_barrier.wait`** at the shared write points (`createSettingsStore`, `agent-config` flush, `project-store` `writeStore`, `plugin-storage` `writeKey`, group-project registry and bulletin flush, canvas KV) | **P0** |
| H2 | **Provider CLI drift and structured protocols**: Codex, Copilot, ACP and stream-json | 21 / 18 | 89% (1) · **Current** | [#683](https://github.com/Agent-Clubhouse/Clubhouse/issues/683), [#1033](https://github.com/Agent-Clubhouse/Clubhouse/issues/1033), [#1215](https://github.com/Agent-Clubhouse/Clubhouse/issues/1215), [#1221](https://github.com/Agent-Clubhouse/Clubhouse/issues/1221), [#1314](https://github.com/Agent-Clubhouse/Clubhouse/issues/1314) (structured event validation and queue race); then [#1716](https://github.com/Agent-Clubhouse/Clubhouse/issues/1716) (Codex could not launch), [#1714](https://github.com/Agent-Clubhouse/Clubhouse/issues/1714), [#1710](https://github.com/Agent-Clubhouse/Clubhouse/issues/1710), [#1720](https://github.com/Agent-Clubhouse/Clubhouse/issues/1720) (7 of 9 server requests dropped, turns hang), [#1729](https://github.com/Agent-Clubhouse/Clubhouse/issues/1729), [#1911](https://github.com/Agent-Clubhouse/Clubhouse/issues/1911) (wire formats), [#1717](https://github.com/Agent-Clubhouse/Clubhouse/issues/1717), [#1725](https://github.com/Agent-Clubhouse/Clubhouse/issues/1725), [#1726](https://github.com/Agent-Clubhouse/Clubhouse/issues/1726), [#1727](https://github.com/Agent-Clubhouse/Clubhouse/issues/1727), [#1733](https://github.com/Agent-Clubhouse/Clubhouse/issues/1733), [#1732](https://github.com/Agent-Clubhouse/Clubhouse/issues/1732), [#1426](https://github.com/Agent-Clubhouse/Clubhouse/issues/1426), [#1718](https://github.com/Agent-Clubhouse/Clubhouse/issues/1718) (open), [#1728](https://github.com/Agent-Clubhouse/Clubhouse/issues/1728) (open), [#1719](https://github.com/Agent-Clubhouse/Clubhouse/issues/1719) (open), [#1531](https://github.com/Agent-Clubhouse/Clubhouse/issues/1531) (open) | Upstream CLI releases changed flags, wire formats and storage paths. Failures showed as hangs, empty lists or immediate exits. | `c.agent.spawn` errors, `early_failure` exit class, `c.agent.turn` end reason → **`c.provider.cli_version` (major.minor, captured in `check_availability`) on spawn spans and the `c.agent.spawns` / `c.agent.exit` metrics, so a spike lines up with an upstream release; `c.chat.protocol.unknown` {adapter, kind: request/notification/field, method from an allowlist or `unknown`}; `c.agent.turn.stalled` (a watchdog fires when a turn has no event for 5 min); `c.agent.hooks.silent_run` (a run over 60 s with hooks configured but zero hook events); `c.provider.list_sessions` span {result-count and dirs-scanned buckets}; `c.pty.inject` span {kind: shoulder_tap/polling/mcp_wake/mission, result: submitted/unconfirmed/failed}** | **P0** |
| H3 | **Hooks and permissions** | 8 / 3 | 92% (0) · **Current** | [#971](https://github.com/Agent-Clubhouse/Clubhouse/issues/971) (agent stuck in needs_permission after resolution); then [#1427](https://github.com/Agent-Clubhouse/Clubhouse/issues/1427) (permission timeout race), [#1558](https://github.com/Agent-Clubhouse/Clubhouse/issues/1558), [#1518](https://github.com/Agent-Clubhouse/Clubhouse/issues/1518), [#1721](https://github.com/Agent-Clubhouse/Clubhouse/issues/1721), [#5](https://github.com/Agent-Clubhouse/Clubhouse/issues/5) | A permission was never surfaced or timed out unseen; hooks were left behind after a stop. | `c.agent.permission` result and wait, `c.agent.permission.stuck` → **`c.permission.prompt_shown` bool on the permission span; `c.hooks.teardown` span {orchestrator, result}** | **P0** |
| H4 | **Terminal and PTY**: xterm rendering, input, replay | 24 / 6 | 84% (5) · **Current**, scroll-guardian approach superseded ([#1097](https://github.com/Agent-Clubhouse/Clubhouse/issues/1097), [#1115](https://github.com/Agent-Clubhouse/Clubhouse/issues/1115)) by the xterm 6 rework ([#1910](https://github.com/Agent-Clubhouse/Clubhouse/issues/1910)) | [#882](https://github.com/Agent-Clubhouse/Clubhouse/issues/882), [#886](https://github.com/Agent-Clubhouse/Clubhouse/issues/886), [#1081](https://github.com/Agent-Clubhouse/Clubhouse/issues/1081) (PTY buffer race), [#1097](https://github.com/Agent-Clubhouse/Clubhouse/issues/1097), [#1115](https://github.com/Agent-Clubhouse/Clubhouse/issues/1115); then [#1910](https://github.com/Agent-Clubhouse/Clubhouse/issues/1910), [#1393](https://github.com/Agent-Clubhouse/Clubhouse/issues/1393) ("can scroll but can't type"), [#1413](https://github.com/Agent-Clubhouse/Clubhouse/issues/1413), [#1389](https://github.com/Agent-Clubhouse/Clubhouse/issues/1389), [#1528](https://github.com/Agent-Clubhouse/Clubhouse/issues/1528) (macOS PTY worker starvation), [#1490](https://github.com/Agent-Clubhouse/Clubhouse/issues/1490), [#1503](https://github.com/Agent-Clubhouse/Clubhouse/issues/1503), [#1390](https://github.com/Agent-Clubhouse/Clubhouse/issues/1390), [#936](https://github.com/Agent-Clubhouse/Clubhouse/issues/936), [#1634](https://github.com/Agent-Clubhouse/Clubhouse/issues/1634), [#310](https://github.com/Agent-Clubhouse/Clubhouse/issues/310) (open) | Output was duplicated or garbled, input was lost, focus wedged. The PTY was healthy but the UI was not. | `c.pty.spawn` errors, time to shell ready, event-loop delay (§4.15), long frames in the `terminal` view → **`c.pty.write.dropped` (oversized writes), `c.terminal.focus_recovered` (the [#1393](https://github.com/Agent-Clubhouse/Clubhouse/issues/1393) recovery path firing), `c.terminal.replay` event {bytes bucket, dedup_trimmed}** | **P1** |
| H5 | **Plugin loading, activation and marketplace** | 9 / 4 | 88% (2) · **Current**, blob-URL loader ([#1499](https://github.com/Agent-Clubhouse/Clubhouse/issues/1499)) superseded by the plugin protocol ([#1522](https://github.com/Agent-Clubhouse/Clubhouse/issues/1522)) | [#409](https://github.com/Agent-Clubhouse/Clubhouse/issues/409), [#1061](https://github.com/Agent-Clubhouse/Clubhouse/issues/1061) (plugin discovery deadlock); then [#1499](https://github.com/Agent-Clubhouse/Clubhouse/issues/1499) → [#1520](https://github.com/Agent-Clubhouse/Clubhouse/issues/1520) → [#1522](https://github.com/Agent-Clubhouse/Clubhouse/issues/1522) → [#1527](https://github.com/Agent-Clubhouse/Clubhouse/issues/1527) (a four-PR regression chain), [#1554](https://github.com/Agent-Clubhouse/Clubhouse/issues/1554) (stuck activation), [#1832](https://github.com/Agent-Clubhouse/Clubhouse/issues/1832) (Monaco hang with a theme plugin), [#1903](https://github.com/Agent-Clubhouse/Clubhouse/issues/1903), [#1902](https://github.com/Agent-Clubhouse/Clubhouse/issues/1902) (failed install deleted existing plugins), [#1674](https://github.com/Agent-Clubhouse/Clubhouse/issues/1674), [#1654](https://github.com/Agent-Clubhouse/Clubhouse/issues/1654), [#1679](https://github.com/Agent-Clubhouse/Clubhouse/issues/1679) (open), [#1453](https://github.com/Agent-Clubhouse/Clubhouse/issues/1453) (open), [#1682](https://github.com/Agent-Clubhouse/Clubhouse/issues/1682) (open) | Plugins failed to import (multi-file, JS main, `./` paths), spun forever, or broke unrelated views. | `c.plugin.activate` errors, `c.plugin.protocol.requests`, `c.plugin.install` failure stage → **`c.plugin.module_load` result by `c.plugin.module_kind` (single_file/multi_file/js_main/ts_main); `c.plugin.activation.recovered`; `c.editor.monaco_load` span {result ok/timeout, `c.theme.kind`}; `c.plugin.install` result `rolled_back`; `c.plugin.command.duplicate_registration` counter** | **P0** |
| H6 | **Auto-update and install** (runtime only) | 13 / 4 | 74% (6) · **Partly superseded**: the March Windows update batch and PowerShell scripts ([#433](https://github.com/Agent-Clubhouse/Clubhouse/issues/433), [#441](https://github.com/Agent-Clubhouse/Clubhouse/issues/441), [#442](https://github.com/Agent-Clubhouse/Clubhouse/issues/442), [#453](https://github.com/Agent-Clubhouse/Clubhouse/issues/453)) and the first Linux path ([#1158](https://github.com/Agent-Clubhouse/Clubhouse/issues/1158)) were rewritten | [#433](https://github.com/Agent-Clubhouse/Clubhouse/issues/433), [#441](https://github.com/Agent-Clubhouse/Clubhouse/issues/441), [#442](https://github.com/Agent-Clubhouse/Clubhouse/issues/442), [#453](https://github.com/Agent-Clubhouse/Clubhouse/issues/453), [#704](https://github.com/Agent-Clubhouse/Clubhouse/issues/704) (blocking execSync at quit), [#1158](https://github.com/Agent-Clubhouse/Clubhouse/issues/1158); then [#1904](https://github.com/Agent-Clubhouse/Clubhouse/issues/1904) (macOS scripts, interrupted downloads), [#1591](https://github.com/Agent-Clubhouse/Clubhouse/issues/1591) (apply-on-quit fire-and-forget), [#1692](https://github.com/Agent-Clubhouse/Clubhouse/issues/1692) (apply marker cleared before spawn), [#1647](https://github.com/Agent-Clubhouse/Clubhouse/issues/1647) (rpm has no update path), [#1650](https://github.com/Agent-Clubhouse/Clubhouse/issues/1650), [#1698](https://github.com/Agent-Clubhouse/Clubhouse/issues/1698), [#1667](https://github.com/Agent-Clubhouse/Clubhouse/issues/1667), [#1590](https://github.com/Agent-Clubhouse/Clubhouse/issues/1590), [#1849](https://github.com/Agent-Clubhouse/Clubhouse/issues/1849) (open), [#1421](https://github.com/Agent-Clubhouse/Clubhouse/issues/1421) (open) | Updates silently did not apply, or applied on some install kinds only. | `c.update.*` spans → **`c.install.kind` resource attribute (`mac_zip`/`squirrel`/`deb`/`rpm`/`appimage`/`dev`); `c.update.download` result `resumed_after_interrupt`; `c.update.apply.verified` event at the next startup (the running version equals the version that was applied, else `apply_not_taken`). This catches silent failed applies on every OS, independent of the marker bug F5. Also: awaited `c.update.apply_on_quit` result.** | **P0** |
| H7 | **Agent lifecycle, identity and config** | 23 / 8 | 87% (4) · **Current** | [#663](https://github.com/Agent-Clubhouse/Clubhouse/issues/663), [#670](https://github.com/Agent-Clubhouse/Clubhouse/issues/670), [#724](https://github.com/Agent-Clubhouse/Clubhouse/issues/724) (spawn tracking race), [#791](https://github.com/Agent-Clubhouse/Clubhouse/issues/791), [#1366](https://github.com/Agent-Clubhouse/Clubhouse/issues/1366); then [#1913](https://github.com/Agent-Clubhouse/Clubhouse/issues/1913) (durable IDs colliding across projects), [#1519](https://github.com/Agent-Clubhouse/Clubhouse/issues/1519) (status not reconciled on reopen), [#1489](https://github.com/Agent-Clubhouse/Clubhouse/issues/1489), [#1459](https://github.com/Agent-Clubhouse/Clubhouse/issues/1459) (quick-agent timer race), [#1400](https://github.com/Agent-Clubhouse/Clubhouse/issues/1400), [#1562](https://github.com/Agent-Clubhouse/Clubhouse/issues/1562) (model setting reverts), [#1567](https://github.com/Agent-Clubhouse/Clubhouse/issues/1567) (New Agent silently fails with Free Agent Mode), [#1516](https://github.com/Agent-Clubhouse/Clubhouse/issues/1516) (group-project creation silently fails), [#1641](https://github.com/Agent-Clubhouse/Clubhouse/issues/1641), [#1640](https://github.com/Agent-Clubhouse/Clubhouse/issues/1640), [#1707](https://github.com/Agent-Clubhouse/Clubhouse/issues/1707), [#1646](https://github.com/Agent-Clubhouse/Clubhouse/issues/1646) (open), [#1706](https://github.com/Agent-Clubhouse/Clubhouse/issues/1706) (open) | **Often silent:** errors swallowed in the renderer, or state drifting from reality. | `c.agent.create` / `c.agent.spawn` → **`c.agent_config.id_collision_repaired` event; `c.agent.status_reconciled` counter {from, to}; `c.ui.action_failed` event {action from an enum: `agent_create`/`group_project_create`/`blueprint_import`/…, error.type} emitted from renderer catch sites that today only toast or swallow; `c.agent.name_collision` counter** | **P0** |
| H8 | **Group projects, bulletin and MCP delivery** | 23 / 9 | 80% (2) · **Current** | [#965](https://github.com/Agent-Clubhouse/Clubhouse/issues/965), [#990](https://github.com/Agent-Clubhouse/Clubhouse/issues/990) (multi-line paste needed Enter twice); then [#1830](https://github.com/Agent-Clubhouse/Clubhouse/issues/1830) (open: messages discarded while reporting success), [#1643](https://github.com/Agent-Clubhouse/Clubhouse/issues/1643), [#1555](https://github.com/Agent-Clubhouse/Clubhouse/issues/1555), [#1557](https://github.com/Agent-Clubhouse/Clubhouse/issues/1557), [#1549](https://github.com/Agent-Clubhouse/Clubhouse/issues/1549), [#1385](https://github.com/Agent-Clubhouse/Clubhouse/issues/1385) (duplicate loop injection), [#1680](https://github.com/Agent-Clubhouse/Clubhouse/issues/1680), [#1544](https://github.com/Agent-Clubhouse/Clubhouse/issues/1544) (open: MCP tool list empty until canvas renders), [#1730](https://github.com/Agent-Clubhouse/Clubhouse/issues/1730), [#1722](https://github.com/Agent-Clubhouse/Clubhouse/issues/1722), [#1673](https://github.com/Agent-Clubhouse/Clubhouse/issues/1673), [#1455](https://github.com/Agent-Clubhouse/Clubhouse/issues/1455) | Messages lost silently, MCP servers not delivered to Codex/Copilot, tools missing. | `c.mcp.tool_call`, `c.group.shoulder_tap` → **`c.bulletin.post` result {ok, evicted_topic, evicted_message}; `c.group.membership_sync` attribute `duplicate_injection_prevented`; `c.mcp.tools_list` event {tool-count bucket, empty}; `c.mcp.inject` attributes `c.mcp.delivery` (`config_file`/`launch_flag`) and result by orchestrator** | **P1** (`c.bulletin.post` is P0 while [#1830](https://github.com/Agent-Clubhouse/Clubhouse/issues/1830) is open) |
| H9 | **Annex** | 39 / 11 | 86% (1) · **Current** | [#685](https://github.com/Agent-Clubhouse/Clubhouse/issues/685), [#1063](https://github.com/Agent-Clubhouse/Clubhouse/issues/1063) (WS listener leak), [#1071](https://github.com/Agent-Clubhouse/Clubhouse/issues/1071), [#1114](https://github.com/Agent-Clubhouse/Clubhouse/issues/1114) (launch race, blank UI), [#1144](https://github.com/Agent-Clubhouse/Clubhouse/issues/1144) (DNS-SD discovery broken), [#1256](https://github.com/Agent-Clubhouse/Clubhouse/issues/1256), [#1285](https://github.com/Agent-Clubhouse/Clubhouse/issues/1285), [#1303](https://github.com/Agent-Clubhouse/Clubhouse/issues/1303); then [#1580](https://github.com/Agent-Clubhouse/Clubhouse/issues/1580) (IPv6 literals), [#1663](https://github.com/Agent-Clubhouse/Clubhouse/issues/1663) ("safe" permission granted full control), [#1632](https://github.com/Agent-Clubhouse/Clubhouse/issues/1632) (silent identity regeneration broke pairing), [#1613](https://github.com/Agent-Clubhouse/Clubhouse/issues/1613) (protocolVersion never checked), [#1609](https://github.com/Agent-Clubhouse/Clubhouse/issues/1609), [#1449](https://github.com/Agent-Clubhouse/Clubhouse/issues/1449), [#938](https://github.com/Agent-Clubhouse/Clubhouse/issues/938), [#1686](https://github.com/Agent-Clubhouse/Clubhouse/issues/1686), [#1685](https://github.com/Agent-Clubhouse/Clubhouse/issues/1685), [#1406](https://github.com/Agent-Clubhouse/Clubhouse/issues/1406) | Pairing broke silently after identity regeneration; some address families failed. | `c.annex.connect` errors (`cert_mismatch`, `protocol_incompatible`), `c.annex.pair` result → **`c.net.addr_family` (`ipv4`/`ipv6`) on discover and connect; `c.annex.identity.regenerated` (E-level event); `c.annex.control.denied` counter by permission scope** | **P0** (raised from P1: 50 fixes, most of them races) |
| H10 | **Canvas interaction, popouts and blueprints** | 58 / 22 | 80% (5) · **Current** | [#834](https://github.com/Agent-Clubhouse/Clubhouse/issues/834) (app-mode file crash), [#885](https://github.com/Agent-Clubhouse/Clubhouse/issues/885) (canvas agent view crash, hook ordering), [#924](https://github.com/Agent-Clubhouse/Clubhouse/issues/924), [#1225](https://github.com/Agent-Clubhouse/Clubhouse/issues/1225), [#1299](https://github.com/Agent-Clubhouse/Clubhouse/issues/1299); then [#1458](https://github.com/Agent-Clubhouse/Clubhouse/issues/1458) / [#1475](https://github.com/Agent-Clubhouse/Clubhouse/issues/1475) (popout IPC channel), [#1563](https://github.com/Agent-Clubhouse/Clubhouse/issues/1563) / [#1566](https://github.com/Agent-Clubhouse/Clubhouse/issues/1566) (blueprint import into the wrong scope), [#1569](https://github.com/Agent-Clubhouse/Clubhouse/issues/1569), [#1538](https://github.com/Agent-Clubhouse/Clubhouse/issues/1538), [#1545](https://github.com/Agent-Clubhouse/Clubhouse/issues/1545), [#1543](https://github.com/Agent-Clubhouse/Clubhouse/issues/1543), [#1693](https://github.com/Agent-Clubhouse/Clubhouse/issues/1693), [#1694](https://github.com/Agent-Clubhouse/Clubhouse/issues/1694), [#1460](https://github.com/Agent-Clubhouse/Clubhouse/issues/1460) (open), [#1454](https://github.com/Agent-Clubhouse/Clubhouse/issues/1454) (open) | Mostly UI behaviour; some silent no-ops. | `c.window.relay.timeouts`, `c.canvas.command` result, long frames in the `canvas` view → **`c.canvas.scope` (`app`/`project`) on `c.canvas.command` and blueprint import; `c.ui.action_failed` for canvas actions** | **P1** (raised from P2: the largest cluster, 80 fixes, code still live) |
| H11 | **Editor and files** | 22 / 4 | 83% (1) · **Current** | [#520](https://github.com/Agent-Clubhouse/Clubhouse/issues/520) (search crash, V8 serializer overflow), [#661](https://github.com/Agent-Clubhouse/Clubhouse/issues/661) (EXC_BREAKPOINT from a stale watcher), [#678](https://github.com/Agent-Clubhouse/Clubhouse/issues/678) (watcher handle leak), [#856](https://github.com/Agent-Clubhouse/Clubhouse/issues/856); then [#1908](https://github.com/Agent-Clubhouse/Clubhouse/issues/1908) (drafts lost on failed saves or stale reads), [#1905](https://github.com/Agent-Clubhouse/Clubhouse/issues/1905) (file watches not scoped per window; UTF-8 split across chunks), [#1493](https://github.com/Agent-Clubhouse/Clubhouse/issues/1493), [#1697](https://github.com/Agent-Clubhouse/Clubhouse/issues/1697) (duplicate watchers), [#1451](https://github.com/Agent-Clubhouse/Clubhouse/issues/1451) | **Silent loss of edits**; resource leaks. | `c.file.save` errors, `c.file_watch.active` → **`c.file.save` result `stale_conflict` / `draft_preserved`; `c.file_watch.active` split by `c.window.kind`; `c.editor.monaco_load` (shared with H5)** | **P0** for save, P1 otherwise |
| H12 | **Goobers panel** (experimental) | 0 / 8 issues | n/a (code added in Sep) · **Current** | [#1888](https://github.com/Agent-Clubhouse/Clubhouse/issues/1888), [#1881](https://github.com/Agent-Clubhouse/Clubhouse/issues/1881), [#1880](https://github.com/Agent-Clubhouse/Clubhouse/issues/1880), [#1876](https://github.com/Agent-Clubhouse/Clubhouse/issues/1876), [#1890](https://github.com/Agent-Clubhouse/Clubhouse/issues/1890), [#1879](https://github.com/Agent-Clubhouse/Clubhouse/issues/1879), [#1874](https://github.com/Agent-Clubhouse/Clubhouse/issues/1874), [#1894](https://github.com/Agent-Clubhouse/Clubhouse/issues/1894) (a 2026-09-19/20 burst) | Stale data presented as live; the SSE stream never went live. | `c.goobers.sse.connect`, liveness transitions → **`c.goobers.data.age` (observable gauge, s since the last fresh payload per stream); `c.goobers.stream.mode` events (`live`/`polling`)** | **P2** |
| H13 | **Electron upgrade fallout** | 2 / 0 | 100% (0) · **Current** | [#1586](https://github.com/Agent-Clubhouse/Clubhouse/issues/1586) (Electron 43: relocator renderer crash, node-pty `spawn-helper` permissions), [#1688](https://github.com/Agent-Clubhouse/Clubhouse/issues/1688), [#1681](https://github.com/Agent-Clubhouse/Clubhouse/issues/1681) (security fuses removed) | Crashes and spawn failures right after an upgrade. | `c.renderer.gone`, `c.pty.spawn` / `c.shell.spawn` errors, with `clubhouse.electron.version` on the resource → **`error.type=spawn_helper_not_executable`**. Fuse state is a build property: a CI check, not telemetry. | **P1** |
| H14 | **Assistant** (`features/assistant`, `assistant-handlers`, its structured mode and canvas commands) | 24 / 3 | 80% (1) · **Current** (experimental) | [#1169](https://github.com/Agent-Clubhouse/Clubhouse/issues/1169), [#1175](https://github.com/Agent-Clubhouse/Clubhouse/issues/1175), [#1176](https://github.com/Agent-Clubhouse/Clubhouse/issues/1176) (project re-selection stuck after leaving the assistant), [#1197](https://github.com/Agent-Clubhouse/Clubhouse/issues/1197) (React crash from hook ordering), [#1236](https://github.com/Agent-Clubhouse/Clubhouse/issues/1236), [#1301](https://github.com/Agent-Clubhouse/Clubhouse/issues/1301), [#1316](https://github.com/Agent-Clubhouse/Clubhouse/issues/1316), [#1317](https://github.com/Agent-Clubhouse/Clubhouse/issues/1317) | Render crashes, races between canvas commands and follow-ups, stuck navigation. | usage events, `AppErrorBoundary` → **assistant spawns go through `c.agent.spawn` with `c.agent.kind=assistant`; `c.assistant.turn` span (mode, end reason, error.type); `c.canvas.command` results tagged `c.command.source=assistant`; render errors carry `c.view=assistant`** | **Retired**: feature removed in [#1930](https://github.com/Agent-Clubhouse/Clubhouse/pull/1930); kept as history |

### 12.2a Cross-cutting patterns (mostly March)

These recur across hot spots. No single span catches them, so each gets a rule instead.

| Pattern | Examples | What catches it |
|---|---|---|
| **C1 · Async state races** (the most common March fix theme) | [#663](https://github.com/Agent-Clubhouse/Clubhouse/issues/663), [#665](https://github.com/Agent-Clubhouse/Clubhouse/issues/665), [#674](https://github.com/Agent-Clubhouse/Clubhouse/issues/674), [#680](https://github.com/Agent-Clubhouse/Clubhouse/issues/680), [#683](https://github.com/Agent-Clubhouse/Clubhouse/issues/683), [#684](https://github.com/Agent-Clubhouse/Clubhouse/issues/684), [#685](https://github.com/Agent-Clubhouse/Clubhouse/issues/685), [#724](https://github.com/Agent-Clubhouse/Clubhouse/issues/724), [#1062](https://github.com/Agent-Clubhouse/Clubhouse/issues/1062), [#1221](https://github.com/Agent-Clubhouse/Clubhouse/issues/1221) | Persistence conflict and guard events (H1); `c.agent.status_reconciled` (H7); an Annex snapshot sequence guard counter (H9). **New:** `c.state.stale_write_rejected` counter wherever a compare-and-set or generation guard rejects a stale update. Those guards exist today, e.g. the `sessionPauseOwner` CAS ([#1468](https://github.com/Agent-Clubhouse/Clubhouse/issues/1468)) and the theme generation guard. |
| **C2 · Leaks** (timers, listeners, watchers, store growth) | [#678](https://github.com/Agent-Clubhouse/Clubhouse/issues/678), [#791](https://github.com/Agent-Clubhouse/Clubhouse/issues/791), [#1063](https://github.com/Agent-Clubhouse/Clubhouse/issues/1063), [#1072](https://github.com/Agent-Clubhouse/Clubhouse/issues/1072), [#1316](https://github.com/Agent-Clubhouse/Clubhouse/issues/1316), [#1317](https://github.com/Agent-Clubhouse/Clubhouse/issues/1317), [#1363](https://github.com/Agent-Clubhouse/Clubhouse/issues/1363) | Memory gauges per process (§4.15), plotted against session age in the Workbook; `c.file_watch.active`. **New:** `c.renderer.ipc_listeners` and `c.main.timers` observable gauges (counts only), sampled every 60 s at level S. |
| **C3 · Render crashes from hook-ordering or state bugs** | [#834](https://github.com/Agent-Clubhouse/Clubhouse/issues/834), [#885](https://github.com/Agent-Clubhouse/Clubhouse/issues/885), [#1197](https://github.com/Agent-Clubhouse/Clubhouse/issues/1197) | `AppErrorBoundary` and `PluginErrorBoundary` exception records with `c.view` (§4.2). The fingerprint groups recurrences across versions. |
| **C4 · Swallowed errors** | [#690](https://github.com/Agent-Clubhouse/Clubhouse/issues/690), [#706](https://github.com/Agent-Clubhouse/Clubhouse/issues/706), [#1215](https://github.com/Agent-Clubhouse/Clubhouse/issues/1215), [#1316](https://github.com/Agent-Clubhouse/Clubhouse/issues/1316), plus H7's silent failures | The swallowed-catch lint rule (§12.4) and `c.ui.action_failed`. |

### 12.3 Regressions telemetry cannot catch (left to CI and E2E)

- **Release and signing pipeline:** [#1836](https://github.com/Agent-Clubhouse/Clubhouse/issues/1836), [#1838](https://github.com/Agent-Clubhouse/Clubhouse/issues/1838), [#1846](https://github.com/Agent-Clubhouse/Clubhouse/issues/1846) (Windows Squirrel signing), [#1895](https://github.com/Agent-Clubhouse/Clubhouse/issues/1895) (unsealed ad-hoc macOS bundle), [#1589](https://github.com/Agent-Clubhouse/Clubhouse/issues/1589), [#1670](https://github.com/Agent-Clubhouse/Clubhouse/issues/1670). These fail before a build reaches users.
- **Visual, layout, theme and accessibility:** for example [#1480](https://github.com/Agent-Clubhouse/Clubhouse/issues/1480), [#1471](https://github.com/Agent-Clubhouse/Clubhouse/issues/1471) (open), [#1454](https://github.com/Agent-Clubhouse/Clubhouse/issues/1454) (open), the z-index and focus-ring sweeps ([#1433](https://github.com/Agent-Clubhouse/Clubhouse/issues/1433), [#1470](https://github.com/Agent-Clubhouse/Clubhouse/issues/1470), [#1477](https://github.com/Agent-Clubhouse/Clubhouse/issues/1477)), and theme token migrations. Telemetry sees that a view rendered, not how it looked.
- **Test-suite flakes:** [#1894](https://github.com/Agent-Clubhouse/Clubhouse/issues/1894), [#1407](https://github.com/Agent-Clubhouse/Clubhouse/issues/1407), [#1469](https://github.com/Agent-Clubhouse/Clubhouse/issues/1469), [#1550](https://github.com/Agent-Clubhouse/Clubhouse/issues/1550).

### 12.4 What changes in the plan

- **P0 flows** are H1, H2, H3, H5, H6, H7, **H9**, the H11 save path, and `c.bulletin.post` from H8. H10 is P1. H14 is retired (Assistant removed in #1930).
  - Their new signals are tagged E or S, never D.
  - They are listed in Phases 3–5 (§9).
  - Each gets an alert-ready query in the Phase 7 workbook. Examples: a persistence `recovery` or `guard_blocked` event, `apply_not_taken`, spawn `early_failure` grouped by `c.provider.cli_version`, and `c.agent.hooks.silent_run`.
- **Cross-cutting rule from H1, H7 and H11.** Any `catch` that swallows an error or turns it into a toast **must** emit either `c.ui.action_failed` (renderer) or an exception record (main) once telemetry lands. A lint rule enforces it in `src/renderer/features/**` and `src/main/services/**`: a `catch` block must contain a `tel.` call or an `// telemetry-exempt: <reason>` comment. This rule is in Phase 3. It is the single change most likely to have caught [#1567](https://github.com/Agent-Clubhouse/Clubhouse/issues/1567), [#1516](https://github.com/Agent-Clubhouse/Clubhouse/issues/1516), [#1641](https://github.com/Agent-Clubhouse/Clubhouse/issues/1641) and [#1908](https://github.com/Agent-Clubhouse/Clubhouse/issues/1908) early.
- **Version attributes for drift.** `c.provider.cli_version`, `clubhouse.electron.version` and `c.install.kind` make "it broke after X upgraded" a query rather than an investigation. Across H2, H6 and H13 that pattern accounts for about 30 curated incidents and 58 fix commits since March.

---

## Appendix A: Span and metric name index

**Spans (roots marked R):**

| Area | Spans |
|---|---|
| App | `c.app.startup`ᴿ (`.main_ready`, `.register_ipc`, `.safe_mode_check`, `.create_window`, `.renderer_init`, `.load_settings`, `.plugin_system`), `c.app.shutdown`ᴿ, `c.window.create`ᴿ, `c.renderer.unresponsive`ᴿ |
| Update | `c.update.check`ᴿ (`.fetch_manifest`), `c.update.download`ᴿ (`.verify`), `c.update.apply`ᴿ, `c.update.session_resume`ᴿ |
| Agent | `c.agent.create`ᴿ, `c.agent.delete`ᴿ, `c.agent.quick_launch`ᴿ (renderer), `c.agent.spawn`ᴿ (`c.provider.resolve`, `c.provider.check_availability`, `c.agent.materialize`, `c.agent.prepare_pty`, `c.hooks.configure`, `c.mcp.inject`, `c.provider.build_command`, `c.pty.spawn`, `c.headless.spawn`, `c.chat.start`), `c.agent.run`, `c.agent.turn`ᴿ (`c.chat.rpc`), `c.agent.permission`ᴿ, `c.agent.exit`ᴿ, `c.agent.kill`ᴿ, `c.agent.tool_call` (D) |
| Group | `c.group.shoulder_tap`ᴿ, `c.group.membership_sync`ᴿ |
| MCP / hooks | `c.mcp.bridge.start`, `c.mcp.tool_call`ᴿ, `c.hook_server.start` |
| Projects / git / files | `c.project.switch`ᴿ, `c.project.add`ᴿ, `c.project.remove`ᴿ, `c.project.git_init`ᴿ, `c.git.<op>`ᴿ, `c.git.worktree_add`, `c.git.worktree_remove`, `c.file.open`ᴿ, `c.file.save`ᴿ, `c.file.tree.read`, `c.search.query`ᴿ, `c.editor.open_external` |
| Plugins / canvas / marketplace | `c.plugin_system.init`, `c.plugin.activate`, `c.plugin.deactivate`, `c.canvas.load`ᴿ, `c.canvas.command`ᴿ, `c.marketplace.fetch_registry`ᴿ, `c.plugin.install`ᴿ, `c.plugin.update_check`ᴿ, `c.plugin.update`ᴿ, `c.plugin.uninstall`ᴿ |
| Annex | `c.annex.server.start`ᴿ, `c.annex.discover`ᴿ, `c.annex.pair`ᴿ, `c.annex.connect`ᴿ, `c.annex.snapshot.build`, `c.annex.rest`ᴿ (D), `c.annex.remote_spawn`ᴿ, `c.annex.replay`ᴿ |
| Goobers | `c.goobers.activate`ᴿ, `c.goobers.daemon.start`ᴿ, `c.goobers.daemon.stop`ᴿ, `c.goobers.sse.connect`ᴿ |
| IPC | `c.ipc.<channel>` (D) |

**Spans added in revision 2:** `c.shell.spawn`ᴿ, `c.provider.list_sessions`, `c.pty.inject`, `c.hooks.teardown`, `c.editor.monaco_load`, plugin spans `clubhouse.plugin.<name>`ᴿ.

**Events added in revision 2:** `c.process.eventloop.blocked`, `c.persist.recovery`, `c.persist.guard_blocked`, `c.agent.turn.stalled`, `c.agent.hooks.silent_run`, `c.agent_config.id_collision_repaired`, `c.ui.action_failed`, `c.update.apply.verified`, `c.terminal.replay`, `c.mcp.tools_list`, `c.annex.identity.regenerated`, `c.goobers.stream.mode`, plugin events `clubhouse.plugin.<name>`.

**Metrics:**

| Area | Metrics |
|---|---|
| App | `c.app.sessions`, `c.app.startup.duration`, `c.app.session.duration`, `c.app.shutdown.duration`, `c.app.unclean_exits`, `c.window.relay.timeouts`, `c.window.popouts` |
| Update | `c.update.checks`, `c.update.failures`, `c.update.download.duration` |
| Agent | `c.agent.spawns`, `c.agent.spawn.duration`, `c.agent.time_to_first_output`, `c.agent.run.duration`, `c.agent.active`, `c.pty.output.bytes`, `c.agent.tool_calls`, `c.agent.hook_events`, `c.agent.turn.duration`, `c.agent.tokens`, `c.agent.cost`, `c.agent.permission.wait`, `c.agent.permission.stuck` |
| Group | `c.group.bulletin.posts` |
| MCP / hooks | `c.mcp.tool_calls`, `c.mcp.tool_call.duration`, `c.mcp.auth_rejected`, `c.mcp.sessions`, `c.hook_server.requests` |
| Projects / git / files | `c.projects.count`, `c.git.status.duration`, `c.git.status.polls`, `c.git.subprocess.duration`, `c.file.ops`, `c.file_watch.active`, `c.file_watch.errors` |
| Plugins / canvas | `c.plugin.permission_violation`, `c.plugin.api_calls`, `c.plugin.protocol.requests`, `c.canvas.save.duration`, `c.canvas.saves`, `c.canvas.views` |
| Annex | `c.annex.reconnects`, `c.annex.reconnect.delay`, `c.annex.disconnects`, `c.annex.heartbeat.rtt`, `c.annex.events`, `c.annex.events.bytes`, `c.annex.send_failures`, `c.annex.clients` |
| Goobers | `c.goobers.polls`, `c.goobers.poll.skipped`, `c.goobers.poll.duration` |
| Telemetry | `c.telemetry.dropped`, `c.telemetry.export.failures`, `c.telemetry.offline.items` |
| Process health (rev 2) | `c.process.eventloop.delay.p99`, `c.process.eventloop.delay.max`, `c.process.memory`, `c.process.cpu`, `c.renderer.long_frames`, `c.renderer.long_frame.duration` |
| Regression signals (rev 2) | `c.persist.writes`, `c.persist.write.duration`, `c.persist.flush_barrier.wait`, `c.chat.protocol.unknown`, `c.agent.status_reconciled`, `c.agent.name_collision`, `c.pty.write.dropped`, `c.terminal.focus_recovered`, `c.plugin.module_load`, `c.plugin.activation.recovered`, `c.plugin.command.duplicate_registration`, `c.bulletin.post`, `c.annex.control.denied`, `c.goobers.data.age` |
| Plugin telemetry (rev 2) | `c.plugin.telemetry.rejected`, `c.plugin.telemetry.throttled`, plugin metrics `clubhouse.plugin.<name>` |

## Appendix B: App Insights table mapping

| OTel signal | App Insights table | Notes |
|---|---|---|
| Root span (SERVER) | `requests` | `name`/`operation_Name` = span name; `success` from status; `resultCode` = `c.outcome` |
| Child span (INTERNAL) | `dependencies` | `type` = `InProc` |
| Log record with `event.name` / `microsoft.custom_event.name` | `customEvents` | feature usage, snapshot, safe mode |
| Log record with `exception.*` | `exceptions` | sanitized type and stack, synthetic message |
| Other log records (bridged appLog) | `traces` | `severityLevel` per §6.6 |
| Metrics | `customMetrics` | `valueCount`/`valueSum`/`valueMin`/`valueMax`; dimensions in `customDimensions` |
| Resource | `cloud_RoleName` = `service.name`, `cloud_RoleInstance` = `service.instance.id`, `application_Version` = `service.version`, `user_Id` = `enduser.pseudo.id` (install ID) | App Insights masks client IPs by default (stored as `0.0.0.0`) but derives coarse geo from them at ingestion. Document this in the help topic. |
