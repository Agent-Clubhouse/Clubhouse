# #3720 member-name value primitives: pure and unwired

Source `13844778782e87f33608fcf86619a217d6803f8c`, branch `annex-wake-readiness/3720-name-primitives`, base main `b02542b5cf3cac51a3aada5919dd5b6c43757a9e`. Contract ref `38cbdaa9fff26aa28630ad14b5db9c13359d39f1`: original contract sections2–4 plus successor-r1 R-a/b, epoch/skew clarifications, retained by r2/r3. Canonical issue https://github.com/Agent-Clubhouse/Clubhouse/issues/3720. This evidence branch changes no source/test/package bytes from that candidate.

The only product addition is `src/shared/annex-member-names.ts`. Its only importer is its test. There is no transport/negotiation/frame-codec, store, hash verification, settings, UI, actor/grant or runtime consumer. The existing strict v1 network protocol, membership and channel files are unchanged from the contract ref and current base. No member, authority or connection behavior changes here.

## Public API and precise limits

| API | Behavior |
| --- | --- |
| normalizeLocalMemberName | Validate the original UTF-16, trim the fixed contract code points at the edges, require1–200 UTF-16 units; return null on refusal. No truncation, case folding or Unicode normalization. |
| isMemberName | A modern receiver value must already be well formed, nonempty, within200 units and trimmed. It never silently normalizes an incoming value. |
| readMemberNamePayload | Strict enumerable own-data snapshot of fingerprint/joinedAt/name/at/by and optional pairingId. Object/null prototype only, exact own keys, no getters/iterators; returned scalars are detached, **not frozen**. Explicit undefined pairingId is invalid; absence stays absent. |
| encodeMemberNamePayload | Validate/snapshot the exact payload (not a record containing id), then emit fresh mutable bytes: domain ASCII `Clubhouse/member-name/1` + LF, six explicit byte-length-prefixed UTF-8 fields. No JSON, locale, platform newline or normalization. It does not compute or verify a digest. |
| sameMemberNameEpoch | Validate and compare selected fingerprint/joinedAt/pairing presence+value, ignoring unrelated record fields. Both absent IDs require equal joinedAt; one absent and one present never match. No current-membership, pin or actor check. |
| compareMemberNameOrder | Validate selected at/by/id scalars; compare numeric at then ordinal by then ordinal id, returning -1/0/1. Caller must scope records to the right epoch first. ID format is checked, **not its hash or authorship**. Names are not order keys. |
| nextMemberNameStamp | Explicit now+durable-maximum inputs; return max(now, maximum+1), with fixed range/overflow refusal. No Date.now, IO, reservation or persistence. |
| remoteMemberNameStampAllowed | Explicit incoming stamp+wall-time inputs; allow exactly24h future, skip more than24h, fail invalid inputs. Incoming-only decision; never apply it to revalidate accepted disk history. No clock mutation/adjustment or convergence guarantee for broken clocks. |

Epoch/payload/order interfaces describe data only. Fingerprints retain the existing16–32-byte lower-case colon-separated bound; pairing IDs retain8–64 ASCII alphanumeric/hyphen. joinedAt is an integer in the supported Date range ±8,640,000,000,000,000. at is1–253,402,300,799,999. Runtime sender/pin/pairing/target epoch/grants and durable commit rechecks remain later responsibilities. Arbitrary Proxy traps can execute caller code; normalization of reflection errors is not a sandbox or authority check. Returned data/bytes are detached rather than frozen or immutable, and future admission owns capture/freeze/currentness.

## Independent expectations and actual proof

The JSON fixture copies eleven byte/hash vectors and ten string cases exactly from the original and successor-r1 fixtures at immutable38cb. Expected bytes/digests predate this implementation. The raw-text import plus JSON.parse preserves the deliberately lone-surrogate case; it does not assert transport reachability. Tests compare full canonical bytes, then node:crypto (test-only) compares their digest to those fixed expectations. A separately executed Python formatter independently matched all eleven byte/digest vectors and ten string cases, including an exact comparison to their frozen Git source objects. Its complete program is retained in independent-vectors.json argv. This is Python/TypeScript value proof, not Go adoption or network compatibility proof.

Original negative/intermediate results are retained, without transferring them to final proof:

- `missing-api-red.json` at2089d1bde is **misnamed by the original invocation**: Vite's JSON transform failed on the ill-formed UTF-16 fixture before reaching the API import. Zero tests ran. It is a fixture-loader failure, not missing-API/product evidence.
- After the raw-fixture loader correction at5ab93a998, `missing-api-red-valid-fixture` fails on the absent module; zero tests. This is test-only credit, not an existing Annex defect.
- `first-implementation` reports122 passes with the implementation untracked. Historical only. Candidate70c reports125 passes and successful types. An additional decomposed-Unicode byte assertion yields the final126 cases.

Exact138447787 proof: **126/126 pass**, full tsc --noEmit exit0, targeted two-file ESLint max-warnings0 exit0, base-to-head diffcheck exit0, independent Python vectors exit0. Thirteen source mutants fail on assertions; the byte-exact restored source passes **126/126** again:

| Deliberately weakened rule | Actual failed tests |
| --- | ---: |
| UTF-16 count instead of UTF-8 prefix bytes | 5 |
| Wrong domain newline | 11 |
| NFC normalization before encoding | 1 |
| Ignore writer tie-break | 2 |
| Ignore content-ID tie-break | 2 |
| Ignore pairing epoch | 1 |
| Ignore joinedAt epoch | 1 |
| Reuse logical stamp | 4 |
| Reject exact24h boundary | 1 |
| Broader Go-style whitespace | 6 |
| Enumerable-only own-key scan | 3 |
| Read raw properties after descriptor capture | 1 |
| Accept unpaired surrogates | 4 |

All other tests pass in each mutant run. Receipts include actual head/argv/time, input SHA256 before/after, tracked diffs, full stdout/stderr, exit and recorder hash. Mutants intentionally have a source diff; they are not clean-commit runs. Their driver always restores the original bytes. SHA256SUMS.txt seals the archive; verify-evidence.py checks the seals, all24 actual receipts and final-source bindings without running tests/installing. Independent source review and hosted exact-head CI remain required before PR/landing.

Admission:16 CPUs, load2.20 initially and2.48 before final type/lint, existing matched dependency cache/lock SHA256 bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d; all1,176 nonoptional package versions matched. No install/shared cache write; runner-mode task-local Vitest config disables cache, uses one worker/no file parallelism and NODE_DISABLE_COMPILE_CACHE=1. Original observations and exact config bytes are retained.

## Reproduce and deferred acceptance

Copy vitest.proof.config.ts.txt to `.cache/3720-names/vitest.config.ts` in this checkout with the verified matched dependency cache; its root is relative to that destination. Use a new recorder label with `python3 docs/implementation-notes/3720-name-primitives/run-proof.py NEW_LABEL 0 node node_modules/vitest/vitest.mjs run --config .cache/3720-names/vitest.config.ts --configLoader runner --maxWorkers 1 --no-file-parallelism src/shared/annex-member-names.test.ts`. Original archive files remain separate from task-local new records. Run verify-evidence.py to verify retained bytes only.

No socket/header negotiation, old/new peer connection, full frame parser or malformed-frame close-code proof is established here. No digest verification/authorship, durable name clock/cap/initialization/loss/replay/merge, settings intent/recovery/emergency races, Details currentness, runtime readiness, UI, live host, release or installation is accepted. No new grants, deadline/retry increases, timers or keepawake. The future name service must use these values within the reviewed real authority/durable transaction boundaries; accepting a well-formed payload or comparing an order never authorizes a name change.
