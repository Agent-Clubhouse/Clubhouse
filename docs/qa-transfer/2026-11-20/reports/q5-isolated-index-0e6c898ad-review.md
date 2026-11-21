# Independent QA: Q5 isolated five-file index assembly

Reviewer: qa-details-local-composition, November 21, 2026.

- **Assembly:** `0e6c898ada85efefb80bc3aec61e07d3d15d2b19`, tree `9d15165a116d7645f116ad2cc9e2a44a3108ced9`, branch `origin/auto-reset-policy-design/q5-isolated-index`. Its parent is `e8e178c4b`.
- **D1 source:** `cacbb88f4`. The test-only baseline is `6076dbe7a`.
- **Evidence:** `4bc64b9089c86dccbd5a6146cdce91ecddf492af`, with file `isolated-0e6c898ad.md`.
- **Draft:** `8c33b2252`, with file `0e6c898ad-pr-draft.json`. It is prepared only and not published.
- **Method:** source read plus hashing. I ran no tests.

## Bridge and scope

- **The assembly adds exactly 5 paths** over `e8e178c4b`:
  - `pages.ts`;
  - `pages.test.ts`;
  - `durability.ts`;
  - `durability.test.ts`;
  - `test/research/q5-index-process.cjs`.

  Each path's blob ID is **identical** to D1 `cacbb88f4`.
- **The import closure is exactly these files.** I verified this at `8dcbf4245`, and D1 adds no imports. It uses Node built-ins, vitest, the existing `typescript` devDependency for the fixture, and `./durability`. The module is unimported by app entry points.
- **Current main:** `origin/main` is now `b02542b5c` (#3765). The only change between `e8e178c4b` and `b02542b5c` is the parser: `src/shared/annex-settings-ipc*` and its proof script.
  - There is **no overlap** with the five paths.
  - There is no change to `package.json`, the lockfile, vitest config, tsconfig, eslint config or `validate.yml`.
  - A rebase or merge onto current main is a clean, non-intersecting change. Re-check `main` again right before opening the PR.

## D1: strict page structure, APPROVE

- The `LeafPage` and `IndexPage` types have lost their index signatures.
- `decode` requires **exact** key sets:
  - a leaf has `schemaVersion`, `minWriterVersion`, `kind` and `entries`;
  - an index has `schemaVersion`, `minWriterVersion`, `kind` and `children`;
  - each entry has exactly `key` and `value`;
  - each child reference has exactly `digest`, `first`, `last`, `count` and `depth`, through `rootValid`;
  - any other `kind` is refused.
- Pages produced by `JSON.parse` have only enumerable own keys, so the `Object.keys`-based check is exact. An own `__proto__` key from JSON counts as an extra key and is refused.
- **Entry `value` stays arbitrary finite JSON,** validated by `json()`, which is unchanged.
- Because every loaded page passes `decode`, and every written page is built from known fields, `{ ...page, entries }` and `{ ...page, children }` can no longer copy unknown fields forward.
- The bounded comments for the cache (at most 20 decoded pages, about 5 MiB encoded, not a heap budget) and for the quadratic split are accurate.
- **Baseline red:** `6076dbe7a` gives exit 1, with **5 failed** and 33 skipped, which are the D1 controls. At `cacbb88f4`: 38 passed and 1 native skip, tsc exit 0, lint exit 0.

## Evidence (hashing only)

- The manifest has **61 receipts**, and its diff against `222492076` removes nothing, so the earlier 54 are preserved.
- **7 new receipts.** For each, raw and receipt sha256 match, head and clean status are the same before and after, and the source-hash maps are equal. I recomputed every hash against the head blobs, with 0 mismatches.
- **Assembly at `0e6c898ad`:**
  - 2 files: 49 passed and 1 skipped, the native-Windows-only test;
  - tsc: exit 0;
  - lint on the four TypeScript files: exit 0. The `.cjs` fixture isn't linted.
- **The draft PR body** scopes it as a five-file storage foundation related to #3758. It defers catalog, activation, migration, runtime and whole-process memory, links the exact evidence commit, and states the native Windows limit. It does **not** claim to close #3758.

## Delivery gates, explicit and not credited locally

- **G2:** the hosted windows-latest JUnit must show "native Windows reuse sync succeeds without platform or descriptor overrides" as **present, passed and not skipped**. It must be bound to the five files' hashes on the PR merge-ref checkout, which will include `b02542b5c`.
- **G4:** inspect the Windows JUnit for unexpected skips or failures in:
  - the fixture process-exit tests (`execFile` of `q5-index-process.cjs`);
  - the symlink tests, which skip only on EPERM, ENOTSUP or EACCES;
  - the prefix-directory rename test.
- **A current-main check** right before opening the PR.

## Verdict

- **APPROVE assembly `0e6c898ad`** for opening the scoped draft PR, after the final current-main check.
- **Not accepted:** catalog, activation, R1, runtime, whole heap, or native Windows until G2 and G4 pass on hosted CI.

## Addendum: static current-main bridge, evidence `2d4b11285` (tree `241d140ac`)

I checked this independently against git:

- `origin/main` is `b02542b5c`.
- `git diff --name-only e8e178c4b b02542b5c` lists exactly the 3 new parser, test and proof files.
- These six blobs are **identical** across `e8e178c4b`, `b02542b5c` and `0e6c898ad`:
  - `package.json`;
  - `package-lock.json`;
  - `vitest.config.ts`;
  - `tsconfig.json`;
  - `.github/workflows/validate.yml`;
  - `eslint.config.mjs`.
- The four index source and test paths are **absent** on main, and nothing under `src` or `test` on main references `group-project-notice-ledger` or `q5-index-process`.
- The evidence commit adds only the comparison JSON and Markdown files, so the candidate and the 61 receipts are unchanged.

**Static disjointness is CONFIRMED.** That is not credit for any combined execution. A final current-main guard is still required at PR and at landing.
