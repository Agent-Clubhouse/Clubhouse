# #3720 r2: explicit local settings intent and complete emergency fences

**Docs-only review candidate. Implementation HOLD.** This supersedes the full-body settings-diff, optimistic renderer and incomplete emergency-fence proposals in frozen r1 `379ebdca083d28634e497279ad9e4e0fd08bd3e1`. Preserve that commit and its real failures/receipts. The approved-in-principle negotiated naming transport, Unicode rules, loaded display resolver/token, pairing-currentness separation and legacy limits are unchanged unless explicitly stated here. [Canonical issue #3720](https://github.com/Agent-Clubhouse/Clubhouse/issues/3720). No product patch has been applied to the worktree or tested.

Source binding: main `50cb77ab6ccf9f383a39e59db308f4f8336051ea`. `caller-inventory.txt` is an actual source search, not proof of migration. The review patch demonstrates proposed exact local contract/caller/entry-boundary hunks. Proposed backend/UI helpers are review interfaces, not completed implementation. Shared store, accepted-intent witness, emergency and loopback code still require independent source/race review before product edits.

## Actual baseline failures and full caller set

Actual `annexStore.saveSettings` publishes the entire requested settings before IPC, then swallows failure without reverting. `AnnexNetworkSettingsView` builds full bodies from current or retained settings; Identity Alias and Color do the same. The command palette has two more full-body producers. Therefore:

1. Refused optimistic Alias B can remain in renderer `settings`, then ride a later Color or toggle full-body save.
2. A retained full body containing A can revert an accepted B, even if the person's actual action changed only Color or a switch. A backend diff against the queued previous body cannot infer touched fields or original intent.

These are source-derived counterexamples; no current product regression has yet executed. The only production preload save caller found is annexStore; its producers are SettingsView (`saveCurrentSettings`, Device name, Reachable as), IdentitySection (Alias, Color), and two palette toggles (~485/494). Getter consumers are annexStore load/purge and SettingsView's pre-save helper. No producer may retain a full-body fallback. Tests/fixtures using the old signature must migrate explicitly and include a source-search assertion/inventory on the implementation head.

## Strict LOCAL IPC contract

This changes the local IPC DTO and callers only. It adds no member-wire, mobile, REST or public AnnexSettings fields. Existing private accepted-intent witness remains a separate r1 review proposal; **r2 adds no persisted revision fields**. The origin is descriptive schema metadata, never authorization. Main-window/frame/document-incarnation checks and existing tool grants remain separate real gates.

GET_SETTINGS returns one cloned committed snapshot:

```ts
type CommittedAnnexSettings = {
  v: 1;
  epoch: string; // random UUID per main launch and reset admission
  revision: number; // monotonically increasing within epoch
  fields: Record<EditableKey, number>; // one committed version per key
  settings: AnnexSettings; // committed values only, including current optional-key presence
};
type LocalSettingsPatch = {
  v: 1;
  requestId: string; // UUID for reply/draft correlation; not authority or a retry token
  origin: 'identity' | 'network-settings' | 'command-palette';
  base: { epoch: string; revision: number; fields: Partial<Record<EditableKey, number>> };
  changes: Partial<EditableValues>;
  unset: OptionalEditableKey[];
};
```

Exact top-level keys are mandatory; no extras, prototypes/accessors, arrays in object positions, legacy `enabled`, unknown fields, undefined values, duplicate unset keys, set/unset overlap or empty touched set. Main validates before cloning and admission, then clones the complete request once; never hold a mutable caller object. Local payload limit 8 KiB serialized UTF-8, at most the 11 editable fields. Numbers are safe nonnegative integers; fields/versions are bounded by `Number.MAX_SAFE_INTEGER - 1`. UUIDs use canonical lowercase RFC4122 version4 form. Never coerce strings/numbers/booleans.

| Editable keys | Set value | Unset |
| --- | --- | --- |
| enableServer, enableClient, autoReconnect | boolean | refused |
| loopbackOnly, networkEnabled, acceptHandoffs | boolean | allowed |
| deviceName, alias | well-formed string, max200 UTF-16 units; existing fixed naming trim/intent validation also applies when publishing an effective name | refused |
| icon, color | string max128 UTF-16 units, well-formed; keep existing custom identifiers, no new enum veto | refused |
| reachableAs | well-formed string max1024 UTF-16 units, including empty string; existing address/runtime validation remains | allowed |

`changes` contains **only explicit touched set fields**. `unset` contains explicit touched deletes. `base.fields` has exactly their union, including no-op/equal-value writes; not all settings fields and not a value-derived diff. Required `base.revision` must not be in the future, and each field version must be at most it. Check epoch mismatch first, before comparing any counters or values. At the actual queued atomic boundary every touched version must equal the current committed field version. One mismatch refuses the **whole patch**, including any Alias/switch combination. Untouched fields rebase onto actual committed state. No partial unguarded subset, equality shortcut, hidden retimestamp or automatic resubmission against a new baseline.

Origins are closed and consistency checked: identity may touch Alias/Color/Icon; command-palette may touch one server/client switch; network-settings may touch Device name/Reachable as/server/client/loopback/network/handoffs/autoReconnect. No origin bypasses any actual sender or grant check. A forged `identity` origin is not main-window authority; `network-settings` cannot smuggle Alias. The actual cleared UI producers submit narrower key sets listed below.

Absent/default semantics refer to the committed in-memory settings **after existing startup default merging**, not raw-file provenance. Version0 means not written in this random epoch, including a loaded/default value. An absent optional key uses its existing product default (loopbackOnly false, networkEnabled/acceptHandoffs true, reachableAs absent); required keys retain existing defaults. Unset deletes an optional property in the committed result, with no invented new default setting. On restart existing defaults can reappear, but the new random epoch invalidates every old token. GET must not claim raw-file absence.

| Current optional property | Requested action | Accepted result at matching version |
| --- | --- | --- |
| absent | set X | present X, touched version advances |
| present X | set X | present X, touched version advances even equal |
| present X | set Y | present Y, touched version advances |
| present X | unset | absent, touched version advances |
| absent | unset | absent, touched version advances even equal absence |

An explicit LOCAL field write advances its touched versions on successful primary commit even if values/presence are equal. Generic same-value Alias save does not mint a network operation; USE_LOCAL_ALIAS/Rename is the explicit same-name network intent. MCP's existing equal-loopback `changed:false` path is different: read-only, no Ask, write, version or audit-save. Refused/failed primary writes advance nothing. All production Annex writers, including forward/restore, emergency and purge, advance only committed versions atomically; their touched sets are explicit. A→B→A increments versions twice, so a held A token cannot authorize ABA.

## Committed snapshot and store seam

Values, epoch, revision and field versions are assembled synchronously in one no-await read over the existing committed store and private version cache. GET_SETTINGS uses only the existing getSettings load when necessary; it adds no IO, name initialization, emit or mutation. Version state/random launch epoch is established by normal main startup, not a display or GET-triggered initializer. It never exposes a pending cache or Alias draft.

Retain r1's opt-in publication after primary commit on the **existing pendingWrite**; default stores remain optimistic. The selected queued mutation is pure/synchronous over a clone, without recursive save/update/await. The proposed commit-publication observer has two bounded synchronous phases: before primary replacement, compute/freeze the entire next private tuple (public settings, exact validated touched set, epoch, revision and field versions); after successful replacement, publish it with one private reference assignment before resolving, audits or callbacks. Normal Annex getSettings and GET_SETTINGS both read this same tuple, not different caches. Never expose a new generic-store cache with an old public version tuple, even through a reentrant read. The observer does no IO/await/emits/grant checks or external calls and is specified no-throw; validate overflow and allocate/clone before primary replacement. If an unexpected post-primary publication fault is injected, mark public snapshot unavailable and return committed_unconfirmed; never return refused/rolled-back or expose a mixed tuple. This is an additional exact store API reservation, not implemented behavior. Default stores without the opt-in publication remain unchanged.

Main returns typed local results with exact requestId and `outcome: 'committed' | 'refused' | 'committed_unconfirmed'`, a fixed code and optional coherent committed snapshot. Refusal codes include schema_invalid, epoch_changed, conflict, caller_changed, superseded, name_store_unavailable and persistence_failed. Transport failure is **unconfirmed**, not proof of no commit. A name activation failure after settings commit is committed_unconfirmed. This DTO is not a member ACK or mobile route. Backend runtime effects use the operation's actual committed before/after and owned versions, never the caller body or an unrelated latest snapshot.

## Renderer committed cache, drafts and late replies

`annexStore.settings` is committed only. Save never `set({settings: requested})`. Keep editable text/pending/error separate, keyed by requestId and local field-edit generation; Color/toggle producers never read/merge Alias draft. Typed refusal and transport-unconfirmed errors remain visible, not swallowed. Alias and Device name text keep a local draft and explicit save/blur/Enter boundary; refusal preserves the person's text with a reason. No automatic mutation retry or rebasing of a refused edit. Current committed Alias and effective network name remain distinct labels.

Capture the committed snapshot and frontend generation when the person submits. If not loaded, a single existing read may establish it before that explicit action, but do not silently load defaults or infer intent from a full body. If a reset changes generation while waiting, refuse the old submission. Different-field requests can be sent independently; no frontend mutation queue delays emergency-off behind Alias. A rapid same-field newer draft is not cleared by an older reply; on conflict it stays visible for an explicit new submission against freshly reviewed saved values.

Within an epoch accept coherent snapshots only at a revision at least the displayed committed revision; an older save/load reply cannot roll B/C back to A. Equal revision with different content/version tuple is an invalid response, not overwrite authority. Each load has an issued sequence and frontend generation; only the latest applicable load may establish a new epoch. An explicit epoch_changed result invalidates pending old-epoch requests/draft bindings and establishes/reloads a coherent current snapshot; it never silently resends text. Once generation advances, all earlier save/load/error continuations are ignored for cache, pending and error ownership. Preserve newer draft text; mark it requiring explicit review/save, not a current accepted operation.

Purge invalidates the renderer generation at invocation before any await; old loads, success replies and errors cannot revive its prior state. Main changes to a new random settings epoch at reset admission, before synchronous stop/deletion work, and all old requests fail epoch checks. A renderer surviving a main restart also gets explicit epoch mismatch even if counters happen to match. Keep pending text separately if useful; never automatically promote it into the new identity. Readback after reset shows actual committed preferences, not invented empty defaults.

## Exact caller migration

| Actual site on bound main | New explicit submission |
| --- | --- |
| Identity Alias ~16 | origin identity, changes {alias: draft}, unset [] |
| Identity Color ~37 | origin identity, changes {color: id}, unset []; no Alias field |
| SettingsView saveCurrentSettings ~77 | replace fullbody read/spread with typed patch builder over committed snapshot; declared changes only |
| SettingsView network toggle ~92 | network-settings, explicit enableServer/enableClient and only on-enable networkEnabled true; no name copy |
| SettingsView loopback ~118 | network-settings, only loopbackOnly |
| SettingsView handoffs ~123 | network-settings, only acceptHandoffs |
| SettingsView Device name ~221 | network-settings, only deviceName draft |
| SettingsView Reachable as ~263 | network-settings, only reachableAs draft |
| Palette server ~485 | command-palette, only enableServer; desired value read from committed state at action invocation, not menu-construction closure |
| Palette client ~494 | command-palette, only enableClient, same invocation rule |
| annexStore load/purge; SettingsView prior getter helper | consume coherent GET_SETTINGS DTO; retain committed settings separately from revisions/drafts; no raw full-save fallback |
| preload save; main SAVE_SETTINGS | typed patch in, typed result out; strict clone/validation; no protocol/mobile schema reuse |

Persisted legacy `enabled` migration remains in the existing main settings layer. LOCAL IPC never accepts `enabled`; no compatibility fallback manufactures server/client intent from an old full body. Existing configuration files and custom names are not rewritten by a read. Default-store behavior and selective purge semantics remain explicit acceptance controls.

## Emergency and tool-entry admission

Admission is opaque internal main state, not grant approval. Capture original installed host object, random settings epoch and emergency generation **at validated request/tool entry, before settingsWrites/MCP writes queue or Ask await**. Do not recapture at host callback entry, replace it with a new epoch/host, or revive it on equal values. Check host identity/removal, original epochs and current real authorization at queued admission, preAsk/postAsk, commit checks including every pre-rename attempt, every post-await effect, runtime apply/scan/start/stop/status, restore and final activation/ACK. Disposal only retires this invocation/intent; it cannot retire a newer one.

Emergency disable and purge bump the generation **before** existing synchronous stop work; purge also changes settings epoch. A fresh deliberate later invocation captures new admission and can enable under existing authority. This is not a permanent halt. Every old enabling/rebinding continuation is fenced, including non-Alias SAVE_SETTINGS and MCP forward/restore, not just naming. Validate requests before treating a claimed origin/field as an emergency action. A dedicated emergency-off invocation's immediate live stop is independent of name reservation/activation and the existing disk queue; do not add a metadata await before it.

Main source stop observations are retained in r1, but executed proof must verify actual read-lease retirement, inbound/outbound channel removal and late callback refusal, not merely spy on stop(). Retain abort-before-notification order. A stopped pending listener's existing serverGeneration/wasSuperseded fence remains; a late old failure must not stop a replacement runtime. No blanket cancel, new server lifecycle policy, keepawake or retry increase.

MCP loopback entry captures original host/admission before its writes queue and Ask. Existing grant, process restriction, expected_state and Ask schema/approval remain unchanged. Before forward commit use original expected_state and current grant; after forward commit the old expected_state is necessarily obsolete. Thereafter use the **exact owned commit/field version and actual committed before/after**, plus fresh grant/admission, not old hash equality. Restore can change only the loopback field still owned by that commit, restoring its actual before presence/value; a newer version, even equal-value ABA, refuses restore. Preserve wasSuperseded no-rollback. Gate stale STOP/catch/status effects as well as start/scan/restore; a superseded failure cannot stop a newer host's runtime. Equal-loopback MCP no-op stays read-only after original admission/current-grant checks, with no Ask/write/version.

All forward and restore persistence uses the existing atomic precondition path. Checks are idempotent, non-mutating and fail-fast. A fixed monotonic deadline only refuses at subsequent checks; it **does not release a queue while old OS IO is in flight**, cancel fsync or imply no temp IO. The existing chain remains held until IO settles. Live emergency-off proceeds synchronously; durable emergency persistence can wait behind that same disk IO. Post-primary supersession is committed/partial, never fake rollback. The private accepted-intent witness and exact cancellation/recovery semantics remain independently review-gated; text equality/ABA never authorizes activation.

## Separate launch-gate receipt boundary

The source audit found no equivalent generation in launch-gate/app-shutdown/shutdown-guard. Current launch-gate stores only closedFor; close/reopen can occur entirely across an await. Existing app-shutdown begin closes launches before the quit-only beginHook and main/index server.stop; quitRequested prevents cancelAppShutdown reopening a quit. A current boolean suffices while quit stays closed, but cannot latch a canceled update/dev-restart close→reopen.

The exact additive patch is limited to `src/main/services/launch-gate.ts`: private opaque Symbol generation, rotation on **every** closeLaunches (including already closed), and `captureLaunchAdmission():()=>boolean`. Capture stores both generation and launchesOpen at capture; current requires captured-open AND unchanged generation AND current-open. Reopen never resets/restores generation. A capture made closed cannot become valid after reopen. Existing assertLaunchesOpen, runAgentWork, agentWorkOpen, closeAgentWork, work waiters, PTY and shutdown behavior stay unchanged. No app-shutdown/coordinator/index/update/dev-restart policy hunk is authorized by this proposal. Annex alone opts into the new observation.

Inventory is retained in `launch-callers.txt`: production closes are app-shutdown begin and update-restart-service validation; reopens are cancelAppShutdown and its test reset helper. Agent-system asserts are existing consumers, not converted. App quit, update restart, cancellation, runtime/manual retry and disabled paths are inspected in that receipt. The independent lifecycle reviewer is the parent-assigned QA reviewer after Navi reported no separate active lifecycle assignment; no owner was inferred from author/branch names.

An Annex runtime admission captures this predicate at original validated request/tool entry along with installed host, settings epoch and emergency generation. Existing authority still checks separately. Dispose it when that invocation ends (including asked/no-op/refused); it is not reusable by another invocation or replacement host. A fresh invocation after reopen captures a new receipt; an old one never refreshes. This predicate observes admissibility, not cancellation/drain of entered OS IO or settings/grant/name-intent authority.

Required executed controls after clearance: capture open→close→reopen stays false across queue/Ask/disk/runtime awaits; capture closed then reopen stays false; repeated close rotates; real quit denies commit/effects; failed-update/cancel reopen denies old callbacks; fresh manual retry/enable after reopen passes existing authority; late success/failure/STOP cannot affect replacement runtime. A no-rotation or generation-reset-on-reopen mutation must make negatives fail. No such execution is claimed in this docs checkpoint.

## Required discriminating proof after clearance

- Refused optimistic B followed by Color, each palette toggle, reach and handoffs: requests contain only explicit keys, committed Alias stays A; failures surface and B stays only draft.
- Accepted B then stale A/color/toggle request: no Alias field, B survives. Stale explicit Alias A with old field version refuses whole patch. Restore optimistic full-cache publication or fullbody fallback and these controls must fail.
- All absent/set × set/unset cases; same-value set and absent-unset bump versions on LOCAL commit; no increments on failure; equal-value MCP no-op remains changed:false/read-only. A→B→A, same counters/different random epochs, restart-surviving renderer and reset mid-edit refuse old requests.
- Out-of-order save/load/error, newer draft during older save, transport-unconfirmed, purge invocation before reply, partial settings/name activation: no stale cache or draft/error ownership revival, no silent failure/retry.
- Non-name and Alias+enable work held at queue/pre-rename/post-primary; emergency stops live reads/channels immediately, later releases durable disable without B or revival. Include purge, retry boundary and fresh later enable.
- MCP queue wait, Ask wait, host replacement/removal, grant revocation, forward/restore fsync, postcommit emergency, late start failure and equal-value ABA: original admission and authority remain separate, stale work neither commits nor starts/stops/rebinds/announces/restores another runtime.
- Default-store optimistic compatibility, opted-in pure mutation on existing pendingWrite, coherent GET snapshots at commit boundaries, actual committed before/after runtime calls, selective purge and legacy file migration.

The fixtures and patch are review material only. No executed product red/green, race, type/lint, mixed-version compatibility or hosted CI is claimed. Exact independent review and writer clearance precede product code; product evidence follows on its actual source head.
