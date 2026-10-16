# Structured chat over coding CLIs: research and design

Status: research, no code changes · Date: 2026-10-16 · Repo state: `f4451aaa`

Interactive version with mockups: https://claude.ai/artifact/3CtVdSGUdfhcnecMLozaQD (private; ask the maintainer for access)

This document looks at replacing the embedded TUIs of Claude Code, OpenAI Codex CLI and GitHub Copilot CLI with a native Clubhouse chat view. It re-probes each CLI's programmatic surface as of today, checks which paths work on $100–200/month subscription plans, and recommends an architecture and a phased plan.

## 1. Summary

- All three CLIs now have a programmatic surface that serious GUIs run on:
  - **Codex:** the Codex IDE extension, the desktop app and the Codex TUI itself run on `codex app-server`.
  - **Claude Code:** VS Code drives Claude through the Agent SDK. The SDK speaks the same stream-json wire as `claude -p`.
  - **Copilot:** VS Code drives Copilot through the GA Copilot SDK.
- **Today's "structured mode" has a working skeleton but can't hold a conversation.**
  - It ends the session after the first turn.
  - It has never run against a real CLI in CI.
  - Its event model has no session, turn or sequence identity.
- **Recommendation:** use native drivers per CLI behind one Clubhouse event model. Name the events after ACP's vocabulary, and attach a per-provider capability record.
  - **Claude:** one driver with two modes. The Agent SDK is the default, pointed at the user's own installed `claude`. Raw `-p` stream-json, with the control protocol spoken directly, is the second mode.
  - **Codex:** `codex app-server` v2 over stdio, with types generated from the pinned version.
  - **Copilot:** finish the existing ACP driver, then move to the Copilot SDK. The ACP driver stays as the generic driver for other ACP agents.
- **Subscription plans (hard constraint):**
  - Codex (ChatGPT Plus/Pro) and Copilot (Pro+/Max) are clearly allowed for a local open-source app.
  - Claude Pro/Max/Team are allowed, per Anthropic's Help Center article of 2026-10-07: "You can still use the Claude Agent SDK, claude -p, and third-party apps with your subscription limits." The maintainer ruled this the governing text (§4).
- **Terminal stays first-class:** each provider can be set to Chat or Terminal, with an automatic fall back to the terminal if a CLI update breaks the protocol or terms change (§7.1).
- **Rollout in four steps (§8.0):**
  1. Remove today's structured mode, migrating anyone using it back to the terminal.
  2. Ship Chat as an experimental feature in beta builds, with a per-provider choice once it's enabled.
  3. Promote Chat to stable, make it the default, and remove the experimental scaffolding.
  4. Introduce the new default with a light first-launch tip that links to Settings.
- **Size:** about 14–18 engineer-weeks across six phases.

## 2. Clubhouse today ("structured mode")

### Pipeline

1. `agent-system.ts:205-266` asks the provider for an adapter:
   - Claude → `StreamJsonAdapter`
   - Codex → `CodexAppServerAdapter`
   - Copilot → `AcpAdapter`, launched with `--acp --stdio --autopilot`
2. The adapter spawns the CLI through `structured-spawn.ts`, normalizes its output into events, and pushes them onto an async queue.
3. `structured-manager.ts:108-146` drains the queue. It writes `agent-logs/<id>-structured.jsonl`, broadcasts `agent:structured-event`, and forwards to Annex.
4. `StructuredAgentView` folds the events into component-local state (`StructuredAgentView.tsx:80`, `processEvent` `:249-447`). It renders them with `MessageStream`, `ToolCard`, `PermissionBanner`, `FileDiffViewer`, `PlanProgress`, `CostTracker`, `ThinkingPanel` and `ActionBar`.

### Event model

`src/shared/structured-events.ts:42-121` defines 13 event types:

`text_delta`, `text_done`, `tool_start`, `tool_output`, `tool_end`, `file_diff`, `command_output`, `permission_request`, `plan_update`, `thinking`, `error`, `usage`, `end`.

- No event carries a session id, turn id or sequence number.
- There are no session-init or user-message events.
- Nobody emits `tool_output`. Only Codex emits `file_diff` and `command_output`.

### Gating

- The experimental `structuredMode` flag (`ExperimentalSettingsView.tsx:20-24`). Its description wrongly says "ACP protocol".
- A hard gate at `agent-system.ts:213-215`.
- A per-durable-agent checkbox.
- `structuredProtocol: 'acp'` on the Claude provider is dead.

### What works

- The adapter → queue → manager → IPC → renderer pipeline.
- A shared NDJSON JSON-RPC base.
- Windows-safe spawn (`.cmd` shims, fixed in #1911).
- About 350 unit tests.
- Renderer components for every block type.

### Missing or broken

- **Every turn ends the session.** All adapters call `queue.finish()` at turn end. The manager then kills the process (`structured-manager.ts:123-127`), the agent goes to `sleeping`, and the feed is lost. A follow-up `sendMessage` fails with "No structured session found", and Stop kills the agent.
- **Claude** (`stream-json-adapter.ts`):
  - It is single-turn with stdin closed; `sendMessage` and `respondToPermission` throw.
  - Tool input is always `{}`.
  - `tool_end` has an empty name.
  - Cost reads `cost_usd` instead of `total_cost_usd`.
  - Usage is probably double-counted.
  - The `system/init` session id is dropped.
- **Codex:** `thread/start` sends no `approvalPolicy`, so the permission mode is ignored. The system prompt is sent as user text. Resume exists but nothing calls it.
- **Copilot:** there are no diffs, no usage, no `text_done` and no `session/load`.
- **Renderer:**
  - `ToolCard` shows results only on error.
  - Codex command output replaces instead of appending.
  - `PermissionBanner` auto-denies after a client-invented 120 s and offers yes/no only.
  - The composer is a one-line input that disappears when the session ends.
  - The Assistant calls preload methods that don't exist (`assistant-agent.ts:624,647`).
- **Durable structured agents** skip Clubhouse MCP injection, hooks, `CLUBHOUSE_AGENT_ID`/nonce env and the launch wrapper (`agent-system.ts:229-266` vs `:387-476`).
- **Sessions and transcripts:** no session ids are captured, and the transcript is reopened with `'w'` on every start.
- **IPC exposure:** `agent:start-structured` accepts renderer-supplied env, args and command prefix, and has no caller.
- **Tests:** all payloads are hand-written. The nightly `scheduled-real-cli-e2e.yml` tests terminal mode only, so the drift went unnoticed for about six months.

### History

| Date | Change |
|---|---|
| 2026-02-28 | Core (#397) |
| 2026-03-01 | Renderer, ACP, Annex and Claude adapters (#400, #403, #404, #406) |
| 2026-03-17 | Codex adapter (#857) |
| 2026-03-26 | Durable agents (#1136) |
| 2026-04-05 | Codex resume (#1334) |
| 2026-04-25 | Flag becomes a hard gate (#1410) |
| mid-May to early Sep | Dormant; then #1729 |
| 2026-10-16 | #1911 fixes protocol drift |

What #1911 found:

- **Codex:** text arrived empty, tools were dropped, failed turns showed as complete, and usage was 0.
- **Copilot:** no output was mapped, permissions were answered in the wrong shape, and turns hit a 30 s timeout.

Open parity epics: #1534 (Copilot) and #1535 (Codex).

## 3. The CLIs today (probed 2026-10-16)

Each CLI was checked with `--help`, schema generators and handshakes. Each got at most two tiny paid prompts on the cheapest models.

### Claude Code: 2.1.300, Agent SDK 0.3.301

**Surfaces**

- `claude -p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages] [--replay-user-messages]`.
- A control protocol runs over the same pipes: about 40 host-to-CLI request types (`initialize`, `interrupt`, `set_permission_mode`, `set_model`, `mcp_*`, `rewind_files`, `get_context_usage`, `stop_task`, …). In the other direction the CLI sends `can_use_tool`, `hook_callback` and `elicitation`.
- The Agent SDK spawns exactly this. It adds `--permission-prompt-tool stdio`, a value `--help` doesn't document.
- There is no standalone wire spec. The SDK's types are the spec.

**Output events**

- `system/init`: tools, MCP status, slash commands, agents, model, permission mode, and a `capabilities[]` list.
- `stream_event` partials.
- `assistant` messages, which arrive before `content_block_stop`.
- `user` tool results, with a typed `tool_use_result` that includes `structuredPatch` for edits.
- `result` once per turn: `total_cost_usd`, `modelUsage`, `queued_turn_count`.
- Also `compact_boundary`, `task_*` (subagents), `rate_limit_event` (5-hour and 7-day), hook events and `permission_denied`.

**Input**

- Text, base64 images and documents.
- `priority`: `now` steers, `next` (the default) joins the current turn, `later` queues for the next turn.
- `shouldQuery:false` injects context without starting a turn.

**Permission modes**

`default` ("Manual"), `acceptEdits`, `plan`, `auto` (classifier), `dontAsk`, `bypassPermissions`.

- `-p` may start in `auto`, so pass `default` explicitly.
- Plan approval arrives as `can_use_tool` for `ExitPlanMode`.
- Todos are now the `TaskCreate`/`TaskUpdate` tools, which are opt-in on newer models.

**Sessions**

- `--resume`, `--fork-session` and resume-at.
- The SDK adds list, read and fork helpers over the on-disk JSONL.
- The V2 session API was removed in 0.3.142.

**Packaging, license and pace**

- The SDK bundles about 250 MB per platform; `pathToClaudeCodeExecutable` uses an existing install instead.
- The SDK is proprietary, under the Commercial Terms.
- Windows x64 and arm64 are supported.
- Releases come near-daily; the SDK had about 27 releases in 30 days.

**ACP adapter**

- `@agentclientprotocol/claude-agent-acp` 0.93.0 (Apache-2.0), built on the SDK.
- It loses cost detail, rewind, raw partials and rich permission metadata, except through `_meta` extensions.

### Codex CLI: 0.159.3 (latest 0.163)

**`codex app-server`**

- JSON-RPC 2.0 without the `jsonrpc` field, over stdio JSONL; ws and unix socket also work.
- OpenAI says it powers rich clients such as the VS Code extension. In 0.159 the TUI also runs on a shared app-server daemon.
- **Handshake:** `initialize {clientInfo, capabilities:{experimentalApi, optOutNotificationMethods}}` → `initialized`.
- **Size:** 107 stable client requests (170 with experimental), 10 server→client requests, 85 notifications.
- **Status:** OpenAI calls it "experimental and aren't supported for production workloads". Generated schemas are specific to the version they came from.

**Requests**

| Area | Methods |
|---|---|
| Threads | `thread/start`, `resume`, `fork` (at a turn), `read`, `list`, `turns/list`, `items/list`, `archive`, `compact/start`, `revert`, `name/set` |
| Turns | `turn/start`, `turn/steer` (stable, needs `expectedTurnId`), `turn/interrupt` |
| Other | `review/start`, `model/list`, `config/*`, `skills/list`, `mcpServerStatus/list`, `mcpServer/oauth/login`, `account/login/*`, `account/read`, `account/rateLimits/read` |
| Experimental only | `thread/queue/*`, `thread/settings/update`, `turn/settings/update`, `collaborationMode/list` |

**Notifications**

| Area | Notifications |
|---|---|
| Lifecycle | `thread/status/changed`, `turn/started`, `turn/completed`, `item/started`, `item/completed` |
| Deltas | `item/agentMessage/delta`, reasoning deltas, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/plan/delta` |
| Turn-level | `turn/diff/updated`, `turn/plan/updated` |
| Usage | `thread/tokenUsage/updated`, `account/rateLimits/updated` |
| Errors | `error` (with `willRetry`) |

**Approvals**

- **Commands** (`item/commandExecution/requestApproval`): parsed actions, cwd, reason, network context, `proposedExecpolicyAmendment` and `availableDecisions`. Answers: `accept`, `acceptForSession`, accept with policy amendment, `decline`, `cancel`.
- **File changes:** answered the same way.
- **Other server requests:** `item/tool/requestUserInput` (experimental), MCP elicitation, dynamic tool calls.
- **AI review:** `approvalsReviewer` can route approvals to an AI reviewer instead of the user.

**Policies**

- Approval: `untrusted`, `on-request`, `never`, or granular.
- Sandbox: `readOnly`, `workspaceWrite{roots, network}`, `dangerFullAccess`, or a named profile.
- Plan mode is `collaborationMode: plan` (experimental).

**Item types**

`userMessage`, `agentMessage`, `reasoning`, `plan`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall` (subagents), `subAgentActivity`, `webSearch`, `imageView`, `contextCompaction`, review markers.

**Other surfaces**

- **`codex exec --json`:** item-level events only. No deltas, no diff text, no approvals.
- **`@openai/codex-sdk` (TypeScript):** wraps exec, so it has the same limits.
- **`codex mcp-server`:** removed.
- **ACP adapter:** `@agentclientprotocol/codex-acp` 2.2.2, which runs on app-server. It ignores `config.toml` approval and sandbox settings.

**License, Windows and pace**

- Apache-2.0.
- Native on Windows (the `mxc` sandbox on Windows 11).
- About weekly releases, with removals: `thread/rollback` in 0.156, `mcp-server`, `--full-auto`.

### Copilot CLI: 1.0.92 installed (latest 1.0.98)

**`copilot --acp`** (stdio, or TCP via `--port`)

- **Status:** public preview since 2026-01-28. The CLI itself went GA on 2026-02-25.
- **Verified live:**
  - `initialize` returns protocol v1 with load, images, embedded context, HTTP/SSE MCP, close and list.
  - `session/new`, `load` (replays history), `list` (machine-wide, so filter by cwd), `close`, `cancel`, `prompt`.
  - `set_mode`, with mode IDs ending `#agent`, `#plan` or `#autopilot`.
  - `set_config_option` for model (23 models with cost multipliers; the list contains duplicates), effort and allow-all.
- **Not available** ("method not found"): `session/resume`, `fork`, `delete`, `$/cancel_request`.
- **Updates:**
  - Message and reasoning chunks. Reasoning arrives one token per notification.
  - `tool_call` with kind, raw input, locations, and `diff` content (old/new text plus a unified diff).
  - Title updates and the command list (33 commands plus skills).
  - Usage carries context fill only. Per-turn tokens come as a non-standard `usage` field on the prompt result.
- **Permissions:** `allow_once`, `allow_always`, `reject_once`. There is no `reject_always`, and nothing says what "always" covers. Rules can be set only at launch.
- **Quirks:**
  - It ignored the client's file-system capabilities and wrote the file itself.
  - A stray `Info: <path>` line appeared in assistant text.
  - Pass `--no-auto-update` to pin the version.

**Copilot SDK (`@github/copilot-sdk`)**

- GA since 2026-06-02, MIT, with SDKs in 6 languages. It talks to a hidden `--server` mode.
- About 150 event types, including queue vs immediate (steer) sends, fork and rewind, plan-exit approval, subagents and credit usage.
- VS Code's Agent Host uses it.

**Other surfaces**

`copilot -p … --output-format json` (one-shot JSONL).

**Auth, license and pace**

- Login: `copilot login`, or the env vars `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`. Bring-your-own-key works via `COPILOT_PROVIDER_*`.
- The CLI is proprietary. Windows is first-class (PowerShell 6+).
- Releases come near-daily.

### Agent Client Protocol

- **Status:** v1 is stable (schema 1.26.0). The only standard transport is stdio JSON-RPC. Governance is interim, by Zed and JetBrains.
- **Clients:** Zed, JetBrains, Neovim, Emacs, Obsidian and others. VS Code built its own Agent Host Protocol instead.
- **Native agents:** Gemini CLI and Copilot (preview). Claude Code doesn't have it; the request was closed as not planned (anthropics/claude-code#6686). Neither does Codex. Both are reachable only through the `agentclientprotocol`-org adapters; the old `@zed-industries/*` packages are deprecated.
- **Stable v1 lacks:** steering and queueing (the v2 draft makes `session/prompt` return on insert), rewind, and reliable fork and subagents (unstable). It also lacks a cost or plan-limit model and structured plan approval.

## 4. Subscription plans and auth (hard constraint)

Requirement: chat must work for users on $100–200/month plans, not only API billing. Everything below comes from official sources, accessed 2026-10-16. Most pages show no last-updated date.

| Path | $20 tier | $100–200 tier | Team / Business / Ent. | Auth | Third-party use | Confidence |
|---|---|---|---|---|---|---|
| Claude Agent SDK (default), user's own binary | Pro, plan limits | Max 5x/20x, plan limits | Team and Enterprise seats | Inherits `/login` | Yes, per the 2026-10-07 Help Center article | Decided |
| Claude `-p` stream-json (second mode) | Same pools | Same | Same | Inherits `/login` | Yes, same article | Decided |
| Claude via claude-agent-acp | Same pools | Same | Same | Inherits `/login` | Built on the SDK; not used | n/a |
| Codex app-server / codex-acp | Plus | Pro | Business works; Sign in with ChatGPT eligibility not stated | `account/login/start`, or Sign in with ChatGPT | Yes for local open-source; never hosted or commercial | High |
| Codex exec / TS SDK | Plus | Pro | Same | Inherits CLI login | No prohibition found | Medium–high |
| Copilot `--acp` | Pro, Pro+ | Max ($100) | Unless an admin disables the CLI | Inherits login; run `copilot login` in a terminal | Yes ("Custom frontends"); preview terms | Medium–high |
| Copilot SDK | Pro, Pro+ | Max ($100) | Org policy | Signed-in user, or a token from your own GitHub OAuth app | Yes ("Desktop applications…") | High |

### Anthropic: allowed (maintainer decision, 2026-10-16)

The maintainer ruled that the Help Center article below governs. Clubhouse may drive Claude through the Agent SDK and `claude -p` on users' Pro, Max and Team subscriptions. The other texts are kept here for the record.

**Governing text**

- [Help Center, Agent SDK with your plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (update dated 2026-10-07): "You can still use the Claude Agent SDK, claude -p, and third-party apps with your subscription limits."
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) has an exception: it doesn't prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".

**Older or stricter wording, superseded for this project**

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) also bars third-party developers to "route requests through Free, Pro, or Max plan credentials on behalf of their users".

**Still to watch**

- [Help Center, Log in](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) (updated about 2026-10-15): the preferred route for third-party tools, "including open-source projects", is an API key. Anthropic "reserves the right to draw use of such third-party tools from usage credits rather than subscription limits."
- [Headless docs](https://code.claude.com/docs/en/headless): `--bare` "will become the default for `-p` in a future release". Bare mode never reads the subscription OAuth.
- [Max/Team monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) ($100 for Max 5x, $200 for Max 20x, up to $500 pooled for Team) apply only with an API key.

### OpenAI: allowed for local open-source apps

- [App-server docs, "Auth endpoints"](https://developers.openai.com/codex/app-server):
  - "If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT".
  - "App-server authentication has never been permitted for commercial or hosted services."
- [Sign in with ChatGPT](https://developers.openai.com/siwc):
  - Plan usage is "available to all open-source partners" for eligible Plus and Pro users.
  - There's no client secret; the app self-registers on first sign-in.
  - The token is passed to app-server as `ACCESS_TOKEN`, and app-server must restart when the token refreshes.
- **Limits:** Plus has a 5-hour window shared across apps; Pro has none.
- **Unclear:** Sign in with ChatGPT for Business, Enterprise and Edu; app-server access for Free and Go; a sunset date for the "continue using it" allowance.

### GitHub: allowed

- [Plans](https://docs.github.com/en/copilot/get-started/plans): "All plans include Copilot CLI and the Copilot app."
- **Billing:** since 2026-06-01, AI Credits at $0.01 each:

  | Plan | Monthly credits |
  |---|---|
  | Pro | 1,500 |
  | Pro+ | 7,000 |
  | Max ($100) | 20,000 |
  | Business | 1,900 per seat |
  | Enterprise | 3,900 per seat |

  Programmatic use bills like interactive use. Org overage is on by default.
- **Third-party use:**
  - The [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) lists "Custom frontends" as a use case. ACP is public preview, so the preview terms apply.
  - The [SDK's signed-in-user auth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) is meant for "Desktop applications where users interact directly".
- **Org gating:** admins can disable the CLI. Whether ACP also needs the preview-features policy is unverified.

### Design consequences

- **Clubhouse never touches tokens.** It spawns the user's installed, unmodified CLI, which uses its own stored login. It never reads `~/.claude`, `~/.codex` or the keychain.
- **Claude:**
  - Default to the Agent SDK with `pathToClaudeCodeExecutable` set to the user's own `claude`. Exclude the SDK's bundled binaries from the Electron build.
  - Raw `-p` stream-json is the second mode, using the same binary and login.
  - Never pass `--bare` in subscription mode, and check whether the SDK sets it once `--bare` becomes the `-p` default.
  - Warn when `ANTHROPIC_API_KEY` would override the plan.
- **Codex:** inherit the CLI login now and move to Sign in with ChatGPT later. Send a stable `clientInfo.name`.
- **Copilot:** inherit the CLI login, hand off to a terminal running `copilot login`, and warn when `GH_TOKEN` overrides it.

### Vendor questions

- **Anthropic** (eligibility is settled; these are operational):
  1. Will there be a way to keep subscription login once `--bare` is the default for `-p`, and does the SDK opt out?
  2. Will Clubhouse traffic ever bill to usage credits instead of plan limits?
- **OpenAI:**
  1. Can Business, Enterprise and Edu use Sign in with ChatGPT?
  2. Is there a sunset date for app-server login in open-source apps?
- **GitHub:**
  1. Which org policy gates ACP?
  2. When does ACP leave preview?

## 5. Capability compatibility matrix

Legend: ✅ native and complete · ◐ partial, experimental or extension-only · ❌ missing · ❓ unverified or ambiguous.

The Claude column covers both modes. The Agent SDK (default) and raw `-p` stream-json speak the same wire, so their capabilities match. The SDK adds typed helpers such as session listing and reading.

| Capability | Claude Agent SDK / `-p` | Claude via ACP | Codex app-server | Codex via ACP | Copilot SDK | Copilot `--acp` |
|---|---|---|---|---|---|---|
| **Works on $100–200 plans** | ✅ Pro/Max/Team (2026-10-07 article) | ✅ (built on the SDK) | ✅ Pro, local OSS | ✅ | ✅ Pro+/Max | ✅ (preview) |
| Multi-turn | ✅ streaming input | ✅ | ✅ threads | ✅ | ✅ | ✅ |
| Resume / history | ✅ resume, fork, resume-at | ✅ list/load/resume/fork | ✅ resume, fork, read, paged, revert | ✅ | ✅ | ◐ load replays; no resume or fork |
| Interrupt | ✅ control interrupt | ✅ cancel | ✅ `turn/interrupt` | ✅ | ✅ | ✅ `session/cancel` |
| Steer mid-turn | ✅ `priority:'now'` | ◐ extension | ✅ `turn/steer` | ◐ extension | ✅ | ❌ |
| Queueing | ✅ `priority:'later'` | ◐ client | ◐ experimental queue | ◐ client | ✅ | ◐ client only |
| Permissions & modes | ✅ `can_use_tool` + suggestions, 6 modes | ✅ | ✅ per-request decisions, policy amendments, sandbox | ◐ presets; config.toml ignored | ✅ | ◐ once/always/reject; rules at launch |
| Plan mode | ✅ ExitPlanMode approval | ✅ | ◐ experimental + questions | ◐ | ✅ | ◐ no approval step |
| Tool/stream detail | ✅ typed + partial deltas | ◐ | ✅ full deltas | ◐ | ✅ ~150 events | ✅ |
| Diffs | ✅ `structuredPatch`, `rewind_files` | ◐ no rewind | ✅ per-file + per-turn, revert | ◐ | ✅ | ✅ old/new + unified |
| Subagents | ✅ `task_*` | ◐ unreliable | ✅ collab items, child threads | ◐ | ✅ | ❓ unverified |
| Slash commands | ✅ from `initialize` | ✅ | ❌ rebuild | ◐ fixed set | ✅ | ◐ interactive ones unsupported |
| Model / effort | ✅ `set_model` | ✅ | ✅ per turn | ✅ | ✅ | ✅ with multipliers |
| Images | ✅ | ✅ | ✅ (+ audio) | ✅ | ✅ | ✅ |
| MCP config | ✅ | ✅ | ✅ + OAuth, elicitation | ◐ | ✅ live | ✅ per session |
| Cost / usage | ✅ cost, usage, 5h/7d windows | ◐ | ✅ tokens + rate limits | ◐ | ✅ credits | ◐ context + tokens only |
| Login flow | ◐ inherits; no API | ◐ | ✅ `account/login/*` | ✅ | ✅ OAuth tokens | ◐ terminal login |
| Windows | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stability | ◐ SDK 0.x, near-daily; raw mode has no control-protocol spec | ◐ 0.x | ◐ "experimental"; weekly | ◐ lags app-server | ✅ GA semver | ◐ preview; daily |
| License | ◐ CLI proprietary (SDK: Commercial Terms) | ✅ Apache-2.0 | ✅ Apache-2.0 | ✅ | ✅ MIT (CLI proprietary) | ◐ CLI proprietary |

## 6. Risks

1. **Protocol churn (high).** All three surfaces release weekly or faster, and structured mode already broke silently once.
   - Commit recorded real-session transcripts as fixtures and replay them through each driver in unit tests.
   - In CI, regenerate `codex app-server generate-ts`, the SDK `.d.ts` and the ACP schema at pinned versions, and fail on any diff.
   - Add a structured leg to `scheduled-real-cli-e2e.yml` that runs tiny prompts on the cheapest models.
   - At runtime, read `system/init` capabilities, the Codex `userAgent` and ACP `agentCapabilities`, and warn outside the tested version range.
2. **Terms changing later (medium).** Anthropic's wording has shifted during 2026, and the `--bare` default change could drop subscription login. Every provider keeps a Terminal mode, and Claude has two chat modes, so a terms or packaging change is a default flip, not a rewrite (§7.1).
3. **Feature lag vs the TUI (medium).**
   - Interactive slash commands and new features land in the TUI first, and Codex app-server has no slash commands at all.
   - Keep a Chat / Terminal switch on the same session (resume by id).
   - Rebuild only the common commands.
4. **What users lose vs the TUI (medium).**
   - Users lose keybindings and the CLI's exact output text.
   - Mitigate with a per-agent default view, opt-in per provider at first, and a dense or verbose stream toggle.
5. **Auth UX (medium).**
   - Claude and Copilot have no programmatic login for clients.
   - Add a pre-flight auth check per provider, and hand off to an embedded terminal for login, then resume.
6. **Performance (low).**
   - Copilot sends reasoning as token-level chunks, and long command output adds up.
   - Coalesce deltas in main every 16–33 ms, keep the feed in a store, window the rendering, and cap stored command output.
7. **Packaging and licensing (low).**
   - Proprietary CLIs, and bundled binaries of 250 MB or more.
   - Require the user's own installs, as today. The Claude SDK is governed by Anthropic's Commercial Terms; Clubhouse uses it as a client library and doesn't ship its bundled binaries.
8. **Security (low).**
   - Never answer a permission without a user action or an explicit mode, and log every decision.
   - Delete `agent:start-structured` along with structured mode (§8.0).

## 7. Recommendation

Three options were compared:

1. ACP everywhere.
2. A native protocol per CLI.
3. The Agent SDK for Claude, native protocols for the others.

**Choose option 3: the Agent SDK for Claude, native protocols for Codex and Copilot, with ACP as the vocabulary and the long-tail driver.** Claude also keeps raw `-p` stream-json as a second mode behind the same driver. VS Code and T3 Code converged on the same shape.

```
ClaudeDriver                CodexDriver                    AcpDriver → CopilotSdkDriver
├ SdkTransport (default)    codex app-server (stdio v2)    copilot --acp → @github/copilot-sdk
└ StreamTransport (-p)      generated types, pinned        also Gemini CLI / other ACP agents
  both run the user's claude
        \                          |                              /
         normalize in main · coalesce deltas · stamp sessionId / turnId / seq
                                   |
   Clubhouse chat contract (structured-events v2) + per-provider capability record
                                   |
   IPC per session + append-only transcript + Annex forwarding
                                   |
   chatStore (renderer) → ChatView
```

### The contract

**Event types** (structured-events v2):

- Session lifecycle: started, resumed, idle, ended.
- Turn lifecycle.
- `user_message`.
- Message and thought chunks.
- `tool_call` and `tool_call_update` (kind, title, locations, diff and terminal content).
- `permission_request`, carrying the native options.
- `plan`, `question`, `subagent`.
- `usage`: tokens, cost, context, limit windows.
- Mode, model and command updates.
- `error`.

**Capability record:** each driver publishes one with `steer`, `queue`, `rewind`, `planApproval`, `subagents`, `cost` and `login` flags. The UI reads it to downgrade gracefully, for example "Stop and send" instead of Steer on Copilot over ACP.

### Why not ACP everywhere

Claude and Codex would each sit behind a third-party adapter. Those adapters have open bugs in steering, rewind, subagents and cost, and features beyond v1 depend on adapter-private `_meta` extensions or on ACP v2.

### Claude: one driver, two transports

The Agent SDK is a typed client over the same pipes `claude -p --input-format stream-json --output-format stream-json` uses. Its message types are the stream-json events, and its control methods (`interrupt`, `setPermissionMode`, `setModel`, `canUseTool`) are `control_request` frames. So Claude gets one driver with two transports:

- **SdkTransport (default):** `query()` with streaming input, `canUseTool`, typed control methods, and session helpers such as `listSessions` and `getSessionMessages`. Set `pathToClaudeCodeExecutable` to the user's installed `claude`, and pass `permissionMode: 'default'` explicitly.
- **StreamTransport (second mode):** spawns the user's `claude -p` with NDJSON in and out, and writes the `control_request` frames by hand: `initialize`, `interrupt`, `set_permission_mode`, `set_model`, and the `can_use_tool` replies via `--permission-prompt-tool stdio`. It's for when an SDK release breaks something, or if terms or packaging change. It costs about a week on top of the SDK transport.
- **Shared:** the normalization into Clubhouse events, the capability record, session and resume handling, and the UI. A fixture recorded through one transport replays through the other, which is a cheap check that they agree.
- **Version skew:** each SDK release is tested against a matching CLI version (SDK 0.3.N with CLI 2.1.N), but the user's `claude` will drift. Read `system/init` capabilities and warn when the CLI is outside the SDK's tested range.

### 7.1 Runtime modes per provider

The embedded terminal stays first-class. Chat is never the only way to run an agent.

| Provider | Modes | Default |
|---|---|---|
| Claude Code | Chat (Agent SDK) · Chat (stream-json) · Terminal | Chat (Agent SDK) |
| Codex | Chat (app-server) · Terminal | Chat (app-server) |
| Copilot | Chat (ACP, later the Copilot SDK) · Terminal | Chat (ACP) |

- **Per-provider setting, with a per-agent override.** If a Codex release breaks app-server, Codex alone flips to Terminal.
- **Same session in either view.** The chat captures the native session id, and the terminal resumes it with `claude --resume`, `codex resume` or `copilot --resume`. The Chat / Terminal switch hands the session over instead of starting a new one.
- **Automatic fallback.** If the installed CLI version is outside the tested range, the reported capabilities don't match, or the handshake fails, the agent opens in the next mode down. The fallback order is SDK, then stream-json, then terminal for Claude, and chat, then terminal for the others. A one-line notice says why.
- **Remote kill switch.** A small denylist of known-bad CLI versions, shipped with the update metadata, can force a lower mode without an app release.

### UI

See the artifact's mockups for the details.

- One stream: user message, reasoning line, grouped read-only tools, diff and command cards, reply, and a turn footer.
- Approvals docked in the composer, offering the provider's native options.
- Plan document or question cards.
- A composer that steers or queues, with a visible queue.
- One five-level permission ladder (Plan, Ask first, Auto-accept edits, Auto, Full access) with native names shown underneath.
- Model and effort menus built from live lists.
- A Changes panel with Clubhouse-owned git checkpoints, so Revert turn works the same for every provider.
- An agent map for subagents.
- A Chat / Terminal switch.

## 8. Phased plan

Sizes are in engineer-weeks. Phases 0–4 ship behind a new experimental **Chat** setting in beta builds. Phase 5 promotes it to stable and makes it the default. The old `structuredMode` flag isn't reused (§8.0).

### 8.0 Rollout: four steps from structured mode to Chat by default

**Step 1 — Remove structured mode as it stands.** This is its own PR, ahead of any chat work, and about S (3–4 days).

- **Delete:**
  - `src/renderer/features/agents/structured/` (StructuredAgentView and its components) and the `MainContentView` routing to it.
  - `structured-manager.ts`, the structured IPC channels and handlers (including `agent:start-structured`), and the preload methods.
  - The three adapters (`stream-json-adapter.ts`, `codex-app-server-adapter.ts`/`-client.ts`, `acp-adapter.ts`/`acp-client.ts`) and `buildStructuredAdapter` on the providers.
  - The `structuredMode` provider capability, the experimental flag, and the per-agent checkboxes (`AddAgentDialog`, `TemplateConfigDialog`, `AgentSettingsView`).
  - The quick-agent `structured` spawn mode, and the Assistant's `structured` mode.
- **Keep:** move `ndjson-rpc-base.ts` and `structured-spawn.ts` (with #1911's Windows `.cmd` fix) to where the new drivers will live. They're transport plumbing, not structured-mode UI.
- **Safe migration to the terminal.** This is a one-time, idempotent startup migration with a version marker:
  - **Durable agents:** drop `structuredMode` from each agent config. These agents start in the standard terminal (PTY) mode next time. Their session ids weren't captured, so there's nothing to resume.
  - **Experimental settings:** drop the `structuredMode` key.
  - **Assistant:** a saved mode of `structured` becomes `interactive`.
  - **Personas, materialization, blueprints and templates:** stop writing `structuredMode` / `structured`, and ignore them on read. Old exports still import cleanly.
  - **Plugin API:** `structuredMode` in `agents.createDurable` options is accepted and ignored, with a deprecation warning. Remove it at the next plugin API major, per `docs/sdk-versioning.md`.
  - **Agents running in structured mode** at upgrade time are killed by the update, as today (resume-on-update excludes them). They come back as sleeping terminal agents.
  - **Old logs:** leave `agent-logs/*-structured.jsonl` in place. They're no longer written and are harmless.
  - **Notice:** if the migration changed anything, show a one-time notice: "Structured mode was removed. N agents now open in the terminal."
- **Annex:** check whether the Annex iOS client consumes the forwarded structured events. If it does, version the Annex message, then remove the forwarding.
- **Telemetry:** retire `core:structured*` and `usage/structured-session` in the attribute registry, with "replaced by Chat" as the reason (checklist item 1 in §8.1).
- **Tests:** delete the structured unit tests and the IPC-stubbed structured E2E specs. Add unit tests for the migration.

**Step 2 — Ship Chat as an experimental feature in beta builds** (phases 0–4).

- Add a new Experimental settings entry, **Chat** (id `chat`), off by default and shown in beta (preview-channel) builds. Its description: "Talk to Claude Code, Codex and Copilot agents in a native chat view. The terminal stays available for every provider."
- **When it's on:** a per-provider Chat / Terminal choice appears (§7.1), along with the per-agent override and the switch in the agent header.
- **When it's off:** every agent runs in the terminal, and no chat code is loaded.

**Step 3 — Promote to stable and make it the default** (phase 5).

- **"Good" means:**
  - the telemetry parity checklist (§8.1) passes;
  - each provider has two green weeks of nightly real-CLI chat runs;
  - beta crash-free and turn-error rates are at least as good as the terminal path.
- **Remove the experimental scaffolding:** delete the `chat` experimental flag and every check of it. Per-provider runtime mode becomes a regular setting under Agents, defaulting to Chat.
- **Respect explicit choices:** a provider or agent the user explicitly set to Terminal stays on Terminal. Only providers still on the default switch. A provider can be promoted later than the others if its numbers aren't there yet.

**Step 4 — Introduce the new default with a light first-launch tip** (ships with step 3).

- The first time an agent opens in Chat after the update, a small tip appears next to the Chat / Terminal switch: "Agents now open in Chat. Prefer the terminal? You can change it for each provider in Settings." It has two buttons, **Open settings** and **Got it**.
- **Open settings** deep-links to the per-provider runtime setting.
- The tip shows once, is remembered per user, and never blocks the agent. Users who had explicitly chosen Terminal never see it.
- It's mocked in the artifact's "First launch" view.

| Phase | Scope | Size |
|---|---|---|
| 0. Foundations | Step 1 of §8.0 lands first: remove structured mode and migrate users to the terminal. Then add the experimental **Chat** setting (beta builds), and per-provider runtime modes (Chat / Terminal, §7.1) with a per-agent override. New session lifecycle: a turn ending doesn't end the session, and Stop means interrupt. Envelope v2 with session, turn and sequence ids, an append-only transcript and a renderer `chatStore`. MCP, hooks, env and wrapper parity with terminal agents. Fixture record/replay harness. Send the vendor questions. | S · 2–3 wk |
| 1. Codex + chat core | Codex driver on generated v2 types: threads, resume, steer, interrupt, full approvals, diffs, usage, rate limits, approval and sandbox ladder. ChatView core: stream, tool groups, cards, approval dock, steer/queue composer, footer, Chat / Terminal switch. | M · 3–4 wk |
| 2. Claude (SDK + stream) | Replace `StreamJsonAdapter` with the Claude driver. The SDK transport is the default; it uses the user's `claude` and excludes the bundled binaries. It covers `canUseTool` with suggestions, 6 modes, priority steer/queue, `setModel`, Task todos, `task_*` subagents, `rate_limit_event`, and resume/list. Then add the stream-json transport on the same normalizer, with cross-replayed fixtures. Plan card via `ExitPlanMode`. Auth pre-flight and `/login` hand-off. | M · 4 wk |
| 3. Copilot + generic ACP | `session/load` resume, modes and config options, diffs, usage, commands, model-list dedupe, `--no-auto-update`. Capability downgrades in the UI. | S · 1–2 wk |
| 4. Depth | Git checkpoints and Changes panel, agent map, live model and mode menus, attachments, auth pre-flight, Annex v2 forwarding. | M · 3 wk |
| 5. Stable + default | Rollout steps 3–4: remove the experimental flag and gating, make runtime mode a regular per-provider setting defaulting to Chat, and ship the first-launch tip. Schema-diff CI, a structured leg in the nightly real-CLI E2E, runtime version warnings, automatic mode fallback and the known-bad-version denylist. Telemetry parity checklist (§8.1) passes. Copilot SDK driver. | S–M · 2 wk |

### 8.1 Telemetry parity checklist

This follows the sequencing in §9.1 of `docs/telemetry-otel-spec.md` ([#1914](https://github.com/Agent-Clubhouse/Clubhouse/pull/1914), decided 2026-10-16). Telemetry won't instrument today's structured adapters (StreamJson, ACP, Codex app-server), because they're being replaced. Instead it subscribes once to the new Clubhouse event model:

| Chat event model | Telemetry signal |
|---|---|
| Turn started / ended | `c.agent.turn` |
| Tool call started / updated / ended | `c.agent.tool_call` |
| Permission request and decision | `c.agent.permission` |
| Usage | Token metrics |
| Error | Errors |

The driver boundary and capability record provide:

- `c.structured.adapter`
- the protocol-drift signal `c.structured.protocol.unknown`, for unknown message, item or notification types
- `c.agent.turn.stalled`
- a new `c.agent.runtime` value for the chat runtime (the PTY and headless values stay)

**Chat doesn't ship, behind its flag or by default, until all four pass:**

- [ ] Every span, metric and event the replaced adapters emit has a named equivalent in the new code, or is explicitly retired in the telemetry attribute registry with a reason.
- [ ] Every Workbook panel that charted the old signal still has data. The KQL-vs-registry test checks names; a manual import into a scratch App Insights resource confirms the panels render.
- [ ] New drivers add their `c.agent.runtime`, `c.structured.adapter` and `c.ui.action_failed` values to `src/shared/telemetry/attributes.ts` in the same PR, with telemetry review via CODEOWNERS.
- [ ] P0 regression signals keep their level (Errors or Standard) and their alert rules.

Phase 0 should emit these from the start. The event envelope v2 (session, turn and sequence ids) is what makes the turn and tool spans possible.

## 9. Sources

All accessed 2026-10-16.

- **Claude Code:**
  - [Headless](https://code.claude.com/docs/en/headless)
  - [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  - [SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
  - [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
  - [User input and permissions](https://code.claude.com/docs/en/agent-sdk/user-input)
  - [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
  - [Authentication](https://code.claude.com/docs/en/authentication)
  - [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
  - Help Center articles [15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [13189465](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [17154008](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) and [11145838](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
  - [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- **Codex:**
  - [App-server](https://developers.openai.com/codex/app-server)
  - [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  - [Non-interactive](https://developers.openai.com/codex/noninteractive)
  - [Sign in with ChatGPT](https://developers.openai.com/siwc) and its [open-source guide](https://developers.openai.com/siwc/token-sharing-open-source)
  - [Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
  - [Pricing](https://developers.openai.com/codex/pricing)
- **Copilot:**
  - [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
  - [Run CLI programmatically](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
  - [Plans](https://docs.github.com/en/copilot/get-started/plans)
  - [Individual billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
  - [SDK auth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
  - [copilot-sdk](https://github.com/github/copilot-sdk)
  - [Additional product terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)
- **ACP:**
  - [Spec](https://agentclientprotocol.com)
  - [v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft)
  - [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
  - [codex-acp](https://github.com/agentclientprotocol/codex-acp)
  - [anthropics/claude-code#6686](https://github.com/anthropics/claude-code/issues/6686)
- **Reference apps:**
  - [T3 Code](https://github.com/pingdotgg/t3code) and its [capability system](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/provider-capability-system.md)
  - [VS Code third-party agents](https://code.visualstudio.com/docs/copilot/agents/third-party-agents)
  - [Claude Code desktop](https://code.claude.com/docs/en/desktop)
