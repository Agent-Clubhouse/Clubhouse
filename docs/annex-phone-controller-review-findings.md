# Proposed phone controller contract: independent V1 findings

**Verdict: HOLD implementation and capability advertisement.** This records
prospective contract gaps, not a retrospective exploitability audit or acceptance
of production behavior. Source references are pinned to
`d8c7247a4dccc1ebff01f0f28f8e61279bdf5437`, the independently inspected base.

Reviewer: `2c2d08f8-cb3b-457f-b587-d205773c9ebd`. Reviewed V1 SHA256:
`5fba06856f4fe5b3f159c60d9eafa54166de8c4d385678dab8dd75b8fc7f2c9e`;
mandatory Q5 addendum:
`10109dbe5681833fa33f4e7d10c877d51a935fe62f7a4ea54e9f16d7a4252d49`.
Their original bytes remain at commit
`ef636998ef3c73803f8861b15555f3b0c3928e87`; the full original reviewer response is
retained separately from this findings summary.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟠 HIGH | `annex-authorizer.ts`, `annex-controller-chat.ts` | 81-113; 26-33 | No executable hidden-controller paired-human privacy/Off/Ask policy; reauthorization does not preserve pairing incarnation. | 9/10 |
| 2 | 🟠 HIGH | `annex-server.ts`, `mobile-dispatcher.ts` | 6033-6039; 175-195 | Generic live/replay isolation is not established for hidden-controller identities and actionable events. | 9/10 |
| 3 | 🟠 HIGH | `dispatcher-clear-chat.ts`, `chat-runtime.ts` | 129-170; 904-917, 1121-1152 | Recovery needs shared sink-level admission, exact target ownership and proven UNKNOWN/partial-outcome semantics. | 9/10 |
| 4 | 🟡 MEDIUM | `annex-controller-chat.ts`, `chat-transcript.ts` | 81-132; 229-233 | Incomplete streams and title cuts can precede known-secret redaction. | 9/10 |

Scores describe confidence in the source-supported contract gap, not a
reviewer-supplied exploitability score. P1 findings are mapped to HIGH and P2 to
MEDIUM for this summary; no CRITICAL or LOW finding was reported.

## Exact source evidence

1. [Current peer/pin/role authorization](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/annex-authorizer.ts#L81-L113)
   and [desktop federation `agent.read`](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/annex-controller-chat.ts#L25-L33)
   do not name a phone hidden-transcript policy.
   [Agent grant callers/defaults](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/clubhouse-mcp/grant-check.ts#L191-L218)
   and [federation-only read defaults](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/clubhouse-mcp/grant-check.ts#L291-L299)
   are not a substitute. [Human grant-answer authority](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/mobile-grant-requests.ts#L1-L21)
   concerns Needs you answers, not this private history.
2. [Shared chat-event broadcast](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/annex-server.ts#L6033-L6040),
   [both Dispatcher identities' projection](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/mobile-dispatcher.ts#L175-L195),
   and [default state-event retention](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/shared/dispatcher-group-chat.ts#L75-L107).
   [Insertion before broadcast](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/annex-server.ts#L1853-L1863)
   and [both replay request forms](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/annex-server.ts#L5346-L5399)
   also require host-side audience fencing.
3. [Recovery preparation and effects](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/dispatcher/dispatcher-clear-chat.ts#L129-L172),
   [queued dispatch after awaited provenance](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/agent-runtime/chat-runtime.ts#L978-L1025),
   [discard settlement](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/agent-runtime/chat-runtime.ts#L904-L917),
   and [queued context replacement](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/agent-runtime/chat-runtime.ts#L1121-L1152).
   [Current confirmation bindings](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/mobile-dispatcher-settings.ts#L38-L76)
   do not bind pairing incarnation. [Current receipt caching](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/mobile-control.ts#L170-L198)
   is fingerprint-scoped, not proof of recovery revocation invalidation.
4. [Projection through a selected sequence boundary](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/annex-controller-chat.ts#L81-L132),
   [quoted-secret patterns](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/telemetry/diag-redaction.ts#L69-L94),
   and [raw first-message title/cut](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/main/services/agent-runtime/chat-transcript.ts#L229-L233).
   [Final text replaces chunks](https://github.com/Agent-Clubhouse/Clubhouse/blob/d8c7247a4dccc1ebff01f0f28f8e61279bdf5437/src/shared/chat/events.ts#L429-L431)
   supports a narrower complete-message-only phone profile.

The original review's `dispatcher-group-chat.ts:88-125` range extended beyond
the inspected file. The source-reference integrity check caught it; the exact
state-retention reference above is 75-107. The original review and failed
integrity output remain preserved, not retroactively corrected.
The follow-up check also caught this summary's proposed 129-175 recovery range;
the final complete-function reference ends at the actual d8 line 172. Both
failed integrity attempts remain distinct from the corrected result.

## Correction status

[V2](annex-phone-controller-recovery-v2.md) specifies the isolation, projection,
incarnation and shared-generation requirements and negative controls. They are
**not implemented or accepted**. The precise human policy decision remains
escalated; read capability and private responses remain withheld. Recovery
additionally awaits actual coordinated sink admission and Q5 UNKNOWN semantics.
A safe read contract can be reviewed independently of recovery.

No prior P7w/P8/security or release verdict transfers. #3757's separately
reviewed desktop-only delivery is not changed by this proposal.
