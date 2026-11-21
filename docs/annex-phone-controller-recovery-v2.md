# Paired-phone controller reads and recovery: proposed V2

**DOCS ONLY; implementation and capability advertisement remain on hold.**
This is a revised proposal for [#3760](https://github.com/Agent-Clubhouse/Clubhouse/issues/3760)
and [Agent-Clubhouse/Clubhouse-Go#626](https://github.com/Agent-Clubhouse/Clubhouse-Go/issues/626),
not an accepted host or phone implementation.

[Machine-readable V2](annex-phone-controller-recovery-contract-v2.json) is
normative together with this document. Proposal revision 2 still proposes wire
version 1: no version was advertised or accepted. The original three-file V1
publication at `ef636998ef3c73803f8861b15555f3b0c3928e87` is unchanged, including
its preassignment `focusedHostIssue:null`. [The committed findings table](annex-phone-controller-review-findings.md)
links exact inspected source; the full independent HOLD verdict is preserved
separately, not rewritten as a green review.

## 1. Independent gates and missing human policy

The existing direct authorizer checks current paired peer, controlling role and
pin. `controllerSurface` classifies the recorded kind/session-only owner/legacy
phone icon. Neither names a policy for previously hidden controller history.
`mobile-grant-requests` documents a human phone's authority to answer Needs you;
it does not define this new private read. Desktop `controllerChatAllowed` uses a
verified federation agent and its `agent.read` grant. Its structural read default
is not available to a phone.

The scoped executable path has **no established paired-human hidden-transcript
privacy/Off/Ask predicate**. Do not infer exemption from agent rules, apply an
arbitrary agent's rules to a human, manufacture an agent identity or create a
grant. The parent has escalated three explicit alternatives: interpret existing
paired-human authority with precise applicable restrictions; separately approve
a new privacy control; or defer. No implicit interpretation is selected here.

Until product/security names an executable authorized mapping, omit the read
capability and return no private body. Every applicable Off/Ask restriction must
be checked at admission and after IO; an unresolved, Off or Ask read decision is
not allow. The exact recovery operation authority is a separate decision:
read-only permission never grants reset/recovery.

A reviewed safe **read specification can proceed independently of recovery**.
Recovery additionally depends on actual sink admission and Q5 semantics. Neither
capability appears merely because the other is supported.

## 2. Immutable phone and target admission

Capture the authority-owned pairing incarnation, raw key/pin/role/pending/kind,
recorded phone surface and persistent/session owner, pairing metadata, host epoch
and accepted policy revision. Existing `PeerTrust` is useful but omits kind,
surface and session ownership. `AnnexPrincipal` omits incarnation.

The incarnation is a non-reusable **host-local authority identity**, not a new
wire field or permission. A real re-pair gets a new incarnation even with the
same fingerprint, certificate and timestamp; an idempotent spent-PIN reply does
not. Forget, revoke, expiry, server stop and authority replacement retire it.
Alias/label/read-only display projection never creates or renews authority.
Because naming may return projected peer copies, `getPeer()` object identity or
a display receipt must not be used as incarnation proof.

Capture the host-selected controller and the selected session's ownership.
Recheck these and the immutable phone lease after every awaited operation and
immediately before private output. New successful authorization of the same
fingerprint does not rescue an old lease. No private cached read or recovery
receipt may cross pairing incarnation; current fingerprint-only command caching
is not sufficient. Logs contain bounded codes, not content, tokens or paths.

## 3. Host-side generic mobile isolation

The new DTO is not `ChatEvent` and is never put on the generic event bus/echo.
Before generic mobile serialization, size omission, held-frame insertion or
replay insertion, classify the captured hidden-controller identity and exclude
its body, id and derivatives. This includes status/hook/snapshot metadata,
permissions/questions, errors, raw recovery notices, Q5 receipts/control and
`frame:omitted`. A phone must not recover them by using the old `replay` spelling
instead of `mobile:replay`.

No hidden entry may be stored as mobile-eligible generic replay or snapshot-held
data. If existing authorized desktop remote replay is retained, its entries are
in a host-enforced non-mobile audience partition, not a shared mobile-eligible
buffer that relies on client ignoring. Existing local desktop event-bus and
transcript consumers and desktop-only controller GET authorization remain
unchanged.

Prechange buffered/held entries need the same audience guard. Mobile replay must
retain a contiguous projected cursor/epoch domain or use the existing bounded
gap/fresh-snapshot behavior. Do not introduce hidden-id tombstones, claim a
partial replay is complete, or create a repeating reconnect loop. Actual epoch
composition and legacy behavior require negative proof before implementation
acceptance, not a phone wire guess.

Generic lookup, chat, event, attachment and command adapters continue rejecting
the hidden controller. Permitted visible-chat notices have the **visible**
identity and fixed text derived from observed recovery stages. They contain no
hidden id, provider error, raw request or Q5 retry/adoption information.

## 4. Complete-message page and fixed-title index

Proposed paths, only under an advertised supported read capability:

```text
GET /api/v1/mobile/dispatcher/controller/chat
GET /api/v1/mobile/dispatcher/controller/chat/sessions
```

The versioned read-only event profile admits final `agent_message` text without
`subagentId`, permitted user-authored plain `user_message` text, and explicitly
whitelisted fixed notices. `agent_message` is already the final text replacing
chunks in the source contract. Never publish `agent_message_chunk`, manufacture
a final event at a page cut or infer completion from turn/session end. Omit raw
mission/MCP/group/action/system instructions rather than copying their content.

Project allowed text first; redact known secret patterns and known host
identifiers/paths over the whole text before any presentation cut. Withhold
recognized unterminated/ambiguous secret assignments. No partial text is emitted
on the assumption that a later page can retract it. This is not arbitrary-secret
DLP: unknown sensitive freeform text may remain undetectable, which is part of
the unresolved human privacy decision.

Only the JSON V2 allowlisted page/event keys are emitted; no sender, physical
agent/native session id, command token, action, media-fetch capability or raw
provider metadata. The session index is separately projected, not spread from
`listChatSessions`. Every title is the fixed label **Controller session**. Counts
cover allowed complete messages, not raw thought/tool/Q5 events.

Strict unique query keys: `sessionId`, `beforeSeq`, `afterSeq`, `limit`.
Before/after conflict, unknown/duplicate keys and malformed/unsafe numbers reject.
Only the captured controller's indexed opaque session can be selected; no native
id/path or cross-controller alias. The source window contains at most `limit`
records (1..2000, default 500), selected before filtering. Cursor semantics in V2
make all-filtered/incomplete-only windows advance and retain a later final event.
Forward callers follow non-null `nextAfterSeq` before adopting sampled `lastSeq`
as the poll cursor. Backward cursors do not overwrite forward polling state.

Encoded UTF-8 JSON including the envelope accepts exactly 8,388,608 bytes and
refuses byte 8,388,609. Indivisible oversized text/index fails explicitly, never
truncates. Use existing bounded rate policy (burst 20, one token/second, 128
buckets, 60-second idle cleanup) with incarnation retirement. No GET wake,
session creation, subscriptions, fallback probing or retry expansion.

## 5. One runtime/session generation interface for recovery and Q5

The following is a **proposed host-private contract**, not implemented exports or
phone fields. `AgentRuntime` and `ChatDriverSession` name existing shared types.
The recovery/runtime-session lifecycle owns the sole generation authority per
runtime/session resource, including dormant ownership. Q5 consumes it and does
not allocate another generation or recovery coordinator.

```ts
interface RuntimeSessionGeneration {
  readonly hostEpoch: string;
  readonly sequence: number;
}

type RuntimeSessionLease =
  | {
      readonly kind: 'live';
      readonly agentId: string;
      readonly generation: RuntimeSessionGeneration;
      readonly runtime: AgentRuntime;
      readonly session: ChatDriverSession;
      readonly transcriptSessionId: string;
    }
  | {
      readonly kind: 'dormant';
      readonly agentId: string;
      readonly generation: RuntimeSessionGeneration;
      readonly resumeSessionId: string | null;
      readonly durableOwnerRevision: string;
    };

interface DispatcherRecoveryPlan {
  readonly work: RuntimeSessionLease;
  readonly resetChat: boolean;
  // Present only for the separately confirmed explicit reset.
  readonly visibleChat: RuntimeSessionLease | null;
  // Captured notice target, never a work-only reset/claim.
  readonly noticeChat: RuntimeSessionLease | null;
}

// Read-only synchronous consumer; never renews an expired lease.
type IsRuntimeSessionCurrent = (lease: RuntimeSessionLease) => boolean;
```

Sequence is monotonic/non-reusable within the host epoch; an exhausted/invalid
sequence fails closed. Runtime replacement, close or dormant resume replacement
retires the resource's token. `durableOwnerRevision` identifies the exact captured
resume owner; it is not a provider path or permission. Queue ownership additionally
uses the **exact queue-item object/attempt**, not just message id or group member.
All fields above remain host-private.

Phone, desktop fresh/clear and automatic repeated-failure recovery use the same
authority. After preparation, compare and retire the full set of captured
affected resources synchronously before destructive entry, with no callback or
await between comparison and retirement. Overlapping work/both/clear claims have
one winner. Default work-only retirement does **not** retire the visible-chat
runtime/queue; explicit both also captures and claims its visible ownership.
This resource claim is not a delivery ledger.

Claim returns one host-private winner ticket referencing this same generation
authority, not another allocator. Admission is closed while retiring; a new
request cannot recapture the old driver session under a new sequence and send.
Destructive sinks validate the ticket and captured old owners, not a renewed old
lease. New ready ownership is established only after the replacement stage.
Failures remain explicit failed/unknown stage evidence, never silent reopening.

Every awaited policy/provenance/pre-prompt/preparation step and runtime work-queue
admission is followed by exact ownership recheck. Quarantine/forget writes,
old-session close, actual context replacement and visible reset need checks at
their actual sinks, not only in a mobile wrapper. A work-stage await cannot
redirect reset to a new chat. Subsequent stages remain bound to the winner and
captured targets; another transition retires admission instead of retargeting.

Q5's final send admission checks captured session, current generation and exact
queue item **synchronously immediately before `session.send`**, with no await.
Known held work lost before entry may settle dropped; after provider entry,
session loss/discard/rejection without genuine ACK is UNKNOWN with intent
preserved. Dispatch completion is not delivery proof.

Late genuine ACK may settle only its exact historical Q5 attempt, even after
retirement. It cannot publish into replacement chat/generation, change current
member coverage, clear a newer attempt or acknowledge a rejoined member. Removal
takes back only exact known-held pre-entry work. Terminal paths release runtime
hook references; any later ledger ACK uses historical attempt identity, not a
replacement runtime callback. Group/Actions consumers handle UNKNOWN
exhaustively. Recovery neither resolves nor automatically replays uncertainty.
Notice publication also checks its separately captured visible-chat lease
after every await; work-only never claims/resets that resource. If it was
replaced, withhold the old notice instead of retargeting it.

Current dropped-only queue settlement and outer `startDispatcherFresh` calls do
not prove this interface exists. Q5's relayed shared-generation disclosure is
coordination evidence, not implementation acceptance. Exact runtime/type/sink
hunks and interface composition must be agreed with Q5 before code.

## 6. Confirmation, preservation and honest effects

Proposed `dispatcher.recover` uses the existing commandId/epoch envelope and
separate opaque keep/reset `expectedState` tokens. They bind incarnation,
pin/role/surface, operation/choice, switch, work generation and, for explicit
reset, visible ownership. Missing/false `resetChat` preserves chat/history;
malformed values reject; only boolean true with the matching explicit-reset
confirmation requests both. Reads cannot start this operation.

Receipt status vocabulary remains `completed`, `rejected`, `failed`. A
type-specific version-1 recovery result records stage evidence for quarantine,
work context, visible chat and notice using fixed values/codes. Keep-chat's
visible stage is `not_requested`, never an inferred successful clear. Quarantine
does not prove context replacement. A later failure/unknown/unattempted stage
returns a failed receipt plus bounded observed-stage evidence; do not undo,
silently default or claim complete success.

Only observed/scheduled effects are described. Sleeping work records the exact
captured resume owner's next-start effect, not a speculative new session. Notice
failure is independently reported. Reauthorize before cached/live receipts; a
revoked phone receives no private stage evidence. No provider reason, path,
hidden id, Q5 ledger attempt, delivered inference or trusted-window retry/adoption
appears in phone responses. Uncertain transport replies cause no automatic send
or old-command fallback.

## 7. Exact writer reservations and negative controls

The actual naming contract is
[`afefa41b2c8e1998979d44d383467a21c454e51e` section 7](https://github.com/Agent-Clubhouse/Clubhouse/blob/afefa41b2c8e1998979d44d383467a21c454e51e/docs/implementation-notes/3720-negotiated-member-names/contract.md#L97-L113).
Its refined reservations include **read-only server label** sites, not the earlier
provisional zero-server expectation. They remain contract-review pending.

| Owner | Concrete boundary |
| --- | --- |
| #3720 | `thisMachine().machine.name`/`getStatus().alias`; peers alias-only get/list provider; client `toPublicConnection().alias` plus isolated name-snapshot notification; local Alias/USE_LOCAL_ALIAS/SAVE_SETTINGS transaction; RenameEditor same-name guard and Alias UI. No mobile/auth/REST/capability/command/lifecycle sites. |
| Landed P7w/Details | SAVE_SETTINGS now 181-195 preserves structuredClone, previous read inside queued apply, persistence, telemetry/runtime ordering, rejection and unpoisoned queue. Network disable at 32-61 aborts controller reads before notification. Client public label at 648 must not touch receipt/generation at 657-658 or state/lifecycle. No alias-driven control read revision/send. |
| Phone read successor | Dedicated DTO/projection/tests; narrow mobile controller GET/sessions/capability adapters; mobile audience checks before server 1853 insertion/live/held output, both replay forms 5346-5399 and derived snapshot/status/hook output. No naming display or pairing invitation field edit. |
| Phone recovery/Q5 joint | Mobile parser/confirmation/dispatcher adapter plus shared generation and exact quarantine/forget/runtime sink admission. Q5 owns deliver/queued/settle/discard classification, final send check, callback release and UNKNOWN type/Group/Actions consumers. Concrete shared hunks require coordination, not concurrent implementation or another ledger. |

Source line labels are inspected d8 or unchanged owned 0af/P7w contexts, not
permission to apply patches by old line number. Re-resolve actual main and
unpublished owner heads before edits. This successor has **no SAVE_SETTINGS,
annex-client lifecycle, Annex device metadata or P7 renderer changes**.

The naming transaction's required shared order is **reserve -> persist ->
settingsChanged -> applyNetworkSettings/lease retirement -> activate**, all in
the serialized operation. It preserves rejection/rollback and committed
disable-before-notification ordering. Its shared patch and race controls need
independent review; design approval does not authorize product code.

V2 JSON enumerates 34 planned negative-control IDs: A1-A8, I1-I5, P1-P8, R1-R12,
M1. They cover missing/Off/Ask authority, same-identity re-pair, each IO/sink race,
all generic live/replay paths, chunks/titles/cursors/byte bounds, default preserve,
explicit confirmation/single winner, pre-entry/UNKNOWN/late ACK and old peers.
They are not tests or accepted fixtures. Each eventual correction must preserve
its genuine pre-correction failure and get risk-targeted exact-head gated proof.

Before any implementation: exact revised independent review, resolved human
policy, actual writer clearance and current-main composition. Before recovery
advertisement: actual Q5/sink semantics and proof. Before Go adoption: real
versioned redacted fixtures through parent/Navi, never remote Go edits. No
full local suite/E2E, new grant/link, app restart, merge or release is authorized.
Desktop-only #3757 was independently landed as
`78092f9b213d80698f758e709a23feac60374380`; its evidence and scope remain separate.
