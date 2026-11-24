# Antigravity provider: acceptance ledger

Epic #3785. Started 2026-11-24 by the integration owner (`antigravity-integration`). Updated with each integration milestone. Nothing on this page has run against a real `agy` binary or a signed-in account.

Each row keeps four kinds of status apart:

- **Source**: code exists on a branch.
- **Fixture**: proven against the fake `agy` (#3788) or a scripted stand-in, built from public docs.
- **CI**: proven by a hosted Validate run on the exact head. "Not run" until a reviewed PR exists.
- **Real**: proven on a real binary or account (#3802). Fixtures are never counted here.

An experimental implementation behind a default-off flag is not epic completion. The epic closes only when every required row is complete in every column that applies, including **Real** for the #3802 gates.

## Children

| Issue | Required | Source | Fixture | CI | Real | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| #3786 eligibility decision | Yes (recorded decision) | n/a | n/a | n/a | **Open**: user decision requested | Interim defaults: terminal and ACP behind the opt-in flag, off. Headless, Auto and Dispatcher off. Vendor clarification not authorized, not sent. |
| #3787 descriptors | Yes | Generic: landed (#3807). Antigravity delta: on branch | Generic: landed. Delta: unit | Generic: landed. Delta: not run | n/a | The generic contract landing is not Antigravity acceptance. |
| #3788 fake `agy` | Yes | d744d187a QA-approved (test-only), composed | | Not run | n/a | Document-derived; never presented as recordings. |
| #3789 terminal provider | Yes | Seam 6984704eb; M2 in progress | Unit only; fake-CLI spawn pending H1 | Not run | **Open**: V9 | Flag-gated; registered last; excluded from first-run detection and the Dispatcher default. |
| #3790 models | Yes | `agy models` parse; default-only fallback | Unit | Not run | **Open**: V2 (chat models) | Effort is part of the slug in the documented list; no per-model efforts invented. |
| #3791 access | Yes | Plan / Ask / Accept edits / Full access; Auto refused | Unit | Not run | V11 optional | Clubhouse sandbox/approval policies refused (no verified mapping). |
| #3792 instructions, skills | Yes (custom agents optional) | In progress (H3) | | Not run | **Open**: V4 | 24,000-byte refusal propagates before spawn (typed ManagedStartRefused). |
| #3793 MCP bridge identity | Yes | H2 f7ef QA-approved source, composed | | Not run | **Open**: V3, V10 | Decision: start refused unless the bridge authenticates with the launch nonce. Risk: if `agy` doesn't start stdio MCP children eagerly, every start is refused until V3 shows otherwise. |
| #3794 config preservation | Yes | In progress (H2) | | Not run | n/a | Never writes `~/.gemini`; allowlisted read-only fields only. |
| #3795 hooks, session id, resume | Yes | WIP: receipt-backed hook member and restore composed; pending review | Unit (documented payloads) | Not run | **Open**: real hooks on macOS/Linux; Windows hooks | Hooks are POSIX only until the Windows hook shell is documented or measured. Windows terminal status and hook-sourced resume are an open required-platform item, not done. |
| #3796 neutral ACP layer | Yes | Generic: landed (#3809). Antigravity use: H4 | Generic: landed | Generic: landed | n/a | Registration gates below. |
| #3797 ACP driver | Yes | H4 successor ef40cf1ed composed; not registered | | Not run | **Open**: V5, V6, V7, V12, V13 | Not registered until gates 2 and 3 close. |
| #3798 headless | Optional | Not started | | | | Off for every auth type until #3786 names one. |
| #3799 Annex, mobile, helpers, capacity | Baseline required; Dispatcher optional | Dispatcher refusal and default exclusion done | Unit | Not run | | Capacity needs a peer-compatible wire design (below) before `capacityTracked` changes. |
| #3800 telemetry, version floors | Yes | In progress (H5) | | Not run | n/a | ACP floor 1.5.10 (verbatim changelog evidence); tested max unset. CLI version and log paths: safe diagnostic design or a retained gap, not dropped. |
| #3801 help, doc contract | Yes | In progress (H5) | | Not run | n/a | |
| #3803 Auto policy | Yes (fields + recorded decision) | Generic policy landed (#3807); Antigravity `opt_in`, no presets | Unit | Not run | n/a | With no presets, Auto never considers Antigravity. |
| #3804 lifecycle suite | Yes | Generic: landed (#3808). Antigravity subject: H4 | Generic: landed. Antigravity: pending | Generic: landed | V13 | |

## ACP registration gates (from #3809)

| Gate | Status | Closing evidence required |
| --- | --- | --- |
| 1. Deterministic stdio direct guard | Closed (#3809) | |
| 2. Windows real-process stop-reading liveness | **Open** | A real-process control where an established session stops reading stdin while it keeps running. Interrupt returning is kept separate from turn settlement, and close-bounded liveness from automatic pipe failure. Needs a native Windows run (hosted `windows-latest` with parent authorization, or a Windows host). A stub is not proof. A child that never initialized does not satisfy it. |
| 3. Effort change when no model option is offered | **Open** | Decision: optional `setEffort` path end to end, current effort reported as an additive `session_info.effort`. Implemented in H4 source (ef40cf1ed); closes only when its tests pass on the composed head and review accepts it. Phone notice undelivered (above). |

No prompt timeout is introduced. An agent that never answers keeps its turn until the person stops it.

## Validation gates (#3802)

All need a real binary. Those marked "signed in" also need the person's own account, signed in by them. None runs in CI.

| Gate | Required | Needs | Status | Token-free probe or minimal check |
| --- | --- | --- | --- | --- |
| V1 eligibility applied, sign-in text | Yes | Signed in | **Blocked**: #3786 decision, account | Read the help and first-run text on the build; confirm the recorded decision is what ships. |
| V2 models offered over ACP | Yes | Signed in | **Blocked**: account | `initialize` + `session/new` only; record the `configOptions` model values. No prompt. |
| V3 env inheritance to stdio MCP children | Yes | Binary (no prompt; TUI start may need sign-in) | **Blocked**: binary | Probe stdio MCP server, configured in a throwaway workspace `.agents/mcp_config.json`, that records one boolean per allowlisted synthetic variable (`CLUBHOUSE_TEST_SENTINEL_A=1`). Never dumps env, never runs with a real nonce. Run once from the TUI and once via ACP `mcpServers`. Also record whether the child starts at session start or only on first tool use. |
| V4 `.git` file stops rule traversal | Yes | Binary; may need sign-in | **Blocked**: binary | Fixture tree: parent folder with an `AGENTS.md` sentinel rule, worktree with a `.git` file. Token-free only if the CLI documents a way to list loaded rules. Otherwise the check needs one minimal prompt on a signed-in account: a conditional proposal that runs only with real-account authorization. |
| V5 `session/load` history replay | Yes | Signed in | **Blocked**: account | One minimal prompt, then `session/load`; compare replayed `session/update` with what was shown. `transcript.jsonl` is never parsed. |
| V6 `initialize` capabilities | Yes | Binary | **Blocked**: binary | `agy acp`, send `initialize` only, record the response as a real handshake fixture. No sign-in expected (spec puts auth after initialize). |
| V7 workspace trust in ACP | Yes | Signed in | **Blocked**: account | `session/new` in a fresh worktree; record whether trust arrives as a question, a permission or an error. |
| V9 PTY paste timing | Yes | Signed in | **Blocked**: account | Paste multi-line text into a TUI session; tune the quiescence profile. |
| V10 `tools/list_changed` | Yes | Binary | **Blocked**: binary | Existing token-free MCP probe (`reference_mcp_list_changed_by_cli`). |
| V12 Windows ACP startup and `.exe` spawn | Yes | Windows, signed in | **Blocked**: Windows host, account | `agy acp` initialize + `session/new` on Windows. |
| V13 steering, cancel, permission, disconnect | Yes | Signed in | **Blocked**: account | The #3804 scenarios with minimal prompts. Records the real answer order for a mid-turn prompt (the steer-union assumption is disclosed until then). |
| V8 subagents over ACP | No | Signed in | Deferred | |
| V11 business account | No | Enterprise account | Deferred | |
| V14 browser controls fail closed | No (Dispatcher optional) | Binary | Deferred | Dispatcher stays refused. |

## Required machine checklist (for #3802, not run)

- macOS machine with `agy` installed by the person from the documented installer, at or above the ACP floor (1.5.10).
- The person signs in themselves by running `agy` once. Clubhouse never automates sign-in, reads credentials or switches accounts.
- A Windows 10/11 machine for V12 and gate 2, same rules.
- A Linux machine with bubblewrap, if sandbox behaviour is checked.
- A Clubhouse build from the reviewed head with the `Antigravity CLI provider` experimental flag on.
- Evidence recorded as `.txt` with hashes: CLI version, OS, auth type (closed value), result. Never environment dumps, tokens, nonces, keys or prompt content beyond the minimal test prompt.
- No load, no retries beyond the single minimal prompt per gate.

## Capacity wire compatibility (#3799 baseline)

Design: the one-release negotiated option from the independent review (`qa-antigravity-capacity-design-review/review.md`, sha256 `9a385d16896f0549bf9b91492fbd8e81ee2ea6375d150656240a16f6d1f690ea`). The earlier staged two-release draft was rejected there and is withdrawn.

- `CAPACITY_WIRE_REQUIRED` freezes today's three keys in their wire order, apart from the tracked set.
- Reader: every required key must be a valid availability. Another tracked key must be valid when present (a malformed known value refuses the response) and reads `unknown` when absent. Up to 32 unknown extra keys are ignored and never copied. The online/offline top-level key checks are unchanged.
- New control feature `capacity-providers`. Older peers drop it in `hello`. Agreement is per link and read per response; a reconnect renegotiates.
- Responder: the `{}` request body is unchanged. The local sample keeps every tracked provider. The answer carries them all only when the requesting machine's current control link agreed the feature, checked after sampling; otherwise exactly the legacy keys.
- Antigravity is `capacityTracked`. With no quota reader its value is `unknown`.

Status: source and unit proof on `antigravity-integration/provider` (commit 525f9b578). Tests include an old-parser fixture copied from `d2b89cf9f` that accepts every non-agreed response and refuses a full one, reader tables, responder shape with and without the feature and after a lost link, and `hello` agreement with an old offer and after close. Not yet independently reviewed as implemented; no CI.

## Open items outside the gate tables

- **Real-build Clubhouse MCP authentication (#3793), required.** V3 (synthetic env booleans, eager child start) cannot by itself show that a real launch's bridge authenticates with that launch's nonce before the fence deadline. A separate check on a real build is required: an Antigravity agent starts and is marked connected only after the bridge authenticates. It must not log the nonce, and it needs the person's existing authorization for the app and account actions. Until it passes, #3793 is not complete, whatever synthetic inheritance and fixture nonce tests show. The fence deadline (60 s) is unmeasured.
- **Hooks merge (#3795).** Clubhouse's hook is a receipt-backed member of `.agents/hooks.json` (workspace-json), restored by receipt in config-pipeline. Pending independent review of the composed source. Windows hooks are off (hook shell undocumented); Windows terminal status and hook-sourced resume stay an open required-platform item.
- **Phone contract notice.** The additive `session_info.effort` field and the model-optional `chat.setModel` were sent to the phone owner (Clubhouse-Go-Orchestrator) and were NOT DELIVERED because that agent is asleep. Cross-client review is not complete.
- **Diagnostics (#3800).** CLI version and log paths in a feedback report need new attributes in the private diagnostics contract. This is retained as a gap. A local, unwired helper exists; help tells the person what to attach.
