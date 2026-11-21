# Proposed phone controller-read and recovery contract

**PROPOSED ONLY.** No implementation, advertised capability, production fixture,
phone adoption or security acceptance is provided by this documentation.

Canonical host successor: [#3760](https://github.com/Agent-Clubhouse/Clubhouse/issues/3760).
Go adoption: [Agent-Clubhouse/Clubhouse-Go#626](https://github.com/Agent-Clubhouse/Clubhouse-Go/issues/626),
coordinated through Navi. Related #3613; historical closed #3474 remains
desktop-only and #3616 remains recovery-copy work. Those contracts are not reopened.

The original frozen [V1 JSON](annex-phone-controller-recovery-contract.json) has
SHA256 `5fba06856f4fe5b3f159c60d9eafa54166de8c4d385678dab8dd75b8fc7f2c9e`.
Its `focusedHostIssue: null` records the snapshot before #3760 was assigned;
this index supplies the canonical issue without rewriting review provenance.

The [mandatory Q5 qualification](annex-phone-controller-recovery-q5-settlement.json)
has SHA256 `10109dbe5681833fa33f4e7d10c877d51a935fe62f7a4ea54e9f16d7a4252d49`
and qualifies every reference to cancelling/stopping controller work:
never-submitted held work may be dropped, but after provider entry loss/reset/rejection
is unknown and preserves intent. A late genuine receipt settles only the old attempt,
not a new chat/generation or rejoined member. Recovery cannot resolve uncertainty
or retry automatically; phone reads expose no local trusted-window adoption/retry.

The proposal uses only advertised/versioned role-specific phone reads and confirmed
recovery. Default recovery preserves visible chat and retained transcript history;
reset is an explicit separately confirmed choice. Existing desktop-only diagnostics
and generic mobile hidden-id rejection remain unchanged.

Independent security/privacy review must resolve exact paired-human existing
Off/Ask policy, immutable target/pairing rechecks, filtered cursor/bounds,
best-effort redaction limits and recovery single-winner/partial-outcome semantics
before code. Proposed examples are not validated wire fixtures.

Actual #3720 writer disclosure reports no REST/server/mobile-capability or client
lifecycle overlap. Q5 reports no clear-chat/controller/recovery hook edits and owns
runtime delivery/queue/unknown-settlement and durable notice semantics. Shared
discard/settlement changes still require concrete coordination. Both designs remain
unapproved documentation; recovery cannot advertise unimplemented Q5 behavior.

The branch is independent of frozen controller-read candidate #3757. No Go source,
grant/link, app restart, shared production code, merge or release is changed.
