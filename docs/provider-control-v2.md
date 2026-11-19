# Provider preview, apply and wake v2

This is an opt-in backend contract for #3731. It does not establish the cause of the reported phone sequence (choose Codex, preview Codex, wake Claude). The installed phone/host versions, whether Apply was offered or sent, and the actual runtime in that incident remain unknown. Go UI work is tracked separately in Clubhouse-Go #610.

The mobile envelope remains version 1. Existing `providerControl.version:1` and its exact verbs remain compatible. A client must separately negotiate provider Apply v2 and Start v2 before sending `contractVersion:2`. Absence of a capability means unsupported, not a reason to send the new fields to an older host. A rejected or uncertain v2 start must never be retried as v1.

## Request and receipt

`agent.providerPreview` and `agent.providerChange` accept `contractVersion:2`, optional `model:{kind:"selected",id:...}` or `model:{kind:"provider_default"}`, and optional `effort:string|null`. Change additionally requires the preview's `expectedState`. A bare model string, a selected id of `default`, unknown fields, or choices without v2 opt-in are refused.

On the same provider, omission preserves a saved choice. Changing the model clears the old model's effort/routing unless a new effort is explicitly selected. A provider change clears the previous model, effort, context choice, routing and resume pointer; explicit selected choices are then applied. Preview shows the exact proposed model/effort and actual cleared fields in `settingsReset`. A same-provider model change with a saved context choice requires separate context review. The per-agent setting stays unchanged on refusal. The Dispatcher uses its existing model-pick workflow rather than this v2 contract.

The additive `contract` contains:

| Field | Meaning |
| --- | --- |
| `version`, `target`, `selection` | Contract version, exact agent, normalized requested intent |
| `current` | Configured next-wake state before this operation |
| `saved` | Configured next-wake state after the operation; equal to current on preview |
| `proposed` | State the reviewed Apply would persist |
| `running` | Registry provider selection only; model/effort unknown |
| `result` | Preview, changed or already selected; persistence acknowledgment; always `started:false` |

`ProviderNextWake` carries the effective provider and an explicit nullable `providerOverride`. A null override remains inherited on a no-op. Model and effort carry `{value,source}`: a selected saved value has source `agent`; `{value:null,source:"provider_default"}` means the provider decides and the effective running value is unknown. It is not a concrete default model/effort.

For `already_selected`, `persisted:true` confirms that the saved state was durably flushed and verified; it does not imply a new write or start. An actual same-provider model/effort change is applied rather than skipped. A successful change acknowledges the durable provider/settings/marker commit. `nextWake` separately reports a fresh host-issued precondition or a blocked/unverified outcome. Post-commit wake-readiness failure never turns an acknowledged save into an invented rollback.

Preview tokens bind actor/host epoch, target/project, lifecycle generation, normalized intent, configured/proposed settings, strict defaults/wrapper, resolved runtime, semantic current model catalog, managed composition/revisions and relevant file identities/bytes. Revalidation occurs inside the guarded config write, with a synchronous final authorization/config/catalog/file check immediately before mutation. No instruction or secret source text is returned in the opaque token.

Concrete selected model/effort values require the provider's current live handshake catalog within the existing cache TTL. Fallback, unavailable, future or expired evidence is explicit and refuses concrete selection. No helper presets or persistent catalog-notice baselines are changed by preview. The pure resolver and synchronous cached-evidence accessor are available for the #3730 catalog work.

## Supported managed transition

The admitted subset is an isolated existing durable-agent workspace, a Codex terminal target, zero resolved skills (including grant-derived skills), verified-empty ambient skill directories, readable saved parts, no launch wrapper/command prefix/native-agent override, and no target context-window choice. Chat, other providers, nested instruction paths, skills, unknown inventories and unproven delivery layouts are refused before mutation. Settings are preserved; the backend never switches runtime or substitutes a provider to make admission pass.

The current primary instruction file must exactly equal the saved managed composition rendered with the existing composer/wildcards. The target primary must be absent or exactly equivalent. Empty and absent are distinct. Custom source/target text, links, special files, oversized files, shared workspaces and stale snapshots block Apply.

Apply exclusively creates only an absent target primary file, privately, with `wx` semantics and a file sync. Existing files are never copied over, moved or overwritten. The durable provider/settings write also saves a per-agent transition marker. A failed/revoked/stale commit conditionally removes only the exact inode/metadata/bytes this operation created. If another writer edits or replaces it, rollback refuses to remove that writer's file and reports a conflict; the provider/settings commit remains rejected. Instructions, parts, identity, branch/path, grants, orchestration/helpers, history and unrelated settings/files remain intact.

An interruption after complete native preparation but before config commit leaves equivalent inert bytes and the old saved provider/history; a new preview can authorize retry. An interruption during writing can leave a conflicting partial file and requires repair/review. A persisted marker with missing or changed native bytes blocks wake. This is fail-closed crash behavior, not a claim of multi-file filesystem atomicity or recovery from every storage failure.

The marker is evidence, never authority. Generic update cannot install it. Every ordinary wake, resume, managed restart, phone start and update-resume goes through `spawnAgent` and revalidates provider, current saved composition/parts/grants, native file/workspace identity, strict project settings, saved configuration and model catalog. A synchronous fence runs at actual PTY creation after command/cwd preparation. A marker copied to another identity/path, changed parts, newly granted skills, added ambient skills, edited native files, catalog/default/config drift or revoked start authority blocks creation. Marked resumes require native-session provenance and never fall back to a fresh conversation.

Marked starts skip TOML cleanup and the legacy managed instruction/skill/MCP/excludes writer entirely. The supported managed start performs no native delivery writes. MCPs use the existing Codex launch-argument path; an unavailable bridge or omitted/unrepresentable MCP arguments blocks creation. The contract does not prove CLI instruction loading, MCP authentication/tool visibility or model execution. Ambient provider configuration remains additional context; it is left intact.

The broader transactional skills/Claude/Copilot/chat migration remains open in #3731. Existing v1/native and other legacy starts retain their separate behavior. The generic mobile `agent.update` route now refuses a cross-provider change with `provider_change_requires_preview` before any write, closing the confirmed bypass. A redundant same-provider legacy field preserves inheritance. The Dispatcher's separately authorized by-hand settings flow is retained.

## Start v2

Start v2 is negotiated separately and currently admits only the prepared read-only managed Codex terminal lane. It requires `expectedProvider`, the complete saved `expectedNextWake`, and a host-issued `expectedState` from Apply/current preview. The token binds unknown defaults and catalog/lifecycle/host state; nullable fields alone never authorize start. Existing/native provider session provenance is still checked for resume. `expectedSessionId` is a native provider id, never an application chat-session id.

The response separates verified configured state, immutable creation evidence for this exact agent/command/host epoch, and current running observation. `configPersistedByStart:false` makes clear that Start did not perform Apply again. `pty_created` names the provider selected for that newly created process; it is not a CLI handshake or execution claim. Current running evidence is associated only while the exact created PTY identity still exists. `unknown` and `not_running` are distinct. `appSessionId` and `nativeProviderSessionId` are separate nullable namespaces. Model/effort remain null in the start receipt because no authoritative provider report is available at that boundary.

Immediate exit retains immutable creation evidence while reporting not running. Post-create failure retains observed creation rather than reporting a harmless pre-create refusal. A different already-running runtime is refused, even when it selected the requested provider. Canonical command replay returns the original receipt after a lost response and never creates a second runtime. After epoch loss/reconnect, an old command is rejected; inspect the target before a new attempt rather than silently downgrading or changing its id.

Complete request/HTTP-response fixtures are in `test/fixtures/annex-mobile/provider-control-v2.json`. Native filesystem/rollback and final-boundary proofs are separate targeted suites; the Annex route fixtures use explicitly synthetic transaction/PTY leaves. Fixture tokens/epochs are normalized opaque examples and cannot authorize real agents.

## Deferred acceptance

No real agent was migrated or restarted for this change. No installed phone/host parity, real CLI/auth handshake, real provider-loaded instructions/model/effort, Electron/Playwright/E2E, screenshots, release or human acceptance is claimed. #3611 hand-test and #3706 hold, plus unrelated #422 review, remain untouched. Independent review and exact-head proof are required before a PR.
