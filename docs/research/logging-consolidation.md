# Logging consolidation: legacy logs to local telemetry

Research for the goal set by the maintainer: before v0.42 stable, remove the legacy local logging (`appLog` / `rendererLog` writing `~/.clubhouse/logs/session-*.jsonl`) and keep the local OpenTelemetry recording from #2278 / PR #2289 (`telemetry-*.jsonl`, `src/main/telemetry/`) as the single local record.

- Code read at PR #2289 head `e266abc9` (branch `feat/2278-local-otel`, still open on 2026-10-19). File:line references are from that commit.
- Volume figures come from one maintainer install: 36 `session-*.jsonl` files, 67,819 lines, 2026-10-07 to 2026-10-20, `minLogLevel: debug`. Only counts were taken, no message content.
- The full list of call sites (757 rows, grouped by namespace) is in [logging-consolidation-callsites.md](logging-consolidation-callsites.md).

## Summary

1. **Telemetry can't carry text.** The attribute registry only has `enum | int | bool | hash | version` kinds (`src/shared/telemetry/attributes.ts:35`). Exception messages are never written. `appLog`'s `msg` and `meta` are never bridged (`src/main/telemetry/log-bridge.ts`).
   - In the legacy log, nearly all warn/error lines carry their value in `msg` and `meta.error`: error strings, paths, ids, stderr, `lastOutput`.
   - Of 71 namespaces, the telemetry signals fully cover 4 and partially cover 21. About 40 are legacy only, and the remaining lines are noise or debug-only.
   - So removing `session-*.jsonl` with nothing to replace it would remove most of the "why" behind local debugging.
2. **Recommendation: one file, two tiers.**
   - Add a **local-only diagnostic tier** to the recorder: `{"t":"diag", ns, level, msg, meta, traceId?, spanId?}` lines in the same `telemetry-*.jsonl` file.
   - Diag lines are never exported. They keep paths and error text, minus prompt content (#1919) and secrets. They are gated by the existing local logging settings (`enabled`, `minLogLevel`, `namespaces`).
   - `appLog` and `rendererLog` become thin wrappers over the diag tier, so the 757 call sites don't have to change in one go. `log-service.ts`'s file writer is then deleted.
   - Separately, the high-value cases get real structured telemetry events, so export and Standard local recording carry them too: chat fallback reasons, session capture, slow interactions, feedback.
3. **The recorder isn't yet fit to be the only record.**
   - Its 10 MB per-run budget stops all recording for the rest of the run (`local-recorder.ts:203-213`). The app often runs for days: one legacy run in the sample went past 12 MB.
   - Its level is fixed at Standard (`local-control.ts:20`).
   - These need to change before the legacy writer goes.
4. **Three consumers break silently if `log:write` goes away:**
   - feedback breadcrumbs (`log-service.ts:125-138`);
   - one E2E spec (`e2e/plugin-mcp-tools.spec.ts:43-84`);
   - the public plugin `api.logging` contract (`src/shared/plugin-types.ts:903-909`, API versions 0.5 to 0.9).

## 1. Inventory: legacy logging

### 1.1 Writer, settings, IPC

| Piece | Where | Behavior |
|---|---|---|
| `appLog(ns, level, msg, {projectId, meta, telemetry})` | `src/main/services/log-service.ts:168-183` | Adds `ts` and `traceFieldsForLog()` (trace and span ids from the active span). Calls `log()`. |
| `log(entry, telemetry?)` | `log-service.ts:145-166` | Runs, in order: `bridgeLog` (opt-in event), `tapBreadcrumb`, the `enabled` check, the namespace filter, the `minLogLevel` check, then buffers the line. |
| Buffer and flush | `log-service.ts:10-12, 102-118` | Flushes every 1 s or at 50 entries. One `appendFile` per flush. On a write failure the lines are dropped and logged with `console.error`. |
| Files and rotation | `log-service.ts:24-47` | `~/.clubhouse/logs/session-<ISO start>.jsonl`, then `.N.jsonl` chunks at 2 MB. No limit per run. |
| Retention | `log-service.ts:50-100` | Covers `session-*` **and** `telemetry-*` files together. Age first, then oldest-first deletion down to the size cap. Runs **only at `init()`** (startup). Tiers are in `src/shared/types.ts:1155-1160`: low 3 d / 50 MB, medium 7 d / 200 MB (default), high 30 d / 500 MB, unlimited. |
| Line format | `LogEntry`, `src/shared/types.ts:1136-1146` | `{ts, ns, level, msg, projectId?, meta?, traceId?, spanId?}`. Renderer entries never get trace ids. |
| Levels | `LOG_LEVEL_PRIORITY`, `types.ts:1128-1134` | `debug < info < warn < error < fatal`. |
| Settings | `src/main/services/log-settings.ts:4-10` (`logging-settings.json`) | `{enabled: true, namespaces: {}, retention: 'medium', minLogLevel: 'info', telemetryRecording: true}` |
| Namespaces list | `log-service.ts:189` | Only namespaces seen during this run. The Settings toggles list is empty until a namespace logs. |
| Startup | `src/main/ipc/index.ts:48` | `logService.init()` is called **without being awaited**, after the first `appLog` (`ipc/index.ts:42`). Entries before `init` sit in the buffer. If 50 pile up first, `flush()` writes to an undefined path and drops them. |
| Renderer path | `src/renderer/plugins/renderer-logger.ts:3-17`, then `src/preload/log.ts:4-17`, then `IPC.LOG.LOG_WRITE` (`src/shared/ipc-channels.ts:340-346`), then `src/main/ipc/app-handlers.ts:364-369` | Fire-and-forget `ipcRenderer.send`. Main checks only that the argument is an object: no checks on `ns`, `level` or size, and **no rate limit**. `rendererLog` throws if `window.clubhouse` is missing. |
| Injected loggers | `src/main/services/agent-runtime/builtin-chat-drivers.ts:19-26`; `src/main/services/framebriar/index.ts:44` | Chat drivers log through `core:chat` (Claude), `core:chat:codex` and `core:chat:copilot`. Feedback logs through `core:feedback`. |
| Opt-in telemetry bridge | `src/main/telemetry/log-bridge.ts:19-42` | 4 call sites pass `telemetry: {event}`: `chat-driver-health.ts:114`, `annex-client.ts:661`, `hook-server.ts:405`, `config-pipeline.ts:293`. |

### 1.2 Call sites by namespace

There are 661 `appLog` calls (main) and 101 `rendererLog` calls (renderer); the AST scan found 757 in total. Five calls take their namespace from a constant. The renderer also has one direct `log.write` call (`src/renderer/telemetry/ui-perf.ts:88`), and the chat drivers make about 60 more calls through their injected loggers.

Two of the volume figures need explaining:
- **12 % for `core:mcp` plus `core:chat`:** almost all of it is `Tool call` and `Tool call completed` (`bridge-server.ts:204-216`), plus the drivers' per-RPC request and response lines.
- **2.7 % for `core:agent-config`:** almost all of it is info-level config resolution.

| Namespace group | Calls | Levels | Typical messages (meta keys) | Share of 67,819 lines |
|---|---|---|---|---|
| `core:hook-server` | 15 | info, warn, error | "Hook event received" (agentId, orchestrator, kind, bodyBytes, toolName) | **41.0 %** (info) |
| `ui:terminal:scroll` | 12 | debug | "PTY data write", fit and scroll details | **34.6 %** (debug) |
| `core:mcp` | 97 | info, warn, error, debug | Tool call (agentId, toolName, **args**); Tool call completed or returned error (errorDetail); binding and injection (configPath, cwd) | 6.6 % |
| `core:chat`, `core:chat:codex`, `core:chat:copilot` | 34 + driver internals | info, warn, error, debug | Chat start requested, driver check (ok, reason, loginRequired, notices), Starting chat agent, session open (nativeSessionId, resumeHonored), cancelled or abandoned, fallback to the terminal, transcript and index failures; drivers: spawn, handshake, `RPC request → <method>` (**params**), stderr, malformed lines, `Unmapped Claude wire message` (type, subtype, shape), `Unrecognized Codex notification` (method), ACP stopReason | 6.9 % |
| `core:agent-config`, `core:agent-settings`, `core:config-pipeline`, `core:config-diff`, `core:materialization` | 76 | all levels | Read or parse failures (**filePath**), restore from backup, materialization steps | 4.1 % |
| `core:project-store`, `core:project`, `core:file`, `core:canvas-index`, `canvas`, `canvas:main` | 52 | mostly error | Persistence failures, recovered from backup, path denied (path) | 2.9 % |
| `core:annex`, `core:annex-client`, `core:annex-server`, `core:permission-queue` | 136 | all levels | Server and TLS lifecycle, satellite state transitions (fingerprint, host, port, error), pairing, permission queue | 1.4 % |
| `core:plugins`, `plugin:<id>`, `marketplace*`, `core:plugin-storage`, `core:plugin-events` | 78 + plugin API | warn, error, info | Loader and activation errors (pluginId, error), registry fetch, updates | 0.6 % |
| `core:agent` | 29 | info, warn, error | Spawning agent (binary, **args**, cwd, model), session-id capture and resume outcomes (sessionId, exitCode, runMs), kill (trigger, waitedMs) | 0.2 % |
| `core:pty` | 6 | info, warn, error | PTY exited (exitCode, binary, **lastOutput** of 500 characters), spawn failed (binary, cwd, error), stale session, oversized write | < 0.1 % |
| `core:git` | 1 | warn | Git operation failed (cmd, cwd, error) | 0.2 % |
| `core:feedback` | 5 + injected | info, warn, debug | Feedback saved for delivery (**id**, status, state), shortcut ignored | 0.3 % |
| `update:*`, `update:session-resume` | 41 | all levels | Check, download, apply, restore steps (version, error) | 0.4 % |
| `core:group-project`, `core:orchestration`, `core:headless`, `core:companion`, `core:hook-server-toggle` | 76 | all levels | Bulletin and polling lifecycle, helper policy, headless spawn (**args**) | 0.1 % |
| `ui:perf` | 2 main + ui-perf sink | warn | Long or slow frames (kind, count, maxMs, view, surface, interaction target, scripts), window unresponsive or responsive again | < 0.1 % |
| `ui:nav`, `ui:chat:switch` | 4 | debug, info, error | View changed (`meta.breadcrumb`), runtime switch | 0.1 % |
| Startup, shutdown, process, window, security, safe mode, protocol, IPC, renderer, stores, telemetry | 40 | all levels | Startup and shutdown steps, uncaught errors (main), error-boundary catches | 0.2 % |

### 1.3 Consumers of the legacy log

| Consumer | Evidence | Depends on |
|---|---|---|
| Feedback breadcrumbs (#2098, #2140) | `log-service.ts:125-138` (`tapBreadcrumb`), `src/main/services/breadcrumbs.ts` | **The `log()` path, whatever the settings are.** `ui:perf` lines become `ui.long_frame`, `ui.slow_interaction` and `window.unresponsive`. `meta.breadcrumb` produces `view.*` (`src/renderer/chrome/telemetry.ts:29`, a debug line that exists **only** for the breadcrumb) and `runtime.switch*` (`AgentRuntimePane.tsx:165,182`). |
| `ui:perf` (#2126, #2129) | `ui-perf.ts:86-92` (calls `log.write` directly), `crash-handlers.ts:39,47` | The `log:write` IPC and `appLog`. |
| Framebriar feedback | `framebriar/index.ts:42-44`, `feedback-service.ts:345,362-365` | Breadcrumbs only. No log file is attached or uploaded. The report id is logged, and maintainers match reports to local logs by that id (maintainer practice, not code). |
| Plugin `api.logging` | `src/shared/plugin-types.ts:903-909,1344`, permission `'logging'` (`:47,81,132,224`), `src/renderer/plugins/plugin-api-logging.ts:4-23` | **A public contract** for API versions 0.5 to 0.9 (`src/shared/marketplace-types.ts:115`), with contract tests in `plugin-api-version-contracts.test.ts:98,163,228,1536,1950`. It writes `plugin:<id>`. `plugin-api-files.ts:317` and `plugin-api-workspace.ts:34` use the bare `ctx.pluginId`. |
| Settings → Logging UI | `src/renderer/features/settings/LoggingSettingsView.tsx:72-142`, `src/renderer/stores/loggingStore.ts` | All settings fields, the namespace list, and the logs folder link. Copy: "never transmitted" (`:72`), and "anonymized the same way as export" for telemetry (`:95`). |
| Local telemetry recording | `src/main/telemetry/local-control.ts:25-27`, `app-handlers.ts:375-382` | Gated on `enabled` and `telemetryRecording` from `logging-settings.json`. Retention for `telemetry-*` lives in log-service. |
| Config snapshot | `src/main/telemetry/lifecycle.ts:204`, `attributes.ts:230,362` | `clubhouse.logging.enabled` and the `settings.changed` key `logging`. |
| E2E | `e2e/plugin-mcp-tools.spec.ts:43-49,80-84` | Reads `*.jsonl` and asserts the text "Plugin <id> registered 1 MCP tools". |
| Auto-update | `auto-update-service.ts:12,876,895,918` | Calls `logService.flush()` before relaunch. |
| Unit tests | 99 files `vi.mock` log-service; 27 assert on `appLog` calls; 11 mock renderer-logger; `test/setup-renderer.ts:287-293` | Import paths and call shapes. |
| Help and docs | `help/content/settings-logging.md`, `troubleshooting-common(.chrome).md:22,73` ("share the log file", and names a namespace `plugins:loader` that doesn't exist), `troubleshooting-safe-mode(.chrome).md:42-57`, `plugins-overview.md:54`, `plugins-permissions.md:22`, `docs/telemetry-otel-spec.md` §6.6, §6.12 and `:21,81,987`, `docs/telemetry-design/05-*.md:22-24` | Text. |
| Maintainer and agent practice | Investigation notes use `core:chat`, `core:agent`, `core:pty`, `core:feedback` and `core:mcp`, read at debug level | Line shape `{ts, ns, level, msg, meta}` and raw ids. |

Not consumers: Annex and mobile (no log access), MCP tools, CLI scripts, `CLAUDE.md`. The lint rule `eslint-rules/catch-must-report.mjs` doesn't accept `appLog` as reporting an error, so it doesn't depend on it.

## 2. Inventory: local telemetry recording (#2289)

| Aspect | Behavior |
|---|---|
| API (main), `src/main/telemetry/facade.ts` | `tel.flow(name, opts, fn)` is a root span (`:190`); `tel.step(name, fn)` is a child span (`:201`); `tel.count(metric, value, attrs)` (`:209`); `tel.event(name, attrs, {severity})` (`:216`); `tel.exception(err, {origin, handled, attrs})` (`:225`). Names must be in `SPANS`, `METRICS` or `EVENTS` (`attributes.ts:655-1230`). |
| API (renderer), `src/renderer/telemetry/facade.ts` | Same shape. Batches flush every 2 s or at 50 items over `telemetry:emit`; main checks each item against the registry (`src/shared/telemetry/renderer-protocol.ts:194`). Renderer spans aren't linked to a parent. |
| Level | Local recording is fixed at **Standard** (`local-control.ts:20`). Detailed-only signals are never recorded locally: `ipc.invoke`, `agent.tool_call`, `annex.rest`, `git.status.slow`. |
| Attributes | `enum`, `int`, `bool`, `hash` (HMAC to 16 hex, `ids.ts:10`), `version`. An enum value outside its set becomes `other`. Strings are capped at 128 characters. **No free-text kind.** |
| Scrubbing | `sanitizeAttribute` (`redaction.ts:35`) applies the registry. The scrubber (`scrubber.ts:42`) replaces URLs, emails, home, paths, IPs, host and user. `sanitizeStack` (`scrubber.ts:73`) drops the message line and keeps up to 30 frames with basenames. |
| Line kinds | `session`, `span` (trace, span and parent ids, duration, outcome, errorType, attrs), `event`, `exception` (type and stack only, **no message**), `metric` (aggregated per 60 s window, 200 series per instrument), `dropped`, `capped`. |
| Volume | 1,000-line queue; flushes every 2 s or at 100 lines; 2 MB chunks; **10 MB per run, after which recording stops for the run**; 50k spans and 10k log records per session (`caps.ts:9`). |
| Retention | None of its own. It shares log-service `cleanup()`, which runs only at startup. |
| Gating | `isLocalRecordingWanted = enabled && telemetryRecording` (`local-control.ts:25-27`). All producers gate on local recording (signal parity); export is an independent uploader. |
| Correlation | Spans, events and exceptions carry the active trace and span (AsyncLocalStorage). `appLog` lines already copy `traceId` and `spanId` (`log-bridge.ts:42`). |
| Breadcrumbs | Not written to the telemetry file. They are in-memory rings that feed feedback reports only. |

Producers that matter for the comparison: `agent.spawn` flow with steps (`agent-system.ts:207`), `agent.run` (exit class and exit code), `agent.kill`, `agent.turn`, `agent.permission`, `chat.start` (no attributes), `chat.probe_failed`, `chat.protocol.unknown` [driver, kind], `mcp.tool_call` [toolKind, tool, result, errorType], `git.<op>` [errorType from `classifyGitFailure`, exit code, timed_out], `ui.hang`, `ui.interaction.duration`, `renderer.unresponsive`, `update.*`, `annex.*`, `goobers.*`, `persist.*`, `plugin.*`, `app.startup` and shutdown trees, `exception`.

## 3. Diff: legacy signal to telemetry

Classes:
- **Covered:** the same information at similar or better fidelity.
- **Partial:** the event is recorded, but the reason, identity or text is lost.
- **Legacy only:** nothing in telemetry.
- **Noise:** no investigative value.

### 3.1 Signals used in investigations

| Signal | Legacy evidence | Telemetry today | Class | What is lost |
|---|---|---|---|---|
| Chat start, driver choice and check | `chat-spawn.ts:319,340,523` (candidates, ok, reason, loginRequired, notices, resume id, MCP servers) | `chat.start` span: ok or error, `chat_start_failed`, **no attributes** (`spawn-telemetry.ts`) | Partial | Driver, provider, check reason, login required, notices, resume honored |
| Chat fallback to the terminal | `chat-spawn.ts:253,263,475` (reason, exitCode); breadcrumb `chat.ended.<reason>` | `session_ended` with reason `fallback` **discards the run** (`chat-telemetry.ts:203-205`) | **Legacy only** | That a fallback happened, and why |
| Chat cancel or abandon | `chat-spawn.ts:182,274,290`, `chat-runtime.ts:534,549` | None | Legacy only | Cancel reason, whether the runtime registered |
| Driver RPC and stderr | `acp-client.ts:147-218`, `codex-app-server-client.ts:114-421`, `stream-transport.ts:87-251` | None (Detailed IPC spans aren't driver RPC) | Legacy only | Method, error code and message, stderr text, malformed line preview |
| Unmapped wire messages | `chat/claude/transport.ts:197-199` (type, subtype, key shape); Codex `Unrecognized Codex notification` (method) | `chat.protocol.unknown` [driver, protocolKind] counter | Partial | **Which** message: the type, subtype or method name, which is open-ended |
| PTY exit | `pty-manager.ts:390` (exitCode, binary, **lastOutput**) | `agent.run` exit class and `process.exit.code`; breadcrumb `pty.exit*` | Partial | `lastOutput`, which is the only clue on early-exit failures. Raw text that scrubbing can't make safe. |
| PTY spawn failure | `pty-manager.ts:349,428` (binary, cwd, error) | `pty.spawn` step with errorType `pty_spawn_failed` | Partial | The error text (ENOENT, EACCES, and so on) |
| PTY stale session, oversized write | `pty-manager.ts:157,492,512` | None | Legacy only | Everything |
| Agent session-id capture and resume | `agent-system.ts:765-844`, `stale-session.ts:71` (8 distinct outcomes, sessionId, exitCode, runMs) | None | **Legacy only** | The outcome itself. The raw session id is needed locally to cross-reference the CLI's session store. |
| Agent spawn command | `agent-system.ts:675` (binary, args, cwd, model, allowedTools) | `agent.spawn` flow: orchestrator, model family, runtime, flags | Partial | Binary and cwd. The args leak prompts (#1919), so dropping them is correct. |
| MCP tool calls | `bridge-server.ts:204,216,250` (agentId, toolName, **args**, errorDetail) | `mcp.tool_call` span [toolKind, tool (closed list), result, errorType] plus metrics | Partial | Which agent (there is no `agent.id_hash`), the error text, plugin tool names (they become `other`). Args must not come back. |
| MCP tool routing refusals | `tool-registry.ts:374-455` (group off, unparseable, no binding) | Counted as an error result at best | Partial | Refusal reason and available bindings |
| Feedback | `feedback-service.ts:345` (report **id**, status, state); `feedback-handlers.ts:53-72` | None; breadcrumbs only | **Legacy only** | The report id is the link maintainers use between a Framebriar report and the local log |
| `ui:perf` long frames | `ui-perf.ts:215-231` (count, maxMs, totalMs, view, surface, interaction target, top 3 scripts) | `ui.hang` [view, surface, duration, frames, script source, interaction type] plus long-frame metrics | Covered for triage; partial for blame | Interaction target (`data-testid`), script function and source detail |
| `ui:perf` slow interactions | Same sink, `kind: slow_interaction` | `ui.interaction.duration` histogram only, **no event** | Partial | When it happened, which view, blame |
| Window unresponsive | `crash-handlers.ts:39,47` | `renderer.unresponsive` span plus metric | Covered | (none) |
| Git failures | `git-service.ts:85` (cmd, cwd, error) | `git.<op>` spans with classified errorType, exit code, timed_out | Covered for triage | stderr text and repo path |
| Hook events | `hook-server.ts:323` (per event, info) | `agent.hook_events` and `agent.tool_calls` metrics | Covered / **noise** | (none; #1927 already asks to demote it) |
| Permission stuck | `hook-server.ts:405` | `agent.permission.stuck` (bridged) | Covered | (none) |

### 3.2 Namespace classification

| Class | Namespaces |
|---|---|
| **Covered** (4) | `ui:perf` (window unresponsive), `core:hook-server` (per-event lines), `core:git` (for triage), `telemetry:control` |
| **Partial** (21) | `core:chat`, `core:chat:codex`, `core:chat:copilot`, `core:pty`, `core:mcp`, `ui:perf` (slow interactions, blame), `core:agent` (spawn and exit), `update:check`, `update:download`, `update:apply`, `update:apply-on-quit`, `core:annex`, `core:annex-client`, `core:annex-server`, `core:plugins`, `marketplace`, `marketplace:updates`, `core:project-store`, `canvas`, `core:startup`, `core:shutdown`. In each, the outcome is counted or spanned but the error text, ids and reason are lost. |
| **Legacy only** (about 40) | `core:feedback`, `core:agent-config`, `core:agent-settings`, `core:config-pipeline` (apart from the bridged restore failure), `core:config-diff`, `core:materialization`, `core:blueprint`, `core:project`, `core:file` (apart from `file.path_denied`), `core:canvas-index`, `canvas:main`, `core:group-project`, `core:orchestration`, `core:orchestrator` (CLI session-store read failures), `core:headless`, `core:companion`, `core:hook-server-toggle`, `core:permission-queue`, `core:plugin-storage`, `core:plugin-events`, `marketplace:custom`, `core:safe-mode` (apart from `app.safe_mode`), `core:security`, `core:protocol`, `core:ipc`, `core:window`, `core:process`, `core:renderer`, `core:resume`, `core:agents`, `agents`, `core:telemetry`, `store:ui`, `store:onboarding`, `store:commandPalette`, `update:session-resume`, `update:history`, `update:restore`/`retry`/`fetch`/`apply-detect`, `plugin:<id>` (plugin API) |
| **Noise or debug-only** (signals) | `ui:terminal:scroll` (35 % of lines, debug), the per-event `Hook event received` line (41 %), per-RPC `RPC request/response` info lines (driver internals), `Tool call` / `Tool call completed` info pairs (duplicating `mcp.tool_call`), `ui:nav` (only a breadcrumb carrier), `core:project-store` debug, `core:agent-config` debug, the `Tools list requested` info line (duplicating `mcp.tools_list`) |

Removing the noise rows leaves every run in the sample at 1.4 MB or less (a 12.1 MB run drops to 0.1 MB). That fits the recorder's budgets even at debug level.

### 3.3 Fidelity and privacy

- **Scrubbing makes telemetry useless for the questions people actually ask while debugging.** Session ids become a 16-hex HMAC (or `other`), paths become `<path>`, and error messages are dropped. Stderr, `lastOutput` and wire-message names have no attribute kind at all. That is correct for export, but for local debugging it is the wrong tool.
- **The legacy log is worse on privacy than it needs to be.** It writes prompt text through spawn args and RPC params (#1919), MCP tool `args` (`bridge-server.ts:204`), and profile env keys (keys only). These must **not** carry over into any new tier.
- **The UI promises things that a mixed file would break.**
  - "Logs are stored on your local disk only and are never transmitted" (`LoggingSettingsView.tsx:72`) stays true.
  - "anonymized the same way as export" (`:95`) becomes false for a file that contains diag lines. The copy has to change, or the diag lines need their own file.

## 4. Gaps and proposed migrations

### 4.1 A local-only diagnostic tier (the core proposal)

Telemetry can't carry text, and investigations need it. So the recorder gets a tier that isn't telemetry:

- **API.** `diag(ns, level, msg, meta?)` in main, with a renderer counterpart over the existing renderer batch channel (`telemetry:emit` gains a `diag` item kind, validated in main). `appLog` and `rendererLog` keep their signatures and forward to `diag` for the length of the migration. The plugin `api.logging` keeps its contract and writes `plugin:<id>` diag lines.
- **Line.**

  ```json
  {"t":"diag","ts":"…","ns":"core:pty","level":"error","msg":"PTY exited","meta":{"agentId":"…","exitCode":1,"lastOutput":"…"},"traceId":"…","spanId":"…"}
  ```

  `traceId` and `spanId` come from the recorder's AsyncLocalStorage, so a diag line sits inside its `agent.spawn` or `chat.start` span. This is better correlation than `session-*.jsonl` has today: renderer lines there carry no trace ids.
- **Local only, by construction.**
  - Diag lines go straight to the `LocalRecorder` queue and never enter the facade, the SDK runtime or the exporter.
  - A test asserts the exporter receives nothing from `diag`, under both `EXPORT_WITHOUT_LOCAL_RECORDING` settings.
  - Diag lines are never added to feedback reports.
- **Gating.** `logging-settings.json` `enabled`, then `namespaces[ns] !== false`, then `minLogLevel`. These are exactly today's semantics. `telemetryRecording` gates only the telemetry signal lines, not the diag lines (see 4.3).
- **Redaction, not scrubbing.** Paths, error messages and ids stay raw, because that is the point of this tier. What is removed is content and secrets:
  - prompt text (spawn args and RPC params, #1919);
  - MCP tool args;
  - env values;
  - `meta` strings capped at 2,000 characters, and `meta` total at 8 KB;
  - bearer tokens and keys, matched by key name (`token`, `secret`, `authorization`, `apiKey`).
- **Budget.** Diag lines get their own byte budget per run and a level floor when under pressure: drop debug first, then info. Signals and diag lines can't starve each other.
- **Breadcrumbs.** The `tapBreadcrumb` logic moves to the diag entry point, or its producers call `recordBreadcrumb` directly (4.2, item F). Breadcrumbs keep being recorded whatever the settings are, as today.

### 4.2 Structured telemetry for high-value gaps

These keep the information available at Standard level and on export, not just in local diag lines:

| Item | Signal |
|---|---|
| A. Chat start, fallback and cancel | Add attributes to `chat.start`: `chat.driver`, `orchestrator`, `chat.start.result` (enum: `ok`, `fallback_no_driver`, `fallback_binary_missing`, `fallback_check_failed`, `fallback_login_required`, `cancelled`, `abandoned`, `failed`), `chat.check.reason` (closed enum of check reasons), `agent.resume` and `chat.resume_honored` (bool). Add a `clubhouse.chat.fallback` event (S) instead of silently discarding the run (`chat-telemetry.ts:203`). Add the unmapped message's type, subtype or method to diag (open-ended, so diag only), and keep the counter. |
| B. Session capture | `clubhouse.agent.session_capture` event (S): `orchestrator`, `agent.id_hash`, `session.capture.result` (enum: `captured`, `kept_previous`, `ignored_not_in_store`, `ignored_foreign`, `resume_failed_no_session`, `resume_failed_early_exit`, `persist_failed`, `capture_failed`), `process.exit.code`. The raw session id goes in a diag line at info. |
| C. PTY exit | `lastOutput` goes in a diag line only (raw text, redacted and capped), and only for exits that aren't completed or killed. The `agent.run` exit class stays the signal. Add `pty.write_rejected` and `pty.stale_swept` counters. |
| D. Slow interactions | `clubhouse.ui.slow_interaction` event (S), symmetric with `ui.hang`: view, surface, duration, interaction type. The blame target (`data-testid`) goes in diag. |
| E. MCP tool calls | Add `agent.id_hash` to `mcp.tool_call`. Add `mcp.refusal.reason` (enum: `group_off`, `unparseable`, `no_binding`) for registry refusals. The error text goes in diag. Args are never recorded. |
| F. Feedback | `clubhouse.feedback.submitted` event (S): `feedback.result` (enum: `delivered`, `queued`, `failed`, `not_configured`). The report id goes in a diag line at info, so maintainers can still match a report to the log. |

### 4.3 Settings

| Today | Proposed |
|---|---|
| `enabled` ("Write logs") | Keep the key. Rename the label to "Record locally". It gates the whole file. |
| `telemetryRecording` ("Record telemetry locally") | Keep the key. It gates only the signal lines; diag lines follow `enabled`. A user who wants only debug text can turn the signals off. |
| `minLogLevel`, `namespaces` | Keep. They apply to diag lines. The namespace list comes from a static registry of known namespaces plus those seen this run, so it isn't empty at startup. |
| `retention` | Keep. Cleanup must also run periodically (hourly) and after each run's rotation, not only at startup. |
| UI copy | Replace "anonymized the same way as export" with copy that says the signals are anonymized, diagnostic lines contain local paths and error text, and nothing in this folder is sent. |

No file migration is needed: every key keeps its meaning. One small migration is needed: if the user's `minLogLevel` is `debug`, warn once on the first run after the migration that debug diag lines now share the run budget.

### 4.4 Justified drops

- **`ui:terminal:scroll`** "PTY data write" and the fit tracing. These are debug-only, 35 % of all lines, and add nothing once the scroll bugs they chased are closed. Drop them. If needed again, put them behind a localStorage dev flag.
- **The per-event `Hook event received` line.** `agent.hook_events` covers it. Replace it with an info diag summary per run (#1927).
- **Per-RPC `RPC request/response` info lines** in the ACP and Codex clients. Demote them to debug, and record method and id without params (#1919). Errors and timeouts stay at warn and error.
- **The `Tool call` / `Tool call completed` info pair.** `mcp.tool_call` covers it. Keep only the error and threw lines in diag, without args.
- **The `ui:nav` "View changed" line.** It exists only for the breadcrumb, so record the breadcrumb directly.

## 5. Removal plan

Ordered. Each step lands on its own, and nothing user-visible regresses between steps.

1. **Land #2289.** (Prerequisite; open now.)
2. **Recorder hardening** (the G and H issues).
   - Replace the 10 MB hard stop with rolling deletion of the oldest chunk within a run, plus a `capped` line that reports what was evicted.
   - Run retention periodically.
   - Move retention out of log-service into `src/main/telemetry/`.
   - *Risk:* long-running apps lose the tail of a run, which is what investigations need. Today's cap ends recording for days.
3. **The diag tier** (issue I).
   - Add a `t:"diag"` line kind with gating, redaction and its own budget.
   - Add the renderer `diag` item kind with validation and a rate limit (today `log:write` has none).
   - Add tests: no diag line reaches the exporter; content redaction.
4. **Drop the noise** (issue J; #1927, #1919). Do this before the switch, so diag budgets are sized on real signal.
5. **Point `appLog`, `rendererLog` and `log:write` at the diag tier** (issues K and L).
   - Keep the function names and import paths, so the 99 mocking test files and 757 call sites are untouched.
   - Move `tapBreadcrumb`, or replace it with direct `recordBreadcrumb` calls (issue M).
   - Point the plugin `api.logging` at diag. The contract is unchanged; check that the version-contract tests pass.
   - Keep `logService.flush()` semantics for auto-update by delegating to the recorder's flush.
   - Fix startup ordering: the recorder starts synchronously in `initTelemetry`, so the "entries before `init`" loss goes away.
   - *Risk:* behavior shifts for 27 tests that assert on `appLog` arguments. They keep passing if the shim keeps its signature.
6. **Structured events** A to F (issues N to S). These can run in parallel with step 5; none blocks removal, except F, which carries the feedback correlation.
7. **Consumers** (issues T and U).
   - The E2E `plugin-mcp-tools.spec.ts` reads `t:"diag"` lines from `telemetry-*.jsonl`.
   - Update the help topics (`settings-logging`, `troubleshooting-*`, `plugins-*`), fixing the `plugins:loader` name.
   - Update spec §6.6 and §6.12 and the "logs never transmitted" banner.
   - Update the Settings copy and labels (issue V).
8. **Delete the legacy writer.**
   - Remove the `session-*.jsonl` file writer, rotation and `getLogPath` from `log-service.ts`. `getNamespaces` moves.
   - Keep pruning the `session-*` prefix in retention for one release, so old files age out instead of being stranded.
   - Remove the `LogEntry.traceId`/`spanId` copy and `traceFieldsForLog`.
   - *Risk:* support guidance and agent habits that grep `session-*.jsonl` go stale. Announce the change in the release notes and the help topic.
9. **Optional follow-up after v0.42.** Codemod `appLog(...)` to `diag(...)` and delete the shim.

### Top risks

1. **Data loss during long runs:** the 10 MB hard stop (`local-recorder.ts:203-213`) plus retention that runs only at startup. As the only record, the recorder must roll, not stop.
2. **Silent breadcrumb and feedback regressions:** `view.*`, `runtime.switch*` and all `ui.*` performance breadcrumbs come in through `log()` (`log-service.ts:125-138`). Removing the writer without moving the tap empties feedback breadcrumbs, and no test fails.
3. **Privacy regression in either direction.**
   - Moving legacy lines into the telemetry file unchanged carries over the prompt leaks (#1919) and falsifies the "anonymized" copy.
   - Scrubbing them destroys their debugging value.
   - The diag tier needs content redaction, a local-only guarantee enforced by tests, and new UI copy, all before the switch.

Also: the plugin `api.logging` is a public contract (API versions 0.5 to 0.9) and must keep working. The E2E spec reads `session-*.jsonl` and will fail in CI at the deletion step if it isn't migrated first.
