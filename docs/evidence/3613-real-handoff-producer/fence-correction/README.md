# Combined producer CP1/CP2 correction for exact-delta review

**Unreviewed successor, no PR/CI or whole-handoff acceptance.** Source
`275df2b3c8e5fa81cc066d0b308edb6c59d9df61`, tree
`507f18b6f9125e2c6eccefb9dee0c054649a32f9`, src tree
`52a10102d89a86af93f6b3ef6f64ac6a2adc384f`, addresses both findings in the full
[`b6aa456b1f3ea7b90d6ebfe74d36ca475fb682e3` review](https://github.com/Agent-Clubhouse/Clubhouse/blob/b6aa456b1f3ea7b90d6ebfe74d36ca475fb682e3/docs/qa-transfer/2026-11-22/reports/producer-ad104-independent-review.md),
blob `1c2b871739e5eaec9f41fce72495a02d6d5b016a`. Its original BLOCK disposition is
preserved; this packet does not confer approval or relabel a product incident.
The full report was retrieved and its Git blob verified before production edits.

Publication ref: `refs/heads/lane-3613-p2-routes/handoff-producer-fences`.
The original candidate ref remains
`refs/heads/lane-3613-p2-routes/handoff-usable-path=ef99265da9faddddf522c2c294745d86d593d78d`;
the boundary ref remains
`refs/heads/lane-3613-p2-routes/handoff-producer-boundary=664effcd1d6d10858c0c7904983628a0393a0780`.
Base/observed main is `50c474b48f57e0256661244bd29b9343ec112bc4`.

## Narrow source bridge and actual admission

Delta from ef992: **4 files, 192 insertions, 11 deletions**. Only two existing
private production files change: `clubhouse-mcp/handoff-permissions.ts` and
`handoff-host.ts`; the complete producer fixture and directly related desktop
documentation are the other two. The manifest binds all four original/successor
blobs, full files and patches, including the genuine baseline fixture and benign
fixture refinement. Other producer files, generic grants/registry/gate/stores,
phone/control/native/worker/Q5 and the original candidate's 61 archives are
unchanged.

**CP1:** The existing queued positive helper still resolves the original arguments,
requires the frozen canonical recipient, and uses real `checkToolGrant` and
`callGrantIsApproved`. A successful offer stores a private synchronous continuity
predicate in its original agreement scope. Fresh Ask compares the original
pre-await approval version and the exact context accepted by the consumed
approval, using existing `grantApprovalContext` with the original resolved
targets. It neither reconsumes an approval nor resolves another target or
substitutes a new positive grant evaluation. Fresh Allow does not depend on an
approval version/context. `HandoffProducerOwner.admit` requires that predicate
after every source-verification await, synchronously before setting admittedId
and entering the unchanged first marker/catalog callback. Missing/invalid scope
throws the existing authorization-changed error.

**CP2:** `verify` captures its observation promise and revision at entry, awaits
that promise, performs the real current source/config reads and existing final
observation wait, then assigns only its captured revision. Any appended revision
is caught by the existing synchronous revision check: even a newer observation
that happens to settle cannot be silently certified against earlier reads.
This is conservative refusal, not an unbounded retry loop. Benign observations
already appended before verification may settle and complete; a fresh call after
a benign pending-observation refusal remains usable. Original source capture,
directory/selection/authority fences and actual observation lifetime are retained.
Already-admitted independent saves remain truthful; no rollback is added.

## Genuine source-specific red and matched green

All runtime commands used gate **4**, one worker, the complete existing producer
fixture, and exact selectors recorded in original logs and before/after receipts.
No false authorization return, private counter rewrite or timeout is a red.

| Run | Actual source | PASS / FAIL / SKIP | Scope |
|---|---|---|---|
| 111 | `c2a6d24fa1b381ac23e825dc31ccd06bd061af9e` | 4 / 4 / 29 | Original-production postpositive Ask version/context and pending-observation reds; current controls |
| 112 | `970e22dd4b99a2a3ce8654505675366067ce2d38` | 1 / 0 / 36 | Original-production benign observation appended before verification starts |
| 113 | `275df2b3c8e5fa81cc066d0b308edb6c59d9df61` | 8 / 0 / 29 | Combined exact successor: four matched greens plus current Ask, Allow, forget-only and stable benign controls |

111 and112 have src trees identical to ef992/ad104/f05. Their fixture versions
are separate and fully archived. 112 refines only the benign timing control to
match the intentional stable-revision refusal policy; it does not rewrite111 or
claim its original late-benign control ran against the successor.
The four111 failed cases contain **22 actual AssertionError failure nodes**:
seven each for dropped Ask/version and changed Ask/runtime context, four each for
pending incompatible and pending benign observations. These are four failed
testcases, not22 failures counted as cases.

CP1 holds the actual `callerHandoffSource` callback after the real queued positive
helper has returned true. Dropping consumed approvals or changing caller runtime
then leaves standing Ask, original source/host/recipient otherwise current.
The remote fixture observes no marker, catalog binding, history file/record,
federation publication attempt or POST on refusal. Current Ask, fresh Allow with
both version/context changes, and forget-only Ask each actually commit, bind,
publish and attempt the existing transport.

CP2 dispatches fixture notification input to the **real registered**
`onAgentConfigChanged` callback between the final wait's snapshot and resume,
then holds its actual `peekDurableConfigs` lookup through the real final check.
The check spy forwards the original method and counts visits while held; no
private counters are inspected or rewritten. Source replacement is subsequently
written to the real fixture agents.json before that lookup is released and the
original producer settles. Pending benign work is also refused, then a fresh
call completes after the benign lookup settles. The separate pre-verification
benign notification control completes the original call.

## New compiler/lint receipts and limits

114 on exact275df uses gate **6**:
`npx tsc --project node_modules/.cache/native-handoff-ingress/79-producer-candidate-tsconfig.json --noEmit --listFiles --pretty false`.
**Actual PASS exit0, zero diagnostics, 3958 ordered emitted compiler inputs**,
including both complete producer and coupled tool fixtures. This is an input
count, not3958 production roots. The same unweakened config is archived.
The ordered input/hash inventory is explicitly captured **after** execution.

115 on exact275df uses gate **4**, `npx eslint` JSON output for exactly
`handoff-host.ts`, `handoff-permissions.ts` and the complete producer fixture:
**3 files, 0 errors, 0 warnings**. The exact command and all output are archived.
Every111–115 admitted command has matching actual clean head/tree and15 relevant
file hash snapshots before/after execution. These are observations, not an
exclusive filesystem lock or atomic all-dependency input seal.

Historical101 remains ad104 exit0 **without listFiles/full input inventory**;
its2467-root reconstruction (2465 production plus two fixtures) was after
execution and is not retrosealed. Historical79/81 compiler failures,86/89 genuine
reds,98/99 unsupported-expectation failures, collector failure and native166FAIL
nonregression/71 and247 warning dispositions remain unchanged under their
original source associations. No aggregate final37-case runtime or transfer of
those old results to this source is claimed.

`manifest.json` contains **43 SHA256-bound lossless gzip archives, 3 raw XML runs,
111 actual name/class/status rows**, all failure nodes, five exact source-bound
command receipt pairs, the complete four-file bridge, original/refined fixture
versions, verified full b6 review and new compiler inventory. Proper XML
attributes are parsed; repeated names and skipped cases are preserved.

## Deferred acceptance

This remains an isolated real MCP/grant/Git/catalog/history/coordinator assembly.
Caller registration, synthetic exact-call approval input, notification delivery
input and remote public-key/member/connectivity metadata are fixtures, not native
TLS/bridge/provider/live-human or watcher-integration proof. No lower/native/sync
tests, full suite, local E2E, installation, restart, grant/timeout changes, PR or CI
were executed. Other reviewed producer evidence retains its original source
attribution only. Full native preparation/content/apply/wake, two-host,
whole-handoff/full-duplex acceptance remains unfinished. Existing independent
combined exact-delta review is required before PR; hosted and fresh landing
gates remain later requirements.
