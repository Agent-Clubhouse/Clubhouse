# Reverse handoff sync: corrected contract confirmation

**Verdict: APPROVE / IMPLEMENTATION-READY at the design boundary.** The exact corrected contract `6385c5ead359d3b46bfc7895e889d4a486dedc4e` resolves D1 from [513d71d](https://github.com/Agent-Clubhouse/Clubhouse/blob/513d71d1666baf865714a8ab874bf849d01d651b/docs/qa-transfer/2026-11-22/reports/handoff-sync-a9bc-independent-design-review.md). No concrete remaining contradiction in the reviewed corrections. The owner may implement the bounded four-file candidate under the existing assignment and gates; this is not approval of unseen production code, a PR, activation or full handoff/duplex behavior.

## Exact object and correction-only scope

Read the full corrected [contract](https://github.com/Agent-Clubhouse/Clubhouse/blob/6385c5ead359d3b46bfc7895e889d4a486dedc4e/docs/evidence/3613-handoff-sync-contract-r2/README.md), blob `9bc0c2ce9314bc69971efe69aa6eaee4e7259d8f`, SHA256 `1f03af2d15c2165c33a99a7c616ca58983fcc9aa7d16558025e9a7d1a8fea796`, and source map blob `0f1cbba4101400bf4fd647a44abfc76f8e0a1db4`, SHA256 `bd19cf601adcdecdbb0dc233cf6b21a6af6cc9b0a44147be504c9df7f874bf7c`.

The corrected document is in **`docs/evidence/3613-handoff-sync-contract-r2/`**; the old `.../3613-handoff-sync-design/README.md` remains the preserved original three-file proposal. This is a distinct successor, not a retroactive rewrite of the original verdict.

- Exact contract tree: `9cb08c0809e15020962e4b724cb2c81dee51cbeb`.
- Parent: `a9bc18116af5b0e7b6467601d323fccfad23d85c`.
- Source checkpoint: `c2a59f9f2c872bf2cb1fe9852adf8c92f2a996fc`, tree `33d3dfed92deaa3e159a46f41d79ce8287149ba8`.
- Independently checked all **12** source/test identities: actual immutable blob, byte length and SHA256 match both source checkpoint and contract commit. The only new paths relative to the previous contract are the two corrected-contract documents. No production, test, compiler/dependency/config or accepted lower-proof delta.
- Authorized `gh` commit readback independently matches the supplied tree and parent. No connector, product edit, test/compiler/lint/CI/app execution, lower-proof rerun, access/login change or helper probe.

## D1 closed at contract level

The successor expressly adds `handoff-command-store.ts` to the three originally proposed production files. Optional synchronous main-only guards are passed through `HandoffCommandStorage.acknowledge/remove` and execute inside the actual command store's queued `change`, after queue acquisition and before updater/validation/save admission. Undefined guards preserve current direct/local/default behavior. The queue must remain usable after a refused operation.

Coverage is no longer caller-only or first-leg-only: original transport capture follows receiver ACK, sender terminal ACK, all response-driven primary removals and secondary-cancellation adoption/ACK/removal. The new reverse acknowledged map advances only after **real guarded durable ACK success**, with explicit failure if that capability is absent. Queue/guard/save refusal cannot leave the reverse map falsely advanced; unrelated direct optimistic ordering remains out of scope.

This meets the concrete fourth-file/ordering correction. The previously identified ordering is now a required executable discriminator: hold an earlier actual command mutation, enqueue ACK/removal, retire, release, verify refusal without that operation's state/disk mutation or premature reverse memory ACK, plus unrelated queue progress and a killed guard-removal mutant. That proof is **planned, not run**.

## Admission versus admitted commit: accepted semantics

The contract selects the precise queue-admission model requested in513d:

- Original guard refuses stale work **inside** the history or command owning queue before its decision/updater/save is admitted. Older-prefix/no-op history acceptance is included.
- An admitted operation may finish saving after retirement. Successful save publishes matching committed memory and returns the truthful committed result; no post-save stale check pretends it failed, drops only memory, rewrites older disk or erases receiver-authored history.
- A later ACK, deletion or POST gets its own admission check using the same original capture. Its refusal does not undo an earlier admitted/committed operation.
- Actual storage failure/ambiguity remains an actual error and existing committed-store behavior. There is no success-shaped ACK, guessed absence of delivery, attempted-marker restoration or invented rollback.

Consequently this approval does **not** assert that authenticated authoritative history can never persist after transport retirement. It may do so once already admitted. No continuous liveness through rename/fsync, cross-instance/crash locking or power-loss proof is inferred. Implementation tests must distinguish a deterministic precommit failure from an ambiguous IO result; an injected error alone must not be relabeled proof that disk was untouched.

## Concrete owner and stop boundary

The named host-local per-invocation `HandoffSyncOwner` has original transport capture, narrowly scoped negative authority lease, sticky retirement and references. The enclosing sync holds ownership through actually awaited history/command queue work. Each POST obtains an additional hold **before** deadline scheduling; that hold is released only by the actual operation's settlement `finally`, including guard/signal refusal. Outer deadline rejection releases no outstanding operation hold. Disposal occurs once at zero references; retirement/disposal never makes an old check current again.

The actual scheduled microtask checks the original capture and expired signal immediately before `postToMachine`. It cannot silently recapture a route, epoch or cancellation identity. The original five-second/512KiB boundary stays intact. The durable attempted marker remains conservative if it committed before retirement despite a locally known zero-POST path.

Normal stop retires new reverse admissions and drains enclosing owned work capable of queued mutations before replacement may own those files. An operation still outliving its deadline retains its separate lease hold until settlement but has no ended sync continuation able to admit writes. This is a concrete bounded ownership contract, not an assertion that `Promise.race` drains transport or that merely releasing a caller's promise drains storage. Exact implementation must prove this with held actual work; no new global framework or shared storage modification is necessary or approved.

## Authority and notification corrections retained

The full original positive `authorizeOutgoing` and pending-command exception remain mandatory. The existing `transferAuthority` negative fence stays limited to reverse, original **local** sender, remote destination, offered record, no pending cancellation. It neither imposes receiver acceptance/incoming-server permission nor authorizes outgoing work by itself. Grant-independent history/ACK and cancellation keep their existing exceptions; original transport capture still guards their separate legs/queues. No incoming/content/helper generalization is accepted.

The chosen notice model is now unambiguous: **normal notification of retained committed authoritative history**, rather than attempt-scoped final-sink transport admission. An unadmitted stale reply creates no new committed version or notification for that version. An already committed version remains queryable and can be notified through normal local eligibility/participant/runtime checks and later independent sweeps, even after transport retirement. The document explicitly does not claim that the transport check fences subsequent notice/federation/label/runtime awaits. No Q5 notice-ledger redesign, false delivery-strength claim, automatic acceptance/apply/wake or new permission follows.

Direct behavior, global `isMachineConnected`, listener,30-second bounded sweep, single-flight and10-slot fairness remain unchanged. Request-only reverse readiness is sufficient transport availability without a snapshot receipt; it is not handoff authority or an immediate-ready-event guarantee.

## Remaining gates and preservation

The corrected contract's finite real-queue/attempt-store/paired assembly controls, host baseline discriminator, grant/binding/epoch/host retirement, secondary cancellation, actual-operation timeout/ref disposal, normal-stop drain, save/admission distinction, missing-ACK capability and retained-history notice controls remain **unexecuted obligations**. Exact implementation, changed-risk tests/mutants, appropriate type/lint results, source/evidence review and ordinary PR/hosted gates still precede any landing. The separately approved lower transfer proof at74d2 remains unchanged and is not re-reviewed or upgraded to host/coordinator/grant/app acceptance.

Review publication only. Local Q5 WIP remains clean on `auto-reset-policy-design/q5-framed-root-journal-wip` at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`. Original Details workspace and all prior immutable refs are preserved. No new user product choice, account access or routine GO is required for bounded implementation within this reviewed contract.
