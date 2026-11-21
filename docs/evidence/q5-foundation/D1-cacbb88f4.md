# D1: exact immutable-page schema before rewrite

Corrected source `cacbb88f4d69b58a45e80a4781e72bb904e669b8`, tree
`9f11c2a4a00cf151043c74c70302539817255d47`, pushed on
`auto-reset-policy-design/q5-durable-delivery-ledger`.
Test-only baseline `6076dbe7ad8df9ed627fca5614f705b207ba2164`, tree
`fbed092f69d5e39a6d0032660142e0c03f7a2d93`, is separately pushed on
`auto-reset-policy-design/q5-D1-schema-baseline`. Original8dcb/222492 and earlier
approvals/evidence remain preserved. Review0eaa15924 confirms five-file closure
with required D1 before PR; this correction still needs assembled-head review.

## Concrete schema boundary

Leaf/index envelopes now require their exact supported structural key sets.
Entries require only key/value; root and child references require only digest,
first,last,count,depth. Unknown structural fields refuse without rewriting or
dropping them. Version changes must be explicit before adding structural fields;
this format has no supported additive structural extension bucket. Arbitrary
finite JSON remains valid inside the entry's value, including nested fields
whose names would be unsupported in the envelope. This is generic index data,
not catalog/profile authority or a rule engine.

The bounded fanout comment explains at most65 rows per64-fanout split and
quadratic row-batch work from repeated JSON sizing, not a whole build/latency
guarantee. Cache comments retain4 leaf+16 index pages, each encoded at most256KiB
(about5MiB encoded content per index); parsed-object expansion, caller values
and call transients are additional. No whole-process/whole-index heap budget.

## Actual proof

| Exact source | Admitted check | Result |
| --- | --- | --- |
| 6076dbe7a (production source unchanged from8dcb) | five new D1 negative cases only | exit1;5failed,33notrun;120ms |
| cacbb88f4 | full changed page suite | exit0;38passed,1native-Windows-onlyskip;17.18s |
| cacbb88f4 | full root ES2020 tsc | exit0 |
| cacbb88f4 | changed page source/test ESLint | exit0;0errors/0warnings |

Baseline read accepted all five unsupported structures and returned the payload,
so every expected-refusal control failed. Corrected cases execute both get and
set rejection and compare exact immutable filenames/byte hashes before/after,
with no temporary files/new pages. Tests do not claim preservation of access
timestamps. A separate positive rewrite control preserves arbitrary nested
payload data and the immutable earlier root.

No unrelated broad suite, native Windows or hosted CI was run. Current root
config excludes tests; compiler scope is not a test typecheck. Vite advisory
stays in raw output. Four commands admitted sequentially min4 tests/lint,min6
compiler,maxWorkers2 for Vitest; no refusals/retries/cancellations. All four
receipts bind clean equal exact head/tree and25 source hashes matched to Git
blobs; all58 receipt/raw hashes verified, prior54 index rows unchanged. Original
dependencies restored after matched worktree-only linkage; no installs.

## Next isolated assembly, not executed by this evidence

Only the five reviewed private index/durability/test/fixture files will be copied
onto a newly verified main branch, with per-file identity bridge and checks on
that new exact head, then independent review before PR. The portable
q5-index-assembly-seal.py is prepared here (SHA256
efad6b395bf775d316e303de372ef7999155079e959846560c8c47671614fedf), not yet an
execution receipt. It will bind13 assembly/config/setup sources and its own
before/after program hash without adding a sixth file to the proposed PR.
No app imports, activation, catalog/R1/runtime/UI/release or native Windows
acceptance is inferred by this D1 result or the prepared sealer.
