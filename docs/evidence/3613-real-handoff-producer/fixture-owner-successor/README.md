# Fixture-local actual owner successor

Exact final source `219fca7759963de4c68a4ddf0159c6c7b1a97645` has admitted
finite proof: **19PASS /50SKIP /69 declarations**, complete changed-fixture
compiler **0 diagnostics /3959 ordered inputs**, and complete fixture lint
**0 errors /0 warnings**. This is delivery for the existing independent source
review, NOT source approval, a PR update, hosted observation or landing readiness.

## Contract and exact source

FULL design `d642886848992bea1a8a7ac845f96578d88ebd1d`,
`docs/qa-transfer/2026-11-22/reports/producer-overlap-16991-design-review.md`,
blob `610ced89454c17139479813b6e2262bea5fd48f8`,21408 bytes, SHA256
`a881e0fbc3fcd18ec5c35fb6b2e6d2a59117768fe86b1733437e6c89ecc81c37`
is verified/read completely and archived with blob/path responses.

Base frozen overlap custody:
`e2da738ce3db11a21c250333e7a80a1ffb8347c2`.
Final executed source tree: `20e0b5b4741b6242d8c1765130a3b5e6ecaf6216`.
Full production src remains `505ff0699b01779e52338e06a239d7cc15a6d2b1`.
The ONLY code change is
`test/annex-v2/handoff-producer-admission.test.ts`:530 insertions/143 deletions
against the frozen baseline. Publication ref:
`refs/heads/lane-3613-p2-routes/handoff-producer-owner-successor`.
The packet commit adds evidence only; its fixture/src are identical to219f.

## Ownership and error protocol

One file-local owner is admitted synchronously before asynchronous setup.
An unfinished prior owner refuses admission before directory allocation or shared
setup. Actual setup completion is registered before its raw async work starts.
The allocated directory and eventual original fixture are assigned once as
non-writable properties. Partial setup captures stop/reset handles before host
readiness; late retired setup retains its original fixture but cannot install
caller wrappers.

All40 actual callbacks are registered through a thin file-private entry wrapper
and Node's public AsyncLocalStorage. The raw promise, not Vitest's timeout or
cancelled wrapper, owns its completion record. Old asynchronous helpers and
continuations access their captured owner, not a newly current fixture/directory.
No Vitest internals, generic framework, registry or production code was changed.

Core retirement closes intake and installs its coalesced completion promise
before diagnostic/release callbacks or the first await. All manual/join callers
share one core outcome. The sole drain deduplicates original promise identities,
waits all settlements and appended batches, and preserves exact actual errors.
Mandatory original-owner teardown steps all run once despite earlier failures,
with separate immutable step outcomes. A single original Error is returned
unchanged; multiple references remain in one shared aggregate's frozen array.

Manual cleanup waits only core work/teardown, never its own callback. Automatic
hook retirement registers its shared promise before releasing original test
holds, joins core and then separately joins actual body completion. Late original
holds registered after hook admission are released too. Test release is
idempotent, and functional release faults retain their provenance/error identity.
The original owner remains admitted until these actual stages complete even
after its live `current()` fixture is intentionally disposed by manual cleanup.
A stale cleanup only joins that owner's completed record; it cannot repeat shared
teardown or target a later owner.

Core stage records are not rewritten as a final success. The final owner record
retains setup/work/release/teardown/body errors, including acknowledged caller
errors. Explicit expected Error references must be registered before retirement.
Strict acknowledgment verifies exact core/error identity, aggregate shape and
every original reference/provenance before recording acknowledgment. Hook
reporting suppresses only those duplicate exact acknowledged work records;
unregistered, extra, teardown/release/body failures remain observable. Body
fulfillment, soft-assertion return, handled promise or equal message is never
acknowledgment.

Original diagnostic limits remain8 rows/3 fields/80-character tool text and
nonthrowing before actual forwarding and during retirement. No new phase stream
or exception/argument/file payload was added. The held-preparation helper now
races source entry against actual caller settlement and visibly refuses an
unreached hold without fabricating success. Existing test deadlines are unchanged.

## Source-specific admitted commands and counts

All six commands have clean matching pre/post head/tree/fullsrc and16 relevant
input lengths/hashes. No gate refusal, install, full suite or native/E2E rerun.

| Proof | Exact source | Result |
|---|---|---|
| 170 finite candidate | 79e562d6bbd45a4e14c8293227cf59f2dd92e1d0 | 18PASS/50SKIP/68 declarations |
| 171 complete fixture types | same79e | 0 diagnostics/3959 ordered inputs |
| 172 complete fixture lint | same79e | 1 file/0 errors/0 warnings |
| 173 final finite | 219fca7759963de4c68a4ddf0159c6c7b1a97645 | 19PASS/50SKIP/69 declarations |
| 174 final complete types | same219f | 0 diagnostics/3959 ordered inputs |
| 175 final complete lint | same219f | 1 file/0 errors/0 warnings |

Final normal-gate commands:

```sh
~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- \
  npx vitest run test/annex-v2/handoff-producer-admission.test.ts \
  -t 'owner lifecycle|keeps overlapping cleanup|drains a real held preparation|completes actual fixture teardown|forwards actual preparation|reports actual early offer|keeps actual fixture preparation|keeps current sender authority' \
  --maxWorkers=1 --reporter=default --reporter=junit \
  --outputFile.junit=node_modules/.cache/native-handoff-ingress/173-owner-final-finite-original.xml

~/.clubhouse/orch/desktop-test-gate.sh lane-p2 6 -- \
  npx tsc --noEmit \
  -p node_modules/.cache/native-handoff-ingress/133-producer-hosted-correction-tsconfig.json \
  --listFiles

~/.clubhouse/orch/desktop-test-gate.sh lane-p2 4 -- \
  npx eslint test/annex-v2/handoff-producer-admission.test.ts --format json \
  --output-file node_modules/.cache/native-handoff-ingress/175-owner-final-lint-original.json
```

The exact shell-rendered commands, raw gate logs/outputs, XMLs and receipt utility
are archived.79e proof stays bound to79e; it is not transferred or summed into a
final69-case runtime claim. Final173 directly executes19 cases only.

## Finite contract controls and limits

The original genuine164 negative atc535 is reused unchanged:
1FAIL/58SKIP/59 declarations/four AssertionError nodes, no timeout/hook/EBUSY.
Its original raw log/XML/receipts and source/custody are retained. On219f the
matched real registered rejection/source-held preparation overlap passes.
The real nine-error control also overlaps its manual cleanup: both waiters
remain pending before release and preserve the same original aggregate/references
afterward. Actual stop/storage/error checks and strict hook acknowledgment pass.

The remaining selected controls cover:

- Raw body held AFTER core cleanup; manual body-to-core relation does not cycle,
  an expired modeled waiter does not end owner lifetime, later admission refuses
  while held and succeeds after real completion.
- A stale completed A cleanup cannot touch newly admitted B storage/state;
  bounded sentinel owners do not start conflicting app hosts.
- Automatic original and late body-hold release, idempotent test-side release.
- Appended actual filesystem operations and rejection, identity deduplication,
  failing mandatory step followed by actual storage cleanup, all step outcomes.
- Additional caller/release/teardown/body errors, fulfilled bodies without
  inferred acknowledgment and equal-message but unregistered references.
- Owned partial setup held through retirement, original late-install refusal,
  subsequent teardown and exact setup error retention.
- Real early preparation refusal without unreachable source wait; original
  current producer, held preparation, early offer, caller-result/error forwarding
  and bounded clock/logger diagnostic controls.

Sentinel/raw-callback/expired-waiter evidence proves its explicit modeled boundary,
NOT Vitest cancellation behavior, native Windows timeout cause or native cleanup
acceptance.50 skipped producer declarations have no new runtime acceptance.

The static source bridge verifies all33 original physical callback headers/
argument counts and448 normalized original expect-call texts remain in order;
all40 current callbacks are owned. Owner-access and whitespace normalization are
explicit. This is NOT unchanged complete-fixture bytes or runtime acceptance.
The complete original fixture/source remains archived for direct delta review.

The174 compiler graph inventory is an owner observation AFTER execution:
3959 ordered inputs,2471 tracked bytes checked to Git and1488 dependency
observations. It is not a pre-execution or atomic dependency seal.
A nongated refactoring parse check caught an inherited `toString` dictionary
lookup bug before any successor product execution; the own-key guard/syntax was
fixed before79e. It was not a gated Vitest/compiler failure and has no invented
head/source receipt. Original tool/session diagnostics remain distinct.

## Unchanged gates and custody

PR#3779 remains OPEN at76656/base actual-main50c. No same-PR push, new PR, dispatch,
rerun, observer, merge or release occurred. Existing independent exact source/
proof review is the next gate. Both original hosted failures remain unwaived:
450682/ab853 and450757/16991; original e2da overlap evidence and full earlier
4aa/e08/454 source-specific approvals are immutable.

The first Windows body delay, closure of all57 failed producer cases and native
Windows safety remain UNKNOWN. No deadline, permission, production, workflow,
dependency, UI or phone field changed. Source composition proves byte identity
outside this one fixture, not whole handoff/duplex acceptance.

Chat remains independently held at the original PDF loader/open error-state gap:
preview open, couldn't-read-PDF message, Page1of2 timeout, painted assertion
unreached; underlying exception remains unknown. No Chat source/log expansion,
repair, flake/preexisting/producer-cause claim or acceptance is made here.

`manifest.json` inventories73 lossless gzip archives, including six exact command
packets, original reused negative, source commits/fixtures/deltas, complete design,
source bridge, helpers,3959-row observed inventory and unchanged PR/ref metadata.
Raw/compressed lengths and SHA256s are retained. Three original XMLs enumerate
196 custody rows across DISTINCT sources; that inventory is not an aggregate
runtime acceptance claim.
