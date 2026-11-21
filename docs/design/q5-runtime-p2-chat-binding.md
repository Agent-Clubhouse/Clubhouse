# Q5 runtime P2: source-bound chat interface preparation

**PROPOSED; no consumer implementation or acceptance.** This freezes the next
bounded host-owned P2 interface/hunk preparation against merged P1. It neither
enables tracked production delivery nor supplies Q5's missing journal primitives.

## Exact foundation and limits

- Fresh `main`: `c43ffb37d20650c542e449a8a04a9fd84e65b655`, tree
  `0193de3b749c243667983176c9807b9fe9749f8e` (squash of PR #3769).
- P1 executed source `0d07e07e36d144d4668bec378f2faf3e06d59695`, evidence
  `4e576b9e9287f5962120816f61e16f45085becd2`; the merged tree is identical.
- [P1 successor QA](https://github.com/Agent-Clubhouse/Clubhouse/blob/70d1a31a906f3a6bc8ac08a51be25e14d3e01dab/docs/qa-transfer/2026-11-20/reports/q5-runtime-p1-pr3769-0d07e07e3-review.md),
  SHA256 `5be7fe839b23cbe18dd8320c972399d153d3acfc2a154df188fcec2951dac71c`.
  [Ordinary hosted run 44945220344](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44945220344)
  succeeded with 33 successful / 4 explicitly skipped jobs. This approves the
  unwired P1 only, not P2, provider/journal behavior or phone.
- Frozen binding contract `8a0eb833e81956e3a0e2674fc276e028587d8c64`,
  `docs/design/q5-runtime-coordinator-binding.md`, SHA256
  `8c14df58a7ba2dc08db1fff3a6f074073ee00b3cea98b3901fd4d68e65f507d6`.
  Its P2 row defines independent chat dispatch state, post-await final entry,
  captured publication and Codex ticket/no second tracked leg.
- [Q5 typed concurrence](https://github.com/Agent-Clubhouse/Clubhouse/blob/b05c927a16e49d243fcdec8fe72e19d8f3125669/docs/evidence/q5-foundation/runtime-8a0-ledger-concurrence.md)
  `b05c927a16e49d243fcdec8fe72e19d8f3125669` remains interface concurrence only.
  Real marker/loss-claim, ACK-first arbitration, historical adapter and
  post-intent constructor-refusal handling remain P5.

P2 may prepare the chat host and Codex seams below. P3 PTY/dormant command entry,
P4 Claude/Copilot native gates, P5 consumers/grants/journal and P6 recovery remain
separate reviewed dependencies. No initial backend ACK mapper is approved.

## Current source, not assumed interfaces

| Current source on `c43` | Observed boundary |
| --- | --- |
| `shared/chat/runtime.ts:115,130,386` | Result/receipt types exist but are unused; send options have no handoff; driver send still returns only `MessageDelivery` |
| `runtime-coordinator.ts:200-260,389-496,608-629` | Sole owner/notice ports; registry checks, bind-once queue/publication, live-only entry and ledger-free transport tickets |
| `chat-runtime.ts:169-230,663-784` | Queue slot plus mutable session/publication fields; direct send captures a session but has no final original-ownership recheck after prompt/causal waits |
| `chat-runtime.ts:807-837,904-1037` | Removal/expiry/discard use queued items; `pendingDispatch` is cleared at 1002 before causal activation awaits at 1008 |
| `chat-runtime.ts:1300-1348` | Emit-chain/media waits precede stamping mutable `this.sessionId` and incrementing `this.seq` |
| `chat-runtime.ts:295-410,1055-1154` | Opening, stop/abandon/replacement; failed close can restore reachable `this.session`, which must not restore old tracked authority |
| `chat-spawn.ts:659-766`; `index.ts:12-20` | Construct and register the actual chat runtime before `runtime.start`; stale cleanup is conditional on that exact runtime |
| `codex-chat-driver.ts:484-541,636-648` | Slash review/compact plus normal turns; a failed steer can currently fall through to turn start; close captures this driver's client |
| `codex-app-server-client.ts:157-174,194-229` | Typed request is a cast over raw RPC; pending/timer registered before the native send |
| `ndjson-rpc-base.ts:153-155` | Missing/nonwritable stdin silently returns on the legacy path |
| `group-project-delivery.ts:366-411` (Q5, read only) | Current legacy consumer acknowledges from mode/Action callbacks and retries caught failures; no runtime handoff construction |
| `ipc/chat-handlers.ts:168-186` (read only) | Validated values become literal `{ source: 'user', delivery }`, not a spread of external options |

The existing client queue and Action receipts are not lifecycle/settlement
authority. The real Q5 consumer must stop deriving ACK/retry from those old
outcomes before it enables the new trusted field.

## Proposed shared signature delta

Reuse P1's existing types; do not introduce another allocator or controller.
Only the host edits `src/shared/chat/runtime.ts`.

```ts
interface RuntimeSendOptions {
  // Existing fields stay unchanged.
  handoff?: RuntimeHandoff; // Trusted main only; registry authority, never wire data.
}

send(
  content: ContentBlock[],
  delivery: MessageDelivery,
  admission?: RuntimeTransportAdmission,
): Promise<MessageDelivery | RuntimeDriverSendResult>;
```

The first block shows the added field, not a replacement interface. The second
is the proposed `ChatDriverSession.send` signature. Existing untracked drivers
may return their mode string. The runtime unwraps a tracked internal result into
the existing `RuntimeSendResult`; no public delivery/event/Action enum changes.
Optional receipt fields are not permission to manufacture a receipt.

At actual `sendMessage` ingress, a supplied value must pass
`runtimeNoticePort.isRegisteredHandoff` before reading its dispatch identity,
calling its methods, entering causal work or invoking a driver. Before passing a
ticket to a driver, main checks `isRegisteredAdmission`. Structural brands,
clones and matching IDs are insufficient. Do not widen preload, IPC, tools,
Actions or Annex payloads to accept this field.

## Proposed host-owned record and linearization

A private independent dispatch record retains the **issued** handoff, captured
live lease and exact `ChatDriverSession`, one exact queue/message object, captured
publication context, original pending-turn token and queue eligibility/expiry.
It stays reachable while prompt/causal/driver work is awaiting, even when the
client queue slot is empty. It does not copy P1's entry/loss state machine.

1. Q5 performs authorized prechecks, captures the original lease/admission,
   durably saves intent, rechecks that original authority and creates one handoff.
   Runtime never reconstructs it from text, queue/action ID or max sequence.
2. Host accepts only that already-registered object, binds queue and publication
   once through `runtimeOwnerPort.bindQueue/bindPublication`, and retains its
   independent record. It does not issue a second handoff. Create its registered
   transport ticket with the original live lease's resource before the marker.
   P1 keeps that ticket disallowed until successful entry: pre-marker checks use
   registration/original ownership, not `ticket.allowed()` as an admission test.
3. A tracked queued request stays in the removable host queue. It does not merge
   with another tracked attempt, nor with an untracked MCP tail. Preserve existing
   untracked coalescing/preamble/Action behavior.
4. After every prompt/causal/work wait, the final gate checks original session,
   generation/live resource, scoped admission, exact queue record, eligibility,
   expiry and publication ownership. `pendingDispatch` presence is not proof.
5. Then call the registered `handoff.tryEnter()` synchronously. No await occurs
   between `entered` and the captured driver's send invocation with its ticket.
   Native code checks that same ticket and its own original process/SDK witness.
6. Removal, expiry, replacement, close and send failure retire the same handoff
   through `runtimeNoticePort.retireHandoff`. Never invoke loss/settle twice using
   its informational return. Reuse `lossSettlement`'s actual promise when awaiting.

Pre-entry refusal is an explicit operational failure, not a success-shaped public
mode. `journal_owned` produces no second loss hook or replay. Unexpected marker
throws stay UNKNOWN and surface their original error. After adapter-early entry,
every later refusal/failure/unverified resolution is UNKNOWN, even with zero
native bytes. No ready revival, resend or capability recapture follows.
A false native ticket never establishes whole-attempt unsubmitted/nonentry.

`createHandoff` can refuse **after Q5 already saved intent**. Its
`RuntimePreIntentRefusal` name does not prove no intent/nonentry; Q5 must reconcile
the original attempt itself when no runtime handoff exists. That P5 operation is
not replaced by a runtime callback or an error-string interpretation.

## Opening, ownership and publication review points

The host needs a main-owned installation/owner record, not another
`registerOwner` call for every facade or a post-await `getAgentRuntime` lookup.
P1 registers an owner once per agent and advances it through owned transitions.
The exact owner lifetime and chat-spawn/index handoff must be reviewed before
implementation; no new owner authority is inferred from an equal agent ID.

Use `claimStart` before the original native open await and attach only its exact
returned `ChatDriverSession` witness. Stale completion closes only that created
session. Stop/abandon/replace closes tracked admission before the first
asynchronous cleanup. A close failure may preserve legacy session reachability,
but never revive the old lease/tickets. Re-admission requires explicit verified
ownership and a fresh start/lease: P1 can reattach the same native instance only
for its original owner/agent after the former frame is no longer current.
No automatic grant restoration or new mission-bearing argv path is proposed.

Captured publication context includes conversation ID, sequence owner, resource,
trace/display context and exact session. The owned emission path checks before
entering emit work, after emit-chain/media awaits, before transcript submission
and again before current Details/UI/listener mutation after append IO. It cannot
stamp a new `this.sessionId`, consume a replacement sequence counter or clear a
replacement pending turn. Already-submitted old-history IO is not undoable;
current publication after replacement must still be suppressed.

If a mode-only resolution is still eligible for ordinary user-message/display
projection, publish under that original context before terminal UNKNOWN
retirement. Displaying a mode does not acknowledge the attempt. Do not bypass
P1's retired publication guard afterward to recover UI through a new context.

Preserve concealed-tool filtering and current media/privacy policy. Suppressing
stale UI does not discard an original historical receipt: any future approved
source goes to its original attempt-only sink separately. No current-member/
publication check becomes journal ACK authority.

## Codex-only native boundary in this piece

Capture the original client, thread and native process/stdin for the issued
ticket. Carry the same trusted internal fence through `turnStart/turnSteer` and
message-triggered review/compact to the final original NDJSON write. It is an
internal request option, **never serialized into JSON-RPC params**.

The tracked write validates that exact process/stdin, liveness/writability and
ticket immediately before writing. Missing transport explicitly refuses and
cleans its pending request/timer; it cannot succeed through the legacy void/no-op.
Untracked requests retain existing defaults.

If the first tracked steer rejects after runtime entry, `turnStart` count must
remain zero for both ambiguous RPC errors and typed pretransport refusal.
An initially idle steer may choose a single first `turnStart`; it may not take
a second leg after invoking steer. Existing untracked stale-steer fallback stays
unchanged. Slash command branches must not drop the ticket, and command replies
do not become message ACKs.

Raw/cast RPC success, active-turn updates, local write, driver mode and optional
receipt shape are not an approved mapper. Initial tracked outcomes remain
UNKNOWN. Claude/Copilot native checks are P4: accepting the optional type in P2
does not claim their buffered/awaited ingress is fenced.

## Exclusive future hunk ownership

| Host-owned proposed P2 files | Boundary |
| --- | --- |
| `shared/chat/runtime.ts` | Trusted field / driver argument and internal union only |
| `agent-runtime/chat-runtime.ts` | Independent record, queue/gates/loss/publication and chat lifecycle |
| `agent-runtime/index.ts`; `chat-spawn.ts` | Exact chat installation/opening binding; no PTY facade/argv changes |
| `orchestrators/adapters/codex-chat-driver.ts`, `codex-app-server-client.ts`, `ndjson-rpc-base.ts` | Tracked-only original native fence, single leg and explicit refusal |
| Existing chat-runtime/Codex driver/client tests | Focused new race/negative controls plus affected legacy controls |

Q5 alone owns delivery/wake construction, exact coverage/attempts, historical
adapters, grant/store brackets and real journal APIs. Q5 supplies compatible
proposals, not overlapping shared runtime/type edits. Its reserved
`group-project-delivery.test.ts` is untouched. Generic async queues, PTY,
Claude/Copilot, Dispatcher recovery, IPC/preload/tools, phone and wire/schema
are not edited by this preparation.

## Required future evidence, not execution by this document

| Targeted control | Measurable result / negative control |
| --- | --- |
| Real main ingress and external literal forwarding | Fabricated/cloned handoff or ticket invokes zero supplied methods and zero driver/native calls; external payload cannot construct intent/handoff; shape-only guard mutant fails |
| Direct and queued prompt/causal waits | Revoke/reset/remove while held: zero pre-entry sends; remove-final-gate mutant fails |
| Queue slot cleared during causal activation | Independent record still retires once; classification comes from P1, not the slot; slot-as-nonentry mutant fails |
| Exact queue/coverage | No tracked coalescing or equal-ID adoption; unrelated/untracked messages retain defaults |
| Adapter-early loss / journal-owned marker | Post-entry rejection stays UNKNOWN/no replay; journal-owned adds zero loss producers; repeated callbacks retain the same failed/committed promise |
| Captured publication during media/append | No replacement ID/sequence/Details/listener mutation; mutable-publication mutant fails; historical sink remains separate without an ACK mapper |
| Codex steer/command/native write | No second tracked turn start, original process only, zero writes after invalidation, explicit nonwritable refusal with no timer leak; fallback/current-lookup mutants fail |
| Legacy modes and naming | Existing queue/Action/command behavior and public projections unchanged; include the unchanged Dispatcher copy guard that caught P1's diagnostics |

Use existing fake driver and mocked native RPC tests; no live provider/phone,
full local suite, local E2E, installs or spending is authorized here. Future
implementation proof must use the ordinary resource gate and structured
per-command before/after source/config/gate seals on the exact integrated head,
followed by independent consumer/hunk review. No automatic per-test PR matrix.
Targeted Vitest uses `lane-p2 4` and at most two workers; ESLint uses ordinary
min-4 admission. All production and fixture TypeScript compiler checks require
ordinary `lane-p2 6` admission (6 GiB minimum). Dependency restoration is allowed
only after an actual missing dependency diagnosis and normal min-6 admission,
not for this documentation.

## Source fingerprints for this preparation

All refer to `c43` above; they are source identity, not runtime proof.

| File | SHA256 |
| --- | --- |
| `src/shared/chat/runtime.ts` | `3d30b01c5a256a3f7d7b2735e1506ea18922c8c2bb0e55ab60a446aa4104bb32` |
| `src/main/services/agent-runtime/runtime-coordinator.ts` | `9107c5a2d55363479fc64f46becf8538a028dacb33a7fe1ca166cd19e8c065f0` |
| `src/main/services/agent-runtime/chat-runtime.ts` | `f4004b2168f61899b5f092e93e6e20e275a7538bfe4976107fb00ab04c1a9cf3` |
| `src/main/services/agent-runtime/chat-runtime.test.ts` | `f6c61bc2a37b22022a66ede936da4c69f4a741e1c4254a0168213cebcc74dad2` |
| `src/main/orchestrators/adapters/codex-chat-driver.ts` | `3227bdd02fb689301041972fc53d846330a0faea4d177aeb4fbbe746223d722f` |
| `src/main/orchestrators/adapters/codex-app-server-client.ts` | `949c55fd934f17f9570bc07306bb69fc8bbfbc5f239caf1e8aa121c4fa5be0ab` |
| `src/main/orchestrators/adapters/ndjson-rpc-base.ts` | `64a72662d7c392909d61ca7bdaadae9c73ec368d5b3c6c47211a6f8bf3df1fdb` |
| `src/main/services/group-project-delivery.ts` (read only) | `025a6fe24183b395a45b47aa19e414270853c9aee3175fd68285a2c5403ca016` |
