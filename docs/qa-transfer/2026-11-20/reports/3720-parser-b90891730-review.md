# Independent QA: #3720 local settings parser (pure, unwired)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Source:** `b908917305eaea9d2b8a11030e2361830b1478b9`, which matches the remote `annex-wake-readiness/3720-local-settings-parser`. Its tree is `4fad95d3c`, and its base is main `e8e178c4b`.
- **Proof:** `a95c48b9d6a77a0e61988a4393684b643d0f0f75`, which is in `annex-wake-readiness/3720-parser-proof`. It adds only `docs/implementation-notes/3720-local-settings-parser/**`.
- **Method:** source read plus hashing. I ran no tests.

## Scope: CONFIRMED pure and unwired

- The diff against `e8e178c4b` contains only `src/shared/annex-settings-ipc.ts`, its test, and `run-proof.py`.
- `git grep annex-settings-ipc` over `src` finds **only the test file**. There is no IPC, preload, store, renderer, session, result, runtime or launch consumer.
- No result, snapshot or session types are added, so those are correctly deferred.

## Source verdict: APPROVE against `38cb` C3 and N4

- **Records:**
  - The prototype must be Object or null.
  - **An early key-count bound** of at most 11 is applied before iterating. All `Reflect.ownKeys` keys must be strings, with enumerable data descriptors.
  - Values are **captured once** into a fresh null-prototype record. Every later read uses those captured values, so a Proxy has no time-of-check/time-of-use window.
  - Exact key sets are checked through `Reflect.ownKeys` on the captured record.
- **Dense `unset`:**
  - The prototype must be `Array.prototype`. `length` is checked through its own data descriptor, must be non-enumerable, and must be at most 11.
  - The own-key count must equal length + 1, and each index must be an enumerable data descriptor.
  - No iterators, getters or array methods run on raw input.
- **Reflection normalization:** every reflective access to raw input runs inside `inspectData`, which turns **any** throw into `invalid_envelope` with a null request ID. That includes a Proxy-thrown `LocalSettingsInputError` carrying a forged ID, the scaffold defect fixed in `b90891730`.
  - The outer `instanceof` rethrow can therefore only see parser-raised errors.
  - Engine normalization of descriptors from Proxy traps also happens inside that boundary.
- **UUID:** exact length 36 plus the v4 regex, which closes the trailing-newline `$` gap. Request IDs and epochs are lowercase only.
- **Versions:** safe integers from 0 to `MAX_SAFE_INTEGER - 1`, and each field version must be at most the revision.
- **N4:** `v ∈ {0, 2, '1', null}` gives `schema_invalid` with the safe ID, which is pinned in a fixture. A missing envelope key gives `invalid_envelope`.
- **Origins and touched set:**
  - The touched set must be non-empty, contain no duplicates, and have no overlap between set and unset. `command-palette` must touch exactly one key.
  - `base.fields` must equal the touched set exactly.
  - Booleans are type-checked. Strings must be well-formed UTF-16 within per-key limits measured in UTF-16 units. Empty strings and whitespace are preserved, and trimming is deferred to the name service, as stated.
- **Output:** a fresh typed construction, an 8 KiB check on the canonical bytes, then `structuredClone`.
  - The output is **detached, not frozen**. The README correctly says "detached typed data". If anyone describes the DTO as "immutable", either freeze it or drop that word.
- **Typed failures:** `LocalSettingsInputError` with `kind` and `requestId`, and fixed message text.
- **Bound:** the largest valid canonical payload is 7,970 bytes, so the 8 KiB guard is defensive and unreachable. No over-cap negative was fabricated. That is honest.

## Proof verification

- `SHA256SUMS.txt` has 40 entries, all ok.
- **29 receipts.** For each, the inputs before and after match, and clean runs match the head blobs. Mutants and red runs carry their source diffs.
- **Historical runs, preserved and not transferred:**
  - `missing-api-red` at `0b4e4858b`: no tests ran. This is not an Annex defect.
  - `first-implementation`: 109 passed, at the test-only head with the implementation **untracked**. Its source isn't captured in `sourceDiff`, so it's historical only.
  - `candidate-types` at `a6dbf6a73`: actual exit 2, the ES2020 `Object.hasOwn` failure, which is retained.
  - The 7 earlier mutants at `3ee9910cd`, and `reflection-error-red` at 1 failed and 111 passed.
- **Final, at `b90891730`:**
  - `sealed-green`: 112 of 112.
  - `sealed-types`: exit 0.
  - `sealed-lint`: exit 0.
  - `sealed-diff`: `git diff --check e8e178c4b..HEAD`, exit 0.
  - 8 sealed mutants, each failing only on assertions, with failure counts 1, 5, 4, 4, 4, 4, 1 and 1 matching the README.
  - `restored-green`: 112 of 112 after a byte-exact restore.

## Verdict

- **APPROVE `b90891730`** as the pure, unwired local settings parser and DTO.
- **Not covered:**
  - Electron structured-clone or IPC reachability;
  - admission, sender or grant checks; current epoch and conflicts; persistence;
  - emergency handling, recovery, naming and readiness;
  - mixed versions.
- Hosted CI on the PR head is still required.
