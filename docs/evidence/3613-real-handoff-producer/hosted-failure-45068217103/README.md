# Original producer hosted failure45068217103

**FAILURE, landing blocked.** The single automatic Validate run for PR#3779
at exact head `7d244fcd153df00668ecac3d0709cece054801e3`, attempt1, finished
with31 successful jobs,4 skipped jobs and2 failed jobs. The owned watcher exited1
once; all original terminal captures succeeded. No manual dispatch or rerun.

[Original automatic run](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/45068217103).
This packet is published on the separate evidence-only ref
`refs/heads/lane-3613-p2-routes/handoff-producer-ci-failure`; PR head and its
reviewed production source remain unchanged.

Eleven actual checkout witnesses in the original logs bind synthetic checkout
`556a86b3ee4bf20b6392333c1b87ec6cafb4adea`, tree
`e17f6a5b0607d95bead22e266f879bcaa65e0da2`, and approved src tree
`2327da993691b55ac2d8fab1e33d6bc6b49f41ab`. Original GitHub commit/tree responses
are retained. Full source/evidence approval45495858 and all older source-specific
proofs are unchanged; source approval does not waive these failed hosted gates.

| Failed job | Actual original unit JUnit result |
|---|---|
| Ubuntu unit shard1, job137349145716 |19571PASS /54SKIP /1FAIL. The prepare-handoff-skill valid-offer case fails at120: isError is true when the fixture expects it not true. Selected producer/coupled rows:68PASS. |
| Windows unit shard1, job137349145736 |19494PASS /93SKIP /37FAIL. The same skill case plus36 producer testcases fail; producer failures are5000ms timeouts and include multiple cleanup EBUSY nodes. Selected producer/coupled rows:36FAIL /32PASS. |

The two shard2 unit artifacts contain no failed cases: Ubuntu16916PASS/65SKIP;
Windows16805PASS/176SKIP. These are per-artifact observations, not combined
local51-case execution or whole-handoff acceptance. Multiple failure nodes on
one case are not additional failing testcases. Four original JUnit files are
archived with all names/classes/status/failure text; selected/failed rows are in
the original terminal packet. Missing scopes are not relabeled successful.

Original artifact IDs:14772044436 (Ubuntu1),14771948723 (Ubuntu2),
14772770847 (Windows1),14771794659 (Windows2).
The original25243515-byte full log has SHA256
`0e8e92dc8af0a2ea2ea2b73cacf35ca9b102e169ab16a07ec81a7563c7f54272`;
the original193711-byte terminal packet has SHA256
`c136086842c2206eb676c69b28d7711ed09758aca5b09321029bfe5a67bc325b`.

The manifest binds every original compressed/raw size/SHA256 and lossless
roundtrip: watcher source/owner/output/exit, initial run/merge ref, final
run/jobs/PR/logs/artifacts/ref outputs and capture stderr/exits, actual checkout
commit/trees, four JUnit files, reviewed approval and original PR guards/body.
No product execution was repeated to package this evidence.

## Unresolved boundaries

The existing skill fixture mocks agreement-call work without its real scope and
uses a synthetic positive approval with incomplete registry/grant/config/project
ports. This is a concrete coupled-fixture compatibility lead, **not yet an
executed root-cause discriminator** or a production-authority waiver.

The producer fixture performs real Git/source work, uses held operations and
inherits a5000ms test deadline. Timeout plus cleanup EBUSY alone does **not**
establish production deadlock, slow-Git causation or justify a speculative
deadline increase. First failure, actual held-work and cleanup ordering still
require bounded investigation. No assertion, deadline, ownership or production
policy was changed for this packet.

Original45046385831/proof13703 remains FAILURE with unknown historical reconnect
cause. Earlier146/2 compiler failures,166FAIL scoped nonregression, separate
71/247-warning scopes, original fixture corrections and source-specific review
limits remain unchanged. No bridge/provider/live-human/two-host/content/apply/wake,
full-handoff or duplex acceptance is inferred. Required hosted checks have failed;
landing remains blocked pending a supported narrow correction and its existing
independent delta review.
