# PR3778: original automatic hosted failure

The one ordinary automatic Validate run45046385831, event `pull_request`,
attempt1, finished **FAILURE:30 SUCCESS /4 SKIPPED /3 FAILURE**. This is not
eligible for landing. No rerun, manual dispatch, source edit or local test was
used to obtain this observation.

PR head206a88dcc93ecd7d2f5009d533894dd77e36e2ed and actual main70eff remained
unchanged. Actual hosted checkout99fee0f0149e2ba0f83735aa947b52c9fef1873f has
parents70eff+206 and tree48956fa912ed4e7696451f1f802f74294f0b863c, identical to
the reviewed PR tree. Original logs and all four shard JUnit artifacts are
preserved, with raw/compressed hashes and separate proper-XML derivation.

| Failed job | Actual failure |
|---|---|
| Ubuntu unit shard2; Windows unit shard2 | Existing `annex-server.test.ts:2734` handoff route case times out after5000ms with unhandled missing `trustOf` export in its `annex-peers` mock. Stack points to the new canonical capture at server3822. This is a concrete missing mock dependency, not claimed runner flakiness. |
| Ubuntu unit shard1 | New native TLS-generation restart case fails only its fresh-positive request at fixture468: result rejected instead of fulfilled200. The preceding original stale request/domain refusal and absent record assertions passed. Windows passes this case. |

The fixture's `connect()` checks only `acceptedHere`; after replacing an old
socket, this may still describe the old accepted link before its close is
observed. A strictly new accepted epoch plus target opened-ready witness is the
bounded proposed correction, not a production-currentness claim. The actual
hosted failure output does not expose the fresh request's rejection code; no
unobserved error code or executed reproducer is invented.

Next bounded disposition: preserve this original run, update the legacy mock to
use the real canonical `trustOf` export, and prove the native reconnect helper
cannot resolve against an unchanged old accepted epoch. Production remains
byte-identical; exact successor fixture evidence/review is required before a new
PR head. No broad rerun, timeout increase, assertion removal or weakened native
retirement control is proposed.

All original7acf/1172/3e06/206/0da source/proof identities remain immutable.
Historical35/initial8/finallegacy1 attribution remains; this failed hosted run
does not replace those execution scopes. The original71 warning mapping and
global160-unmeasured, protected Details/Naming/Q5, phone fixtures, real grant/
preparation/content/apply/wake/two-host/full-handoff/full-duplex and human gates
remain unchanged. Ordinary hosted E2E successes are not full handoff acceptance.
