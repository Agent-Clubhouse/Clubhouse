# Reverse handoff sync: corrected four-file admission contract

**Contract only; no production edits or new execution.** This supersedes the
three-file proposal at `a9bc18116af5b0e7b6467601d323fccfad23d85c` in response to the
fully read [513d71d boundary review](https://github.com/Agent-Clubhouse/Clubhouse/blob/513d71d1666baf865714a8ab874bf849d01d651b/docs/qa-transfer/2026-11-22/reports/handoff-sync-a9bc-independent-design-review.md),
blob `17a96db555a39ec04b60da7912291019f67b239f`. Its D1 command-queue and optimistic
reverse ACK findings are incorporated below. The original design/proof refs are
immutable; exact implementation/proof still requires independent review.

Source checkpoint remains `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`. The accepted
lower-layer source/proof is `a4074c7f5e76714bbe346ecee1acfc434307de0e` /
`be01f8bd511dba2a625462021732c119ce6b170e`, reviewed at
`74d2ed4f64c1e9d539339e5a75b7c3c31171e8b3`. Reuse it only by exact identity; no new
native-grant, coordinator, mutation-isolation, product or full-duplex credit.
Its owner original-consumer test-body hash removes terminal whitespace; the
independent raw test-body hash includes the final newline. These are distinct definitions,
not falsely identical raw hashes. The prior81,937 bytes remain envelope fidelity.

## Scope and transport, not authority

Exactly four private production files are proposed:
`handoff-host.ts`, `handoff-coordinator.ts`, `handoff-service.ts` and
**`handoff-command-store.ts`**. Focused existing host/coordinator/service/command
tests and bounded paired assembly tests cover them, with related desktop docs.
No Q5, shared settings store, client/control transport, protocol/caps, grant-store,
renderer, federation, Naming or selected-board expansion.

Do not redefine `isMachineConnected` or direct publication. Existing direct/local
callers retain their current behavior, optional guards undefined. A handoff-local
reverse attempt captures, once: eligible network peer, direct absence, current
`getControllerReadObservation` revision and original host instance. That observation
already incorporates pinned trust/accepted-link epoch; it grants no handoff or
snapshot authority. Recheck the same capture after awaits; never reselect or adopt
a replacement within this invocation. The next ordinary invocation may capture a
new route while retaining the original logical offer/cancellation identities.

Keep the full original `authorizeOutgoing(record)` decision and its current
pending-command exception. For **reverse, original LOCAL sender, remote
destination, offered record, no pending cancellation** only, the existing
`transferAuthority` is reused unchanged as negative revision/binding invalidation
around async lookup. The review confirmed compatibility for that precise scope:
no receiver acceptance/grant is required, local server/acceptHandoffs is not a new
outgoing prerequisite, Dispatcher targets retain their original semantics.
The negative fence never grants permission. Do not apply it to incoming/content,
post-acceptance history/status, ACK cleanup or cancellation taking the exception.
Conservative broad notification invalidation ends an attempt, not future rights.

The same original **transport capture** guards every primary/terminal/secondary
leg and queue. Fresh-offer negative authority checks additionally run where that
fresh-offer gate applies; they must not turn grant-independent history/ACK or an
existing cancellation into a fresh-offer permission test. No new capture can
replace either original fence merely because current readiness became true.

## Exact queue admission and commit semantics

| Phase | Required rule |
|---|---|
| Before actual queue admission | A retired original guard throws inside the owning queue, before accepting the decision/updater/save. That operation makes no history/ACK/removal mutation; no false reverse ACK memory or new-version notice is credited. Enqueue-time caller checks alone are insufficient. |
| After admission, before/during save | Retirement is permitted. The admitted atomic operation may complete; success publishes matching committed memory and returns its actual committed result. No post-save guard may pretend the save failed, drop only memory, restore an older disk snapshot or erase receiver-authored history. |
| Save failure/ambiguity | Surface the real storage error and existing committed-store behavior. No success-shaped ACK, guessed rollback, invented no-delivery proof or restored never-attempted marker. |
| Later distinct operation | A successful history/ACK commit does not admit a later deletion, POST or ACK. That next operation independently checks the same original capture at its own admission. Its refusal does not undo earlier committed results. |

**History:** optional synchronous `beforeAdopt` in `receiveSnapshot` runs inside
the actual `HandoffStore.transact` callback before newer-history or older-prefix
acceptance. Parsing, source/id validation and complete history-extension checks
remain. There is no new await between guard/validation and that admitted decision.
The store's subsequent existing await/save is not retroactive revocation.

**Commands:** extend coordinator-owned `HandoffCommandStorage.acknowledge` and
`remove` with optional synchronous main-only guards. Forward them to
`HandoffCommandStore.change`; invoke after that store's existing lock is acquired,
before the updater, validation and save are admitted. Do not serialize callbacks
or change shared storage. Undefined guard preserves existing callers/direct/local
defaults. Guard failure leaves that ACK/removal's committed command state and disk
untouched; the actual queue remains usable by unrelated jobs.

Pass the same original transport guard to receiver ACK, sender terminal-history
ACK, every response-driven primary cleanup/removal and every secondary
cancellation reply's adoption/ACK/removal. Do not gate only the first command or
replace a queued guard with a check before calling the API.

**Reverse ACK memory:** await a real guarded durable ACK success **before**
advancing the new reverse `acknowledged` map. Missing ACK capability is not durable
success; fail explicitly. Guard/save refusal cannot leave the map advanced.
After admitted ACK success, publish the corresponding map result even if the
route retired during save; no post-save fake refusal. Unrelated existing direct
optimistic ACK ordering is unchanged.

## POST ordering, attempt marker and actual-operation owner

Capture before initial authorization. Check after authorization, before/after
the awaited attempt marker, and before each POST. The host's actual
`withCapacityDeadline` operation checks the same capture **and its expired signal**
inside the scheduled microtask immediately before `postToMachine`. Keep existing
route/status handling,512 KiB limit,5-second deadline and request signal. Every
secondary cancellation leg uses the original owner/checks after all intervening
adoption/ACK/removal awaits; no new epoch or new cancellation ID is selected.

The attempted marker remains conservative. If `markAttempted` already committed
and admission retires before any POST, retain attempted state even when the
known local path sent nothing. No undelivered-marker restoration. Same-ID sync
and cancellation serialization, immutable retry history and exception semantics
are preserved.

Concrete owner: a **host-local `HandoffSyncOwner` per captured reverse invocation**,
not a shared deadline/lock framework. It contains the original transport capture,
optional narrowly scoped negative authority lease, sticky retirement state and
refcount. The coordinator holds one enclosing-sync reference through all actually
awaited history/command operations. Before scheduling each deadline-wrapped POST,
the host acquires a separate actual-operation reference synchronously.

The actual scheduled operation releases its reference from its own settlement
`finally`, including pre-POST guard/signal rejection; outer deadline rejection
does not release that reference. The enclosing sync releases only its own hold.
Exactly one final disposal occurs when all references are gone; disposed/retired
owners never become current again. Late rejection is handled, not an unhandled
promise or guessed successful settlement. Actual queued work remains held by
the enclosing reference until its queue result settles.

The original host owns these reverse sync completions locally. On normal stop,
retire new admissions and drain enclosing reverse sync work that could own queued
mutations before handing its files to a replacement host. A posted operation that
outlives its deadline retains its separate lease reference until actual settlement,
but cannot admit later writes from the already ended sync. No new global lock,
host restart or transport drain is introduced. A replacement is not allowed to
write around an old admitted save. If the bounded host-lifetime proof cannot show
this ownership, report the conflict rather than expand shared storage or assert
cross-instance/crash locking that was never proved.

## Chosen notices: retained committed history

Choose **normal notification of retained committed authoritative history**,
not attempt-scoped final-sink transport admission. Only actual committed store
history can enter that path; an unadmitted stale response creates neither a new
agreement/version nor its notification. A retired transport cannot erase a
committed version; its existing normal local eligibility/participant/runtime
checks and later independent sweep may notify it.

No transport check is claimed to cover the later awaits in `changed`,
`notifyRecord`, notice claims, labels, federation publication or runtime delivery.
Do not add attempt guards to that ledger or redesign Q5. Tests distinguish no
new-version notice for unadmitted stale replies from permitted normal notification
of an admitted/committed version after retirement. Do not infer runtime/provider
delivery strength, automatic acceptance/apply/wake or new permissions.

## Finite exact assembly proof after contract correction

Reuse74d's unchanged lower proof by identity; execute only new assembly risks:

1. Genuine original-host reverse-ready/direct-false/no-snapshot offer failure;
   candidate real coordinator/service/attempt-store/pinned request behavior,
   old/no-control and unchanged direct controls. Fixture grants/preparation/
   route/app boundaries remain explicit.
2. Held authorization and actual POST microtask; withdrawal/restoration of
   grant/binding/peer/trust/epoch/host; expired signal; attempt marker committed
   before retirement with zero POST and no undelivered restoration. Include
   permitted Dispatcher with local server/acceptHandoffs off, connected ordinary
   target, unconnected ordinary refusal and cancellation/history exceptions.
3. Hold an earlier **actual history-store queue** job; retire before queued
   adoption/older-copy guard executes and prove no mutation. Separately admit,
   hold actual save, retire, complete and compare truthful disk/committed memory.
   Include conflicting/refused history and actual save failure.
4. Hold an earlier **actual command-store mutation**, enqueue each guarded
   ACK/removal, retire, release; prove no ACK/deletion or premature reverse map
   update and unrelated queued progress. A queue-guard-removal mutant must fail.
   Separately retire after admission during actual save, prove allowed matching
   disk/memory and subsequent original-capture POST refusal. Save failure cannot
   advance the reverse map or remove a command.
5. Cover primary terminal cleanup and every secondary cancellation across held
   primary adoption/ACK/removal, retaining original IDs and no new-epoch leg.
   Separate never-attempted local cancellation from uncertain attempted delivery.
6. Expire outer deadline with actual operation still held; references/listeners
   remain until actual settlement, dispose once, no stale new adoption/version
   notice, no unhandled rejection. Prove normal host stop/replacement cannot bypass
   owned admitted mutations. Test chosen retained-history notices, not a coarse
   caller-check proxy for final delivery.

Keep original30-second sweep/direct listener, single-flight and10-slot fairness;
no immediate request-only readiness-event promise or new poller. No standalone
matrix/PR/CI is started by this contract. Exact implementation, real-queue
discriminators, changed-fixture typing/lint and source/proof go to independent
review before coherent PR/ordinary hosted CI. All listed tests are **not executed
here**, and continuous liveness through already admitted disk commit, generic
cross-instance locking and native/two-host/full-duplex acceptance are not claimed.
