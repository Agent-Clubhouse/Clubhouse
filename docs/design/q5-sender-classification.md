# Q5 eligibility: literal system is not authenticated provenance

Source-only observation on immutable main
5bbabde2d9f6dcb4db248d0976681fc331f5611e; exact seven blob IDs/SHA256s in
`q5-sender-classification-source.json`. No executed failure, provider incident,
access bypass or product change is claimed. Canonical Q5 #3758; IB3 replay issue
#3770 is a separate identity problem, not evidence of this sender ambiguity.

C1 b11fa01a / evidence19efe8259 / QA286a3121 proves **existing behavior**:
sender exactly `system` OR topic exactly `system` is excluded in current live
and reconnect delivery, including subscribed bootstrap shapes, mentions and lead.
It does not prove that every such record was created by trusted housekeeping.
Production bootstrap helpers do use that sender, but author-supplied display
labels can collide with it.

## Actual source paths

- `src/shared/agent-name.ts:18–40`: syntax/device-name validation permits the
  folder name `system`; Windows device names are the reserved set. This is not
  a requirement to create or rename any actual agent. Existing named identities
  must be preserved.
- `src/main/services/clubhouse-mcp/tools/group-project-tools.ts:39–69`:
  `resolveSenderLabel` normally returns `system@Board` for a binding named
  `system` and resolved/cached project name, so the usual label is **not** literal
  `system`. On registry lookup failure, cached project name is optional; bare
  binding name or fallback agent ID can be returned. `binding-manager.ts:144`
  accepts an optional projectName. Neither is a universal no-collision proof.
- `src/shared/group-project-network.ts:253–257`: a remote post parser accepts
  sender as a string, not a reserved authenticated author-kind enum.
- `src/main/services/group-project-host.ts:1975–1991`: an agent-author post is
  checked against authenticated machine, membership and remote grant policy.
  That path does not require its display sender to differ from `system`.
  `applyRemoteWrite:2024` forwards the supplied sender to normal host posting;
  normal posting1074 stores its independently derived senderAddress when present.
  Therefore an authorized member record with sender exactly `system` can be
  represented on a non-system topic. This is a conditional source path, not an
  executed test or claim that the standard MCP label generator normally emits it.
- `src/main/services/annex-server.ts:3441–3456`: phone/controller post accepts
  a sender field while supplying person author; it reserves system **topic**,
  not literal sender. This further prevents treating the label as housekeeping
  provenance. No new endpoint call, phone recovery behavior or grant is proposed.
- `src/main/services/group-project-delivery.ts:211,492`: both existing paths
  use literal sender/topic exclusions, independently of durable senderAddress.
  Thus a colliding authored record is excluded by the same current policy.

## Carry-forward adapter contract

Keep C1 closed as current-behavior proof. Its future ledger adapter must represent
scan-time exclusion truthfully and retain ordinary later-post flow; describe this
case as **excluded by existing policy**, not “authenticated housekeeping” or
“provider confirmed.” Do not silently tighten name validation, rename an agent,
clear history, reinterpret a label as authority or alter the predicate to make a
new test pass. No automatic reclassification of old excluded coverage after a
subscription/policy change.

Alongside IB3, a future eligibility contract must decide explicitly whether to
preserve the literal policy or adopt a reviewed content-free author-kind/source
provenance model with compatible legacy behavior. A new field alone cannot
authenticate old posts, and absence must not be guessed from body/topic/ID text.
This note selects no change and grants no producer/runtime/board hunk edits.
If the predicate eventually changes, keep exact live/reconnect, genuine bootstrap,
authored literal-label and non-system ordinary-post controls, with meaningful
predicate-removal mutants. No additional tests or PR are needed for this
source-only observation.
