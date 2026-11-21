# Independent QA: #3720 member name primitives (pure, unwired)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `13844778782e87f33608fcf86619a217d6803f8c`, which matches the remote `annex-wake-readiness/3720-name-primitives`. Its base is `b02542b5c`, the landed parser #3765.
- **Proof:** `34b85c945c31692a7692a8c6668e5518baae045a`, which is in `3720-names-proof`. It adds only `docs/implementation-notes/3720-name-primitives/**`.
- **Method:** source read plus my own independent Python checks against frozen git objects, and hashing. I ran no tests.

## Scope: pure and unwired, CONFIRMED

- The diff against the base contains `src/shared/annex-member-names.ts`, its test, `src/shared/fixtures/annex-member-names-v1.json` and `run-proof.py`.
- `git grep annex-member-names` finds only the test file.
- It has no authority, authorship, hash-verification, store, transport or UI consumers.

## Independent vector verification (my own execution: Python and git only)

- **Canonical bytes:** I wrote my own encoder from r1 `contract.md:51`: domain `Clubhouse/member-name/1\n`, then six fields, each the ASCII byte length, `:`, and the UTF-8 bytes. Fields are the fingerprint, decimal `joinedAt`, `pairingId` or an empty string, the exact name, decimal `at`, and `by`.
- **All 11 hash vectors:** recomputed `canonicalBytesHex` and sha256 match **and** every sha256 is present in the frozen `38cbdaa9f` fixture objects (`fixtures.json` plus `successor-r1/fixtures.json`).
- **All 10 string cases** are field-for-field equal to the frozen r1 cases. My own trim and UTF-16 model reproduces every `writerResult` or refusal and every `modernReceiverAcceptsInput`. The trim set is the ECMAScript set, excluding 0085 and 180E.
- The owner's `independent-vectors` receipt asserts the same against the exact `38cb` objects.

## Source verdict: APPROVE

- **Trim and names:**
  - `normalizeLocalMemberName` checks well-formedness, applies the fixed trim, then requires 1 to 200 UTF-16 units, with no truncation and no NFC.
  - `isMemberName` requires an already-trimmed, well-formed name of 1 to 200 units.
  - A mutant that applies NFC fails, and so does a mutant that uses Go's broader whitespace.
- **Payload:**
  - `readMemberNamePayload` captures exact own enumerable data once: five required keys plus an optional `pairingId`, with any throw becoming null. A record carrying `id` is **not** a payload.
  - It validates the fingerprint format (lowercase, 16 to 32 colon-separated bytes), `joinedAt` within the Date range, the name, `at` from 1 to 253402300799999, and `pairingId` against `[A-Za-z0-9-]{8,64}`.
  - **No ID or hash is verified and no sender is checked.** The distinction between a detached payload and a verified record is explicit.
- **Encoding:** returns a **fresh mutable `Uint8Array`** on each call. A missing `pairingId` encodes as `0:`. A present one can't be empty because of its minimum length, so there's no ambiguity.
- **Epoch comparison:** `sameMemberNameEpoch` compares only the fingerprint, `joinedAt` and `pairingId`, and allows unrelated fields. A **missing `pairingId` differs from a present one**, because presence is compared with `owns`. Mutants that ignore `joinedAt` or `pairingId` fail.
- **Ordering:** `compareMemberNameOrder` gives a total order on (`at`, `by`, `id`), with `id` as exactly 64 lowercase hex digits. Invalid input throws, and it is documented as not an authorship or epoch check.
- **Clock:**
  - `nextMemberNameStamp(now, maximum)` takes explicit inputs, returns `max(now, maximum + 1)`, keeps the result within the stamp range or throws, and persists nothing.
  - `remoteMemberNameStampAllowed` means `at - now ≤ 86_400_000` inclusive, on incoming records only. A mutant that rejects the exact boundary fails.
- **Integration note:** the target and `by` fingerprints must be lowercase. Existing protocol regexes accept either case (`/i`). Integration must normalize to lowercase before reading or encoding. Uppercase input is refused, not hashed differently, so it fails closed.

## Proof verification (hashing)

- `SHA256SUMS.txt` has 34 entries, all ok.
- **24 receipts**, each with inputs equal before and after. Clean runs match the head blobs, and mutants carry their source diffs.
- **Red and historical runs, preserved and not transferred:**
  - `missing-api-red` at `2089d1bde`: a fixture parse failure, *"unexpected end of hex escape at line 203 column 222"*. That is the invalid-surrogate fixture-loading failure; it is **not** the missing-API red its label claims, and it ran zero tests.
  - `missing-api-red-valid-fixture` at `5ab93a998`: genuinely *"Cannot find module './annex-member-names'"*, zero tests.
  - `first-implementation`: 122 passed at `5ab93a998`, with the implementation untracked. Historical only.
  - `candidate` at `70c1419c9`: 125 passed and types clean. Not transferred.
- **Final, at `138447787`:**
  - green 126 of 126, types exit 0, lint exit 0;
  - `diff --check` exit 0;
  - independent vectors exit 0;
  - **13 mutants**, each failing only on assertions: unpaired surrogates 4, Go whitespace 6, enumerable-only 3, ignore id order 2, ignore `joinedAt` 1, ignore `pairingId` 1, ignore writer order 2, NFC 1, raw property read 1, exact skew boundary 1, reuse stamp 4, UTF-16 length prefix 5, wrong domain newline 11;
  - restored green 126 of 126.

## Verdict

- **APPROVE `138447787`** as the pure, unwired name primitives, matching `38cb`/r1 byte for byte.
- Not accepted: hash or ID verification of records, the store, negotiation or transport, authority, the display resolver, mixed versions, or live behaviour.
- Hosted CI on the PR head is still required.
