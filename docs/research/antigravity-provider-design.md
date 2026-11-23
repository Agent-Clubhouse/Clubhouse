# Antigravity CLI provider: requirements and design

Issue references written `#E` and `#A1`..`#A19` are draft keys from `antigravity-provider-issues.md`; they are replaced with real issue numbers on publish.

Status: design only. Nothing here has been run against a signed-in Antigravity account. No Antigravity binary was installed, launched or logged in to while writing it.

- Evidence snapshot: 2026-11-23, official docs at `https://antigravity.google/docs/` (no per-page "last updated" dates are shown). Changelog latest entries: CLI v1.5.12 (2026-11-19), App v2.34.0 (2026-11-20).
- Clubhouse baseline: `main` at `50c474b48`.
- Author: research helper `antigravity-provider-design` (Claude Opus 5.5), for Clubhouse-Orchestrator.

Every claim below is tagged:

- **[Doc]** stated on an official Antigravity or ACP page, with the URL.
- **[Inference]** our reading of documented facts. Must be confirmed before code depends on it.
- **[Unknown]** not stated anywhere we found. Listed in [Unknowns](#unknowns-and-validation-gates) with the gate that settles it.

## 1. Summary

Antigravity ships three programmable surfaces. Clubhouse should integrate the two that are language-neutral and documented for third-party clients, and keep the third out of scope for now:

| Surface | Clubhouse use | Why |
| --- | --- | --- |
| `agy` interactive TUI | Terminal agents (PTY), the always-available fallback | Same shape as Claude, Codex and Copilot today |
| `agy acp` (Agent Client Protocol v1, JSON-RPC over stdio) | Native structured chat | Documented for "Any ACP client" with permission requests, cancel, steering, session load/resume/list/close, model and thinking-level options, images and embedded resources |
| `agy -p` headless (`--output-format stream-json`) | Quick agents, Actions, one-off prompts | Documented NDJSON events and exit codes, but the FAQ restricts wrapping it on consumer plans (section 3) |
| Python SDK `google-antigravity` | Not used | Python only; documents API-key and Vertex/Enterprise auth only; would need a Python sidecar. Revisit only if ACP proves insufficient |

Clubhouse already had a generic ACP chat driver. It was removed with legacy Copilot ACP in #2868 (`00c9534bb`) and can be recovered from `00c9534bb^`. `docs/structured-chat-research.md:441-450` had kept "ACP as the vocabulary and the long-tail driver" for agents like this one.

The main abstraction gap is not the `OrchestratorProvider` interface, which is open (`OrchestratorId = 'claude-code' | (string & {})`, `src/main/orchestrators/types.ts:7`). It is the roughly 35 non-test files that enumerate `claude-code`, `codex-cli` and `copilot-cli` by literal (telemetry enums, helper routing, capacity, access levels, display maps, chat driver selection). A fourth provider has to touch each of them, or they have to become data-driven first.

## 2. Public-doc evidence

### 2.1 Product, install, versions

- [Doc] Surfaces: Antigravity App (desktop), Antigravity CLI (`agy`, "v1.2+"), IDE extensions, Antigravity SDK (Python). https://antigravity.google/docs/overview/
- [Doc] CLI install: macOS/Linux `curl -fsSL https://antigravity.google/cli/install.sh | bash` to `~/.local/bin/agy`; Windows PowerShell `irm https://antigravity.google/cli/install.ps1 | iex` (or the CMD variant) to `%LOCALAPPDATA%\agy\bin`. Verify with `agy --version`. https://antigravity.google/docs/getting-started/
- [Doc] Auto-update can be disabled with `AGY_CLI_DISABLE_AUTO_UPDATE=true`. https://antigravity.google/docs/cli/troubleshooting/
- [Doc] ACP server added in CLI 1.5.0; Auto mode for ACP sessions in 1.5.4; context-window usage updates in ACP sessions in 1.5.8; 1.5.1 fixed `session/update` notifications arriving after the `session/prompt` reply and cancel/close races. https://antigravity.google/docs/changelog/
- [Doc] App requirements: macOS 13+, Windows 10/11 x64 and ARM64, Linux glibc >= 2.28. https://antigravity.google/docs/getting-started/

### 2.2 Terminal CLI

- [Doc] Flags: `--mode` (`accept-edits`, `auto`, `plan`), `--model`, `--effort`, `--agent`, `--add-dir` (repeatable), `-c/--continue`, `--conversation <id>`, `-i/--prompt-interactive`, `-p`, `--output-format`, `--input-format`, `--json-schema`, `--print-timeout`, `--disable-slash-commands`, `--sandbox`, `--dangerously-skip-permissions`, `--remote-control`, `--remote-agent`, `--project`, `--new-project`, `--log-file`. https://antigravity.google/docs/cli/reference/
- [Doc] `agy models` lists model slugs; `agy agents` lists agents. https://antigravity.google/docs/cli/headless/
- [Doc] `auto` mode: v1.3.5+ macOS/Linux, v1.4.4+ Windows, needs the terminal sandbox, not available for business or enterprise accounts. https://antigravity.google/docs/cli/reference/
- [Doc] Conversation history is scoped to the working directory; `-c` resumes the most recent for that workspace. https://antigravity.google/docs/cli/conversations/
- [Doc] Workspace trust: the CLI asks before indexing an untrusted folder and records it in `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`. https://antigravity.google/docs/settings/
- [Doc] Exit is a slash command (`/exit`, alias `/quit`). https://antigravity.google/docs/cli/reference/

### 2.3 Headless

All from https://antigravity.google/docs/cli/headless/ unless noted.

- [Doc] `-p` sends one prompt and exits; stdout carries the response, stderr carries diagnostics.
- [Doc] `--output-format text|json|stream-json`. `stream-json` is NDJSON: one `init` (`cwd`, `tools`, `permission_mode`, `model`, `agent`), any number of `step_update` (`conversation_id`, `step_index`, `state`, `step_type`, `tool_name`, `text_delta`, `usage`, `tool_info`, `subagent_info`), one `result` (`status` of `SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING`, `usage` with input/output/thinking/cache-read/total tokens).
- [Doc] `--input-format stream-json` with `--output-format stream-json` accepts `{"event":"user","message":{"content":...}}` lines on stdin; only `text` content blocks; closing stdin ends the session.
- [Doc] Stateless by default; `--continue` or `--conversation <id>` continues.
- [Doc] No interactive prompt: tools that would ask are "handled by policy". Since v1.5.7 `agy -p` runs in `auto` where available, `default` otherwise. An unobtainable approval is soft-denied, the run continues and exits 0.
- [Doc] An unknown `--model` exits non-zero with `ERROR`; there is no silent fallback.
- [Doc] Unauthenticated headless runs exit with `authentication required` rather than hanging.

### 2.4 ACP

From https://antigravity.google/docs/ide/extensions/acp/ and https://antigravity.google/docs/cli/acp/ unless noted.

- [Doc] `agy acp [flags]` "starts an Agent Client Protocol (ACP) server", JSON-RPC over stdin/stdout. "Any ACP client can launch Antigravity CLI. Configure it to run this command with the project directory as the working directory." Protocol version 1; identifies as `Antigravity ACP Server`.
- [Doc] The agent, its tools, sign-in and settings come from the CLI.
- [Doc] Tool calls stream; edits stream as diffs; permission requests pause the turn; slash commands appear in the client's command menu; titles update; images and embedded resources accepted; questions use ACP elicitation forms where the client supports them; a prompt sent mid-turn steers that turn; cancel ends open tool calls and abandons pending permission requests.
- [Doc] Session options: Model (models available to the account) and Thinking level (`Low`, `Medium`, `High`, `Extra`, `Max`).
- [Doc] Sessions: load, resume (without replaying history), list, close; multi-root workspaces can send extra folders.
- [Doc] Auth methods when no credential is cached (`Authentication required`, code `-32000`): `oauth-personal`, `oauth-business`, `gemini-api-key` (reads `GEMINI_API_KEY` from the agent env), `agent-platform` (ADC + `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`), `terminal-login` (only for clients that support ACP terminal auth).
- [Doc] Flags: `--add-dir`, `--agent`, `--sandbox`, `--dangerously-skip-permissions`, `--process-per-session` ("Required for HTTP MCP servers that your editor configures"), `--ide-mcp-port`, `--login`, `--log-file`, `--disable-telemetry`. Logs at `~/.gemini/antigravity-cli/log/acp-*.log`.
- [Doc] Session modes `default`, `accept-edits`, `plan` (1.5.0), plus `auto` (1.5.4). https://antigravity.google/docs/changelog/
- [Doc] ACP clients can pass MCP servers; 1.5.x fixed "prompts no longer fail when the ACP client passes an MCP server whose name contains spaces". https://antigravity.google/docs/changelog/
- [Doc] ACP spec: `session/new` carries `cwd` and `mcpServers`; stdio MCP is baseline, `http`/`sse` are gated by `mcpCapabilities`; `session/resume`, `session/close`, `session/list` gated by `sessionCapabilities`. https://agentclientprotocol.com/protocol/session-setup and https://agentclientprotocol.com/protocol/initialization
- **Discrepancy on models.** The ACP guide says "Third-party models are only offered to JetBrains IDEs (including JetBrains Air), Android Studio, Android Performance Analyzer, Zed, and Xcode." The CLI 1.5.1 changelog says it "Changed `agy acp` to offer every model available to your account to every ACP client". [Unknown] which applies today. Clubhouse must show what the server offers in `configOptions` and must never alter `clientInfo` to unlock models.

### 2.5 Instructions, skills, MCP, hooks, settings

- [Doc] Rules: `AGENTS.md`, `GEMINI.md`, `.agents/AGENTS.md`, `.agents/GEMINI.md`, `.agents/rules/*.md` (needs a `trigger` frontmatter or it is silently discarded). Read from the workspace folder and each parent up to the repository root, never below. Global: `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.gemini/config/AGENTS.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/rules/*.md`. Rules are cumulative. 24,000-byte per-file limit, 20,000-token aggregate budget. https://antigravity.google/docs/rules/ and https://antigravity.google/docs/customization-discovery/
- [Doc] Skills: `<workspace>/.agents/skills/<name>/SKILL.md` (legacy `.agent/skills`), `~/.gemini/config/skills/`, CLI also `~/.gemini/antigravity-cli/skills/` and `~/.gemini/skills/`. One level deep. Agent Skills open standard. https://antigravity.google/docs/skills/
- [Doc] Custom agents: `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md`; selected with `--agent`. https://antigravity.google/docs/customization-discovery/
- [Doc] MCP: global `~/.gemini/config/mcp_config.json`, workspace `<workspace>/.agents/mcp_config.json`, root key `mcpServers`. stdio (`command`, `args`, `env`, `cwd`) and Streamable HTTP (`serverUrl` or `url`, `headers`); legacy HTTP+SSE is not supported. `enabledTools`, `disabledTools`, `disabled`, `timeoutSeconds`. On a name collision "the server that is already running keeps it". Unconfigured MCP tools run in Ask mode; permission rules `mcp(server/tool)`. https://antigravity.google/docs/mcp/ and https://antigravity.google/docs/settings/
- [Doc] Hooks: `.agents/hooks.json` and `~/.gemini/config/hooks.json` (hooks in the CLI `settings.json` are not loaded), events `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`, handlers `{"type":"command","command":...,"timeout":...}`. Handlers get camelCase JSON on stdin including `conversationId`, `workspacePaths`, `transcriptPath`, `modelName`, `lastUserInput`. For the CLI, `transcriptPath` is `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`. https://antigravity.google/docs/hooks/
- [Doc] CLI settings: `~/.gemini/antigravity-cli/settings.json` (`agentMode`, `toolPermission`, `permissions.allow|ask|deny`, `enableTerminalSandbox`, `allowNonWorkspaceAccess`, `trustedWorkspaces`, `model`, `modelProvider`, `gcp`, ...). Rule precedence Deny > Ask > Allow. https://antigravity.google/docs/settings/ and https://antigravity.google/docs/permissions/
- [Doc] Terminal sandbox: seatbelt on macOS, bubblewrap on Linux; off by default in the CLI; `auto` turns it on. https://antigravity.google/docs/enterprise/ and https://antigravity.google/docs/features/

### 2.6 Auth, plans, models

- [Doc] Personal Google account (Free, Google AI Plus, Pro, Ultra) via Google OAuth; Gemini Enterprise (`oauth-business`); Gemini API key requires both `"modelProvider": "gemini"` in `settings.json` and `GEMINI_API_KEY` ("Only setting a `GEMINI_API_KEY` environment variable on its own has no effect"); ADC with `AGY_ADC_AUTH=true`. Credentials live in the OS keyring. Google Workspace plans don't include Antigravity plans. https://antigravity.google/docs/install/ and https://antigravity.google/docs/plans/
- [Doc] Quotas: Pro and Ultra refresh every five hours up to a weekly limit; other tiers weekly. Remaining quota shows in the App's model picker and via `/usage` in the CLI. Numeric limits are not published. https://antigravity.google/docs/plans/ and https://antigravity.google/docs/models/
- [Doc] Models include Gemini 4 and 3.x families, Claude Sonnet/Opus 5.5 on paid plans, and models scheduled for removal on 2026-11-30. Efforts: `low`, `medium`, `high`, `xhigh`, `max` depending on the model. https://antigravity.google/docs/models/
- [Doc] With a Claude model selected, "lightweight first-party Gemini models continue to run in the background ... These background models consume first-party tokens." https://antigravity.google/docs/enterprise/

## 3. Plan and usage eligibility (documented statements only)

Paraphrased; read the linked pages for the exact wording. This doc draws no legal conclusion from them.

1. FAQ ([link](https://antigravity.google/docs/faq/), entry on third-party software and Antigravity logins): using third-party software to access Antigravity with an Antigravity login violates the Terms of Service and can lead to account suspension; for third-party coding agents it recommends a Gemini Enterprise or Google AI Studio API key.
2. FAQ ([link](https://antigravity.google/docs/faq/), entry on headless mode in third-party agents): `agy -p` is meant for direct scripting and CI; wrapping `agy` in third-party agents or apps, or automating account rotation, is not supported under consumer plans.
3. ACP guide ([link](https://antigravity.google/docs/ide/extensions/acp/)): any ACP client can launch `agy acp`, which reuses credentials cached by an interactive `agy` sign-in; it lists a community VS Code client among the examples.

What this means for the plan:

- Statement 2 is a negative statement about consumer plans. It does not, by itself, document that headless wrapping is permitted for any other auth type. Statement 1's API-key recommendation concerns using Gemini from a third-party agent, not wrapping `agy`. Headless (6.5) is therefore off for every auth type until the eligibility decision (#A1) names the auth types it may be enabled for; API key, Agent Platform and Gemini Enterprise are the candidates, recorded as [Inference].
- Statement 3 documents ACP for any ACP client with cached interactive credentials. The ACP chat path is planned for the documented auth methods behind the experimental flag. How statement 1 applies to an ACP client that launches the user's own `agy` is not stated; the clarification issue asks, and its answer can change the defaults.
- The Python SDK documents API-key and Vertex/Enterprise auth only. That is not evidence about subscription use through the SDK either way; the SDK is out of scope.
- Clubhouse never automates account switching or rotation, never reads or copies credentials from the keyring, and never sets `clientInfo` to anything but Clubhouse.
- Running the user's own `agy` TUI in a Clubhouse terminal is not addressed by any statement. The clarification issue asks.

## 4. Capability matrix

`Yes`/`No` describe documented behaviour of Antigravity CLI 1.5.12; the Clubhouse column says how we would use it.

| Capability | Claude Code | Codex CLI | Copilot CLI | Antigravity (documented) | Antigravity in Clubhouse |
| --- | --- | --- | --- | --- | --- |
| Terminal (PTY) | Yes | Yes | Yes | Yes, `agy` | Phase 1 |
| Native chat transport | Agent SDK / stream-json | app-server | Copilot SDK | ACP v1 (`agy acp`) | Phase 3, generic ACP driver |
| Headless one-shot | `-p` stream-json | `exec --json` | `-p --output-format json` | `-p --output-format stream-json` | Phase 4, auth-gated |
| Streaming deltas | Yes | Yes | Yes | ACP `session/update`; headless `text_delta` | Yes |
| Permission requests | Yes | Yes | Yes | ACP `session/request_permission`; headless soft-deny | Chat only; headless uses policy |
| Permission ladder | plan/ask/auto_edit/auto/full | ask/auto/full (terminal) | ask/full (terminal) | `plan`, default, `accept-edits`, `auto`*, `--dangerously-skip-permissions` | All five, `auto` only where available |
| Steering mid-turn | Yes | Yes | Yes | ACP: a prompt mid-turn steers | `steer: true` |
| Interrupt | Yes | Yes | Yes | ACP `session/cancel` | Yes |
| Resume by id | Yes | Yes | Yes | `--conversation <id>`; ACP load/resume | Yes |
| Session list | Yes | Yes | Yes | ACP `session/list`; TUI picker | ACP `session/list` only; no directory scanning |
| Transcript / history | Yes | Yes | Yes | ACP `session/load` replays history as `session/update`; hooks report a `transcriptPath` whose line format is not documented | ACP history only; no parsing of the transcript file unless Google publishes its schema |
| Model list | handshake | handshake | SDK | `agy models`; ACP config option | Yes |
| Effort | Yes | Yes | Yes | `--effort`; ACP thinking level | Yes |
| Plan quota (token-free) | Yes | Yes | No | `/usage` interactive only | No reader; Auto eligibility decided in #A18 |
| Usage tokens | Yes | Yes | Yes | headless `usage`; ACP context-window updates | `usage: 'context'` in chat |
| Images / attachments | Yes | Yes | Yes | ACP images + embedded resources; headless text only | Chat only |
| Questions | Yes | Yes | Yes | ACP elicitation forms | Yes |
| Slash commands | Yes | Yes | Yes | ACP command menu | Yes |
| Subagents | ids/full | ids | full | headless `subagent_info`; ACP [Unknown] | `ids_only` until shown |
| Hooks | Yes | Yes | Yes | `.agents/hooks.json` | Terminal status |
| Instructions file | `CLAUDE.md` | `AGENTS.md` | `copilot-instructions.md` | `AGENTS.md`/`GEMINI.md`/`.agents/rules` | `AGENTS.md` |
| Skills dir | `.claude/skills` | `.agents/skills` | `.github/skills` | `.agents/skills` | `.agents/skills` |
| Project MCP file | `.mcp.json` | not read | not read | `.agents/mcp_config.json` | Workspace file + ACP `mcpServers` |
| Config-dir override env | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` | `COPILOT_HOME` | none documented | Not isolated (section 6.7) |
| Desktop control off | n/a | `--disable plugins` | n/a | No dedicated flag. Documented controls: workspace `PreToolUse` hook returning `deny` (matcher e.g. `browser_.*`), `mcp(server/tool)` deny rules (apply to the `/browser` subagent's DevTools tools since 1.5.x), MCP `disabledTools` | Eligibility gate (#A14) |
| Sandbox | n/a | Yes | n/a | seatbelt / bubblewrap; Windows non-admin | Map from execution policy |

\* `auto` needs the sandbox and is not available to business or enterprise accounts.

## 5. Clubhouse abstraction gaps

Pointers are against `50c474b48`.

1. **Provider identity is enumerated in ~35 files.** Examples: telemetry enums `src/shared/telemetry/attributes.ts:328,608,633`; helper routing `src/shared/helper-routing.ts:62,73,94`; capacity `src/shared/handoff-capacity.ts:3,62`; budgets `src/shared/helper-auto-budget.ts:2`; access levels `src/shared/agent-access.ts:105-109` (an unknown provider gets Ask only); execution policy `src/shared/execution-policy.ts:30`; remote history allowlist `src/main/services/remote-session-history.ts:34`; display maps `OrchestratorGlyph.tsx:5`, `orchestrator-colors.ts:7-9,46-48`, `SleepingMascots.tsx:209-211`, `SleepingAgent.tsx:61`, `FirstRun.tsx:21-23`, `HelperPresetsSection.tsx:30`; chat labels `chat-version-policy.ts:80-84`, `ChatHeader.tsx:11-14`, `src/shared/chat/provider-inventory.ts:15-16`; telemetry `knownCli` sets in `feature-events.ts:41`, `chat-telemetry.ts:84`, `agent-signals.ts:94,118`, `agent-telemetry.ts:62`, `session-telemetry.ts:20`, `spawn-telemetry.ts:30`. Unknown ids collapse to `other` in telemetry, which is acceptable; the rest silently degrades a new provider.
2. **Chat driver ids are a closed list.** `CHAT_DRIVER_IDS` (`src/shared/chat/capabilities.ts:16-21`) is validated by the CI kill-switch denylist. Driver selection hard-codes Copilot (`src/main/services/agent-runtime/chat-drivers.ts:19-32`, `chat-spawn.ts:139-148`, `chat-runtime-settings.ts:61,90`). An ACP driver needs an id and a provider binding that is not a Copilot special case.
3. **No generic ACP driver on main.** Recover `acp-client.ts`, `acp-session.ts`, `acp-updates.ts`, `acp-chat-mapper.ts`, `acp-schema.ts`, `acp-capabilities.ts`, `acp-chat-driver.ts` (`AcpLaunchSpec` `:23`, `createGenericAcpChatDriver` `:441`) from `00c9534bb^:src/main/orchestrators/adapters/`. They were tested against ACP schema v1.26.0 fixtures; `acp-session.ts` (1015 lines) and `acp-chat-mapper.ts` (882 lines) carry Copilot-specific branches that must be lifted into the launch spec. Lessons that still apply: #2240 (agent refused stdio MCP from the client), #2191 (agent kept working after the prompt ended; Antigravity fixed the equivalent in 1.5.x), #2401 (flaky clock comparison in the resume test).
4. **MCP injection assumes Claude-style project files or CLI flags.** `buildMcpArgs?` (`types.ts:497-513`) and the TOML branch in `clubhouse-mcp/injection.ts:229` cover Codex and Copilot. Antigravity reads a workspace `.agents/mcp_config.json` (like Claude's `.mcp.json`) and accepts `mcpServers` over ACP. The bridge is stdio and takes its nonce from the inherited environment (`injection.ts:460-470`); whether `agy` passes its environment to stdio MCP children is [Unknown]. HTTP from an ACP client needs `--process-per-session`.
5. **Instructions and skills overlap with Codex.** Antigravity reads `AGENTS.md` and `.agents/skills`, as Codex does (`codex-cli-provider.ts:249-264`). Managed delivery special-cases Copilot and Claude (`managed-agents/delivery.ts:482,692-695,707,851,1077-1090`). Antigravity additionally reads `GEMINI.md`, `.agents/rules`, parent folders up to the repo root, and the user's global `~/.gemini` rules, all cumulatively.
6. **No config isolation.** `provider-profiles-removed.ts:33-37` maps each provider to a state-dir env var. Antigravity documents none, so sessions, settings, permissions and global customizations are the user's own. `GEMINI_HOME` appears only in an IDE-extension changelog line and is not a documented CLI setting.
7. **Hooks writer.** `shared.ts:517` `writeTerminalHooksConfig` and `config-pipeline.ts:194,242,288` assume known paths per provider. Antigravity's `.agents/hooks.json` is a named-hook map (`{"<name>": {"PreToolUse": [...]}}`), unlike Claude's settings or Copilot's `hooks/hooks.json`.
8. **Session capability.** `SessionCapable` (`types.ts:290-335`) assumes a readable on-disk transcript and an id parsed from PTY output (`extractSessionId`). For Antigravity the id arrives in hook payloads (`conversationId`), not in PTY text. The `transcript.jsonl` line format and the `brain/` directory layout are not documented as a stable format, so Clubhouse must not parse or scan them. History comes from ACP `session/load` and listing from ACP `session/list`. `extractSessionId` needs a hook-sourced alternative, and `readSessionTranscript` must be allowed to report "unsupported".
9. **Quota and helper routing.** Auto routing ranks providers by `readPlanQuota`. Copilot has no reader and is still an Auto candidate, ranked last (`helper-routing.ts:70-73`). Eligibility and unknown-quota ranking are hard-coded per provider rather than declared, so a new provider has no stated policy. Antigravity has no token-free documented quota read.
10. **Provider doc contract.** `provider-doc-contract.test.ts:49-53` and `settings-orchestrators.md:43-49` hard-code three providers.
11. **No user-facing binary path override.** Only `CLUBHOUSE_TEST_CLI_BINARIES` (`shared.ts:48`) and launch wrappers. `agy` installs to `~/.local/bin`, which GUI-launched apps often miss on macOS; `getExtraBinaryPaths()` must include it and `%LOCALAPPDATA%\agy\bin`.
12. **No written lifecycle contract for chat drivers.** Receipt, settlement and retry semantics live in `chat-runtime.ts` and each driver. #3782 shows the cost: the runtime keeps one pending token per prompt receipt and retires one per `turn_started`, so two accepted submissions that join one native turn leave a token behind. Antigravity's ACP server documents exactly that shape (a prompt sent mid-turn steers the running turn). A driver-independent conformance suite is needed before a new driver lands.
13. **Chat and headless fall back to the terminal implicitly.** Copilot chat opens in the CLI view when its driver fails (`chat-spawn.ts:141-144`). A terminal agent has different approval and lifecycle semantics, so for Antigravity the switch must be explicit.

## 6. Proposed design

### 6.1 Provider descriptor (contract change)

Add a static descriptor next to each provider and drive the enumerations from it:

```ts
interface ProviderDescriptor {
  id: OrchestratorId;                 // 'antigravity-cli'
  displayName: string;                // 'Antigravity CLI'
  shortName: string;                  // 'AGY'
  telemetryCode: string;              // closed enum value, 'other' fallback stays
  accessLevels: { chat: AccessLevel[]; terminal: AccessLevel[] };
  helperRouting: { preset: boolean; auto: 'candidate' | 'opt_in' | 'excluded'; quota: 'reader' | 'unknown' };
  capacityTracked: boolean;
  remoteHistory: boolean;
  install: { docsUrl: string; binaryHint: string };
  stateDirEnv?: string;               // absent for Antigravity
}
```

Tradeoffs: a descriptor moves policy (access levels, routing eligibility) next to the provider and makes the fourth provider a one-file change for most lists. Telemetry enums must stay closed for the exporter, so `telemetryCode` still needs a reviewed enum addition. The alternative, adding `antigravity-cli` literals everywhere, is faster once and repeats for every later provider (Gemini CLI, OpenCode). Recommend the descriptor, landed before the provider, with no behaviour change for the existing three.

### 6.2 Terminal provider: `AntigravityCliProvider`

- `id: 'antigravity-cli'`, badge `Experimental`, registered after Codex so it never becomes the Dispatcher default (`dispatcher-service.ts:748-751`) and hidden unless the experimental flag and the provider toggle are on.
- Binary: `binaryNames ['agy']`, extra paths `~/.local/bin`, `%LOCALAPPDATA%\agy\bin`. Availability runs `agy --version` (token-free).
- Spawn: `--model`, `--effort`, `--mode` / `--dangerously-skip-permissions` from the access ladder, `--sandbox` from execution policy, `--conversation <id>` or `-c` for resume, `--add-dir` for extra workspace folders (after #1724 adds `SpawnOpts.additionalDirs`; added folders also contribute customizations), `--agent` for custom agents (`AgentFileCapable`), `-i <mission>` for a positional mission if desired. `--disable-slash-commands` is not used.
- Exit `'/exit\r'`. Paste timing starts from the Copilot profile (quiescence) until measured.
- Workspace trust: a fresh worktree is untrusted, so the first launch will prompt. Clubhouse must not edit `trustedWorkspaces`; it surfaces the prompt in the terminal and says so in help. [Unknown] whether ACP also prompts (changelog mentions "interactive Workspace Trust verification" for the IDE ACP server).
- Models: `agy models` parsed by `modelFetchConfig`, static fallback minimal (`default` only) to avoid shipping stale slugs; `acceptsModel` must reject unknown slugs because headless exits non-zero on them.

### 6.3 Managed instructions, skills, agents

- Instructions: write the managed block to `<worktree>/AGENTS.md`. Do not touch `GEMINI.md`.
- Size limit: Antigravity documents a 24,000-byte per-file limit and a 20,000-token aggregate rules budget, and the docs do not say what happens to content past either. Clubhouse must not truncate user text and must not count over-limit instructions as delivered. If the composed `AGENTS.md` (user text plus managed block) exceeds 24,000 bytes, the start is refused with the size and the fix (shorten the persona, or move user text). A split across `AGENTS.md` and `.agents/rules/*.md` (`trigger: always_on`) is only allowed once the combined ordering is documented or proven by a test on the real binary, because the docs say rules are combined but not in what order. The aggregate budget includes the user's own global rules, which Clubhouse cannot see in full; delivery is recorded as "within per-file limit, aggregate unverified".
- Skills: `skillsRoot: '.agents/skills'`, flat layout, the same root Codex uses, so the existing exclude and manifest logic (`managedSkillExcludes`, `delivery.ts:354`) applies.
- Custom agents: personas may map to `.agents/agents/<name>.md` plus `--agent <name>` later; out of scope for the first slice.
- Inherited customizations: Antigravity also loads the user's `~/.gemini` rules, skills, hooks and MCP. Clubhouse cannot isolate them (6.7). The agent settings view lists them as "also loaded from your Antigravity profile" using the documented paths, read-only.
- Parent traversal stops at the repository root. A Clubhouse worktree has its own `.git` file, so traversal should stop there. [Unknown] whether a `.git` file counts as a root marker (V4).

### 6.4 MCP and identity

- Terminal and headless: write the Clubhouse bridge into `<worktree>/.agents/mcp_config.json` under the reserved `clubhouse` name, merged with existing user entries, snapshotted and restored by `config-pipeline.ts` the same way `.mcp.json` is. No nonce or token in the file; the bridge reads `CLUBHOUSE_HOOK_NONCE`, `CLUBHOUSE_AGENT_ID`, `CLUBHOUSE_MCP_PORT` from the inherited env, so this depends on env inheritance ([Unknown], validation gate V3). If env is not inherited, the bridge fails to authenticate and the start is refused (fail closed). Writing a nonce into the stdio `env` field of a workspace file is a candidate, not a prescription: it needs a written threat model (file readers, sync tools, crash leftovers, git) and security review before it is built.
- Name collision: "the server that is already running keeps it", so a user or plugin server named `clubhouse` could take the bridge's place. Clubhouse fails closed: the start is refused when any readable MCP config (global, workspace, or a project server list) defines `clubhouse`, and an agent is only marked as having the Clubhouse MCP after the bridge has authenticated to Clubhouse with that launch's agent identity and nonce. A server that merely answers under the name is never trusted. Plugin-contributed servers cannot all be enumerated from documented files, so the authenticated-connection check is the real gate.
- Chat (ACP): pass the bridge as a stdio `mcpServers` entry in `session/new`/`load`/`resume` with explicit `env` (ACP spec makes `env` explicit). Prefer stdio so `--process-per-session` is not required. The same authenticated-connection check applies. Project servers that are HTTP go over ACP only when the agent advertises `mcpCapabilities.http`, else they are left to the workspace file with a notice.
- `ignoresToolListChanged`: unknown; default `true` (conservative re-list strategy) until the token-free probe from `reference_mcp_list_changed_by_cli` is run.
- Permissions for Clubhouse tools: unconfigured MCP tools run in Ask mode. Pre-approve the bridge's read-only tools through a workspace permission rule only if Antigravity documents workspace-scoped `permissions` (it documents the user `settings.json` only). Otherwise approvals surface as normal permission requests in chat and as TUI prompts.

### 6.5 Headless and quick agents

- `buildHeadlessCommand`: `agy -p <prompt> --output-format stream-json [--model] [--effort] [--mode] [--conversation]`, with `--print-timeout` from the quick-agent deadline.
- `createEventNormalizer`: map `init` to system init, `step_update` with `text_delta` to assistant deltas, `tool` steps to tool use/result, `result` to the final result with `usage`. Fixtures only.
- Eligibility gate: headless is off for every auth type until the decision in #A1 lists the auth types it may run under (section 3). The gate reads `auth.type` and `modelProvider` from `~/.gemini/antigravity-cli/settings.json` read-only and `AGY_ADC_AUTH` from the environment; it never reads the keyring. Unknown auth means not eligible.
- When headless is not available, the request is refused with the reason. A quick agent can be started as an interactive terminal agent only if the person chooses that, with the different approval behaviour stated. Actions that need headless refuse. Nothing is converted or replayed automatically.
- Soft-denied approvals exit 0. The normalizer must surface the stderr notice as a warning so an Action does not report success for work that was refused.

### 6.6 Chat: generic ACP driver plus Antigravity launch spec

- Restore the ACP protocol layer as `src/main/chat/acp/` with no provider branches. Copilot-specific behaviour from the removed files is dropped, not ported.
- `AcpLaunchSpec` for Antigravity: `agy acp` with `--log-file <clubhouse log dir>`; `--sandbox` and `--dangerously-skip-permissions` only from the access ladder; `--add-dir` for extra folders; never `--process-per-session` unless an HTTP server must be passed.
- Driver id `antigravity_acp` added to `CHAT_DRIVER_IDS` (and the kill-switch denylist validation), `optIn` until real-login QA passes.
- Capabilities from `initialize`, not hard-coded: `loadSession`, `sessionCapabilities.{resume,list,close}`, `promptCapabilities.{image,embeddedContext}`, `mcpCapabilities`. Static claims for documented behaviour only: `steer: true`, `interrupt: true`, `questions: true` when elicitation is advertised, `slashCommands: true`, `usage: 'context'`, `modelSwitch`/`effortSwitch: 'live'` via `session/set_config_option`, `login: 'terminal'`, `systemPrompt: false` (instructions go through `AGENTS.md`).
- Permission ladder to ACP modes: `plan`→`plan`, `ask`→`default`, `auto_edit`→`accept-edits`, `auto`→`auto` (only when offered by the session and not on business accounts), `full_access`→process flag `--dangerously-skip-permissions`, which needs a restart. `liveLevels` excludes `full_access`.
- Auth: `needsLogin` when `initialize` returns `authMethods` and `session/new` fails with `-32000`. Clubhouse does not call `authenticate` for OAuth methods itself; it tells the person to run `agy` (or `agy acp --login` over SSH) and offers a retry.
- Start failure: no automatic switch to the terminal. The agent shows the failure and two choices: retry chat, or open in terminal. The unsent first message stays in the composer; nothing is replayed into the terminal. A failure after a prompt was accepted settles that turn as failed with its known work (tool calls, edits) kept in the transcript.
- Lifecycle: the driver must pass the conformance suite (#A19), including steering that joins a running native turn. `gemini-api-key` works only if the user has set `modelProvider` and the key in their environment; Clubhouse does not store or inject the key in phase 3.
- Client identity: `clientInfo { name: 'clubhouse', title: 'Clubhouse', version }`. Never another client's name.
- Models: show exactly the model option values the server returns. No local filtering to "third-party allowed" lists.

### 6.7 Config preservation and isolation

- Clubhouse never writes `~/.gemini/**`. Reads are limited to `settings.json` (`auth.type`, `modelProvider`, `agentMode`, `gcp`) and `mcp_config.json` (collision warning), both tolerant of a UTF-8 BOM (changelog fixes) and of comments (the ACP server changelog describes Hjson `settings.json`); an unparsable file means "unknown", never an error that blocks launch.
- Workspace files Clubhouse writes: `AGENTS.md` managed block, `.agents/skills/<managed>`, `.agents/mcp_config.json` `clubhouse` entry, `.agents/hooks.json` `clubhouse-*` named hooks. Each is merged (never replaced), snapshotted, restored on stop, and listed in `.git/info/exclude` when Clubhouse created it. User entries and custom text are preserved byte-for-byte.
- No per-agent profile. Two Antigravity agents share one account and one quota. That matches the removed-profiles decision (#2749).

### 6.8 Hooks for terminal status

- Named hooks `clubhouse-status` with `PreToolUse`, `PostToolUse`, `Stop` and `SessionStart` calling the existing curl hook command (`shared.ts:485`), which forwards the stdin JSON. `SessionStart` gives `conversationId`, recorded as the agent's native session id for resume (`--conversation <id>`). The payload's `transcriptPath` is not read: the file's line format and the `brain/` layout are undocumented. Clubhouse status hooks always return `allow`.
- `parseHookEvent` maps to `NormalizedHookEvent`. Permission-request hooks are not documented; `permission_request` events come only from chat.
- Hooks add latency to every tool call; the default `timeout` stays small and failures must not block tools (handler exit code semantics per docs).

### 6.9 Remote, Annex, Dispatcher, helpers

- Annex: provider id is already generic except `remote-session-history.ts:34` and `RemoteSessionHistory.tsx:52`; both move to the descriptor. Mobile refuses unknown ids (`orchestrator_unavailable`), so the phone needs the descriptor list from the desktop, not its own allowlist.
- Dispatcher: never the default provider. The Dispatcher contract (#3185, `agent-system.ts:792`) is that the agent acts only through the Clubhouse MCP and never through the CLI's own computer use or browser control. Antigravity documents no dedicated flag, but documents controls that may satisfy the contract: a workspace `PreToolUse` hook that returns `deny` for browser tools, `mcp(server/tool)` deny rules that apply to the `/browser` subagent's DevTools tools, and the terminal sandbox's network rules. Eligibility is a gate (#A14): map each documented browser/desktop tool name to a control, prove the control fails closed (the changelog records a Windows bug where a blocking hook was silently skipped), then decide. Until the gate passes, Antigravity is not offered as a Dispatcher CLI.
- Helpers: Antigravity can be chosen explicitly (`cli: 'antigravity-cli'`). For `cli: 'auto'`, the descriptor declares eligibility and quota kind (#A18). Copilot shows an unknown-quota provider can be a candidate ranked last, so unknown quota alone does not exclude Antigravity. Its initial setting is `opt_in` (off unless the person turns it on), recorded as a starting choice to revisit, not a conclusion. Helpers run in terminal or chat, never headless, unless the headless gate allows it. Cross-project helpers inherit the same rules.
- `--remote-agent`, `--remote-control` and `/schedule` are Antigravity's own remote features; Clubhouse does not drive them.

### 6.10 Platforms

- macOS: `~/.local/bin/agy`; sandbox seatbelt.
- Linux: same path; bubblewrap must be installed for `--sandbox`/`auto`, and a sandboxed start refuses without it; glibc >= 2.28.
- Windows: `%LOCALAPPDATA%\agy\bin\agy.exe`; `structured-spawn.ts` handles `.exe` and `.cmd`; ACP had a Windows-only startup crash fixed upstream (changelog), so the version floor must be at or above the fix; `auto` needs v1.4.4+.

### 6.11 Observability and security

- Telemetry: `clubhouse.orchestrator` gains `antigravity-cli`; `c.chat.driver` gains `antigravity_acp`. No prompt text, model ids beyond the existing allowlist rules, or auth type in exported telemetry; auth type as a closed enum is local-only.
- Diagnostics: feedback bundles may include the path (not content) of `~/.gemini/antigravity-cli/log/acp-*.log` and the Clubhouse-owned `--log-file`.
- Antigravity's own telemetry: Clubhouse does not pass `--disable-telemetry` by default; that is the user's Antigravity account setting. A Clubhouse toggle may add it later.
- Security: no credential reads, no keyring access, no API keys in argv or files Clubhouse writes, no `clientInfo` spoofing, no undocumented endpoints or env vars (`GEMINI_HOME`, `ANTIGRAVITY_HARNESS_PATH` are not used).

### 6.12 Tests and CI

- Fake `agy` CLI under `scripts/chat-fixtures` and `adapters/testing/fake-cli.ts`: `--version`, `models`, `acp` (replays recorded-shape JSONL built from the public ACP schema), `-p --output-format stream-json` (replays documented examples).
- ACP schema pin: vendor `@agentclientprotocol/sdk` schema at a fixed version; CI diffs it like the Codex bindings. No tokens.
- `provider-integration.test.ts` describe block, `provider-doc-contract.test.ts` matrix column, `registry.test.ts`, instructions-path and helper-access tests.
- No paid prompts, no live login in CI (feedback_no_ci_token_spend). The nightly handshake smoke may add `agy acp` initialize-only once a pinned binary is available in CI; the CLI install is a network fetch, so this is optional.

### 6.13 Migration and backward compatibility

- Additive only: no change for existing providers' settings, agents, presets or telemetry values.
- Saved agents with an unknown orchestrator id (e.g. a downgrade) keep their id and show "provider unavailable", as today.
- Removing the experimental flag later must not delete Antigravity agents or their saved settings (legacy-defaults rule, #3245).

## 7. Phases

| Phase | Content | Needs subscription |
| --- | --- | --- |
| 0 | Descriptor refactor; fake `agy` harness; eligibility clarification issue | No |
| 1 | Terminal provider, binary/availability, models, access ladder, managed `AGENTS.md`/skills, workspace MCP, config preservation, help + contract matrix | No (fake CLI); live check in V-gates |
| 2 | Hooks status, session id capture and resume | No (fixtures) |
| 2b | Chat lifecycle conformance suite (#A19) | No |
| 3 | Generic ACP driver restore; Antigravity launch spec, capabilities, auth handling, permissions, models | No (fixtures) |
| 4 | Headless normalizer with auth gate; quick agents and Actions | No (fixtures) |
| 5 | Annex, mobile, helper Auto eligibility, Dispatcher eligibility gate, telemetry, diagnostics | No |
| 6 | Real-login validation (V1-V12), then remove `optIn` / experimental per maintainer | Yes |

Required for the epic to close, cannot be waived: terminal provider, managed instructions and skills, Clubhouse MCP with authenticated identity, ACP chat, config preservation, the lifecycle conformance suite, and the required real-login gates. Optional, may be deferred with a recorded reason: headless, Dispatcher eligibility, Auto routing, custom agents, transcript rendering beyond ACP history, business-account checks.

## Unknowns and validation gates

None of these block phases 0-5; each is settled at the named gate. Gates run outside CI on a real binary, some signed in, with no automation of the login itself. A gate marked required can fail and produce a fix, but cannot be waived to close the epic.

| # | Unknown | Settled by | Required to close the epic |
| --- | --- | --- | --- |
| V1 | How the FAQ statements apply to a Clubhouse ACP client or Clubhouse-hosted TUI on personal plans | Clarification request and maintainer defaults (#A1) | Yes (a recorded decision, whatever it is) |
| V2 | Which models a custom ACP client is offered (ACP guide vs 1.5.1 changelog) | Signed-in `session/new` config options, per plan | Yes |
| V3 | Whether `agy` passes its environment to stdio MCP children (TUI and ACP) | Dummy stdio server that records its env; login only if MCP starts after auth | Yes |
| V4 | Whether a worktree `.git` file stops parent rule traversal | Fixture tree on the real binary | Yes |
| V5 | ACP `session/load` history replay fidelity | Signed-in session. The undocumented `transcript.jsonl` format is never parsed | Yes |
| V6 | ACP `initialize` capabilities on the pinned version | Initialize probe. [Inference] works without login, since the ACP spec puts auth after initialize | Yes |
| V7 | Workspace trust prompt in ACP sessions for a new worktree | Signed-in ACP session | Yes |
| V8 | Whether ACP reports subagent activity | Signed-in session with a subagent | No |
| V9 | Paste timing for the TUI | Signed-in PTY session | Yes |
| V10 | `tools/list_changed` handling | Token-free MCP probe | Yes |
| V11 | Business-account behaviour (`oauth-business`): no `auto`, admin policies | Enterprise account, if available | No |
| V12 | Windows ACP startup and `.exe` spawn | Windows machine, signed in | Yes |
| V13 | Steering, cancel and permission settlement on the real server match the conformance suite | Signed-in ACP session running the #A19 scenarios with minimal prompts | Yes |
| V14 | Documented browser/desktop controls fail closed (Dispatcher gate) | Real binary, hook and deny rule scenarios | No (Dispatcher is optional) |

## Sources

All read 2026-11-23.

- https://antigravity.google/docs/overview/
- https://antigravity.google/docs/getting-started/
- https://antigravity.google/docs/install/
- https://antigravity.google/docs/cli/reference/
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/acp/
- https://antigravity.google/docs/ide/extensions/acp/
- https://antigravity.google/docs/cli/conversations/
- https://antigravity.google/docs/cli/troubleshooting/
- https://antigravity.google/docs/changelog/
- https://antigravity.google/docs/faq/
- https://antigravity.google/docs/plans/
- https://antigravity.google/docs/models/
- https://antigravity.google/docs/enterprise/
- https://antigravity.google/docs/rules/
- https://antigravity.google/docs/skills/
- https://antigravity.google/docs/customization-discovery/
- https://antigravity.google/docs/mcp/
- https://antigravity.google/docs/hooks/
- https://antigravity.google/docs/settings/
- https://antigravity.google/docs/permissions/
- https://antigravity.google/docs/features/
- https://antigravity.google/docs/sdk/overview/, /docs/sdk/mcp/, /docs/sdk/policies/, /docs/sdk/tools/, /docs/sdk/lifecycle/, /docs/sdk/structured-output/
- https://agentclientprotocol.com/protocol/overview, /protocol/initialization, /protocol/session-setup
- npm `@agentclientprotocol/sdk` latest 2.9.1 (registry read 2026-11-23)
