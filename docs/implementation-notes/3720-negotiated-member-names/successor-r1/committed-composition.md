# I-1 replacement source contract — review only

**Not approved or executed. No product edits.** Source binding: `50cb77ab6ccf9f383a39e59db308f4f8336051ea`. The proposed shared-store, writer and emergency supersession hunks require P7w/QA review. This replaces the precondition-only sketch, retained as `unsafe-precondition-only.review.patch.json` (exact patch bytes in a JSON wrapper) to preserve why it was rejected. It does not transfer proof from current main, another feature, or the frozen afefa contract.

## Actual counterexample and writer set

Existing `settings-store.save` checks a precondition, then publishes `cachedSettings = attempted` **before** async disk replacement. `update` uses a separate existing updateLock and reads that optimistic cache. A guarded Alias B may therefore be visible to an external non-name writer before its guard eventually refuses disk replacement. If that writer queues a newer cache containing B, the failed Alias rollback deliberately preserves the newer cache, and its unguarded write can commit B. An optional precondition on only the original save does not fix this. This is source reasoning; no race has yet been executed here.

Actual source audit (`git grep` on the bound commit) found five Annex settings write sites, all in `annex-handlers.ts`:

| Site | Current behavior | Proposed boundary |
| --- | --- | --- |
| SAVE_SETTINGS ~188 | Existing serialized requested full save | Same queue; actual Alias change uses one guarded committed field patch; ordinary save does not access naming health. |
| MCP loopback change ~79 | updateSettings current→loopback | Existing update callback evaluated against committed state at disk queue turn; existing grant/expected-state checks retained. |
| MCP loopback rollback ~102 | updateSettings with expected delivery hash | Same committed mutation; expected-state/rollback checks still run on actual current state. Never overwrite a newer committed edit. |
| DISABLE_AND_DISCONNECT ~252 | Synchronous server/client stop, then snapshot save | Keep immediate stop first; committed update changes only server/client switches and retires the accepted intent witness. No metadata reservation/activation wait. |
| PURGE_SERVER_CONFIG ~270 | Synchronous stop, deletes identity/TLS/peers, saves reset with copied Alias | Existing explicit purge authority only; committed update preserves committed preference/deviceName while resetting its existing fields and retiring witness. No new deletion. |

No other production caller importing saveSettings/updateSettings from annex-settings was found in this audit. Repeat the audit on implementation head; do not assume it remains exhaustive.

## Two invariants

1. Non-name writers cannot observe or inherit any uncommitted Alias. A failed guarded write never publishes B through another writer. A later independent accepted rename to the same string is a different operation.
2. Activation belongs to the **exact still-valid accepted intent**, not a matching committed text. Disposal/invalidation targets only the refused intent id and cannot erase a newer reservation, winner or accepted witness.

## Opt-in store composition on the existing disk queue

Propose `createSettingsStore` option `publishAfterCommit: true`, enabled only for the Annex settings store and the new name metadata store. The accompanying `committed-composition.review.patch` shows the proposed generic seam, wrapper, exact handler changes, MCP callback and main registration. Its new membership/UI helpers are explicit proposed APIs: no product implementation/typecheck is claimed. All other settings stores retain existing immediate optimistic publication, updateLock behavior, audits, rollback and default options. Required compatibility control asserts that an ordinary default store still exposes its pending save before disk completion.

The existing opt-in `skipUnchangedUpdates` behavior must remain compatible if combined with committed publication: a returned current object is still a no-write, with the usual guard checks. The review sketch preserves that identity check after evaluating the queued callback. Annex does not opt into skipUnchangedUpdates; a compatibility control still covers the combined options before product adoption.

For the opted-in store, save and update both append to the **existing pendingWrite**, not a second queue. A queued update evaluates its callback once against a detached actual committed value at its disk turn, after the previous success/failure. No optimistic cache/displaySnapshot is published. Run existing recovery-copy/atomic replacement/precondition machinery; only after primary replacement succeeds publish the new committed cache and audit. Failure leaves the prior committed cache intact. A subsequent mutation still runs after a failed predecessor. Do not call `store.save` recursively from the queued callback or wait on this queue from its own task.

No guard prepare waits for UI, name activation, grants or another queue. Checks are synchronous, non-mutating, idempotent and bounded, repeated at entry/turn/temp creation/every rename attempt. One intent is reserved earlier, never from a precondition. The proposed UI authority receipt and membership mutation admission capture a per-operation monotonic deadline (proposed 10 seconds, no added timer/retry or extended existing timeout) refuses stale work at subsequent boundaries. It bounds the validity of naming authority at checks, **not uninterruptible OS filesystem latency**. A stuck fsync may delay durable settings mutations already behind it on the existing disk queue; it must not delay immediate live stop or depend on name metadata completing. Do not claim an expired operation stopped I/O already underway or that failure means no temporary file was written. Before primary rename failure means no primary commit; after it, the outcome is committed/partial.

The 10-second naming admission bound is a new proposed guard constant, not a change to hello, heartbeat, retry or settings-store timeouts. Review it explicitly; it is not an approval to increase a deadline. Tests use a mocked monotonic clock, never real sleeps.

## One guarded field patch, no silent split

Inside the existing settingsWrites turn, capture baseline and cloned requested settings. Normalize the deprecated enabled field using existing migration, then compute the exact field set whose value/presence differs. Alias intent compares the effective preference separately. If it changes, reserve one durable original intent and make **one atomic patch** containing all requested field changes, including any switch change. Do not persist an unguarded subset after refusal.

At the existing disk queue turn, obtain actual committed state. For every touched field, require the current value/presence still equals the captured baseline; conflict rejects the entire save visibly. Untouched fields rebase onto actual current values. Optional-key absence differs from an explicit value. No-op fields do not overwrite newer committed values. A same-value Alias in an ordinary save is not explicit intent and does not access name health; USE_LOCAL_ALIAS and Rename are explicit operations even for the same string. A concurrent loopback update of an untouched field survives. A concurrent loopback change of a touched field refuses the whole Alias transaction. Existing loopback rollback still requires its expected delivery hash and cannot restore over a newer committed change, even if its Alias text happens to match.

Return the actual committed before/after pair from the queued patch, then pass that pair into existing settingsChanged/applyNetworkSettings. This prevents stale requested switch values re-enabling a concurrently disabled runtime. Preserve the internal abortControllerReads-before-devicesChanged order in applyNetworkSettings; a label event must not precede a required lease retirement.

## Accepted-intent witness and failures

Propose private `memberNameIntentCommit` metadata in the Annex settings file, hidden from AnnexSettings/GET_SETTINGS/preload and ignored by the Settings audit value list. It contains only the exact local pending intent id and target epoch; no authority token or remote settings entry point. Ordinary full saves must preserve it internally and strip/reject caller attempts to supply it; an accepted guarded patch writes it atomically with the preference. Emergency disable/purge explicitly clears it in its durable committed mutation. A repeated Alias string cannot manufacture this witness.

The proposed `assertLocalAliasIntentCurrent` checks pending id/epoch before settings commit; `activateLocalAliasIntent` additionally checks the accepted settings witness id/epoch at its atomic commit and publication boundary. Direct Rename/USE_LOCAL_ALIAS are single-store operations and do not fabricate a settings witness. Recovery requires pending id == accepted witness id, exact epoch and after-preference, and valid naming store initialization. A refused/pre-primary-failed intent has no accepted witness, so later text equality cannot activate it even if cancellation persistence failed. Disposal removes only its own pending id. A newer witness or intent is untouched. Startup recovery uses the original stamp and is separately guarded by current membership/network eligibility; it never reuses an IPC receipt or freshens ordering.

If settings primary replacement succeeded but metadata activation failed, report typed `name_unconfirmed` and retain the original pending operation/witness for recovery. Do not claim rollback, clear a newer winner or undo runtime security effects. If emergency supersession retired the accepted witness, the old pending intent cannot recover even if the text still matches. If a crash precedes the durable emergency clear, the live stop occurred but its persistence is unconfirmed; no cross-file fsync cancellation guarantee is claimed.

This metadata is an additional proposed Annex settings-wrapper/store hunk, beyond the already cleared optional precondition passthrough. It is not cleared merely because it is private; the precise serialization/hiding and failure tests require review before product code.

## Emergency supersession and actual live-off evidence

Actual current source: server.stop increments serverGeneration, cancels pending listeners, resets controller chat reads, closes inbound membership channels and removes inbound control authority; client.stopClient first sets controllerReadsRunning=false and aborts reads, removes the connection source, disconnects satellites, closes outbound membership/control and stops discovery. `networkChannel.closeFor` synchronously removes each channel; `handle` refuses work for a channel absent from its set. These are source observations, not executed stop proof.

No existing exported receipt was found that covers both emergency handler admission and a queued settings runtime apply. Propose a handler-local emergency generation, incremented **before** existing stop calls in disable and purge. Capture it for each SAVE_SETTINGS/USE_LOCAL_ALIAS/UI Rename and propagate it through guarded intent commit, runtime apply, activation and ACK checks. Captured remote name work remains bound to the actual channel membership token; after stop it is no longer current. MCP naming also observes current membership/runtime supersession in addition to its actor authority.

An old continuation admitted before that emergency cannot re-enable the server/client or activate an intent afterward. If supersession is detected before primary rename, refuse the whole guarded Alias write. If primary settings commit already happened, mark committed/partial and suppress stale runtime enable and name activation; execute no compensating settings overwrite, preserve the immediate stop and queue the emergency committed mutation. Retire the matching accepted witness; a failed retirement is explicitly unconfirmed and pending recovery cannot be claimed safe until durable state is known. Do not reactivate by comparing text.

A **new explicit enable after the emergency** captures the new generation and remains allowed under existing authority; the generation is not a permanent stop flag. It still obeys queue order and touched-field checks. No new server/client lifecycle branch, power setting or permission bypass is proposed. The handler generation, emergency retirement path and exact post-primary partial semantics require P7w review; the patch is not yet proof they are complete.

## Required discriminating execution after approval

- Hold Alias B before primary replacement, externally disable: real controller-read lease aborted, incoming and outgoing channels removed and late frames/commit callbacks refused **before** durable persistence resolves. Guard refusal must not publish B in cache, settings primary, any external update, name projection or activation.
- Repeat with Alias+enable, purge, and same-URL navigation away/back. Release stalled flush, then verify durable disable and raw committed preference; a deliberate later enable succeeds.
- Both disk failure orders, first failure followed by repeated/no-op disable, and failed cleanup. Newer committed values survive; queue continues; no old witness can activate by later equal text. Mutating the implementation back to optimistic publication must make this negative fail.
- Loopback forward/rollback interleaved before/after failed Alias; touched conflict refuses whole patch, untouched fields survive, and grant/expected-state checks remain effective.
- Metadata reservation stalled or failed does not delay immediate emergency stop or cause an emergency call to await name health/activation. Existing pending disk I/O may still delay durable persistence and is reported honestly.
- After-primary activation failure and emergency supersession return typed partial/unconfirmed outcomes, preserve actual runtime apply/lease ordering, original stamp, correct witness ownership and independent newer intents.
- Default-store compatibility and opted-in committed-cache controls, audit order, unknown/private field hiding, absent-key conflict, repeated same Alias/no-op behavior, retry-boundary navigation and deadline checks.

No test has run for this proposed source contract. Approval of the direction is not shared-code clearance or a green race result.
