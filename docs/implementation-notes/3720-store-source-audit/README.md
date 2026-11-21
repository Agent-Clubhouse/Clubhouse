# #3720 shared-store source audit: preparation only

Bound source main `77fa095320f2184ebf8870a5251ad0fd26a46501`; approved contract direction `38cbdaa9fff26aa28630ad14b5db9c13359d39f1`, successor-r2 store-and-recovery-algorithm plus successor-r3 B1/L1/C1–C3 amendments. This branch contains **read-only source inventory and notes**, no proposed implementation patch, new API, compatibility execution, test credit or shared-source clearance. #3767 candidate19a681f03/proof90df17c24 remain untouched under hosted observation. No production module is imported/invoked by the collector.

## Current actual writer/compatibility set

TypeScript AST inventory (comments/imports are not counted as calls) finds **46 createSettingsStore call sites**, **6 replaceFile call sites** including settings-store's own queue, and **5 direct importers**: agent-settings-service, group-project-bulletin, group-project-json-file, group-project-notification-store, group-project-registry. These are source call sites, not a bound on runtime store instances. Factories can construct many stores. Files and lines are in callers.json, with exact source SHA256 for critical store/telemetry, all identified callers/direct importers and the known local producers.

Static Annex facade import/reference audit finds **5 direct primary-setting write sites**, all in annex-handlers.ts: MCP forward update79, MCP restore update102, SAVE save188, emergency disable save252, selective server purge save270. No detached/aliased write reference is found in those imported facade bindings. The wrappers' store.save/store.update are in annex-settings.ts. The separate annex-ports store remains a default store; it is not a primary settings field-version writer. This is a source inventory, not dynamic writer/authority proof.

The corrected local producer search includes Identity Alias/Color via onSave, SettingsView fields/toggles, both command-palette switches, renderer store and preload. Current callers still send full bodies; no migration occurred here. Future explicit-key migration must include the palette and Color so a refused draft Alias cannot be inherited. Origin metadata remains descriptive, never real sender/grant authority.

## Actual queue and publication boundaries

| Existing mechanism | What it currently serializes |
| --- | --- |
| Handler settingsWrites | SAVE apply calls only. It is not the MCP or emergency disk queue. |
| MCP module writes | Tool invocation/Ask/host operations only, separate from SAVE. |
| Store pendingWrite | Disk write callbacks. Candidate cloning, JSON serialization and save's optimistic cache publication currently happen **before** this turn. |
| Store updateLock | update calls, not all save callers. update invokes save after its current-value read. |

All these source mechanisms are real; treating them as one fake common queue would not establish RS1. The opted-in Annex mutation must compute/rebase/check its declared touched fields **inside the actual pendingWrite turn**, while preserving default stores' existing behavior. A wrapper awaiting old save cannot repair an already escaped optimistic Alias. No additional publication/write queue is proposed.

Current default save synchronously publishes cachedSettings and accepted-save display metadata, then queues IO. Failure rollback occurs only while cachedSettings is the exact attempted object; newer cache wins. peekLoaded detaches nested values/provenance and freezes the returned outer objects; its values come from cachedSettings. Keep default accepted-save timing, shape/value/primary/origin/observedAt, lazy load, migration, recovery-copy, audit and updateLock semantics. The future opted-in Annex snapshot must instead use one complete committed values+versions+scope tuple, with honest degraded state after a post-primary fault; it cannot reuse a valid old DTO or independently swap cached values and versions.

replaceFile does temp FILE sync+close, optional mode, then renameOver. There is no primary directory sync. Existing renameOver checks preconditions per attempt and has the six existing Windows backoffs (up to7 rename attempts). Preserve signatures/modes/temp cleanup/retries and direct callers. Publication remains the reviewed store-turn placement after definitive replaceFile success, outside filesystem retry/cleanup/legacy rollback. persist.timed adds an await and performs persistence telemetry after its callback; write catches telemetry failure. The future full opted-in code must still classify post-primary failures honestly rather than using a wrapper signature as proof of atomic publication. No power-loss/directory-durability claim.

Legacy loadSettings can back up unreadable files and fall back to defaults. Controlled recovery/UNKNOWN-base emergency must use strict validated primary reread, never that loader. Existing bounded peek helpers are read-only candidate building blocks; the exact path/provenance/complete schema/private-witness validation and commit-turn composition must be shown in the future patch. Nothing initializes or heals from display/GET in this audit.

## Required next executable review, still missing

The full opted-in algorithm/API bodies, immutable candidate/publication tuple, actual known/UNKNOWN primary receipt, post-primary degraded outcome, typed field/version model, normal startup/reset epoch and strict recovery/healthy-get behavior remain unimplemented. The next exact patch must show each reference assignment and catch boundary, preserve all non-opted callers, keep emergency live-off independent of stuck filesystem IO, and keep the queue held until OS IO settles. Known-base emergency composes the actual receipt; UNKNOWN requires strict reread+off mutation in the same pendingWrite turn and refuses durable persistence if reread fails. Publication failure never returns fake refused/rollback, silently heals, activates a name by equality or makes emergency use a stale public tuple.

Private accepted-intent witness, renderer draft/load ownership, real sender/document and host/grant/admission checks, name-store health and RS1–5 consumers remain separately review-gated. Existing bounded recovery ticket/fresh-versus-status protocol and >32 failures control from r3 are not implemented. Exact writer/hunk clearance and discriminating tests must precede product changes. This source audit grants no new scope, lifecycle policy, default-store or filesystem-helper edits and imports no federation review/machinery as approval.

## Collector provenance and limitations

callers.json records the actual base/head/time, collector hash, source hashes and AST sites. Raw rg argument/exit/stdout/stderr JSON files are retained. Initial collection guessed the palette path incorrectly; local-save-producers.failure.json retains actual exit2/stderr, with collect-callers.initial.cjs/callers.initial.json preserved. A later AST-reference extension initially omitted parent nodes, making directCall flags false; callers.parentless.json and its collector are retained as **incorrect intermediate collector output**, not alias findings. Current collector enables parents and all five directCall flags are true. Counts46/6/5 were unaffected by those collector corrections. No product or runtime failure is inferred from a collector failure.

SHA256SUMS.txt seals this packet; verify-audit.py validates bytes/source bindings and the retained distinctions without running production or compatibility tests. The inventory is authoritative only for this frozen source. Recheck actual writers/current main and obtain exact shared-store/P7w/Details review before implementation. No hosted CI, runtime red/green, resolver, name convergence, live host, OS teardown or release acceptance is claimed by this packet.
