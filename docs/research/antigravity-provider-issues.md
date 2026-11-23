# Antigravity provider: epic and child issue drafts

Published 2026-11-23: epic #3785, children #3786-#3804, linked as GitHub sub-issues. Each block between `<!-- issue ... -->` markers was one issue; numbers are substituted here and GitHub is authoritative from now on. Design reference for every issue: `docs/research/antigravity-provider-design.md` on branch `antigravity-provider-design/design-epic`.

Labels: every issue gets `antigravity-2026-11-23` (new dated batch label) plus the existing labels listed.

<!-- issue key=E labels="enhancement,epic,tracking,type:feature,area:main,area:renderer,area:shared,severity: MEDIUM" -->
# [MEDIUM] Epic: Antigravity CLI as a fourth provider (terminal, ACP chat, headless)

Add Google Antigravity CLI (`agy`) as a Clubhouse provider using only its publicly documented interfaces, and generalize the provider abstraction so a fourth provider does not need edits in ~35 files.

Design, evidence and capability matrix: `docs/research/antigravity-provider-design.md` (branch `antigravity-provider-design/design-epic`). Evidence snapshot 2026-11-23, CLI v1.5.12.

## Surfaces
- Terminal: the `agy` TUI in a PTY.
- Chat: `agy acp`, Agent Client Protocol v1 over stdio, which the ACP guide documents for any ACP client (https://antigravity.google/docs/ide/extensions/acp/). Driven by a restored, provider-neutral ACP driver (removed with legacy Copilot ACP in #2868, recoverable from `00c9534bb^`).
- Headless: `agy -p --output-format stream-json` (https://antigravity.google/docs/cli/headless/). Off until the eligibility decision in #3786, because the FAQ says wrapping `agy -p` in third-party apps is not supported on consumer plans (https://antigravity.google/docs/faq/) and no page positively documents it for other plans.
- Not used: the Python SDK `google-antigravity` (Python only; its docs cover API-key and Vertex/Enterprise auth only).

## Constraints
- Public docs only. No reverse engineering, undocumented formats (for example the `transcript.jsonl` line format), env vars or endpoints, no credential or keyring reads, no `clientInfo` spoofing, no account rotation.
- Clubhouse never writes `~/.gemini/**`. Workspace files are merged, snapshotted and restored; user configuration is preserved.
- No implicit fallback between chat, headless and terminal. Switching runtime is the person's explicit choice, and nothing is replayed.
- The Clubhouse MCP fails closed: an agent counts as connected only after the bridge authenticates with that launch's identity.
- Behind the experimental flag and a provider toggle; never the default provider.
- No paid prompts or live login in CI. Real-login checks are in #3802 and run when a subscription is available.

## Children (dependency order)
Phase 0, no subscription needed
- [ ] #3786 Record plan and usage eligibility statements, request clarification, decide defaults
- [ ] #3787 Provider descriptor: replace hard-coded provider id lists
- [ ] #3788 Fake `agy` CLI and fixtures

Phase 1, terminal
- [ ] #3789 Terminal provider `AntigravityCliProvider` (needs #3787, #3788)
- [ ] #3790 Model and effort discovery (needs #3789)
- [ ] #3791 Access ladder and execution policy mapping (needs #3789)
- [ ] #3792 Managed instructions, skills and custom agents (needs #3789)
- [ ] #3793 Clubhouse MCP bridge delivery and authenticated identity (needs #3789)
- [ ] #3794 Configuration preservation and inherited customizations (needs #3789; lands with #3792, #3793)
- [ ] #3801 Help, settings, first run and provider doc contract (needs #3789)

Phase 2, terminal status, sessions and lifecycle contract
- [ ] #3795 Hooks-based status, session id and resume (needs #3789, #3794)
- [ ] #3804 Chat driver lifecycle conformance suite (needs #3788; blocks #3796, #3797)

Phase 3, chat
- [ ] #3796 Restore a provider-neutral ACP chat protocol layer (needs #3788, #3804)
- [ ] #3797 Antigravity ACP chat driver (needs #3788, #3791, #3793, #3796, #3804)

Phase 4, headless
- [ ] #3798 Headless normalizer and eligibility gate (needs #3786, #3788, #3789, #3791)

Phase 5, integration
- [ ] #3803 Helper Auto eligibility and unknown-quota ranking as declared provider policy (needs #3787)
- [ ] #3799 Annex, mobile, helpers and Dispatcher eligibility gate (needs #3787, #3789, #3803)
- [ ] #3800 Telemetry, diagnostics and version policy (needs #3787, #3789, #3797)

Phase 6, subscription
- [ ] #3802 Real-login validation gates (required gates need #3786, #3787-#3797, #3799 baseline, #3800, #3801, #3803, #3804; optional gates need their feature; deferred acceptance)

## Acceptance for the epic
Required, cannot be waived: #3787, #3788, #3789, #3790, #3791, #3792 (except custom agents), #3793, #3794, #3795, #3796, #3797, #3800 (telemetry values and version floors), #3801, #3804, the baseline of #3799 (Annex, mobile and remote history, explicit helpers, capacity), the declared policy fields and the recorded Antigravity decision in #3803, the eligibility decision in #3786, and every gate marked required in #3802. Together these give an Antigravity agent in terminal and chat with managed instructions, skills and an authenticated Clubhouse MCP, on macOS, Windows and Linux, reachable from Annex and helpers, proven by fixtures in CI and by #3802 on a real account.

Optional, may be deferred with a recorded reason: #3798 (headless), the Dispatcher gate in #3799, actually enabling Antigravity for Auto in #3803, custom agents in #3792, the vendor clarification request in #3786, and the optional gates in #3802.

Existing providers' settings, agents, presets and telemetry values must be unchanged.

<!-- issue key=A1 labels="needs-decision,type:chore,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity: record plan and usage eligibility statements, request clarification, decide defaults

Part of #3785.

## Problem
Three public statements bear on how Clubhouse may launch `agy` (paraphrased; see the links for exact wording):
1. FAQ (https://antigravity.google/docs/faq/): accessing Antigravity through third-party software with an Antigravity login violates the Terms of Service and can lead to suspension; for third-party coding agents it recommends a Gemini Enterprise or Google AI Studio API key.
2. FAQ (same page): `agy -p` is meant for direct scripting and CI; wrapping `agy` in third-party agents or apps, or automating account rotation, is not supported under consumer plans.
3. ACP guide (https://antigravity.google/docs/ide/extensions/acp/): any ACP client can launch `agy acp`, which reuses credentials cached by an interactive sign-in.

Statement 2 only says what is not supported on consumer plans. No page positively documents headless wrapping for API-key, Agent Platform or Gemini Enterprise auth; treating those as allowed is an inference.

The docs also disagree on models for custom ACP clients: the ACP guide limits third-party models to named editors, while the CLI 1.5.1 changelog says every model is offered to every ACP client (https://antigravity.google/docs/changelog/).

## Scope
- Keep the paraphrases, links and read date in the Antigravity help page (#3801) and in this issue.
- Proposed follow-up, not authorized by publishing this issue: ask Google through a public channel (Antigravity feedback or support) how statements 1-3 apply to (a) an ACP client launching the user's own `agy acp`, (b) a terminal app hosting the user's `agy` TUI, (c) headless `agy -p` launched by a desktop app, per auth type. Sending it needs the maintainer's explicit authorization first, including who sends it and from which account. If sent, record the answer and date.
- Maintainer decision, recorded here:
  - ACP chat: proposed available behind the experimental flag for documented auth methods.
  - Terminal TUI: proposed available.
  - Headless: proposed off for every auth type until an answer or a maintainer ruling names the auth types it may run under.

## Non-goals
- Any legal conclusion beyond the documented text.
- Blocking phases 0-5. Code reads these defaults as settings (#3797, #3798).

## Acceptance
- Statements, links and the model discrepancy recorded in-repo with the date.
- Clarification request either sent after explicit authorization (linked, with the answer or "no answer by <date>"), or recorded as not authorized.
- Maintainer decision recorded for each runtime and auth type.

## Proof
The recorded decision, and the request link if one was authorized and sent. No code.

<!-- issue key=A2 labels="enhancement,type:chore,area:main,area:renderer,area:shared,severity: MEDIUM" -->
# [MEDIUM] Provider descriptor: replace hard-coded provider id lists before adding a fourth provider

Part of #3785. Blocks #3789, #3799, #3800, #3803.

## Problem
`OrchestratorId` is open (`src/main/orchestrators/types.ts:7`) but about 35 non-test files enumerate `claude-code`, `codex-cli` and `copilot-cli` by literal. A new provider silently degrades in each: Ask-only access (`src/shared/agent-access.ts:105-109`), no helper presets (`src/shared/helper-routing.ts:62,94`), no capacity tracking (`src/shared/handoff-capacity.ts:3,62`, `src/shared/helper-auto-budget.ts:2`), no remote history (`src/main/services/remote-session-history.ts:34`), missing glyph, colors, mascots and install link (`OrchestratorGlyph.tsx:5`, `orchestrator-colors.ts:7-9,46-48`, `SleepingMascots.tsx:209-211`, `SleepingAgent.tsx:61`, `FirstRun.tsx:21-23`, `HelperPresetsSection.tsx:30`), `other` in telemetry (`src/shared/telemetry/attributes.ts:328,608,633`; `knownCli` sets in `feature-events.ts:41`, `chat-telemetry.ts:84`, `agent-signals.ts:94,118`, `agent-telemetry.ts:62`, `session-telemetry.ts:20`, `spawn-telemetry.ts:30`), and chat labels (`chat-version-policy.ts:80-84`, `ChatHeader.tsx:11-14`, `src/shared/chat/provider-inventory.ts:15-16`). `supportsPositionalMission` falls back to `id === 'claude-code'` (`types.ts:386`).

## Scope
- A static `ProviderDescriptor` per built-in provider: id, names, short name, telemetry code, access levels per runtime, helper preset flag, Auto policy and quota kind (policy semantics in #3803), capacity tracking, remote-history eligibility, install docs URL, glyph and color keys, optional state-dir env. Shape in design section 6.1.
- Replace the literal lists above with descriptor lookups. Telemetry enums stay closed and reviewed; the descriptor supplies the value.
- Provider-specific behaviour (Codex TOML, Copilot hooks) stays where it is; this issue moves enumerations only.

## Related
- #2777 renames `OrchestratorId` to `ProviderId`; land in either order, but not both in flight.
- #384 provider parity suite can iterate the descriptor list.

## Non-goals
- Adding Antigravity (#3789). Any behaviour change for the existing three providers.

## Acceptance
- No non-test file outside `src/main/orchestrators/` enumerates all three provider ids for policy or display (a test enforces it).
- A test rebuilds every former list from descriptors and matches the old literal values.

## Proof
Full `npm test`, `npm run typecheck`, lint.

<!-- issue key=A3 labels="enhancement,test-coverage,type:chore,area:main,severity: MEDIUM" -->
# [MEDIUM] Fake `agy` CLI and fixtures for Antigravity tests (no tokens)

Part of #3785. Blocks #3789, #3796, #3797, #3798, #3804.

## Problem
There is no Antigravity binary in CI and no subscription. Every Antigravity code path needs a deterministic stand-in built from the public docs.

## Scope
- Extend `scripts/chat-fixtures/fake-cli.mjs` and `src/main/orchestrators/adapters/testing/fake-cli.ts` (see `docs/chat-fixtures.md`) with an `agy` personality:
  - `agy --version`: configurable version string.
  - `agy models`: slug list in the documented shape (https://antigravity.google/docs/cli/headless/).
  - `agy -p ... --output-format stream-json|json`: documented `init`/`step_update`/`result` examples, error, soft-deny and unknown-model exits.
  - `agy acp`: JSON-RPC per ACP v1 (https://agentclientprotocol.com/protocol/initialization, https://agentclientprotocol.com/protocol/session-setup): `initialize` with the documented `authMethods`, `session/new` success and `-32000`, `session/update` streams, `session/request_permission`, `session/cancel`, `session/load` with history replay, `resume`, `list`, `close`, `session/set_config_option` for model and thinking level, and a scripted prompt sent mid-turn that joins the running turn.
  - A TUI stub for PTY tests that echoes args, runs configured hooks, and exits on `/exit`.
- Fixtures are hand-built from documented shapes and labelled as such; none are presented as recordings of a real CLI.
- Vendor the ACP JSON schema from `@agentclientprotocol/sdk` at a pinned version (2.9.1 when drafted) with a CI diff check, like the Codex bindings.

## Non-goals
- Recording from a real account (#3802 may later add real handshake fixtures).

## Acceptance
- `CLUBHOUSE_TEST_CLI_BINARIES` can point `agy` at the fake in unit and E2E tests.
- The schema pin test fails on drift.

## Proof
Unit tests for each personality; schema diff test.

<!-- issue key=A4 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity terminal provider: `AntigravityCliProvider`

Part of #3785. Needs #3787, #3788.

## Problem
Clubhouse cannot launch `agy` as an agent.

## Scope
- `src/main/orchestrators/antigravity-cli-provider.ts` extending `BaseProvider` (`base-provider.ts:62-118`): `id: 'antigravity-cli'`, display "Antigravity CLI", short "AGY", badge Experimental. Registered after Codex so it is never the first-enabled default (`dispatcher-service.ts:748-751`). Hidden unless the experimental flag and provider toggle are on.
- Binary: `binaryNames ['agy']`; `getExtraBinaryPaths()` adds `~/.local/bin` and `%LOCALAPPDATA%\agy\bin`, the documented install locations (https://antigravity.google/docs/getting-started/). `checkAvailability` runs `agy --version` and applies the floor from #3800.
- `buildSpawnCommand`: `--model`, `--effort`, access flags from #3791, `--sandbox` from execution policy, `--conversation <id>` (or `-c`) for resume, optional `-i <mission>` (`--prompt-interactive`). `--add-dir` once #1724 adds `SpawnOpts.additionalDirs`; added folders also load their customizations (https://antigravity.google/docs/customization-discovery/). Flags per https://antigravity.google/docs/cli/reference/.
- `getExitCommand` `'/exit\r'`. Paste timing starts from the Copilot profile with quiescence; tuned in #3802.
- `conventions`: `configDir '.agents'`, `localInstructionsFile 'AGENTS.md'`, `skillsRoot '.agents/skills'`, `mcpConfigFile '.agents/mcp_config.json'`, `hooksFile 'hooks.json'`, `settingsFormat 'json'`, `permissionRules false`.
- Capabilities: `headless` from #3798's gate, `hooks: true` (#3795), `sessionResume: true`, `permissions: true`, `supportsPositionalMission: false`.
- Workspace trust: a new worktree prompts in the TUI. Do not write `trustedWorkspaces` (https://antigravity.google/docs/settings/); explain in help.
- `provider-integration.test.ts` describe block (spawn flags, resume, free agent, default permissions) and `registry.test.ts`.

## Non-goals
- Chat, headless, hooks (separate issues). Writing any `~/.gemini` file.

## Acceptance
- With the fake `agy`, a durable agent starts in a PTY with the expected argv on macOS, Linux and Windows CI.
- With `agy` absent, the provider reports unavailable with the install link and no agent is created.
- Off by default; no change for users who don't enable it.

## Proof
Unit and integration tests with the fake CLI; Windows `.exe` resolution test. Live start in #3802 (V9).

<!-- issue key=A5 labels="enhancement,type:feature,area:main,area:renderer,severity: MEDIUM" -->
# [MEDIUM] Antigravity model and effort discovery

Part of #3785. Needs #3789.

## Problem
Model pickers and `acceptsModel` need Antigravity's live model list. Headless exits non-zero on an unknown `--model` with no fallback (https://antigravity.google/docs/cli/headless/), so a stale static list breaks runs. Several models are scheduled for removal on 2026-11-30 (https://antigravity.google/docs/models/).

## Scope
- `modelFetchConfig` running `agy models` in the empty probe dir (`base-provider.ts:312-341`), parsed into `ModelInfo`. The static fallback is `default` only; no hard-coded slugs.
- Efforts: `low|medium|high|xhigh|max` "depending on the model" (headless page). Where the CLI does not report per-model efforts, offer the documented set and surface the CLI's rejection.
- `acceptsModel` true only for listed slugs.
- Chat models come from ACP config options (#3797), not this list.
- No `readPlanQuota`: there is no token-free documented quota read (`/usage` is interactive). Quota kind `unknown` in the descriptor; routing policy in #3803.

## Non-goals
- Filtering third-party models by client (the docs disagree, #3786). Show what the CLI reports.

## Acceptance
- The picker lists fake `agy models` output; probe errors set `liveError` and fall back without crashing.
- `peekModels` never spawns.

## Proof
Unit tests for normal, malformed and timed-out output. Live list in #3802 (V2).

<!-- issue key=A6 labels="enhancement,type:feature,area:main,area:shared,severity: MEDIUM" -->
# [MEDIUM] Antigravity access ladder and execution policy mapping

Part of #3785. Needs #3789. Used by #3797, #3798.

## Problem
Clubhouse's five levels (`src/shared/chat/capabilities.ts:32`) must map to Antigravity's documented modes, and an unknown provider currently gets Ask only (`src/shared/agent-access.ts:105-109`).

## Scope
- Mapping (https://antigravity.google/docs/cli/reference/, https://antigravity.google/docs/cli/modes/, https://antigravity.google/docs/permissions/):
  - `plan`: `--mode plan` / ACP `plan`
  - `ask`: default mode (`toolPermission` default `request-review`)
  - `auto_edit`: `--mode accept-edits` / ACP `accept-edits`
  - `auto`: `--mode auto` / ACP `auto`, only where offered (needs the terminal sandbox; macOS/Linux v1.3.5+, Windows v1.4.4+; not for business or enterprise accounts)
  - `full_access`: `--dangerously-skip-permissions` (a process flag; chat needs a restart)
- Descriptor access levels (#3787): all five for terminal and chat, with `auto` hidden when the account is business/enterprise or the type is unknown (read-only from `auth.type`).
- Execution policy: `--sandbox` when the agent's policy asks for one (`src/shared/execution-policy.ts:30` is Codex-only today; extend through the descriptor). Linux needs bubblewrap; refuse the sandboxed start with a reason when it is missing rather than running unsandboxed.
- Headless runs in `auto` by default since v1.5.7, so every headless launch passes `--mode` explicitly and never runs above the chosen level.
- UI note that the user's own `permissions.allow|ask|deny` in `~/.gemini/antigravity-cli/settings.json` still apply (Deny > Ask > Allow).

## Non-goals
- Writing permission rules into the user's `settings.json`.

## Acceptance
- Unit tests for argv per level and runtime; `auto` absent for business accounts and older versions; headless always passes `--mode`; a missing sandbox refuses.

## Proof
Unit tests; live behaviour in #3802 (V11 optional).

<!-- issue key=A7 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity managed instructions, skills and custom agents

Part of #3785. Needs #3789.

## Problem
Managed agents deliver instructions and skills per provider (`src/main/services/managed-agents/delivery.ts:134,354,820,948`), with special cases for Claude and Copilot (`delivery.ts:482,692-695,707,851,1077-1090`). Antigravity reads `AGENTS.md`, `GEMINI.md`, `.agents/AGENTS.md`, `.agents/rules/*.md` and `.agents/skills/<name>/SKILL.md` from the workspace and each parent up to the repo root, cumulatively. It documents a 24,000-byte per-file limit and a 20,000-token aggregate rules budget but not what happens to content beyond them (https://antigravity.google/docs/rules/, https://antigravity.google/docs/skills/, https://antigravity.google/docs/customization-discovery/).

## Scope
- Managed block in `<worktree>/AGENTS.md` (the file Codex uses; one provider per agent, so no conflict). Do not create `GEMINI.md`.
- Size: if user text plus the managed block exceeds 24,000 bytes, refuse the start with the size and the fix. Never truncate user text. Never record over-limit instructions as delivered.
- A lossless split into `.agents/rules/*.md` (`trigger: always_on`) is allowed only after a test on the real binary shows the combined order (the docs say rules combine, not in what order); until then it is not built.
- Delivery receipt records "within per-file limit, aggregate budget unverified", since the user's own global rules count toward the 20,000-token budget.
- Skills in `.agents/skills/<name>/`, flat, reusing Codex's root and exclude logic.
- Custom agents (`.agents/agents/<name>.md` + `--agent <name>`): optional follow-up, not required for the epic.
- Parent traversal stop at a worktree `.git` file is checked in #3802 (V4); until then help says rules in the main checkout's parent folders may also load.

## Non-goals
- Editing user rules or skills in `~/.gemini`.

## Acceptance
- A managed Antigravity agent gets its instructions and skills in the documented locations; switching provider removes only Clubhouse-owned content.
- Over-limit composition refuses, with user text untouched.
- Codex delivery unchanged.

## Proof
Unit tests with a temp worktree, including a 24,001-byte case and a user file with custom text.

<!-- issue key=A8 labels="enhancement,type:feature,area:main,severity: HIGH" -->
# [HIGH] Antigravity: Clubhouse MCP bridge delivery and authenticated identity

Part of #3785. Needs #3789. Blocks #3797.

## Problem
Every agent gets the Clubhouse MCP. The bridge is a stdio server that reads `CLUBHOUSE_HOOK_NONCE`, `CLUBHOUSE_AGENT_ID` and `CLUBHOUSE_MCP_PORT` from its inherited environment (`src/main/services/clubhouse-mcp/injection.ts:460-470`). Antigravity reads MCP from `~/.gemini/config/mcp_config.json`, `<workspace>/.agents/mcp_config.json` and plugins; on a name collision the server already running keeps the name; unconfigured MCP tools run in Ask mode (https://antigravity.google/docs/mcp/, https://antigravity.google/docs/settings/). ACP clients can pass `mcpServers`; HTTP servers from the client need `--process-per-session` (https://antigravity.google/docs/ide/extensions/acp/). Whether `agy` passes its own environment to stdio MCP children is not documented.

## Scope
- Terminal: merge a `clubhouse` stdio entry into `<worktree>/.agents/mcp_config.json`; snapshot and restore via `config-pipeline.ts` (`:106,139`); add the file to `.git/info/exclude` when Clubhouse created it; keep all user entries and keys.
- Chat: pass the bridge in ACP `mcpServers` with explicit `env` (ACP makes `env` explicit); configured HTTP project servers only when `mcpCapabilities.http` is advertised, else a notice.
- Fail closed on identity: an agent counts as having the Clubhouse MCP only after the bridge has authenticated to Clubhouse with that launch's agent id and nonce within the start deadline. If it has not, the start is refused with the reason. A server answering under the name `clubhouse` is never trusted on its name.
- Fail closed on collisions: refuse the start when any readable config (global, workspace, project list) defines `clubhouse`. Plugin servers cannot all be enumerated from documented files, so the authenticated-connection check is the backstop.
- No nonce in argv, files or the spawn log. If V3 shows env is not inherited, the start fails closed. A per-launch nonce in the stdio `env` field of a workspace file is only a candidate: it needs a written threat model (local readers, sync tools, crash leftovers, git) and security review in a separate issue before anything is built.
- Clubhouse tool approvals appear as Antigravity permission requests; no pre-approval unless a documented workspace-scoped rule exists.
- `ignoresToolListChanged: true` until measured (V10).

## Non-goals
- Writing the global MCP config.

## Acceptance
- With the fake CLI: the workspace file gains the bridge entry with user entries unchanged; restore is byte-identical; ACP `session/new` carries the bridge.
- A fake server named `clubhouse` that does not authenticate leaves the agent refused, not connected.
- A configured `clubhouse` collision refuses before launch.

## Proof
Unit tests on merge and restore with user files (comments, BOM, extra keys); ACP request capture; impostor-server and collision tests. V3 and V10 in #3802.

<!-- issue key=A9 labels="enhancement,type:feature,area:main,area:renderer,severity: MEDIUM" -->
# [MEDIUM] Antigravity configuration preservation and inherited customizations

Part of #3785. Needs #3789. Lands together with #3792 and #3793.

## Problem
Antigravity documents no config-dir override (no equivalent of `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `COPILOT_HOME`, `provider-profiles-removed.ts:33-37`). Every Antigravity agent shares the user's `~/.gemini` rules, skills, hooks, MCP servers, permissions and account, all loaded cumulatively.

## Scope
- Clubhouse never writes under `~/.gemini`. Reads are limited to `~/.gemini/antigravity-cli/settings.json` (`auth.type`, `modelProvider`, `agentMode`, `gcp`) and `~/.gemini/config/mcp_config.json` (the #3793 collision check). Both are BOM- and comment-tolerant. An unparsable settings file means "unknown" for eligibility; an unparsable MCP config means the collision check cannot pass, so the start is refused with the reason.
- Workspace writes (`AGENTS.md` block, `.agents/skills/*`, `.agents/mcp_config.json` entry, `.agents/hooks.json` named hooks) are merged, snapshotted, restored and excluded. User custom text is preserved byte-for-byte.
- Agent settings view: a read-only list "Also loaded from your Antigravity profile" with the documented global paths that exist.
- Do not use the undocumented `GEMINI_HOME`.

## Non-goals
- Per-agent Antigravity profiles or accounts (#2749 removed profiles).

## Acceptance
- A test proves no code path writes under a temp `HOME/.gemini`.
- User workspace files are identical after start/stop cycles and after crash recovery.

## Proof
Unit tests with a temp HOME; crash-restore through `config-pipeline` recovery.

<!-- issue key=A16 labels="documentation,enhancement,type:chore,area:renderer,severity: MEDIUM" -->
# [MEDIUM] Antigravity help, settings, first run and provider doc contract

Part of #3785. Needs #3789.

## Problem
The provider doc contract test hard-codes three providers (`src/main/orchestrators/provider-doc-contract.test.ts:49-53`) against the matrix in `src/renderer/features/help/content/settings-orchestrators.md:43-49`. Users need install, sign-in and limitation guidance.

## Scope
- An Antigravity column in the help matrix and the contract test.
- Help page: install link (https://antigravity.google/docs/getting-started/); sign in by running `agy` once in a terminal (or `agy acp --login` over SSH); workspace trust prompt; what each runtime needs and why headless may be unavailable; `auto` unavailable for business accounts; inherited `~/.gemini` customizations; the #3786 statements paraphrased with links.
- Settings: provider toggle with the Experimental badge; first-run install link via the descriptor.
- API-key use requires the person to set `"modelProvider": "gemini"` and export `GEMINI_API_KEY` themselves (https://antigravity.google/docs/install/); Clubhouse does not edit that file.

## Non-goals
- Promises about models, quotas or plan eligibility.

## Acceptance
- The contract test covers four providers; help renders; copy follows the UI style rules.

## Proof
Unit and renderer tests.

<!-- issue key=A10 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity terminal status via hooks, session id capture and resume

Part of #3785. Needs #3789, #3794.

## Problem
Terminal agents need tool and stop status and a native session id for resume. Antigravity prints no documented session id to the PTY; documented hook payloads carry `conversationId`. Hooks live in `.agents/hooks.json` as a map of named hooks with `SessionStart`, `PreToolUse`, `PostToolUse` and `Stop` (https://antigravity.google/docs/hooks/). `SessionCapable.extractSessionId` (`types.ts:309`) assumes PTY text, and `readSessionTranscript` assumes a parseable file.

## Scope
- `HookCapable`: merge a `clubhouse-status` named hook into `.agents/hooks.json` calling the existing curl hook command (`shared.ts:485`); strip it on stop (`config-pipeline.ts:242,288`).
- `parseHookEvent`: `PreToolUse` to `pre_tool`; `PostToolUse` to `post_tool`, or `tool_error` when `error` is set; `Stop` to `stop` with `terminationReason`; `SessionStart` records `conversationId`.
- Session contract change for all providers: a hook-sourced session id path alongside `extractSessionId`, and `readSessionTranscript` may return "unsupported".
- Resume with `--conversation <id>`; `-c` only when no id was captured, and the UI says which was used.
- No scanning of `~/.gemini/antigravity-cli/brain/` and no parsing of `transcript.jsonl`; their layout and line format are not documented. Terminal transcripts show "not available for this provider" unless Google publishes a schema.
- Clubhouse status hooks return `allow` and never block a tool; timeouts stay short.

## Non-goals
- Permission-request hooks (not documented for Antigravity).

## Acceptance
- Documented payload examples produce status events and a stored session id; resume argv uses it; the hook file is restored after stop.

## Proof
Unit tests with documented payloads; live check in #3802.

<!-- issue key=A11 labels="enhancement,type:feature,area:main,area:shared,severity: HIGH" -->
# [HIGH] Restore a provider-neutral ACP chat protocol layer

Part of #3785. Needs #3788, #3804. Blocks #3797.

## Problem
Clubhouse removed its ACP driver with legacy Copilot ACP in #2868 (`00c9534bb`). The research doc kept ACP as the event vocabulary and the long-tail driver (`docs/structured-chat-research.md:441-450`), and the event model is already ACP-named (`src/shared/chat/events.ts:8`). Chat driver ids are a closed list (`src/shared/chat/capabilities.ts:16-21`), and selection special-cases Copilot (`src/main/services/agent-runtime/chat-drivers.ts:19-32`, `chat-spawn.ts:139-148`, `chat-runtime-settings.ts:61,90`).

## Scope
- Recover `acp-client.ts`, `acp-session.ts`, `acp-updates.ts`, `acp-chat-mapper.ts`, `acp-schema.ts`, `acp-capabilities.ts` and `acp-chat-driver.ts` from `00c9534bb^:src/main/orchestrators/adapters/` into `src/main/chat/acp/`, removing every Copilot branch. `AcpLaunchSpec` (`acp-chat-driver.ts:23` in that tree) becomes the only provider hook.
- Update to the ACP schema pinned in #3788 (the removed code targeted schema v1.26.0): `session/resume`, `session/close`, `session/list`, `session/set_config_option`, elicitation, `$/cancel_request`, `additionalDirectories`.
- Capabilities come from `initialize`; static claims come only from the launch spec.
- Driver selection treats a provider's ACP driver as an ordinary candidate (Copilot branches move to descriptor data). Selecting chat never implies a silent terminal fallback for providers that opt out of it.
- Carry forward the fixes for #2191 (activity after the prompt reply) and #2401 (resume test timing).
- Passes #3804.

## Non-goals
- Re-adding Copilot ACP.

## Acceptance
- The generic driver passes the fake ACP flows and #3804 with no provider-specific code.
- The kill-switch denylist validation accepts the new id(s).

## Proof
Unit and fake-CLI flow tests (`chat-fake-cli-flows.test.ts` pattern); schema pin test.

<!-- issue key=A12 labels="enhancement,type:feature,area:main,area:renderer,severity: HIGH" -->
# [HIGH] Antigravity ACP chat driver

Part of #3785. Needs #3788, #3791, #3793, #3796, #3804.

## Problem
Native chat for Antigravity over `agy acp` (https://antigravity.google/docs/ide/extensions/acp/, https://antigravity.google/docs/cli/acp/).

## Scope
- Launch spec: `agy acp --log-file <clubhouse log dir>`; `--sandbox` and `--dangerously-skip-permissions` from #3791; `--add-dir` after #1724; `--process-per-session` only when an HTTP MCP server must be passed. Working directory is the agent worktree.
- Driver id `antigravity_acp`, `optIn: true` until the required #3802 gates pass.
- Capabilities from `initialize` plus documented behaviour: steer (a prompt mid-turn steers the running turn), interrupt (`session/cancel`), questions (elicitation when advertised), slash commands, `usage: 'context'` (1.5.8+), live model and thinking-level switch through `session/set_config_option`, images and embedded resources per `promptCapabilities`, `login: 'terminal'`, `systemPrompt: false`, `subagents: 'ids_only'` until V8. History from `session/load` replay.
- Modes from #3791; `liveLevels` excludes `full_access`.
- Auth: `needsLogin` and `loginHint` on `-32000` ("Run `agy` in a terminal to sign in", or `agy acp --login` over SSH). Clubhouse does not call `authenticate` for OAuth methods and does not inject `GEMINI_API_KEY`.
- No implicit terminal fallback. On a start failure the agent shows the reason with "Retry chat" and "Open in terminal"; the unsent first message stays in the composer and is not replayed. After a prompt was accepted, the turn settles as failed only when the provider reports a failure. A lost connection or any other ambiguous outcome settles as unknown. Either way the known work (tool calls, edits, messages) stays in the transcript and the prompt is never retried automatically.
- `clientInfo` name and title are Clubhouse with the app version; never another client's identity.
- Models exactly as offered by the session's config options.
- Chat version policy entry (`chat-version-policy.ts`): floor from #3800; tested max advisory.
- Chat header label and driver picker entry.
- Workspace trust in ACP sessions handled if it arrives as a question or permission (V7).

## Non-goals
- Third-party model access decisions (#3786). Headless.

## Acceptance
- Passes #3804 against the fake CLI.
- Fake-CLI flows: start, stream, tool call with diff, permission allow and deny, question, cancel mid-tool, steer, model switch, resume after restart, auth-required with hint and no fallback, Windows `.exe` spawn.
- No regression in other drivers.

## Proof
Fake-CLI tests and a chat E2E spec added to an explicit E2E job list; real-login QA in #3802.

<!-- issue key=A13 labels="enhancement,type:feature,area:main,severity: MEDIUM" -->
# [MEDIUM] Antigravity headless: stream-json normalizer and eligibility gate

Part of #3785. Needs #3786, #3788, #3789, #3791. Optional for the epic.

## Problem
Quick agents, Actions and one-off prompts use `HeadlessCapable` (`types.ts:252`, `agent-system.ts:867-968`, `headless-prompt.ts:106-120`). Antigravity documents `agy -p --output-format stream-json` with `init`, `step_update` and `result` events (https://antigravity.google/docs/cli/headless/). The FAQ says wrapping `agy -p` in third-party apps is not supported on consumer plans (https://antigravity.google/docs/faq/); no page positively documents it for other plans.

## Scope
- `buildHeadlessCommand`: `agy -p <prompt> --output-format stream-json --mode <level>` plus `--model`, `--effort`, `--conversation` and `--print-timeout`.
- `createEventNormalizer` to the stream-json shape `headless-manager.ts` consumes (pattern: `codex-headless-events.ts`).
- Soft-denied approvals (exit 0 with a stderr notice) become a warning on the run result, never silent success.
- Gate: off for every auth type by default. Enabled only for auth types listed by the #3786 decision, read from `auth.type`, `modelProvider` and `AGY_ADC_AUTH`; unknown means not eligible.
- When the gate is closed: the request is refused with the reason. A quick agent may be started as an interactive terminal agent only if the person picks that option, which states that approvals then happen in the terminal. Actions that need headless refuse. No automatic conversion or replay.
- `disallowedTools` and `noSessionPersistence` map only to documented equivalents; otherwise they are reported unsupported.

## Non-goals
- `--input-format stream-json` multi-turn headless (chat covers it).

## Acceptance
- Normalizer tests for every documented event and status; gate tests for each auth type, including unknown; refusal and explicit-choice paths.

## Proof
Unit tests with the fake CLI. A live run in #3802 only if #3786 enables an auth type that is available.

<!-- issue key=A14 labels="enhancement,type:feature,area:main,area:shared,severity: MEDIUM" -->
# [MEDIUM] Antigravity in Annex, mobile, helpers, and the Dispatcher eligibility gate

Part of #3785. Needs #3787, #3789, #3803.

## Problem
Remote and orchestration paths enumerate providers: remote history (`remote-session-history.ts:34`, `RemoteSessionHistory.tsx:52`), mobile refusal of unknown ids (`orchestrator_unavailable`), helper presets (`src/shared/helper-routing.ts:62,94`), the Dispatcher default (`dispatcher-service.ts:748-751`) and the Dispatcher's no-desktop-control contract (#3185, `desktopControlOffArgs`, `agent-system.ts:792`).

## Scope
- Annex: the desktop sends the descriptor list so phone and remote desktops show Antigravity agents without their own allowlists; remote session history for Antigravity sessions.
- Helpers: explicit `cli: 'antigravity-cli'` for same-project and cross-project helpers. Auto policy comes from #3803.
- Dispatcher eligibility gate (optional for the epic):
  1. Write down the contract: the Dispatcher acts only through the Clubhouse MCP, never through the CLI's own computer use or browser control.
  2. List Antigravity's documented browser and desktop tools (hooks tool list, the `/browser` subagent, `browser_*` tools) and the documented controls for each: a workspace `PreToolUse` hook returning `deny`, `mcp(server/tool)` deny rules (which cover the `/browser` subagent's DevTools tools since a 1.5.x fix), sandbox network rules.
  3. Prove each control fails closed on the real binary (V14). The changelog records a Windows bug where a blocking hook was silently skipped, so this needs proof per platform.
  4. Decide. Until then Antigravity is not offered as a Dispatcher CLI, as a pending gate rather than a finding of incompatibility.
- Capacity tracking per descriptor.

## Non-goals
- Driving Antigravity's own `--remote-agent`, Remote Control or `/schedule`.

## Acceptance
- Mobile and remote desktop list, open and message an Antigravity agent (fake CLI); explicit helper creation works.
- The Dispatcher mapping and decision are recorded here; the picker reflects the decision.

## Proof
Unit tests for routing and Annex payloads; existing Annex harness; V14 evidence.

<!-- issue key=A15 labels="enhancement,type:chore,area:main,area:shared,severity: LOW" -->
# [LOW] Antigravity telemetry, diagnostics and version policy

Part of #3785. Needs #3787, #3789, #3797.

## Scope
- Telemetry enum values `antigravity-cli` (`clubhouse.orchestrator`, helper routing) and `antigravity_acp` (`c.chat.driver`), reviewed per the OTel spec. No prompt text, raw model ids outside existing rules, or auth type in exported data.
- Feedback diagnostics (`framebriar/feedback-diagnostics.ts:148`): the CLI version, driver, and the paths (not contents) of the Clubhouse `--log-file` and `~/.gemini/antigravity-cli/log/acp-*.log`.
- Version policy: terminal floor and ACP floor (1.5.8 proposed) with reasons from the changelog (ACP added in 1.5.0, ACP Auto in 1.5.4, context usage in 1.5.8, a Windows ACP startup fix); advisory tested max. `AGY_CLI_DISABLE_AUTO_UPDATE` exists, but Clubhouse does not set it.
- `--disable-telemetry` is not passed by default (it is the user's Antigravity setting); a later Clubhouse toggle may add it.

## Acceptance
- Telemetry attribute tests updated; version policy and diagnostics unit tests.

## Proof
Unit tests.

<!-- issue key=A17 labels="type:chore,area:main,severity: HIGH" -->
# [HIGH] Antigravity real-login validation gates (deferred until a subscription is available)

Part of #3785. Required gates need #3786, #3787, #3788, #3789, #3790, #3791, #3792, #3793, #3794, #3795, #3796, #3797, #3799 (baseline), #3800, #3801, #3803, #3804. Optional gates need only their feature: V14 needs the Dispatcher part of #3799; any headless run needs #3798. Deferred acceptance: nothing here runs in CI or before an account exists.

## Problem
Fixtures are built from public docs. The gates below need a real binary, and some need a signed-in account. Required gates decide whether `optIn` and the experimental status can be removed.

## Required gates (cannot be waived to close #3785)
Real binary, no prompt:
- V3: `agy` passes its environment to stdio MCP children, in the TUI and in ACP. The probe server sees only synthetic sentinel variables set for the test (for example `CLUBHOUSE_TEST_SENTINEL_A=1`) and records a boolean per allowlisted name. It never dumps the process environment and never runs with a real nonce, token or credential in its env. If inheritance fails, the bridge fails closed (#3793).
- V4: a worktree `.git` file stops parent rule traversal.
- V6: ACP `initialize` capabilities on the pinned version; record a real handshake fixture.
- V10: MCP `tools/list_changed` handling (token-free probe used for other CLIs).

Signed in:
- V1: the #3786 decision is applied; sign-in flow text confirmed.
- V2: which models the ACP session offers Clubhouse, per available plan.
- V5: ACP `session/load` history replay is enough for the chat transcript. The undocumented `transcript.jsonl` is not parsed whatever this shows.
- V7: workspace trust prompt in ACP sessions for a new worktree.
- V9: PTY paste timing.
- V12: Windows ACP startup and spawn.
- V13: steering, cancel, permission and disconnect settlement on the real server match #3804.

## Optional gates (may be deferred with a reason)
- V8: subagent reporting over ACP.
- V11: business account (`oauth-business`): no `auto`, admin policies, if an account is available.
- V14: documented browser and desktop controls fail closed (Dispatcher gate in #3799).

## Rules
- Use the person's own account, signed in by them. No automated login, credential reads or account switching.
- Each run records CLI version, OS, auth type and result as `.txt` evidence (not `.log`) with hashes. Evidence never contains environment dumps, tokens, nonces, keys or prompt content beyond the minimal test prompt.
- Minimal prompts only; no load.

## Acceptance
- Each required gate passed, or failed with a filed fix that then passes.
- Each optional gate passed, failed with a follow-up, or deferred with a reason.
- Fixtures updated where real shapes differ from the documented ones.

<!-- issue key=A18 labels="enhancement,needs-decision,type:feature,area:main,area:shared,severity: MEDIUM" -->
# [MEDIUM] Helper Auto eligibility and unknown-quota ranking as declared provider policy

Part of #3785. Needs #3787. Blocks the helper part of #3799.

## Problem
`cli: 'auto'` picks among `AUTO_CANDIDATE_PROVIDERS` (`src/shared/helper-routing.ts:73`) and ranks by `readPlanQuota`. Copilot has no quota reader and is still a candidate, ranked last behind even low and unmeasured providers (`helper-routing.ts:70-72`, #3279). That policy lives in literals and comments rather than in the provider contract, so a new provider like Antigravity (no token-free quota read, no documented headless eligibility on consumer plans) has no stated policy.

## Scope
- Descriptor fields (#3787): `auto: 'candidate' | 'opt_in' | 'excluded'` and `quota: 'reader' | 'unknown'`, with documented ranking: providers with readings by remaining quota, then `unknown`, preserving today's Copilot behaviour exactly.
- Auto only starts a provider in a runtime that provider's gates allow (terminal or chat for Antigravity; headless only if #3798's gate is open).
- Decision for Antigravity's initial value, recorded here: proposed `opt_in` (off unless the person enables it in helper settings), as a starting point to revisit after #3802, not a conclusion that Antigravity is unsuitable.
- Settings UI shows why a provider is ranked where it is (for example "quota unknown").

## Non-goals
- Inventing a quota read from interactive `/usage` output or any undocumented source.

## Acceptance
- Table-driven tests: existing three providers rank exactly as today; an `unknown`-quota `candidate` ranks last; `opt_in` is skipped unless enabled; `excluded` never chosen.
- Decision recorded.

## Proof
Unit tests on `helper-routing` and `helper-auto-policy`.

<!-- issue key=A19 labels="enhancement,test-coverage,type:feature,area:main,area:shared,severity: HIGH" -->
# [HIGH] Chat driver lifecycle conformance suite (receipts, settlement, retries)

Part of #3785. Needs #3788. Blocks #3796, #3797.

## Problem
Receipt, settlement and retry semantics are spread across `chat-runtime.ts` and each driver, with no driver-independent test. #3782 demonstrates the risk with a synthetic reproduction: the runtime keeps one pending token per prompt receipt and retires one per `turn_started`, so two accepted submissions that join one native turn leave a token behind and later work queues with nothing to drain it. Incident evidence there is compatible with this mechanism but is not proven to be its historical cause. Antigravity's ACP server documents exactly that shape: a prompt sent mid-turn steers the running turn instead of starting a new one (https://antigravity.google/docs/ide/extensions/acp/). Its changelog also records past races in cancel, close and late `session/update` delivery (https://antigravity.google/docs/changelog/).

## Scope
A conformance suite that any `ChatDriver` runs against a scripted fake (the #3788 ACP personality, the fake chat driver, and the existing drivers where their fakes allow):
- Receipts: pending vs started vs settled for each accepted submission, including two submissions sharing one native turn (steer) and a submission arriving between turns. Every receipt settles exactly once.
- Stop and cancel: settle to the outcome the provider actually reports (cancelled, completed, failed). If it reports nothing (exit, disconnect), the outcome is unknown; Clubhouse never fabricates a provider completion. Open tool calls and pending permissions or questions are closed in Clubhouse as cancelled when the provider confirms it, otherwise as abandoned with the outcome unknown.
- Permissions and questions: answered, answered elsewhere, timed out, and outstanding when the process exits or disconnects; none left blocking later turns.
- Disconnect and crash: unknown outcomes stay unknown, not reported as delivered, completed or failed; known work is kept.
- Stale generations: events or results from an earlier session, process or turn after restart, resume or `session/load` are ignored or attributed correctly.
- Bounded streams: limits on event queue, text and tool output size, with a visible truncation notice; no unbounded memory.
- No duplicate side effects: a submission whose delivery is unknown is never retried automatically.
- Settlement schemas and replay policy stay as they are; the suite documents them as the contract.

## Non-goals
- Fixing #3782 itself (tracked there). The suite adds the shared-turn case so new drivers can't regress it, marked expected-fail for drivers that currently fail it until #3782 lands.

## Acceptance
- The suite runs in CI for the fake driver and the generic ACP driver, and is required for #3797.
- Contract written in `src/shared/chat/README.md`.

## Proof
Unit tests; full `npm test`, typecheck and lint.
