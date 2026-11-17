# Independent sandbox and approval policy (#3686)

## Evidence and limits

Research date: 2026-11-17, macOS arm64. Clean-home/no-network version probes reported installed Claude Code 2.1.312 and Copilot CLI 1.0.112 at /opt/homebrew/bin/copilot (reconfirmed after the Copilot v2 rebase; the installed CLI was not changed). Read #3686, #1535 and its comments, closed #3366 and #1716 in full. The parity epic's July 0.144.1 argv is historical; the removed `--full-auto` and `--continue` flags are not used.

The installed `/opt/homebrew/bin/codex` reports **codex-cli 0.163.0**. Its stable `app-server generate-json-schema` output was generated with a temporary empty HOME/CODEX_HOME, an allowlisted environment, and `sandbox-exec` denying all network. No model turns, credentials, login or paid inference. [The provenance manifest](sandbox-approval-provenance.json) records schema hashes, properties and enum evidence. Repository generated TypeScript bindings are pinned to **0.166.0**, not the installed binary. This distinction matters: newer documentation does not establish installed support.

Current official references, retrieved on the research date:

- [App-server](https://learn.chatgpt.com/docs/app-server): independent thread/turn policy fields, approvals and permission-grant scopes. Current docs describe restricted read roots, `availableDecisions`, and experimental per-command `additionalPermissions`; these are not all present in our installed stable schema. This change does not opt in to experimental API or implement permission profiles.
- [Permissions](https://learn.chatgpt.com/docs/permissions): newer profile configuration is outside this implementation. Host-managed requirements can reject a choice; Clubhouse must preserve the restriction rather than silently substitute.
- [Sandboxing](https://learn.chatgpt.com/docs/sandboxing): macOS enforcement uses Seatbelt. Current Linux/WSL guidance uses bubblewrap or a bundled helper with namespace prerequisites; AppArmor can affect startup. Windows has a native sandbox, while WSL follows Linux. Only the macOS schema-generation boundary was exercised here; no claim of live Linux/Windows enforcement testing.

## Support matrix

`R` = read-only, `W` = workspace-write, `D` = danger-full-access (no sandbox).

| Provider / transport | Approval policy | R | W | D | Resume |
| --- | --- | --- | --- | --- | --- |
| Codex app-server, verified floor 0.163.0 | untrusted | yes | yes | yes | thread/resume and turn/start |
| Codex app-server | on-request | yes | yes | yes | same |
| Codex app-server | never | yes | yes | yes | same; failures do not create prompts |
| Codex terminal | on-request | yes | yes | yes | resume ID or --last, same flags |
| Codex terminal | never | yes | yes | yes | same |
| Codex terminal | untrusted | disabled | disabled | disabled | CLI help only offers on-request / never |
| Codex fresh headless exec | never | yes | yes | yes | not applicable |
| Codex headless exec | interactive approval | disabled | disabled | disabled | no bidirectional approval UI |
| Codex exec resume | any explicit override | disabled | disabled | disabled | neither -s nor -a accepted here; fail closed |
| Claude SDK / stream-json / terminal | native ladder retained | independent control disabled | disabled | disabled | existing behavior retained |
| Copilot SDK / terminal | native tool permissions retained | independent control disabled | disabled | disabled | existing behavior retained |
| Custom providers | provider-owned | disabled | disabled | disabled | no verified independent contract |

Claude Agent SDK **0.3.318** has a native `Options.sandbox` seam, verified in installed `sdk.d.ts`; Clubhouse currently does not pass it. It is independently configured from permissionMode, but is not a verified translation of these Codex R/W/D policies. [Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing) describes shell-specific isolation and retry settings, not Codex's SandboxMode enum. After rebasing onto #3685 (`2f813c626`), installed **@microsoft/copilot-sdk 2.0.0** exposes `SessionOptionsBase.permissions.sandbox` (`SessionPermissionOptions.sandbox`), serialized to grouped create/resume `permissions.sandbox`; the former SDK 1.0.29 seam was `sandboxConfig`. Its declarations require runtime support, apply policy before MCP/tools start, fail create/resume on managed-policy conflict, and require re-supply on cold resume. `permissions.mode` is separate and reports an authoritative `permissionModeResult`. `SandboxConfig` and `sandbox.getHostSupport()` are experimental: native containment/capabilities, filesystem fragments, network rules, MCP/LSP/extensions, credential/keychain options and an opt-in `allowBypass` (false by omission) need a provider-specific design. Auto-added cwd/developer-tool grants mean an assumed Codex read-only translation would be unsafe.

The v2 package declares paired CLI **1.0.113**. [#3685's boundary evidence](copilot-test-boundary.md) separately records bundled SDK runtime 1.0.113/protocol 4 and installed CLI 1.0.112/protocol 3. A clean-home/all-network-denied version probe here reconfirmed the installed 1.0.112; the bundled runtime does not accept `--version`, so its version/protocol provenance is the existing zero-token handshake, not an installed-CLI claim. No live sandbox/session/model turn was run. [GitHub's SDK documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/mcp#applying-sandbox-policy-before-mcp-startup) describes the older flat `sandboxConfig` contract and warns that protocol version alone is not a feature capability signal; v2 grouped-field evidence comes from the exact installed declarations and serializer, whose hashes are in the provenance manifest.

Existing permission callbacks/allow-all flags and successful protocol negotiation do not prove a mapped sandbox is enforced. These providers stay disabled with the reason **no verified mapping/enforcement for these policies**, not a claim that their SDK lacks native sandbox support. Follow-ups: Claude Agent SDK 0.3.318 `Options.sandbox` mapping/enforcement; Copilot v2 `permissions.sandbox` / native `sandboxConfig` mapping/enforcement on a verified CLI 1.0.113 host. No Claude/Copilot policy changes in this PR.

The app-server schema accepts all nine pairs at thread/start, thread/resume and turn/start. This is **protocol/schema evidence**, not a live inference or sandbox-enforcement test. Chat explicit overrides require a recognized stable version at least 0.163.0; the existing central version policy still applies. Returned startup policy must match explicit choices before any prompt is sent. Terminal flags unsupported by another installed version fail at CLI parsing; choices are never dropped.

## Defaults, configuration and migration

Two optional fields, `sandbox` and `approvalPolicy`, are separate from the five-level Access setting. Each can remain unset. Existing records are never populated automatically. Editing unrelated settings, templates, managed migration, helper presets, runtime preference or model/provider selection does not migrate policy values.

| Existing path / level | Unset effective behavior retained |
| --- | --- |
| Chat Plan | on-request + read-only |
| Chat Ask first | untrusted + workspace-write |
| Chat Auto-accept edits | on-request + workspace-write |
| Chat Auto | never + workspace-write |
| Chat Full access | never + danger-full-access |
| Terminal below Auto | existing CLI configuration |
| Terminal Auto | workspace-write + never |
| Terminal Full access | existing bypass flag |
| Fresh headless | workspace-write, or legacy bypass at skip-all |
| Legacy headless resume | existing resume behavior, with no new override |

Explicit sandbox selection suppresses the bypass flag even at Full access. Changing the approval level during chat preserves both explicit axes. Codex has no native Plan mode in this mapping: Plan prevents changes through its default read-only sandbox; explicitly choosing a broader sandbox can allow changes, and the settings help says so. Clearing an override is a deliberate return to the existing level default. Unsupported provider/runtime fallback fails closed instead of deleting a choice. No personal/global CLI config is written. Codex’s host reviewer configuration is separate: a configured automatic reviewer or managed requirement may resolve/deny work upstream. Clubhouse shows user-facing requests it actually receives; selecting an interactive policy does not promise a prompt for every failure.

The installed stable SandboxPolicy defaults network access to false for read-only and workspace-write. Workspace write includes cwd, configured additional writable roots and temporary-directory exclusions. Chat preserves the **entire returned policy** when its type matches, including network, roots and temporary-directory choices. Config-supplied permissions stay host-owned; changing levels does not replace them with a guessed broad policy. Switching sandbox type uses the provider's resolved policy on startup; per-turn type changes use the existing conservative no-network constructors. `dangerFullAccess` removes Codex's sandbox, but does not confer Clubhouse tool grants or credentials.

User-selected fields persist in agent records, managed templates and restart capture/queue. Durable resume re-reads the saved policy on the execution host, so an older restart snapshot cannot undo a later restriction; quick sessions without a durable record keep their captured explicit choices. Quick templates historically deliver parts only, so they refuse a template with explicit execution overrides rather than silently ignoring them. Managed fingerprints include them only when explicitly present, preserving old fingerprints. Tool-driven creation/push checks the access needed by each override; helper launches retain the existing access ceiling and cannot exceed an explicit parent policy. Grant records, target identities, connections, Auto provider/model resolution, and third-party MCP approval defaults are separate.

#3366 remains narrowly scoped: only the `clubhouse` MCP server gets `default_tools_approval_mode = "approve"`. Other servers retain Codex defaults. MCP tool approval is not shell/filesystem/network isolation.

## Requests and remote routing

| Event | Response | Meaning |
| --- | --- | --- |
| item/commandExecution/requestApproval | decision: accept / acceptForSession / decline / cancel | one command, session approval cache, denial or stop |
| command request with proposed policy amendment | exact advertised amendment | persistent exec rule or network host allow/deny; distinct from temporary permission grant |
| item/fileChange/requestApproval | accept / acceptForSession / decline / cancel | file changes; grantRoot is displayed |
| item/permissions/requestApproval | permissions + scope: turn or session | grant only requested network/filesystem data; denial grants {} |
| Legacy v1 execCommandApproval / applyPatchApproval | not mapped to cards | schema contains them, but Clubhouse uses v2 thread/turn paths; no evidence they are emitted there. Explicit gap, not translated as v2. |

The mapper emits the existing `permission_request`. The chat runtime retains pending options and publishes stamped events to the desktop approval card and Annex chat stream/pending-permission snapshot. Desktop/phone responses carry the exact option ID back to the originating runtime and mapper. Existing Annex authorization, session identity, complete-input review and target-host grant checks continue to apply. This change needs no annex-server or phone-specific decision contract.

Command cards include network host/protocol context and the complete provider request, rather than describing managed-network approval as an opaque command. Permission cards show requested read/write roots and preserve newer filesystem entries in reviewed input. Accepting a permissions request grants exactly the requested network/filesystem subset for the chosen turn or session; denying returns an empty grant. It does not edit saved settings. Session grants are not promises of persistence across a process restart.

A sandbox failure under `never` is returned to the model; Clubhouse does not fabricate a request, bypass the sandbox or rerun a command. An unsupported SDK request remains a protocol error rather than an invented escalation. Remote execution is constrained by the provider on **its own host**. A phone approval is a routed decision, not a grant to the phone's filesystem, network, or another computer.

## Why git can fail

Use the actual error and requested scope. Network denial can prevent DNS, HTTPS or SSH; a network grant does not repair filesystem or authentication failures. Credential helpers and macOS keychain can require services outside a sandbox. SSH depends on its agent socket, key/config/known-host files and host launch environment. Worktrees may store `.git` as a pointer to metadata outside cwd: index locks, refs, objects and config writes need access to those metadata locations. Read-only sandboxes can fail local commits without network activity. PATH, HOME, Git configuration, SSH_AUTH_SOCK, proxies and shell initialization can differ between an Electron-launched process and an interactive terminal. Inspect existence and scope without logging credential values.

Do not diagnose every git failure as network-only, grant the whole home directory by default, write global provider config, or convert a one-off approval into permanent unsandboxing.

## Validation contract

Credential-free deterministic tests cover the cross-product, legacy defaults, explicit Full access with a sandbox, matching returned policy, old/unknown-version refusal, unsupported provider/runtime fallback, chosen-session resume, network denial, allow once/session/deny, and preserving configured roots/network. Settings fixtures cover atomic invalid-value refusal and explicit reset. UI fixtures verify distinct labels and disabled choices with reasons. Existing Annex and Clubhouse-only MCP approval fixtures remain the routing and boundary regression controls. Real CLI research used only schema/help/version output (and existing #3685 handshake evidence); no local E2E, Playwright, model turn or full test suite is required for this lane.
