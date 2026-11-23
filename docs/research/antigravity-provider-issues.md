# Antigravity provider: epic and child issue drafts

Draft for parent readback. Each block between `<!-- issue ... -->` markers becomes one GitHub issue. `#E` means the epic, `#A1`..`#A17` mean the children, replaced by real numbers on publish. Design reference for every issue: `docs/research/antigravity-provider-design.md` on branch `antigravity-provider-design/design-epic`.

Labels: every issue gets `antigravity-2026-11-23` (new dated batch label) plus the listed ones.

<!-- issue key=E labels="enhancement,epic,tracking,type:feature,area:main,area:renderer,area:shared,severity: MEDIUM" -->
# [MEDIUM] Epic: Antigravity CLI as a fourth provider (terminal, ACP chat, headless)

Add Google Antigravity CLI (`agy`) as a Clubhouse provider using only its publicly documented interfaces, and generalize the provider abstraction so a fourth provider does not need edits in ~35 files.

Design, evidence and capability matrix: `docs/research/antigravity-provider-design.md` (branch `antigravity-provider-design/design-epic`). Evidence snapshot 2026-11-23, CLI v1.5.12.

## Surfaces
- Terminal: `agy` TUI in a PTY.
- Chat: `agy acp`, Agent Client Protocol v1 over stdio. The ACP guide says "Any ACP client can launch Antigravity CLI" (https://antigravity.google/docs/ide/extensions/acp/). Driven by a restored, provider-neutral ACP driver (removed with legacy Copilot ACP in #2868, recoverable from `00c9534bb^`).
- Headless: `agy -p --output-format stream-json` (https://antigravity.google/docs/cli/headless/), gated by auth type because the FAQ says wrapping `agy -p` in third-party apps "is not supported under consumer plans" (https://antigravity.google/docs/faq/).
- Not used: the Python SDK `google-antigravity` (Python only; documents API-key and Vertex/Enterprise auth only).

## Constraints
- Public docs only. No reverse engineering, undocumented env vars or endpoints, credential or keyring reads, `clientInfo` spoofing, or account rotation.
- Clubhouse never writes `~/.gemini/**`. Workspace files are merged, snapshotted and restored; user configuration is preserved.
- Behind the experimental flag and a provider toggle; never the default or Dispatcher provider.
- No paid prompts or live login in CI. Real-login checks are collected in #A17 and run when a subscription is available.

## Children (dependency order)
Phase 0, no subscription needed
- [ ] #A1 Record plan/usage eligibility statements and request clarification
- [ ] #A2 Provider descriptor: replace hard-coded provider id lists
- [ ] #A3 Fake `agy` CLI and fixtures

Phase 1, terminal
- [ ] #A4 Terminal provider `AntigravityCliProvider` (needs #A2, #A3)
- [ ] #A5 Model and effort discovery (needs #A4)
- [ ] #A6 Access ladder and execution policy mapping (needs #A4)
- [ ] #A7 Managed instructions, skills and custom agents (needs #A4)
- [ ] #A8 Clubhouse MCP bridge delivery and identity (needs #A4)
- [ ] #A9 Configuration preservation and inherited customizations (needs #A4; with #A7, #A8)
- [ ] #A16 Help, settings, first run and provider doc contract (needs #A4)

Phase 2, terminal status and sessions
- [ ] #A10 Hooks-based status, session id and resume (needs #A4, #A9)

Phase 3, chat
- [ ] #A11 Restore a provider-neutral ACP chat protocol layer (needs #A3)
- [ ] #A12 Antigravity ACP chat driver (needs #A6, #A8, #A11)

Phase 4, headless
- [ ] #A13 Headless normalizer and auth-type gate (needs #A4, #A6, #A1 for defaults)

Phase 5, integration
- [ ] #A14 Annex, mobile, helpers and Dispatcher eligibility (needs #A2, #A4)
- [ ] #A15 Telemetry, diagnostics and version policy (needs #A2, #A4, #A12)

Phase 6, subscription
- [ ] #A17 Real-login validation gates V1-V12 (needs everything above; deferred acceptance)

## Acceptance for the epic
- All children closed or explicitly deferred with a reason.
- An Antigravity agent can run in terminal and chat with the Clubhouse MCP, managed instructions and skills, on macOS, Windows and Linux, verified by fixtures in CI and by #A17 on a real account.
- Existing providers' settings, agents, presets and telemetry values are unchanged.

<!-- issue key=A1 labels="needs-decision,type:chore,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity: record plan and usage eligibility statements and request clarification

Part of #E.

## Problem
Antigravity's public docs contain three statements that bear on how Clubhouse may launch `agy`:
1. FAQ: "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service ... To use a third-party coding agent with Gemini, we recommend using a Gemini Enterprise or Google AI Studio API key." https://antigravity.google/docs/faq/
2. FAQ: "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans." https://antigravity.google/docs/faq/
3. ACP guide: "Any ACP client can launch Antigravity CLI", reusing credentials cached by an interactive `agy` session. https://antigravity.google/docs/ide/extensions/acp/

The docs also disagree on models for custom ACP clients: the ACP guide limits third-party models to named editors; the CLI 1.5.1 changelog says every model is offered to every ACP client (https://antigravity.google/docs/changelog/).

## Scope
- Keep the exact statements, URLs and read date in the Antigravity help page (#A16) and in this issue.
- Ask Google, through a public channel (Antigravity feedback or support), how statements 1 and 3 apply to (a) an ACP client that launches the user's own `agy acp`, (b) a terminal app that hosts the user's `agy` TUI, for personal plans. Record the answer verbatim with date.
- Maintainer decision on defaults, recorded here:
  - Headless (`agy -p`) for `oauth-personal`: off (proposed), per statement 2.
  - ACP chat for `oauth-personal`: available behind the experimental flag (proposed), per statement 3, with the statements shown in the provider's help.
  - Terminal TUI: available (proposed).

## Non-goals
- Any legal conclusion beyond the documented text.
- Blocking phases 0-5 on an answer. Code paths take the decided defaults as settings in #A12/#A13.

## Acceptance
- Statements and the model discrepancy recorded in-repo with URLs and date.
- Clarification request sent, linked here; the answer (or "no answer by date") recorded.
- Defaults decision recorded by the maintainer.

## Proof
Links to the request and the recorded decision. No code.

<!-- issue key=A2 labels="enhancement,type:chore,area:main,area:renderer,area:shared,severity: MEDIUM" -->
# [MEDIUM] Provider descriptor: replace hard-coded provider id lists before adding a fourth provider

Part of #E. Blocks #A4, #A14, #A15.

## Problem
`OrchestratorId` is open (`src/main/orchestrators/types.ts:7`) but about 35 non-test files enumerate `claude-code`, `codex-cli` and `copilot-cli` by literal. A new provider silently degrades in each: Ask-only access (`src/shared/agent-access.ts:105-109`), no helper presets (`src/shared/helper-routing.ts:62,73,94`), no capacity tracking (`src/shared/handoff-capacity.ts:3,62`, `src/shared/helper-auto-budget.ts:2`), no remote history (`src/main/services/remote-session-history.ts:34`), missing glyph/colors/mascots/install link (`OrchestratorGlyph.tsx:5`, `orchestrator-colors.ts:7-9,46-48`, `SleepingMascots.tsx:209-211`, `SleepingAgent.tsx:61`, `FirstRun.tsx:21-23`, `HelperPresetsSection.tsx:30`), `other` in telemetry (`src/shared/telemetry/attributes.ts:328,608,633`; `knownCli` sets in `feature-events.ts:41`, `chat-telemetry.ts:84`, `agent-signals.ts:94,118`, `agent-telemetry.ts:62`, `session-telemetry.ts:20`, `spawn-telemetry.ts:30`), and the chat labels (`chat-version-policy.ts:80-84`, `ChatHeader.tsx:11-14`, `src/shared/chat/provider-inventory.ts:15-16`). `supportsPositionalMission` falls back to `id === 'claude-code'` (`types.ts:386`).

## Scope
- A static `ProviderDescriptor` per built-in provider (id, names, short name, telemetry code, access levels per runtime, helper preset/auto eligibility, capacity tracking, remote-history eligibility, install docs URL, glyph/color keys, optional state-dir env). Shape in design section 6.1.
- Replace the literal lists above with descriptor lookups. Telemetry enums stay closed and reviewed; the descriptor supplies the value.
- Keep provider-specific behaviour (Codex TOML, Copilot hooks) where it is; this issue only moves enumerations.

## Related
- #2777 renames `OrchestratorId` to `ProviderId`; land in either order but rebase, not both in flight.
- #384 provider parity suite: the descriptor gives it the provider list to iterate.

## Non-goals
- Adding Antigravity (that is #A4).
- Changing any behaviour of the existing three providers.

## Acceptance
- No non-test file outside `src/main/orchestrators/` enumerates all three provider ids for policy or display (grep check added to CI or a unit test).
- Existing unit tests pass unchanged; snapshot of descriptor-derived lists equals today's lists.

## Proof
Full `npm test`, `npm run typecheck`, lint. A test that builds every former list from descriptors and compares to the old literal values.

<!-- issue key=A3 labels="enhancement,test-coverage,type:chore,area:main,severity: MEDIUM" -->
# [MEDIUM] Fake `agy` CLI and fixtures for Antigravity tests (no tokens)

Part of #E. Blocks #A4, #A11, #A12, #A13.

## Problem
There is no Antigravity binary in CI and no subscription. Every Antigravity code path needs a deterministic stand-in built from the public docs.

## Scope
- Extend `scripts/chat-fixtures/fake-cli.mjs` and `src/main/orchestrators/adapters/testing/fake-cli.ts` (see `docs/chat-fixtures.md`) with an `agy` personality:
  - `agy --version` -> configurable version string.
  - `agy models` -> slug list in the documented shape (https://antigravity.google/docs/cli/headless/).
  - `agy -p ... --output-format stream-json|json` -> replays documented `init`/`step_update`/`result` examples, error, soft-deny and unknown-model exits.
  - `agy acp` -> JSON-RPC replay per ACP v1 (https://agentclientprotocol.com/protocol/initialization, /protocol/session-setup): `initialize` with `authMethods` from the ACP guide, `session/new` success and `-32000` auth-required, `session/update` streams, `session/request_permission`, `session/cancel`, `session/load`/`resume`/`list`/`close`, `session/set_config_option` for model and thinking level.
  - A TUI stub for PTY spawn tests that echoes args and exits on `/exit`.
- Fixtures are hand-built from documented shapes and marked as such; none are presented as recordings of a real CLI.
- Vendor the ACP JSON schema from `@agentclientprotocol/sdk` at a pinned version (2.9.1 at drafting) with a CI diff check, like the Codex bindings.

## Non-goals
- Recording from a real account (that happens in #A17 and may replace fixtures later).

## Acceptance
- `CLUBHOUSE_TEST_CLI_BINARIES` can point `agy` at the fake in unit and E2E tests.
- Schema pin test fails on drift.

## Proof
Unit tests for the fake's personalities; schema diff test.

<!-- issue key=A4 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity terminal provider: `AntigravityCliProvider`

Part of #E. Needs #A2, #A3.

## Problem
Clubhouse cannot launch `agy` as an agent.

## Scope
- `src/main/orchestrators/antigravity-cli-provider.ts` extending `BaseProvider` (`base-provider.ts:62-118`), `id: 'antigravity-cli'`, display "Antigravity CLI", short "AGY", badge Experimental. Registered after Codex in `registry.ts` so it is never the first-enabled default (`dispatcher-service.ts:748-751`); hidden unless the experimental flag and provider toggle are on.
- Binary: `binaryNames ['agy']`; `getExtraBinaryPaths()` adds `~/.local/bin` and `%LOCALAPPDATA%\agy\bin` (documented install locations, https://antigravity.google/docs/getting-started/). `checkAvailability` runs `agy --version` and applies a minimum version (1.5.0, the first with `agy acp`; terminal-only floor may be lower, decided with #A15).
- `buildSpawnCommand`: `--model`, `--effort`, access flags from #A6, `--sandbox` from execution policy, `--conversation <id>` or `-c` for resume, `--add-dir` for extra folders once #1724 adds `SpawnOpts.additionalDirs` (Antigravity also loads customizations from added folders, https://antigravity.google/docs/customization-discovery/), optional `-i <mission>` (`--prompt-interactive`) for a starting mission. Flags per https://antigravity.google/docs/cli/reference/.
- `getExitCommand` `'/exit\r'`. Paste timing starts from the Copilot profile with quiescence; tuned in #A17.
- `conventions`: `configDir '.agents'`, `localInstructionsFile 'AGENTS.md'`, `skillsRoot '.agents/skills'`, `mcpConfigFile '.agents/mcp_config.json'`, `hooksFile 'hooks.json'`, `settingsFormat 'json'`, `permissionRules false`.
- Capabilities: `headless` per #A13, `hooks: true` (#A10), `sessionResume: true`, `permissions: true`, `supportsPositionalMission: false`.
- Workspace trust: a new worktree will prompt in the TUI. Do not write `trustedWorkspaces` (https://antigravity.google/docs/settings/); document it in help.
- `provider-integration.test.ts` describe block (spawn flags, resume, free agent, default permissions) and `registry.test.ts`.

## Non-goals
- Chat, headless, hooks (separate issues). Writing any `~/.gemini` file.

## Acceptance
- With the fake `agy`, a durable agent starts in a PTY with the expected argv on macOS, Linux and Windows CI.
- With `agy` absent, the provider reports unavailable with the install link; the agent is not created.
- Disabled by default; no change for users who don't enable it.

## Proof
Unit + integration tests with the fake CLI; Windows path test for `.exe` resolution. Live start deferred to #A17 (V9).

<!-- issue key=A5 labels="enhancement,type:feature,area:main,area:renderer,severity: MEDIUM" -->
# [MEDIUM] Antigravity model and effort discovery

Part of #E. Needs #A4.

## Problem
Model pickers and `acceptsModel` need Antigravity's live model list. Headless exits non-zero on an unknown `--model` with no fallback (https://antigravity.google/docs/cli/headless/), so a stale static list breaks runs. Several models are scheduled for removal on 2026-11-30 (https://antigravity.google/docs/models/).

## Scope
- `modelFetchConfig` running `agy models` in the empty probe dir (`base-provider.ts:312-341`), parsed into `ModelInfo`; static fallback is `default` only (no hard-coded slugs).
- Efforts: `low|medium|high|xhigh|max` "depending on the model" (headless page). Where the CLI does not report per-model efforts, offer the documented set and let the CLI reject; surface the error.
- `acceptsModel` true only for listed slugs.
- Chat models come from ACP `configOptions` (#A12), not this list.
- No `readPlanQuota`: no token-free documented quota read (`/usage` is interactive). Helper routing treats it as unmeasured (#A14).

## Non-goals
- Filtering third-party models by client (the docs disagree, #A1); show what the CLI reports.

## Acceptance
- Model picker lists fake `agy models` output; probe errors show `liveError` and fall back without crashing.
- `peekModels` never spawns.

## Proof
Unit tests with fake output, malformed output and timeout. Live list check in #A17 (V2).

<!-- issue key=A6 labels="enhancement,type:feature,area:main,area:shared,severity: MEDIUM" -->
# [MEDIUM] Antigravity access ladder and execution policy mapping

Part of #E. Needs #A4. Used by #A12, #A13.

## Problem
Clubhouse's five levels (`src/shared/chat/capabilities.ts:32`) must map to Antigravity's documented modes, and an unknown provider currently gets Ask only (`src/shared/agent-access.ts:105-109`).

## Scope
- Mapping (docs: https://antigravity.google/docs/cli/reference/, https://antigravity.google/docs/cli/modes/, https://antigravity.google/docs/permissions/):
  - `plan` -> `--mode plan` / ACP `plan`
  - `ask` -> default mode (no `--mode`; `toolPermission` default `request-review`)
  - `auto_edit` -> `--mode accept-edits` / ACP `accept-edits`
  - `auto` -> `--mode auto` / ACP `auto`, only where offered: needs the terminal sandbox, macOS/Linux v1.3.5+, Windows v1.4.4+, not for business or enterprise accounts
  - `full_access` -> `--dangerously-skip-permissions` (process flag; restart needed in chat)
- Descriptor access levels (#A2): terminal and chat both all five, with `auto` hidden when the account type is business/enterprise (read-only from `auth.type` in settings, unknown -> hidden).
- Execution policy: `--sandbox` when the agent's policy asks for a sandbox (`src/shared/execution-policy.ts:30` is Codex-only today; extend with the descriptor). Linux requires bubblewrap; surface a notice when absent.
- Headless default (since v1.5.7 `auto` where available) must be pinned explicitly with `--mode` so a quick agent never runs at a higher level than chosen.
- Note in UI that the user's own `permissions.allow|ask|deny` in `~/.gemini/antigravity-cli/settings.json` still apply (Deny > Ask > Allow).

## Non-goals
- Writing permission rules into the user's `settings.json`.

## Acceptance
- Unit tests for argv per level and runtime; `auto` absent for business accounts and older versions; headless always passes `--mode`.

## Proof
Unit tests; live behaviour in #A17 (V11 for business).

<!-- issue key=A7 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity managed instructions, skills and custom agents

Part of #E. Needs #A4.

## Problem
Managed agents deliver instructions and skills per provider (`src/main/services/managed-agents/delivery.ts:134,354,820,948`), with special cases for Claude and Copilot (`delivery.ts:482,692-695,707,851,1077-1090`). Antigravity reads `AGENTS.md`, `GEMINI.md`, `.agents/AGENTS.md`, `.agents/rules/*.md` (needs `trigger` frontmatter or is silently discarded), and skills from `.agents/skills/<name>/SKILL.md`, from the workspace and each parent up to the repo root, cumulatively, with a 24,000-byte per-file limit and a 20,000-token aggregate rules budget (https://antigravity.google/docs/rules/, https://antigravity.google/docs/skills/, https://antigravity.google/docs/customization-discovery/).

## Scope
- Managed block in `<worktree>/AGENTS.md` (same file Codex uses; one provider per agent, so no conflict). Do not create `GEMINI.md` or `.agents/rules`.
- Inspector warning when the composed `AGENTS.md` exceeds 24,000 bytes.
- Skills in `.agents/skills/<name>/` flat, reusing Codex's root and exclude logic.
- Custom agents: map a persona to `.agents/agents/<name>.md` + `--agent <name>` only if `AgentFileCapable` is wanted; otherwise record as a follow-up.
- Fixture test (no login) that a worktree's `.git` file is where parent traversal stops is in #A17 (V4); until then document that rules in the main checkout's parents may also load.

## Non-goals
- Editing user rules or skills in `~/.gemini`.

## Acceptance
- Managed agent on Antigravity gets its instructions and skills in the documented locations; switching provider away removes only Clubhouse-owned content.
- Existing Codex delivery unchanged.

## Proof
Unit tests on delivery with a temp worktree; inspection test for the size warning.

<!-- issue key=A8 labels="enhancement,type:feature,area:main,severity: HIGH" -->
# [HIGH] Antigravity: Clubhouse MCP bridge delivery, identity and isolation

Part of #E. Needs #A4. Blocks #A12.

## Problem
Every agent must get the Clubhouse MCP (always on). The bridge is a stdio server that reads `CLUBHOUSE_HOOK_NONCE`, `CLUBHOUSE_AGENT_ID` and `CLUBHOUSE_MCP_PORT` from its inherited environment (`src/main/services/clubhouse-mcp/injection.ts:460-470`). Antigravity reads MCP from `~/.gemini/config/mcp_config.json` and `<workspace>/.agents/mcp_config.json` (stdio `command/args/env/cwd`; Streamable HTTP `serverUrl`/`headers`; SSE unsupported); on a name collision "the server that is already running keeps it"; unconfigured MCP tools run in Ask mode (https://antigravity.google/docs/mcp/, https://antigravity.google/docs/settings/). ACP clients may pass `mcpServers` in `session/new`; HTTP servers from the editor need `--process-per-session` (https://antigravity.google/docs/ide/extensions/acp/). Whether `agy` passes its own environment to stdio MCP children is not documented.

## Scope
- Terminal/headless: merge a `clubhouse` stdio entry into `<worktree>/.agents/mcp_config.json`; snapshot/restore via `config-pipeline.ts` (`:106,139`); add to `.git/info/exclude` when Clubhouse created the file; preserve all user entries and keys.
- Chat: pass the bridge in ACP `mcpServers` with explicit `env` (ACP spec makes `env` explicit); configured HTTP project servers only when `mcpCapabilities.http` is advertised, else a notice.
- Identity: no nonce in argv or files when env inheritance works. If V3 shows it does not, fall back to a per-launch nonce in the stdio `env` field, file mode 0600, excluded, removed on stop, rotated per launch.
- Collision: warn when the user's global `mcp_config.json` defines `clubhouse`.
- Grants: Clubhouse tool permission prompts appear as Antigravity permission requests; no pre-approval unless a documented workspace-scoped rule exists.
- `ignoresToolListChanged: true` until measured.

## Non-goals
- Writing the global MCP config.

## Acceptance
- With the fake CLI, the workspace file contains the bridge entry and user entries unchanged; restore returns the file byte-identical; ACP `session/new` carries the bridge.
- No nonce in argv or the spawn log.

## Proof
Unit tests on merge/restore with user-authored files (comments, BOM, extra keys); ACP request capture test. Env inheritance (V3) and list-changed (V10) proven token-free in #A17.

<!-- issue key=A9 labels="enhancement,type:feature,area:main,area:renderer,severity: MEDIUM" -->
# [MEDIUM] Antigravity configuration preservation and inherited customizations

Part of #E. Needs #A4; lands with #A7, #A8.

## Problem
Antigravity documents no config-dir override (no equivalent of `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`COPILOT_HOME`, `provider-profiles-removed.ts:33-37`). Every Antigravity agent shares the user's `~/.gemini` rules, skills, hooks, MCP servers, permissions and account, and loads them cumulatively.

## Scope
- Hard rule: Clubhouse never writes under `~/.gemini`. Reads limited to `~/.gemini/antigravity-cli/settings.json` (`auth.type`, `modelProvider`, `agentMode`, `gcp`) and `~/.gemini/config/mcp_config.json` (collision check); BOM- and comment-tolerant; unparsable means unknown.
- Workspace writes (`AGENTS.md` block, `.agents/skills/*`, `.agents/mcp_config.json` entry, `.agents/hooks.json` named hooks) are merged, snapshotted, restored and excluded. User custom text preserved byte-for-byte.
- Agent settings view: read-only list "Also loaded from your Antigravity profile" with the documented global paths that exist.
- Do not use undocumented `GEMINI_HOME`.

## Non-goals
- Per-agent Antigravity profiles or accounts (#2749 removed profiles).

## Acceptance
- Test that no code path writes under a temp `HOME/.gemini`.
- Restore leaves user workspace files identical after start/stop cycles and crashes (recovery path).

## Proof
Unit tests with a temp HOME; crash-restore test via `config-pipeline` recovery.

<!-- issue key=A16 labels="documentation,enhancement,type:chore,area:renderer,severity: MEDIUM" -->
# [MEDIUM] Antigravity help, settings, first run and provider doc contract

Part of #E. Needs #A4.

## Problem
The provider doc contract test hard-codes three providers (`src/main/orchestrators/provider-doc-contract.test.ts:49-53`) against the matrix in `src/renderer/features/help/content/settings-orchestrators.md:43-49`. Users need install, sign-in and limitation guidance.

## Scope
- Add an Antigravity column to the help matrix and contract test.
- Help page: install link (https://antigravity.google/docs/getting-started/), sign in by running `agy` once in a terminal (or `agy acp --login` over SSH), workspace trust prompt, auth types and what each enables (headless gate, `auto` not for business accounts), inherited `~/.gemini` customizations, the FAQ statements from #A1 verbatim with links.
- Settings: provider toggle with Experimental badge; first-run install link (`FirstRun.tsx:21-23` via descriptor).
- Explain API-key use requires the user to set `"modelProvider": "gemini"` themselves and export `GEMINI_API_KEY` (https://antigravity.google/docs/install/); Clubhouse does not edit that file.

## Non-goals
- Marketing copy; promises about models or quotas.

## Acceptance
- Contract test covers four providers; help renders; copy passes the UI style rules (no em-dash reveals, no tinted callouts).

## Proof
Unit tests, renderer tests.

<!-- issue key=A10 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity terminal status via hooks, session id capture and resume

Part of #E. Needs #A4, #A9.

## Problem
Terminal agents need tool/stop status and a native session id for resume. Antigravity prints no documented session id to the PTY, but hook payloads carry `conversationId` and `transcriptPath` (CLI: `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`). Hooks live in `.agents/hooks.json` as a map of named hooks with `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` (https://antigravity.google/docs/hooks/). `SessionCapable.extractSessionId` (`types.ts:309`) assumes PTY text.

## Scope
- `HookCapable` for Antigravity: merge a `clubhouse-status` named hook into `.agents/hooks.json` calling the existing curl hook command (`shared.ts:485`); strip on stop (`config-pipeline.ts:242,288`).
- `parseHookEvent`: `PreToolUse` -> `pre_tool`, `PostToolUse` (with `error`) -> `post_tool`/`tool_error`, `Stop` -> `stop` with `terminationReason`; `SessionStart` records the session id and transcript path.
- Session contract: add a hook-sourced session id path alongside `extractSessionId` (contract change, applies to future providers too); resume with `--conversation <id>`; `-c` only as a fallback.
- `listSessions`/`hasSession` from the documented `brain/` directory; transcript rendering waits for V5.
- Hook timeouts small; a failing Clubhouse hook must never block a tool.

## Non-goals
- Permission-request hooks (not documented for Antigravity).

## Acceptance
- Fake hook payloads produce status events and a stored session id; resume argv uses it; hook file restored after stop.

## Proof
Unit tests with documented payload examples; live check in #A17.

<!-- issue key=A11 labels="enhancement,type:feature,area:main,area:shared,severity: HIGH" -->
# [HIGH] Restore a provider-neutral ACP chat protocol layer

Part of #E. Needs #A3. Blocks #A12.

## Problem
Clubhouse removed its ACP driver with legacy Copilot ACP in #2868 (`00c9534bb`). The research doc kept "ACP as the vocabulary and the long-tail driver" (`docs/structured-chat-research.md:441-450`) and the event model is already ACP-named (`src/shared/chat/events.ts:8`). Chat driver ids are a closed list (`src/shared/chat/capabilities.ts:16-21`) and selection special-cases Copilot (`src/main/services/agent-runtime/chat-drivers.ts:19-32`, `chat-spawn.ts:139-148`, `chat-runtime-settings.ts:61,90`).

## Scope
- Recover `acp-client.ts`, `acp-session.ts`, `acp-updates.ts`, `acp-chat-mapper.ts`, `acp-schema.ts`, `acp-capabilities.ts`, `acp-chat-driver.ts` from `00c9534bb^:src/main/orchestrators/adapters/` into `src/main/chat/acp/`, removing every Copilot branch. `AcpLaunchSpec` (`acp-chat-driver.ts:23` in that tree) becomes the only provider hook.
- Update to the current ACP schema pinned in #A3 (the removed code targeted schema v1.26.0): `session/resume`, `session/close`, `session/list`, `session/set_config_option`, elicitation, `$/cancel_request`, `additionalDirectories`.
- Capabilities derived from `initialize` (`loadSession`, `sessionCapabilities`, `promptCapabilities`, `mcpCapabilities`, auth); static claims only from the launch spec.
- Generalize driver selection so a provider's ACP driver is a normal candidate (remove the Copilot-only branches into descriptor data).
- Carry forward the fixes for #2191 (activity after the prompt reply) and #2401 (resume test timing).

## Non-goals
- Re-adding Copilot ACP.

## Acceptance
- Generic driver passes the fake ACP flows (handshake, prompt, permission, cancel, steer, load/resume/list/close, auth-required) with no provider-specific code.
- Kill-switch denylist validation accepts the new id(s).

## Proof
Unit + fake-CLI flow tests (`chat-fake-cli-flows.test.ts` pattern), schema pin test.

<!-- issue key=A12 labels="enhancement,type:feature,area:main,area:renderer,severity: HIGH" -->
# [HIGH] Antigravity ACP chat driver

Part of #E. Needs #A6, #A8, #A11.

## Problem
Native chat for Antigravity over `agy acp` (https://antigravity.google/docs/ide/extensions/acp/, https://antigravity.google/docs/cli/acp/).

## Scope
- Launch spec: `agy acp --log-file <clubhouse log dir>`; `--sandbox`/`--dangerously-skip-permissions` from #A6; `--add-dir` for extra folders after #1724; `--process-per-session` only when an HTTP MCP server must be passed. Working directory = agent worktree.
- Driver id `antigravity_acp`, `optIn: true` until #A17 passes; terminal fallback on failure (existing pattern).
- Capabilities: from `initialize`, plus documented behaviour: steer (prompt mid-turn), interrupt (`session/cancel`), questions (elicitation when advertised), slash commands, `usage: 'context'` (1.5.8+), live model and thinking-level switch via `session/set_config_option`, images/embedded resources per `promptCapabilities`, `login: 'terminal'`, `systemPrompt: false`, `subagents: 'ids_only'` until V8.
- Modes per #A6; `liveLevels` excludes `full_access`.
- Auth: `needsLogin` + `loginHint` ("Run `agy` in a terminal to sign in" / "`agy acp --login` over SSH") on `-32000`. Do not call `authenticate` for OAuth methods; do not inject `GEMINI_API_KEY`.
- `clientInfo` name/title Clubhouse with the app version. Never another client's identity.
- Models exactly as offered by the session's `configOptions`.
- Chat version policy entry in `chat-version-policy.ts` (min 1.5.8 proposed, for context usage and the 1.5.x cancel/close fixes), tested max advisory.
- Chat header label, settings driver picker entry.
- Workspace trust in ACP sessions: handle a trust prompt if it arrives as a question/permission (V7).

## Non-goals
- Third-party model access decisions (#A1); headless.

## Acceptance
- Fake-CLI flows: start, stream, tool call with diff, permission allow/deny, question, cancel mid-tool, steer, model switch, resume after restart, auth-required -> terminal with hint, Windows `.exe` spawn.
- No regression in other drivers.

## Proof
Fake-CLI tests and chat E2E spec added to an E2E job list (per E2E migration rules); real-login QA in #A17.

<!-- issue key=A13 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity headless: stream-json normalizer and auth-type gate

Part of #E. Needs #A4, #A6; defaults from #A1.

## Problem
Quick agents, Actions and one-off prompts use `HeadlessCapable` (`types.ts:252`, `agent-system.ts:867-968`, `headless-prompt.ts:106-120`). Antigravity documents `agy -p --output-format stream-json` with `init`/`step_update`/`result` events (https://antigravity.google/docs/cli/headless/). The FAQ says wrapping `agy -p` in third-party apps "is not supported under consumer plans" (https://antigravity.google/docs/faq/).

## Scope
- `buildHeadlessCommand`: `agy -p <prompt> --output-format stream-json --mode <level>` plus `--model`, `--effort`, `--conversation`, `--print-timeout`.
- `createEventNormalizer` mapping to the stream-json shape `headless-manager.ts` consumes (pattern: `codex-headless-events.ts`).
- Soft-denied approvals (exit 0 with a stderr notice) become a warning on the run result, not silent success.
- Gate: available when `auth.type` is `gemini-api-key`, `agent-platform` or `oauth-business`, or `AGY_ADC_AUTH=true`; otherwise (personal or unknown) quick agents open as interactive terminal agents and headless-only Actions refuse with an explanation linking the FAQ. The gate is a setting whose default comes from #A1.
- `disallowedTools`/`noSessionPersistence`: map only to documented equivalents; otherwise record unsupported.

## Non-goals
- `--input-format stream-json` multi-turn headless (chat covers that).

## Acceptance
- Normalizer tests for every documented event and status; gate tests for each auth type; Actions refusal message.

## Proof
Unit tests with fake CLI; live run in #A17 with an API key or enterprise account if available.

<!-- issue key=A14 labels="enhancement,type:feature,area:main,area:shared,severity: MEDIUM" -->
# [MEDIUM] Antigravity in Annex, mobile, helpers and Dispatcher

Part of #E. Needs #A2, #A4.

## Problem
Remote and orchestration paths enumerate providers: remote history (`remote-session-history.ts:34`, `RemoteSessionHistory.tsx:52`), mobile refuses unknown ids with `orchestrator_unavailable`, helper routing presets and Auto candidates (`src/shared/helper-routing.ts:62,73,94`), Dispatcher default (`dispatcher-service.ts:748-751`) and desktop control off (`agent-system.ts:792`).

## Scope
- Annex desktop sends the descriptor list so phone and remote desktops show Antigravity agents without their own allowlists; remote session history for Antigravity sessions.
- Helpers: explicit `cli: 'antigravity-cli'` supported (same-project and cross-project); excluded from `cli: 'auto'` (no quota reader; headless gate).
- Dispatcher: Antigravity not offered as the Dispatcher CLI, because Antigravity ships a browser subagent and documents no per-session switch to turn it off (`desktopControlOffArgs` absent). Revisit when documented.
- Capacity tracking per descriptor.

## Non-goals
- Driving Antigravity's own `--remote-agent`, Remote Control or `/schedule`.

## Acceptance
- Mobile and remote desktop list, open and message an Antigravity agent (fake CLI); helper creation with explicit CLI works; Auto never picks it; Dispatcher picker hides it.

## Proof
Unit tests for routing and Annex payloads; existing Annex test harness.

<!-- issue key=A15 labels="enhancement,type:chore,area:main,area:shared,severity: LOW" -->
# [LOW] Antigravity telemetry, diagnostics and version policy

Part of #E. Needs #A2, #A4, #A12.

## Scope
- Telemetry enum values `antigravity-cli` (`clubhouse.orchestrator`, helper routing) and `antigravity_acp` (`c.chat.driver`), reviewed per the OTel spec; no prompt text, raw model ids outside existing rules, or auth type in exported data.
- Feedback diagnostics (`framebriar/feedback-diagnostics.ts:148`): include the CLI version, driver, and paths (not contents) of the Clubhouse `--log-file` and `~/.gemini/antigravity-cli/log/acp-*.log`.
- Version policy: terminal floor and ACP floor (1.5.8 proposed) with reasons from the changelog (ACP added 1.5.0; ACP Auto 1.5.4; context usage 1.5.8; Windows ACP startup fix); advisory tested max. Note `AGY_CLI_DISABLE_AUTO_UPDATE` exists but Clubhouse does not set it.
- Do not pass `--disable-telemetry` by default (it is the user's Antigravity setting); a later Clubhouse toggle may.

## Acceptance
- Telemetry attribute tests updated; version policy unit tests; diagnostics test.

## Proof
Unit tests.

<!-- issue key=A17 labels="type:chore,area:main,severity: HIGH" -->
# [HIGH] Antigravity real-login validation gates (deferred until a subscription is available)

Part of #E. Needs all other children. Deferred acceptance: nothing in this issue runs in CI or before an account exists.

## Problem
Fixtures are built from public docs. The items below can only be settled on a real binary, some on a signed-in account. Results gate removing `optIn`/experimental status.

## Gates
Token-free (binary installed, no prompt):
- V3 `agy` passes its environment to stdio MCP children (TUI and ACP).
- V4 a worktree `.git` file stops parent rule traversal.
- V6 ACP `initialize` capabilities on the pinned version; record a real handshake fixture.
- V10 MCP `tools/list_changed` handling (token-free probe method already used for other CLIs).

Signed-in:
- V1 apply the #A1 decision; confirm sign-in flow text.
- V2 which models the ACP session offers Clubhouse, per plan.
- V5 CLI `transcript.jsonl` line format.
- V7 workspace trust prompt in ACP sessions for a new worktree.
- V8 subagent reporting over ACP.
- V9 PTY paste timing.
- V11 business account (`oauth-business`): no `auto`, admin policies (if an account is available).
- V12 Windows ACP startup and spawn.

## Rules
- Use the user's own account, signed in by the user. No automation of login, no credential reads, no account switching.
- Each run records CLI version, OS, auth type, and result as `.txt` evidence (not `.log`) with hashes.
- Minimal prompts only; no load testing.

## Acceptance
- Each gate passed, failed with a filed follow-up, or explicitly waived by the maintainer.
- Fixtures updated where real shapes differ.
