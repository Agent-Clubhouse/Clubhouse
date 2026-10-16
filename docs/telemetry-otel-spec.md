# Clubhouse Telemetry Export: OpenTelemetry Instrumentation Spec

| | |
|---|---|
| **Status** | Draft for review (scoping/design only, no implementation) |
| **Date** | 2026-10-16 |
| **Target** | Clubhouse 0.43+ (Electron 43, Node ≥ 22) |
| **Supersedes** | [`docs/telemetry-design/`](telemetry-design/01-overview.md) (June 2026 log-subscriber plugin design) |

## 0. Summary

Clubhouse gets an **opt-in, user-configured telemetry export**. Telemetry is off by default.

A user creates their own Azure Application Insights resource and pastes its **connection string** into Settings → Logging → Telemetry export. Clubhouse then sends traces, metrics and sanitized error records to that resource. Nothing goes to the Clubhouse maintainers and no ingestion key ships in the binary. Ingestion with only an instrumentation key was retired in 2025, so the connection string is the only supported input.

How it works:

- It is built on **OpenTelemetry (OTel)**, set up manually in the **main process only**. The renderer forwards to main over IPC. The exporter is `@azure/monitor-opentelemetry-exporter`, with OTLP as a later option.
- Coverage follows **user flows**, not existing log lines. Each important flow (startup, agent spawn → run → exit, permission round trip, project switch, plugin activation, update, Annex connect, …) gets a span tree, a small set of metrics and classified error records. The existing `appLog` stream is not mirrored. It bridges in only where a call site opts in (§6.6).
- **Privacy is enforced in code, not by convention.** A typed attribute registry is an allowlist. A redaction processor drops anything outside it before export. Prompts, terminal output, file contents, paths, and repo, branch, project and agent names are never sent. Identifiers are HMAC-hashed with a per-install salt.

The estimate is **7 PR-sized phases**, about 4,000–5,500 lines of production code plus tests. Phases 1–3 alone give a useful product: errors, startup, update and session health. See §9.

How this differs from the June 2026 design in `docs/telemetry-design/`:

| June 2026 design | This spec | Why |
|---|---|---|
| Built-in ingestion key, maintainers' resource | **User's own resource only**; no key ships | Decided by the maintainer: self-configured, no maintainer-run backend |
| `applicationinsights` SDK `trackEvent` | **OTel API + SDK, Azure Monitor exporter** | Vendor-neutral; OTLP later costs one exporter swap |
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

- Maintainer-run aggregate telemetry. Nothing is collected centrally.
- Auto-instrumentation of `http`, `fs` or `child_process`.
- Session replay, UI click tracking or per-keystroke anything.
- Microsoft Entra ID (AAD) ingestion auth. Resources with `DisableLocalAuth=true` reject connection-string ingestion; see §10 for the follow-up.
- Instrumenting the Annex iOS app. It is not Clubhouse code; see §7.
- Remote configuration or a server-side kill switch. Nothing phones home.

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
- **Percentiles come from spans, not histograms.** The Azure exporter sends histogram metrics to `customMetrics` as count/sum/min/max, so they have no buckets and no percentiles. p50/p95 come from `requests`/`dependencies` `duration` via KQL `percentile()`. Histograms are still recorded for averages, cheap dashboards and OTLP backends later. Every latency that needs percentiles must therefore be a span, unsampled for its flow (§6.4).

### 3.3 Telemetry levels (user-selectable)

| Level | Exceptions and crash events | Lifecycle and flow traces | Metrics | High-volume detail (tool-call spans, IPC latency spans, per-route Annex spans) |
|---|---|---|---|---|
| **Off** (default) | — | — | — | — |
| **Errors** | ✓ | only spans that end in error (tail decision, §6.4) | health counters only | — |
| **Standard** | ✓ | ✓ | ✓ | — |
| **Detailed** | ✓ | ✓ | ✓ | ✓ |

The level is the main volume and cost control. Every instrument and span in §4 is tagged with its minimum level.

---

## 4. Coverage map by flow

Each subsection lists the **spans** (with boundaries in code), **metrics**, **errors** (the `error.type` enum) and **level**.

- File references are to `src/` as of `f4451aaa`.
- Attribute names refer to the registry in §5. `c.` is shorthand for `clubhouse.`.
- Level codes: E = Errors, S = Standard, D = Detailed.

### 4.1 App lifecycle: startup, shutdown, windows

**Spans**

| Span | Start → end | Children | Level |
|---|---|---|---|
| `c.app.startup` (root, SERVER) | Module load in `main/index.ts`. Record `performance.timeOrigin`; backdate the span start to process start using `process.hrtime` relative to `performance.timeOrigin`. **End:** the new `app:renderer-ready` IPC, sent by the renderer after `initApp()` resolves. | `c.app.startup.main_ready` (module load → `app.on('ready')`); `c.app.startup.register_ipc` (`registerAllHandlers`, `index.ts:199`); `c.app.startup.safe_mode_check` (`:227`); `c.app.startup.create_window` (`createWindow` → `ready-to-show`); `c.app.startup.renderer_init`, carried from the renderer (§6.2), with children `load_settings` (`app-initializer.ts:38`) and `plugin_system` (`plugin-loader.ts:234`). Fire-and-forget services such as hook server, MCP bridge and Annex get their own short spans parented to startup but do not gate its end. | S |
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
| `c.window.relay.timeouts` | counter | `c.relay.kind` (`agent_state`/`hub`/`canvas`, `window-handlers.ts:104,312,378`) | S |
| `c.window.popouts` | counter | `c.popout.type` (`agent`/`hub`/`canvas`) | S |

**Detecting unclean exits.** Write `telemetry/last-session.json` at startup containing `{session_id, started_at}`. Mark it clean in `c.app.shutdown`. If it is still unmarked at the next startup, emit `c.app.unclean_exit`. This is cheap crash detection without `crashReporter`.

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
  └─ c.pty.spawn | c.headless.spawn | c.structured.start
c.agent.first_output      (event on run; carries latency)
c.agent.turn              (structured mode; one per turn)
c.agent.permission        (root per permission request)
c.agent.exit              (root; short; classifies the exit)
c.agent.kill              (root; user/system kill with escalation)
```

#### Create (`ipc/agent-handlers.ts:56` → `agent-config.ts:1069`)

| Span | Children | Result enum | Level |
|---|---|---|---|
| `c.agent.create` | `c.git.rev_parse`, `c.git.bootstrap_commit` (empty repo), `c.git.branch`, `c.git.worktree_add` (`:1131`), `c.agent_config.write`, `c.agent.apply_defaults`, `c.agent.persona_inject` | `error.type ∈ {worktree_failed, write_failed}`; non-fatal `c.warnings` list: `defaults_failed`, `persona_failed` | S |

Quick agents have no main-process create step. The renderer `spawnQuickAgent` (`agentLifecycleSlice.ts:25`) starts a renderer span `c.agent.quick_launch` that is propagated into `SPAWN_AGENT` (§6.2). That is how the renderer-side work (summary instruction fetch, template expansion) gets measured.

#### Spawn (`agent-system.ts:98`)

- **Boundaries:** `spawnAgent` entry to the `return` after `AGENT_AWOKE` (`:269`, `:321` or `:328`), or the throw (`:115-121`, `:329-332`).
- **Children:** listed in the tree above, with source lines in the agent survey. `provider.check_availability` matters most: it can run a **synchronous `execFileSync(shell -ilc which)` for up to 5 s on the main thread** (`orchestrators/shared.ts:100`). Codex also runs `codex --version` on every spawn. The span carries `c.binary.lookup_tier ∈ {cache, well_known, path_scan, login_shell}`.
- **Attributes:**
  - `c.agent.kind` (`durable`/`quick`/`companion`/`assistant`)
  - `c.orchestrator` (`claude-code`/`codex-cli`/`copilot-cli`/`other`)
  - `c.agent.runtime` (`pty`/`headless`/`structured`)
  - `c.agent.runtime.reason` (`requested`/`fallback_no_mission`/`fallback_not_capable`/`default`)
  - `c.structured.adapter` (`stream_json`/`acp`/`codex_app_server`)
  - `c.agent.resume` (bool)
  - `c.model.family` (bucketed against `MODEL_OPTIONS`: `opus`/`sonnet`/`haiku`/`gpt-5`/`default`/`other`)
  - `c.agent.uses_worktree`, `c.clubhouse_mode`, `c.mcp.enabled`, `c.hooks.enabled`, `c.profile.active`, `c.wrapper.applied` (all bool)
  - `c.agent.id_hash`, `c.agent.run.id_hash`
- **`error.type`:** `orchestrator_unknown`, `binary_not_found`, `binary_check_failed`, `preflight_failed`, `cwd_invalid`, `pty_spawn_failed`, `headless_no_pid`, `structured_start_failed`, `materialize_failed` (non-fatal warning).

#### Run, first output and readiness

There is no CLI "ready" signal. The proxies below are recorded as **events** on a minimal `c.agent.run` span. That span is started at spawn and **ended at exit**, but because it can be long-lived it is exported only when it ends, as normal OTel behavior. A run lasting days is acceptable: an unfinished span is simply never exported, and the metrics below still capture the data.

- `c.agent.shell_ready`: the first PTY `onData`, where the pending command flushes (`pty-manager.ts:125-137`). PTY only.
- `c.agent.first_output`: the first data after the flush (PTY), the first stdout JSONL event (headless, `headless-manager.ts:328`), or the first `text_delta` (structured).
- `c.agent.first_hook`: the first hook event for this agent ID (`hook-server.ts`). This is the best "the CLI is alive and working" proxy for hook-capable providers.

**Metrics (level S)**

| Name | Kind / unit | Attributes |
|---|---|---|
| `c.agent.spawns` | counter | kind, orchestrator, runtime, `clubhouse.outcome` |
| `c.agent.spawn.duration` | histogram, s | kind, orchestrator, runtime |
| `c.agent.time_to_first_output` | histogram, s | orchestrator, runtime |
| `c.agent.run.duration` | histogram, s | kind, orchestrator, runtime, `c.agent.exit.class` |
| `c.agent.active` | UpDownCounter (or observable gauge from `agentRegistry`) | kind, runtime |
| `c.pty.output.bytes` | counter, By; **incremented at exit from a per-session byte total, never per chunk** | orchestrator |
| `c.agent.tool_calls` | counter, fed from hook-server `pre_tool`/`post_tool`/`tool_error` and from structured/headless `tool_start`/`tool_end` | orchestrator, `c.tool.bucket`, `c.tool.result` (`ok`/`error`) |
| `c.agent.hook_events` | counter | orchestrator, `c.hook.kind` (`pre_tool`/`post_tool`/`stop`/`notification`/`tool_error`/`permission_request`) |

**Tool name bucketing.** `c.tool.bucket` reports the provider's built-in tool name, from a static list per orchestrator: `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`, `Agent`, …. Otherwise it reports `mcp_clubhouse`, `mcp_other` or `other`. **MCP tool names are never sent**: they embed server names and hashes, and are user-defined.

**Tool-call spans (level D only).** A span `c.agent.tool_call` pairs `pre_tool` with `post_tool`/`tool_error`, matched by agent ID and tool-use ID where the hook payload carries one. For headless and structured runs the pairing uses `tool_use.id` → `tool_result.tool_use_id`. The adapters hard-code `durationMs: 0`, so the duration comes from timestamps. At about 1,300 tool calls a day for this user, the volume is acceptable as opt-in only.

#### Structured turns (`structured-manager.ts`)

| Span | Boundaries | Attributes / errors | Level |
|---|---|---|---|
| `c.agent.turn` | `startStructuredSession`/`sendMessage` → `end` event | `c.turn.end_reason` (`complete`/`error`/`cancelled`/`timeout`); `c.turn.time_to_first_token` (s, also an event); `c.turn.tool_calls` (count); token usage as `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (numbers only, from `usage` events); `error.type ∈ {max_tokens, max_turn_requests, refusal, prompt_failed, session_start_failed, turn_failed, rpc_timeout, process_exited, unhandled_server_request}` | S |
| ↳ `c.structured.rpc` | ACP `initialize` / `session/new` / `session/prompt`; Codex `thread/start` / `turn/start` | `rpc.method` from a fixed list | D |

Metrics: `c.agent.turn.duration` (s), `c.agent.tokens` counter (unit `{token}`, split by `gen_ai.token.type` = `input`/`output`), `c.agent.cost` (USD, from headless `result.total_cost_usd` where present).

#### Permissions (hook path and structured path)

| Span | Boundaries | Attributes | Level |
|---|---|---|---|
| `c.agent.permission` (root) | `permissionQueue.createPermission` (`hook-server.ts:162`) → `res.end` (`:194`). For structured runs: the `permission_request` event → `respondToPermission` (`structured-manager.ts:191`). | `c.permission.decision` (`allow`/`deny`/`ask`), `c.permission.result` (`resolved`/`timeout`/`expired`/`agent_mismatch`/`not_found`), `c.permission.source` (`desktop`/`annex`), `c.permission.path` (`hook`/`structured`), `c.tool.bucket`, orchestrator | S |

Metrics: `c.agent.permission.wait` histogram (s; already computed as `elapsedMs`), `c.agent.permission.stuck` counter (the 30 s stuck scan, `hook-server.ts:358`).

#### Exit and kill

| Span | Boundaries | Attributes | Level |
|---|---|---|---|
| `c.agent.exit` (root, short) | `broadcastAgentExit` (`agent-exit-broadcast.ts:26`), plus **the structured exit path that bypasses it** (`structured-manager.ts:125`; see §11) | `c.agent.exit.class` (see below), `process.exit.code` (int), `c.agent.exit.signal` (`SIGTERM`/`SIGKILL`/none), `c.agent.run.duration_s`, `c.pty.output.bytes` | S |
| `c.agent.kill` | `killAgent` (`agent-system.ts:526`) → exit | `c.kill.trigger` (`user`/`quick_auto_stop`/`shutdown`/`replace`/`sweeper`), `c.kill.stage_reached` (`exit_command`/`eof`/`sigterm`/`sigkill`, from `gracefulKill` `:498-548`) | S |

`c.agent.exit.class` takes one of:

| Value | Meaning |
|---|---|
| `completed` | exit 0, not killed |
| `failed` | non-zero, not killed |
| `early_failure` | exit within 3 s of spawn; mirrors `agentStatusSlice.ts:41` |
| `killed_user` | user kill |
| `killed_escalated` | SIGKILL reached |
| `stale_swept` | removed by the stale sweeper |
| `structured_error` | `end.reason=error` |
| `replaced` | session replaced. This currently emits no exit event; instrument it at `pty-manager.ts:290`. |

#### Agent queue (`agent-queue-runner.ts`)

- **`c.queue.task` (root, S):** from `createdAt` to completion. Children: `c.queue.wait` (created → claimed, which is not computed today) and `c.queue.run` (startedAt → exit, parent of the agent spawn).
- **Attributes:** `c.queue.task.status`, `error.type ∈ {queue_missing, no_project, spawn_failed, nonzero_exit}`, `c.queue.concurrency`.
- **Metrics:** `c.queue.depth` (observable gauge), `c.queue.tasks` counter.

#### Group projects and shoulder taps

- `c.group.shoulder_tap` (S): `executeShoulderTap` (`group-project-shoulder-tap.ts:63`), with a child per target. Attributes: `c.delivery.result` (`delivered`/`not_running`/`unsupported_runtime`/`failed`), `c.agent.runtime`, `c.targets.count`.
- `c.group.membership_sync` (S): `syncMemberships`. Attributes: join/leave counts.
- Counter `c.group.bulletin.posts`, which comes from the MCP tool calls.

### 4.5 Clubhouse MCP bridge (`clubhouse-mcp/`)

| Instrument | Boundaries / attributes | Level |
|---|---|---|
| `c.mcp.bridge.start` span | `bridge-server.ts:302` | S |
| `c.mcp.tool_call` span | `handleToolsCall` `:126` → JSON-RPC return. Attributes: `c.mcp.tool` (the **built-in Clubhouse tool name only**, from `tool-registry.ts`; plugin-contributed tools are bucketed as `plugin`), `c.mcp.result` (`ok`/`tool_error`/`threw`), `error.type ∈ {unknown_tool, no_binding, invalid_args, admin_denied, internal}` | S |
| `c.mcp.tool_calls` counter, `c.mcp.tool_call.duration` histogram | tool, result | S |
| `c.mcp.auth_rejected` counter | nonce 403s (`:71-82`) | E |
| `c.mcp.sessions` gauge | SSE connections | D |

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

### 4.8 Git and worktrees (`git-service.ts`, `agent-config.ts`)

- **User-initiated operations** get spans (`c.git.op`, S). The operations are checkout, stage/unstage (all), discard, commit, push, pull, create branch, stash/pop, diff, show commit, worktree list.
  - Span name: `c.git.<op>`.
  - Attributes: `c.git.op`, `c.outcome`, `process.exit.code`, `c.git.timed_out`.
  - `error.type ∈ {timeout, not_a_repo, validation, nonzero_exit, no_remote, conflict, auth}`, classified from exit codes and stderr **patterns matched locally**. Stderr is never sent.
- **Worktree create/remove** spans are children of `c.agent.create` and `c.agent.delete`. `c.agent.delete` carries `c.agent.delete.mode ∈ {commit_push, cleanup_branch, save_patch, force, unregister}`.
- **Polled `getGitInfo`**, every 3 s per widget (`builtin/git/main.ts:107`, `GitCanvasWidget.tsx:84`), **never gets a span.** It feeds histogram `c.git.status.duration` (s), dimension `c.size_bucket` (from file count), plus counter `c.git.status.polls`. A span is emitted only when one poll exceeds 2 s, as a slow-operation exemplar at level D.
- `c.git.subprocess.duration` histogram by `c.git.op` covers both of the above.

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

### 4.10 Plugins: built-in and community (`renderer/plugins/plugin-loader.ts`)

**Plugin identity attribute.** `c.plugin.ref` is the raw plugin ID **only** when the plugin is built-in, or listed in the cached official registry with `official:true` and no `marketplaceId`. Otherwise it is `hmac(id)`. `c.plugin.origin ∈ {builtin, official_registry, custom_marketplace, preview, sideloaded}` always accompanies it. The built-ins are `hub`, `terminal`, `files`, `browser`, `git`, `canvas`, `review`, `group-project`, `sticky-note`, `agent-queue`, `sessions`, `goobers`.

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
| `c.canvas.load` | `loadCanvas` `:360` + `loadWires`. `c.canvas.load.result ∈ {ok, recovered_from_backup, degraded, unreadable, failed, remote_hydrated}`. Attributes: `c.canvas.count`, `c.canvas.view.count_bucket`, `c.canvas.wire.count_bucket` | S (E for `unreadable`/`failed`) |
| `c.canvas.save` | **no per-autosave span.** Histogram `c.canvas.save.duration` plus counter `c.canvas.saves` by `c.canvas.persist_gate` (`ok`/`blocked`/`verify_empty`/`snapshot_first`) and result | S |
| `c.canvas.save.failed` | exception record; the currently unhandled rejection at `main.ts:253` must get a `.catch` | E |
| `c.canvas.command` | assistant/MCP canvas commands (`canvas-command-handler.ts:798`), named by command (`add_view`, `connect_views`, …; a static list) | S |
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

### 4.13 Goobers (`goobers-*.ts`)

| Instrument | Notes | Level |
|---|---|---|
| `c.goobers.activate` | `subscribe()` → first liveness result | S |
| `c.goobers.liveness` state-change event | only **on transition**, not per poll. `c.goobers.state ∈ {not_running, starting, unknown, running, recovering}`; `error.type ∈ {non_loopback_address, unexpected_readyz_status, identity_check_failed, auth_required, recovery_stalled, degraded}` | S |
| `c.goobers.polls` counter, `c.goobers.poll.skipped` counter, `c.goobers.poll.duration` histogram | the 5 s / 30 s poll loop. **No spans.** | D |
| `c.goobers.daemon.start` / `.stop` | `goobers-daemon.ts:133`, `:197`. `c.outcome`; `error.type ∈ {lock_contention, exited_before_ready, ready_timeout, binary_not_found, binary_not_executable, invalid_root}` | S |
| `c.goobers.sse.connect` | with `c.sse.terminal_reason ∈ {auth_required, no_read_model, schema_changed}`; reconnect counter | S |

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
| `c.assistant.*` | `started` (mode `interactive`/`structured`/`headless`), `message_sent` (count only), `action_approved` |
| `c.theme.changed` | `c.theme.kind` (`builtin`/`plugin`), `c.theme.builtin_id` if built-in |
| `c.popout.opened` | `c.popout.type` |
| `c.telemetry.*` | `enabled`, `level_changed`, `disabled` (sent as the last record before shutdown of the exporter), `test` |

---

## 5. Attribute schema and privacy enforcement

### 5.1 The registry

All attribute keys are declared in **one file**, `src/shared/telemetry/attributes.ts`, as a typed registry:

```ts
export const ATTR = {
  agentKind:     enumAttr('clubhouse.agent.kind', ['durable', 'quick', 'companion', 'assistant']),
  orchestrator:  enumAttr('clubhouse.orchestrator', ['claude-code', 'codex-cli', 'copilot-cli', 'other']),
  agentRuntime:  enumAttr('clubhouse.agent.runtime', ['pty', 'headless', 'structured']),
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
| `clubhouse.install.id` | `randomUUID()`, stored in `telemetry-settings.json` | until the user clicks **Reset telemetry ID** | resource attribute; maps to App Insights `user_Id` via `enduser.pseudo.id`. Lets the user count their own installs (several machines on one resource). |
| Hash salt | 32 random bytes, stored with the install ID | rotated with **Reset telemetry ID** | never exported |
| `*.id_hash` | `HMAC-SHA256(salt, rawId)` truncated to 16 hex characters | stable per install | span attributes only, **never metric dimensions** (cardinality) |

Hashes are applied only to opaque internal IDs: agent ID, project ID (`proj_<ts>_<rand>`), run ID, canvas ID, request ID. They are **never applied to names or paths** (P3). Low-entropy inputs such as a project name would be guessable even with a salt, and a path hash still says "same repo".

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
| `os.version` | major.minor only |
| `host.arch` | `arm64` / `amd64` |
| `process.runtime.version` | Node version |
| `clubhouse.electron.version` | Electron version |
| `clubhouse.telemetry.schema` | integer, starts at `1`; bump on breaking attribute changes |
| `clubhouse.telemetry.level` | `errors` / `standard` / `detailed` |
| `clubhouse.annex.role` | `none` / `satellite` / `controller` / `both` |

Explicitly **not set**: `host.name`, `os.description`, `process.command_args`, `process.executable.path`, `process.owner`, `service.namespace` (all would leak). Resource detectors are **not** used. `@opentelemetry/resources` default detectors include `host.name` and process args.

**Config snapshot event** `c.app.config_snapshot`:

| Area | Attributes |
|---|---|
| Counts | `c.projects.count`, `c.projects.git.count`, `c.projects.remote.count`, `c.agents.durable.count`, `c.profiles.count` |
| Orchestrators | `c.orchestrators.used` (sorted CSV from the enum) |
| Theme | `c.theme.kind`, `c.theme.builtin_id` |
| Feature flags | `c.clubhouse_mode`, `c.headless.enabled`, `c.mcp.enabled`, `c.annex.server`, `c.annex.client`, `c.annex.satellites.count` |
| Experimental | `c.experimental.*` (known keys only: `sessions`, `agentQueue`, `goobers`, `assistant`, `themeGradients`) |
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
- **Renderer readiness.** A new `app:renderer-ready` IPC is sent once after `initApp()`. It also benefits non-telemetry code: the startup survey found that no such signal exists today.
- **Renderer errors** (§4.2) go through the same channel with sanitized stacks. The sanitization is redone in main.
- **Disabled state.** While telemetry is off, the renderer facade drops calls before queueing. Main broadcasts the enabled/level state so this costs nothing.
- **Plugins** get no telemetry API in v1. Plugin errors and activation are observed by the host (§4.10). A plugin telemetry API is a possible future addition, gated by a permission.

### 6.3 Packages, versions and bundling

| Package | Version (2026-10-16) | Notes |
|---|---|---|
| `@opentelemetry/api` | 1.9.x | stable |
| `@opentelemetry/sdk-trace-base`, `sdk-metrics`, `resources`, `core` | 2.12.x (≥ 2.10 required by the exporter) | stable line |
| `@opentelemetry/sdk-logs`, `api-logs` | **0.221.x** | **must match the exporter's `^0.221.0` caret**. On 0.x a caret pins the minor, so 0.223 would install a second copy. Pin exact versions, and have Dependabot group all `@opentelemetry/*` packages together. |
| `@opentelemetry/context-async-hooks` | 2.12.x | `AsyncLocalStorageContextManager` |
| `@opentelemetry/semantic-conventions` | 1.43.x | import only `/incubating`-free stable constants, or copy the ~15 constants we use into `attributes.ts`. The package is 12 MB unpacked, so check that tree-shaking works under CJS webpack. |
| `@azure/monitor-opentelemetry-exporter` | **1.0.0-beta.46** | **the `latest` dist-tag is stale (beta.32, which depends on OTel 0.200).** Install `@beta` or the exact version. It is still pre-1.0, so pin exactly. Requires Node ≥ 22; Electron 43 is fine. Sends JSON via `@azure/core-rest-pipeline`, with **no protobufjs**. |
| `@opentelemetry/exporter-*-otlp-http` | 0.221.x | Phase 7 only. Use the JSON/HTTP variants and avoid `-proto` and `-grpc`, which pull in protobufjs and grpc and trip the asset relocator. |

Bundling notes (`webpack.main.config.ts`):

- The only external is `node-pty`. Every runtime dependency must bundle cleanly through `@vercel/webpack-asset-relocator-loader` (`webpack.rules.ts:11`).
- **Phase 1 starts with a spike:** build a packaged app (in CI; local packaged launch crashes on code signing) and assert that the exporter loads and exports.
- **The SDK goes in a separate chunk** via `await import('./telemetry/sdk')`. That code is never evaluated unless telemetry is enabled, so startup cost when disabled is zero. Chunked dynamic imports already work in main (`ipc/agent-handlers.ts:66`).
- Expected size: about 0.6–1.2 MB minified across the OTel SDKs, the Azure exporter and `@azure/core-*`. That is about 1% of the roughly 97 MB `app.asar`. Add a CI check that fails if the telemetry chunk exceeds 2 MB.

### 6.4 Sampling and volume

- **Errors are always kept.** Exceptions and E-level events are log records and are never sampled.
- **Traces use a custom `FlowSampler`:**
  - Errors level: root spans are recorded but only exported if they end in error. This is a tail decision, done by a processor that buffers each trace (max 64 spans) until the root ends.
  - Standard: flow roots sampled at 100%. Volume per user is low, roughly 100–1,000 roots a day, because hot paths have no spans (P4).
  - Detailed: also 100%, with tool-call, IPC and Annex REST spans enabled.
  - An **advanced "trace sample rate"** (1.0 by default) applies a `ParentBased(TraceIdRatioBased)` on top, for heavy users who want to cut cost. The sample rate is stamped on spans as `microsoft.sample_rate` so App Insights `itemCount` stays correct.
- **Metrics** are exported every 60 s with delta temporality, which the Azure exporter expects. A metric `View` caps cardinality at 200 attribute sets per instrument.
- **A per-session hard cap** of 50,000 spans and 10,000 log records, after which items are dropped and counted in `c.telemetry.dropped`. This protects against a runaway loop billing the user's Azure subscription.
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

- When telemetry is disabled, `tel.*` are no-op functions that run `fn` directly. That is one property read and a branch, so hot-adjacent code (hook server) pays nothing measurable.
- `tel.flow` also accepts an existing `AbortSignal` and marks `cancelled` on abort.
- Thrown errors are recorded via `tel.exception` (sanitized) and rethrown unchanged. Instrumentation never changes control flow.

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
  - a size cap (exporter option or a periodic prune, max 20 MB / 48 h);
  - deletion on disable.

  Offline data is post-redaction, so the disk copy contains nothing more sensitive than what would be sent.
- **Exporter self-telemetry ("Statsbeat").** The Azure exporter can send its own SDK health metrics to a **Microsoft-owned** endpoint, separate from the user's resource. **It must be disabled.** Phase 1 verifies the exact mechanism (environment flag or option for the pinned version). Phase 1 also adds a CI test that runs the exporter against a mock HTTP server, intercepts all outbound requests, and asserts that **only the configured ingestion host is ever contacted.** This test is a release blocker.
- **Proxy.** `@azure/core-rest-pipeline` honors `HTTPS_PROXY`/`NO_PROXY`. Document this. Electron's system proxy is not used.

### 6.8 Settings UX (Settings → Logging)

The existing **Logging** page (`LoggingSettingsView.tsx`) gets a second section, **Telemetry export**. It is not a new nav item: it shares the privacy context and avoids touching the four places a new page needs (`SettingsSubPage`, `AccessoryPanel`, `MainContentView`, command palette).

```
Logging                                         ← existing section unchanged
  ...
  "Logs are stored on your local disk only and are never transmitted."   ← text stays true

Telemetry export                                ← new
  Send anonymized diagnostics to your own Azure Application Insights resource.
  Nothing is sent to the Clubhouse maintainers. Off by default.        [Learn what's sent]

  Connection string   [ ••••••••••••••••••••••••••••••  ]  [Paste] [Clear]
                      ✓ InstrumentationKey …1a2b · Ingestion: westus2-1.in.applicationinsights.azure.com
  Level               ( ) Off  ( ) Errors only  (•) Standard  ( ) Detailed
  [Send test event]   ✓ Accepted by ingestion (HTTP 200, 412 ms)
  [Preview data]      opens the last 200 items exactly as exported

  ▸ Advanced
      Trace sample rate  [1.0]
      Reset telemetry ID (rotates install ID and hash salt)
      Offline queue: 0 items · [Clear]
```

- **Connection string handling:**
  - It is parsed locally. `InstrumentationKey` must be a GUID and `IngestionEndpoint` must be an `https:` URL whose host ends in `.applicationinsights.azure.com` or a sovereign-cloud equivalent. The allowlist lives in code; users can override it for OTLP later.
  - Bare instrumentation keys are rejected with a message that IKey-only ingestion was retired in 2025.
  - It is stored with **`safeStorage.encryptString`** in `userData/telemetry-secret.bin`, mode 0600. This is the first use of `safeStorage` in the codebase.
  - On Linux, if `safeStorage.getSelectedStorageBackend()` returns `basic_text`, the UI warns that the string will be stored with weak protection, and asks the user to confirm.
  - After saving, **the renderer only ever receives a masked form** (the last 4 characters of the IKey plus the ingestion host). The full string never crosses back into the renderer.
  - The connection string is not truly secret: it is an ingestion-only credential and cannot read data. It is still treated as one, because it lets anyone write into the user's resource and bill them.
- **Test event:** emits `c.telemetry.test` as a span and an event, calls `forceFlush()`, and reports the exporter's `ExportResult` plus the HTTP status and latency. Common failures get explicit text: 400 invalid IKey, 401/403 with local auth disabled (points to the Entra ID follow-up), DNS or proxy failure.
- **Preview:** a tee exporter keeps a ring buffer of the last 200 items **after redaction**, exactly as sent. A dialog shows them as JSON with the type (span/metric/log) and the destination table. The same buffer is filled even when the level is Off: in that case nothing is exported, but the user can see what *would* be sent. This uses a separate dry-run pipeline with no network.
- **Learn what's sent:** a help topic `settings-telemetry` in `features/help/content/`, generated partly from the attribute registry so it cannot drift.
- **Storage:** `TELEMETRY` is added to `settings-definitions.ts` via `createManagedSettings`, with `{ level, sampleRate, installId, consentVersion }`. The secret is kept separate, as above.
- **Consent:** choosing a non-Off level for the first time shows a one-time confirmation listing the "never sent" categories. `consentVersion` is bumped if the schema widens materially, which forces re-confirmation.
- **The local logging banner text stays true:** logs are still never transmitted. Bridged events (§6.6) are telemetry, not logs, and the telemetry section says so explicitly.

---

## 7. Annex satellites and controllers

**The facts** (from the survey):

- A **satellite** is a Clubhouse install running `annex-server`. A **controller** is a Clubhouse install running `annex-client`, and it dials the satellite.
- The Annex **iOS app** is a separate, non-Clubhouse client that uses bearer tokens.
- Desktop controllers send `agent:spawn`/`wake`/`kill`/`pty:input` over WS, plus about 40 REST routes. Satellites stream `pty:data`, hook, structured and permission events back to every client.

**Rules:**

1. **Each install has its own telemetry config.** A satellite never exports on behalf of a controller, or the reverse. Telemetry data never travels over Annex. There is no "forward my telemetry to the controller", because that would create a channel for data the other user didn't consent to.
2. **Trace context propagates only if both sides opt in.**
   - A controller with telemetry on adds `traceparent` to the WS JSON envelope (`{type:'agent:spawn', …, tc:'00-…'}`), since WS frames have no headers, and to REST request headers.
   - A satellite continues the trace only if *its own* telemetry is on. Otherwise it ignores the field.
   - `traceparent` contains only random IDs and a sampled flag, so receiving it reveals nothing.
   - If both installs point at the **same** App Insights resource (the common one-person, two-machines case), `c.annex.remote_spawn` on the controller and `c.agent.spawn` on the satellite appear as one end-to-end transaction. `clubhouse.annex.role` and `service.instance.id` tell them apart.
   - Protocol compatibility: `tc` is an optional field. Old satellites ignore unknown fields (they parse JSON loosely). Confirm this in Phase 6 against the dual-instance E2E.
3. **No per-event spans for the event stream.** That includes PTY data fan-out, hook and structured event fan-out (`broadcastAndBuffer`), and controller-side `handleSatelliteMessage`. These are counters with byte totals (§4.12).
4. **Peer identity is never an attribute.** No fingerprints, aliases, hostnames, IPs or ports. `c.annex.client.kind` (desktop/mobile) and peer counts are allowed.
5. **The iOS app is out of scope.** If it later adopts OTel, it should reuse this registry's names for the shared flows (pair, connect, permission) and honor rule 2. Satellite-side spans already cover its server interactions.
6. **The `?token=` query auth** (`annex-server.ts:2567`) is one more reason never to record URLs. The registry has no URL attribute at all.

---

## 8. Performance budget

| Path | Budget | How |
|---|---|---|
| Telemetry disabled | 0 module loads, no allocations on hot paths | SDK chunk not imported; facade is a constant-false branch |
| PTY `onData` (`pty-manager.ts:350`) | **no telemetry code inside**; a single `bytes += data.length` on a per-session counter that already exists in spirit (`appendToBuffer`) | totals attached at exit |
| Hook server request | ≤ 1 counter increment (two with tool bucketing); no span below Detailed | `Counter.add` is about 100 ns |
| Structured/headless event loops | no telemetry per delta; first-token event fires once per turn via a flag | |
| Git status poll | 1 histogram record per poll | |
| Main-thread export work | batching every 5 s (spans/logs) or 60 s (metrics); serialization off hot paths | `BatchSpanProcessor` `maxExportBatchSize: 256` |
| Startup when enabled | < 30 ms added before `ready`, measured in Phase 1 | lazy chunk, async init, backdated span |

---

## 9. Phased plan and estimates

Sizes: **S** ≈ ≤ 400 LOC, **M** ≈ 400–1,000, **L** ≈ 1,000–1,800, counting production code plus tests. Every PR is validated with `npm run typecheck`, `npm run lint` and vitest. E2E specs are written but run in CI only.

| # | Phase / PR | Contents | Size | Depends on |
|---|---|---|---|---|
| 1 | **Foundation: SDK and pipeline** | <ul><li>Spike: bundle the OTel SDK and exporter in the main chunk; packaged-build smoke test in CI; size check.</li><li>`src/main/telemetry/`: facade, bootstrap, providers, resource, attribute registry, redaction processors, scrubber, HMAC IDs, `FlowSampler`, session caps, preview tee, offline dir, flush-on-quit and `flushBeforeExit()` at all `app.exit` sites.</li><li>Statsbeat off, with the **egress-allowlist CI test**.</li><li>Only instrumentation: `c.app.sessions`, `c.telemetry.test`.</li><li>Feature flag `experimental.telemetry` until Phase 3 lands.</li></ul> | **L** | — |
| 2 | **Settings UX** | `TELEMETRY` managed settings; `safeStorage` secret store + Linux backend warning; connection-string parser and validator; Telemetry export section on the Logging page; test event; preview dialog; consent confirm; help topic; reset ID | **M** | 1 |
| 3 | **Errors and app lifecycle** | Main `uncaught`/`unhandled` → exception records; `render-process-gone`, `child-process-gone`, `unresponsive`; renderer `error`/`unhandledrejection`; new `AppErrorBoundary`; renderer facade and `telemetry:emit` IPC; `app:renderer-ready`; `c.app.startup` span tree; shutdown span; unclean-exit detection; safe-mode events; auto-update spans; config snapshot. **First "useful" release.** | **L** | 1 (2 for user-facing) |
| 4 | **Agents** | Create/spawn span trees across all three runtimes; run/first-output events; exit classification incl. the structured path; kill escalation; permissions (hook and structured); structured turns and token usage; hook-event and tool-call metrics with tool bucketing; MCP tool calls; queue; shoulder taps | **L** (could split 4a spawn/exit, 4b permissions/turns/MCP/queue) | 3 |
| 5 | **Workspace** | Project switch (renderer root + traceparent into main), add/remove, store recovery; git user-op spans and poll histogram; worktree spans; file open/save, search, watch gauges; plugin system init, activate, render errors, protocol counters; canvas load/save; marketplace fetch/install/update/uninstall; settings and feature-usage events | **L** (could split 5a projects/git/files, 5b plugins/canvas/marketplace/features) | 3 |
| 6 | **Annex, Goobers and Detailed level** | Annex server/client spans and metrics; `traceparent` over WS envelope and REST (dual-instance E2E spec); Goobers lifecycle, state transitions, poll metrics; Detailed-level additions: tool-call spans, IPC latency (patch `ipcMain.handle` once before `registerAllHandlers`, channel name from the static `ipc-channels.ts` constant set, dynamic `*:response:{id}` channels collapsed), Annex REST per route template | **M** | 4 |
| 7 | **appLog bridge and extras** | `telemetry` field on `appLog`, severity mapping, trace IDs in local JSONL, initial opt-in sites. **Optional extras:** OTLP/HTTP-JSON exporter selector (Honeycomb, Grafana, a local collector); a shipped **Azure Workbook template** (`docs/telemetry/workbook.json`) with KQL for startup p95, agent spawn p95 by orchestrator, exit-class mix, top `error.type`, update funnel; release source maps for stack symbolication | **M** | 3 |

**Rough total:** 7–9 PRs, about 4,000–5,500 LOC including tests. Phases 4 and 5 can run in parallel after Phase 3: they touch disjoint files except the registry, where conflicts are append-only.

---

## 10. Risks and open questions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OTel/Azure packages fail under webpack + asset relocator (dynamic requires, optional peers) | Medium | High (blocks everything) | Phase 1 spike in a packaged CI build first; avoid protobuf/grpc exporters; the lazy chunk keeps a failure contained to "telemetry unavailable", reported in Settings |
| Azure exporter is pre-1.0 (beta.46) with frequent breaking changes and version lockstep with OTel 0.2xx experimental packages | High | Medium | Pin exact versions; Dependabot group for `@opentelemetry/*` + `@azure/monitor-opentelemetry-exporter`; a contract test that exports one of each signal to a mock ingestion server and snapshots the payload shape |
| Exporter contacts endpoints other than the user's (Statsbeat, AAD discovery) | Medium | **High (trust)** | Disable Statsbeat; egress-allowlist test is a release blocker (§6.7) |
| Privacy regression: a new attribute or call site leaks a path or name | Medium | High | Typed registry + lint import restriction + runtime redaction + fuzz test + key snapshot test; CODEOWNERS on `src/shared/telemetry/attributes.ts` |
| Hot-path performance (PTY, hook server, structured deltas) | Low (by design) | Medium | §8 budget; vitest micro-benchmark around hook-server `handleRequest` with telemetry on/off; no spans below Detailed |
| Bundle size | Low | Low | ~1 MB lazy chunk vs ~97 MB asar; CI size guard at 2 MB |
| Windows: path scrubbing (`C:\`, UNC, `\\?\`), `safeStorage` (DPAPI, fine), `app.exit` paths during Squirrel update | Medium | Medium | Scrubber tests on the Windows CI runner using `os.homedir()`; `flushBeforeExit` covers Squirrel relaunch |
| Linux `safeStorage` falls back to `basic_text` without a keyring | Medium | Low | Detect the backend and warn the user; the ingestion-only credential limits the blast radius |
| User's App Insights bill | Low | Medium | Levels, sampling, session caps, a cost hint, a recommended daily cap |
| Resources with local auth disabled reject connection strings | Medium in enterprises | Medium | Clear error in the test button; **follow-up:** Entra ID via `DefaultAzureCredential` is out of scope for v1 because it needs an interactive sign-in flow in the app |
| Histograms give no percentiles in App Insights | Certain | Low | Percentile-critical latencies are spans (§3.2); histograms remain for averages and future OTLP |
| A long-lived `c.agent.run` span is never exported if the app crashes | Certain | Low | Metrics recorded at edges; unclean-exit event; run duration recomputed at the next exit where possible |
| Clock skew between renderer and main timestamps | Low | Low | Renderer sends `performance.timeOrigin`-relative times; main converts using an offset measured at IPC handshake |

**Open questions for the maintainer:**

1. Should the **Errors** level be offered alone, or is a three-way Off/Standard/Detailed simpler?
2. Should `clubhouse.install.id` → `user_Id` be on by default, or should the default be a per-run ID only? The trade-off is multi-machine dashboards against minimal identifiers.
3. Should community plugins be able to emit their own telemetry through a permissioned API in a later version, or should the host observe only?
4. Should OTLP (Phase 7) be shown in the main UI or kept behind Advanced? It widens the "where does my data go" surface.
5. Should a shared Azure Workbook be published (Phase 7) so every user gets the same dashboards?

---

## 11. Findings discovered while scoping (not fixed here)

These came out of the code survey and log analysis. They are independent of telemetry, but several would make telemetry data wrong or misleading if not fixed first. Most are worth filing per the repo's issue convention.

| # | Finding | Where | Telemetry impact |
|---|---|---|---|
| F1 | **Structured exits bypass `broadcastAgentExit`.** `onAgentExit` listeners (the queue runner) never see them, so structured queue tasks never complete. | `structured-manager.ts:125-126`, `agent-queue-runner.ts:252` | exit metrics would undercount structured runs |
| F2 | **A headless exit by signal is reported as code 0** (`code ?? 0`, signal dropped). Killed headless queue tasks are marked "completed". | `headless-manager.ts:486,488` | exit class would be wrong |
| F3 | **Prompts and missions are written to local logs** through `args` and RPC params | `agent-system.ts:462`, `headless-manager.ts:540`, `acp-client.ts:103`, `codex-app-server-client.ts:60` | no export impact (never bridged), but a local privacy issue |
| F4 | **Safe-mode logic appears inverted.** "Safe Mode" clears the marker so the renderer loads plugins; "Try Again Normally" keeps it, so the renderer enters safe mode. Also, `CLUBHOUSE_SAFE_MODE` is read in `initializeTrustedManifests` before it is set. | `safe-mode.ts:58-83`, `plugin-loader.ts:239`, `plugin-handlers.ts:30` | safe-mode events would be mislabeled |
| F5 | **The update apply-attempt marker is never written on macOS/Windows relaunch**, because `app.exit(0)` runs before `recordSuccessfulApply`, so `update:apply-detect` cannot fire there | `auto-update-service.ts:826,852,945` | the update failure funnel would be blind on two OSes |
| F6 | **Uncaught `send EADDRNOTAVAIL 224.0.0.251`** from the mDNS socket. It happens twice in 10 days of logs, at fatal level, and the process continues. | `bonjour-service` via `annex-server.ts:2777` / `annex-client.ts:706` | first real crash class telemetry would report |
| F7 | **Canvas `saveCanvas`/`saveWires` are fire-and-forget.** Write failures become unhandled renderer rejections, and there is no renderer `unhandledrejection` handler. | `canvas/main.ts:253-254` | lost canvas writes are invisible today |
| F8 | **Shutdown has no global timeout**, and the log flush at quit is not awaited. Several `app.exit` paths skip all flushing. | `shutdown-guard.ts:17-22`, `log-service.ts:168`, `app-handlers.ts:421`, `auto-update-service.ts:887,899,969` | telemetry would need `flushBeforeExit` anyway (Phase 1) |
| F9 | **Pending permissions appear not to be cleared on agent exit when Annex is inactive** (`clearForAgent` is only called from the Annex exit subscription and the hook toggle). Not verified at runtime. | `annex-permission-queue.ts:226`, `annex-server.ts:2689` | stuck-permission counter would include dead agents |
| F10 | **`node-forge` is imported but not a declared dependency**; it resolves only through `selfsigned` from the dev tree | `annex-tls.ts:16`, `package.json` | none; a build fragility found while checking bundling |
| F11 | **`provider.checkAvailability` can block the main thread** for up to 5 s (`execFileSync` login shell `which`), and Codex runs `codex --version` on every spawn | `orchestrators/shared.ts:100`, `codex-cli-provider.ts:279` | `c.provider.check_availability` will show this; worth fixing independently |
| F12 | `hook-server` logs every hook event at **info**, which is 56% of all log lines | `hook-server.ts:323` | none; suggests demoting it to debug |

---

## Appendix A: Span and metric name index

**Spans (roots marked R):**

| Area | Spans |
|---|---|
| App | `c.app.startup`ᴿ (`.main_ready`, `.register_ipc`, `.safe_mode_check`, `.create_window`, `.renderer_init`, `.load_settings`, `.plugin_system`), `c.app.shutdown`ᴿ, `c.window.create`ᴿ, `c.renderer.unresponsive`ᴿ |
| Update | `c.update.check`ᴿ (`.fetch_manifest`), `c.update.download`ᴿ (`.verify`), `c.update.apply`ᴿ, `c.update.session_resume`ᴿ |
| Agent | `c.agent.create`ᴿ, `c.agent.delete`ᴿ, `c.agent.quick_launch`ᴿ (renderer), `c.agent.spawn`ᴿ (`c.provider.resolve`, `c.provider.check_availability`, `c.agent.materialize`, `c.agent.prepare_pty`, `c.hooks.configure`, `c.mcp.inject`, `c.provider.build_command`, `c.pty.spawn`, `c.headless.spawn`, `c.structured.start`), `c.agent.run`, `c.agent.turn`ᴿ (`c.structured.rpc`), `c.agent.permission`ᴿ, `c.agent.exit`ᴿ, `c.agent.kill`ᴿ, `c.agent.tool_call` (D) |
| Queue / group | `c.queue.task`ᴿ (`.wait`, `.run`), `c.group.shoulder_tap`ᴿ, `c.group.membership_sync`ᴿ |
| MCP / hooks | `c.mcp.bridge.start`, `c.mcp.tool_call`ᴿ, `c.hook_server.start` |
| Projects / git / files | `c.project.switch`ᴿ, `c.project.add`ᴿ, `c.project.remove`ᴿ, `c.project.git_init`ᴿ, `c.git.<op>`ᴿ, `c.git.worktree_add`, `c.git.worktree_remove`, `c.file.open`ᴿ, `c.file.save`ᴿ, `c.file.tree.read`, `c.search.query`ᴿ, `c.editor.open_external` |
| Plugins / canvas / marketplace | `c.plugin_system.init`, `c.plugin.activate`, `c.plugin.deactivate`, `c.canvas.load`ᴿ, `c.canvas.command`ᴿ, `c.marketplace.fetch_registry`ᴿ, `c.plugin.install`ᴿ, `c.plugin.update_check`ᴿ, `c.plugin.update`ᴿ, `c.plugin.uninstall`ᴿ |
| Annex | `c.annex.server.start`ᴿ, `c.annex.discover`ᴿ, `c.annex.pair`ᴿ, `c.annex.connect`ᴿ, `c.annex.snapshot.build`, `c.annex.rest`ᴿ (D), `c.annex.remote_spawn`ᴿ, `c.annex.replay`ᴿ |
| Goobers | `c.goobers.activate`ᴿ, `c.goobers.daemon.start`ᴿ, `c.goobers.daemon.stop`ᴿ, `c.goobers.sse.connect`ᴿ |
| IPC | `c.ipc.<channel>` (D) |

**Metrics:**

| Area | Metrics |
|---|---|
| App | `c.app.sessions`, `c.app.startup.duration`, `c.app.session.duration`, `c.app.shutdown.duration`, `c.app.unclean_exits`, `c.window.relay.timeouts`, `c.window.popouts` |
| Update | `c.update.checks`, `c.update.failures`, `c.update.download.duration` |
| Agent | `c.agent.spawns`, `c.agent.spawn.duration`, `c.agent.time_to_first_output`, `c.agent.run.duration`, `c.agent.active`, `c.pty.output.bytes`, `c.agent.tool_calls`, `c.agent.hook_events`, `c.agent.turn.duration`, `c.agent.tokens`, `c.agent.cost`, `c.agent.permission.wait`, `c.agent.permission.stuck` |
| Queue / group | `c.queue.depth`, `c.queue.tasks`, `c.group.bulletin.posts` |
| MCP / hooks | `c.mcp.tool_calls`, `c.mcp.tool_call.duration`, `c.mcp.auth_rejected`, `c.mcp.sessions`, `c.hook_server.requests` |
| Projects / git / files | `c.projects.count`, `c.git.status.duration`, `c.git.status.polls`, `c.git.subprocess.duration`, `c.file.ops`, `c.file_watch.active`, `c.file_watch.errors` |
| Plugins / canvas | `c.plugin.permission_violation`, `c.plugin.api_calls`, `c.plugin.protocol.requests`, `c.canvas.save.duration`, `c.canvas.saves`, `c.canvas.views` |
| Annex | `c.annex.reconnects`, `c.annex.reconnect.delay`, `c.annex.disconnects`, `c.annex.heartbeat.rtt`, `c.annex.events`, `c.annex.events.bytes`, `c.annex.send_failures`, `c.annex.clients` |
| Goobers | `c.goobers.polls`, `c.goobers.poll.skipped`, `c.goobers.poll.duration` |
| Telemetry | `c.telemetry.dropped` |

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
