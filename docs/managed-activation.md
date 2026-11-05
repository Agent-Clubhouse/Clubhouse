# Managed activation backend

This is a bounded backend slice of #2739 and #2819. It does not complete either issue or enable the Builder UI to activate an agent. The main-only API is not registered with IPC, agent tools, or the renderer. No release, installation, real-provider prompt, authentication test, or native instruction-load proof accompanies this change.

## Explicit adoption

A trusted local main-process caller calls `previewManagedActivation({projectPath, agentId, expectedRevision, adoption, projectId?})`, then `adoptManagedActivation(agentId, preview.token)`. `BaseAdoption` is required; no content, structure, base or project policy is chosen by this backend. The preview shows exact literal composer bytes as **Appended managed instructions**, says ambient CLAUDE.md/provider instructions are additional context, and lists effective namespaced skill names. It does not rewrite references to unqualified skill names.

The token binds delivery semantics, exact catalog plan, workspace identity, explicit policy, receipt revision and installed CLI evidence. Commit and launch reject a selected binary changing from A to B even if A remains installed unchanged. Adoption freezes and retains the saved composition, without starting an agent. Later catalog changes do not change that snapshot. Unresolved structure continues to use the planner's last accepted valid structure.

`unassignManagedActivation(agentId, expectedRevision)` drops future references. It does not stop a running agent, rewrite a generation, remove any files, or release receipt pins. Receipt history, published private generations, interrupted private staging and revision pins are retained. There is no retention/cleanup UI or cleanup policy in this slice.

## Supported delivery boundary

Only local macOS, Claude Code, an existing isolated durable-agent worktree and an explicitly fresh terminal start are admitted. An installed, absolute, resolved CLI path must return an admitted version and advertise both `--append-system-prompt-file` and `--plugin-dir` in `--help`. These commands provide flag evidence only, with no model/auth/quota handshake. The provisional 2.1.316 filter is a conservative admission range matching the repository's current Claude baseline, not a feature-introduction fact or SDK upgrade assumption. Version alone never enables delivery. Tests use fake CLI fixtures; a real installed CLI has not been validated by this PR.

Capability identity binds canonical path, device/inode, size, timestamps and SHA-256 bytes. It is rechecked at adoption and against the actual built command immediately before PTY creation. The command uses that resolved absolute binary. Unknown/older versions, unsupported flags, Linux, Windows, other providers, chat, resume, native agent overrides, launch wrappers, command prefixes and additional `systemPrompt` text fail closed. No driver/provider/fresh-session fallback is introduced.

Existing enabled Clubhouse hooks, MCP, helpers/orchestration or legacy Clubhouse materialization are incompatible. The backend refuses them rather than changing settings, dropping permissions or skipping required MCP delivery. A supported fixture has these choices already disabled by the person. The managed terminal path does not snapshot, inject or restore hook/MCP files and does not call legacy materialization. It does not enable bare mode, alter settings sources or suppress ambient instructions.

A generation is built solely from frozen catalog payloads under private Clubhouse app storage, never a repository-controlled output path. `instructions.txt` contains exact UTF-8 composer bytes, including `@@` tokens. A skills-only plugin contains a generated manifest and the selected immutable bundles; its stable per-agent namespace gives names such as `clubhouse-agent-<id hash>:review`. No plugin MCP, hooks, agents, settings or dependencies are generated. Operational or ambiguous skill frontmatter and provider dynamic command interpolation are refused without stripping or rewriting payloads. The accepted frontmatter is a deliberately narrow grammar for plain, single-line `name` and `description` fields.

The provider documents session file append and session plugin delivery in its [CLI reference](https://code.claude.com/docs/en/cli-reference). The [skills reference](https://code.claude.com/docs/en/skills) describes namespaced plugin skills. These documents establish intended flag semantics; they do not prove authorization, policy acceptance, visibility or actual loading in a launched session.

## Receipts and failures

Desired and prepared state commits before generation writes. Durable pending intent precedes private staging. A crash leaves an inert incomplete staging directory; retry builds a new complete private generation and publishes only after exact shape/hash checks. Published generations are checked and never overwritten or deleted. Observed private collisions/edits block launch. Ordinary repo edits or repo symlink swaps cannot redirect staging because no repo path is used for output. Malicious same-user rewrites of private app storage are outside this boundary; this is not an atomic filesystem CAS guarantee against such a process.

Materialized means the private bytes were published. It precedes the persisted attempt intent and PTY process creation. `pty_process_created` records an opaque PTY generation/PID identity and timestamps. It observes the login shell, which may still have a pending Claude command. It does not mean Claude executed, read instructions, loaded skills, saw tools or authenticated. Fast exit is recorded separately. A pre-creation spawn failure keeps the materialized snapshot and records `process_not_created`.

If creation succeeds but the receipt cannot commit, the error is `process_started_receipt_failed`, carrying that exact runtime/attempt identity. Cleanup targets only that created PTY, cancels a pending command, and distinguishes cleanup requested from observed exit confirmed. Request exceptions, identity mismatch or timeout preserve the error and registry. Signal dispatch, synthetic timeout cleanup and missing manager state are not exit proof. Managed sessions remain tracked until an actual process exit callback; a concurrent retry cannot replace one. Generic run cleanup cannot release reserved activation pins.

A persisted unresolved start after app interruption blocks as `activation_runtime_unreconciled`. Automated orphan-runtime reconciliation and a person-facing recovery action remain follow-ons; the backend does not guess that an unobserved runtime stopped or silently start another session.

## Validation and follow-ons

Focused tests cover frozen retention and permissions, preview binding, A-to-B commit/launch regressions, staging interruption/recovery, published edits and observed parent swaps, alias/shared-workspace refusal, unsupported modes, fake capability evidence, skill grammar, actual terminal argument construction, process creation/fast exit, receipt failures, cleanup throw/refusal/timeout and real-exit tracking. Existing identity, provider/model/access, session/wire/worktree settings are not mutated by adoption. Existing runtime session capture keeps its prior behavior.

Still required: user-facing activation/adoption UI and inventory/review boundaries; broader provider/platform/session delivery; hooks/MCP session configuration; native subagent delivery; runtime reconciliation; history retention policy; real installed-path validation and human review. This PR makes no screenshots or visual-proof claim and does not complete #2819 acceptance.

## Separate adoption UI integration dependency

The next deliverable is a separate isolated integration draft, preserving the held #2842 checkout and runnable package. It needs a typed local-user IPC/preload bridge for delivery preview/adopt/read/unassign. Main resolves the current agent and project and requires explicit BaseAdoption, the saved revision/current target and the delivery token. The surface must show effective namespaced skills, ambient-context notice and specific block reasons, then refresh receipts with separate desired/prepared/materialized/PTY observations.

The existing Builder effective preview composes unsaved drafts and is saved-only. It cannot authorize adoption or activate anything. Add a distinct explicit next-start adoption action, separate from Start, with no wake and no invented adoption default. The UI integration depends on the backend contract and Builder surface; both need honest integration and visual review. The #2842 visual hold does not prevent work in a separate checkout, but backend readiness does not constitute that visual or adoption acceptance.

The native PTY-create boundary has a synchronous final compatibility and CLI identity check after asynchronous cwd validation. A shutdown/policy rejection after intent is recorded as a known non-creation; secondary receipt persistence failures preserve the original rejection and leave intent conservatively unresolved.
