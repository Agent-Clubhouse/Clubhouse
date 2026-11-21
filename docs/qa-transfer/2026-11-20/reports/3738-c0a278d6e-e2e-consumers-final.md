# Independent QA final review: #3738 E2E consumers

Reviewer: qa-details-local-composition. November 21, 2026.
Source: `c0a278d6e96484394cda8b595a90e32da2af9a12` (`fix/3738-e2e-callable-consumers`, test-only, on the approved `0723c3410`).
Evidence: `e86254490b5860c431ed41936352d254b6ac543e` (`origin/evidence/3738-e2e-consumers-c0a278d6e`), directory `docs/evidence/mcp-stable-binding-e2e-consumers/`.
- `manifest.json` SHA256 `c70dd9ba…f955b` matches.
- `SHA256SUMS` SHA256 `83cea852…b448a3` matches.

Method: I read artifacts only and ran nothing.

## Verdict

**APPROVE the source and unit proof** for the ordinary PR update. The **E2E runtime proof is hosted only** and not credited until hosted CI passes. The source review is in my earlier message.

## Evidence verified

- **Seals:** all 27 committed copies match their seals.
- **`src/` is unchanged against `0723c3410`:** I checked this myself.
- **`helper-exact`** (`test/mcp-target-tools.test.ts`): head is `c0a278d6e` before and after, exit 0. **12 tests passed.** The SHA256 of each of the 5 changed files is equal before and after **and equals the blobs at `c0a278d6e`**.
- **E2E typecheck:**
  - With the initial ES2020 `lib`, the run exits 2 with `AggregateError` and argument-count diagnostics. Those same diagnostics appear on the `0723` baseline, so they are not introduced here.
  - With `lib: ["ES2022","DOM"]`, as Node 22 supports, it exits 0.
  - **Note:** this is an ad-hoc evidence tsconfig, not the repository config, and the repo's own e2e type-checking is unchanged. Playwright transpiles without type-checking, so hosted E2E is the runtime gate.
- **`lint-exact`:** 0 errors, 6 warnings.
- **`retained-contract.json`:** all 9 critical dedup and receipt assertions (`firstArgs` and `secondArgs` with idempotency keys, `duplicate.isError === false`, the result hash, the file result and bytes, the request-ID sequence, the persisted receipt) are listed. **I confirmed each one is present verbatim** in `agents-across-machines.spec.ts` at `c0a278d6e`.
- **Hosted context:** the extra Windows Annex trace and the Windows unit-2 JUnit ZIPs are retained with their API digests.
  - The README's correction is explicit: a timeout stack pointing at the definition at :91 does not prove which await was pending, so the `managed-agents/restart.test.ts` timeout stays **unexplained**.
  - It is not waived, and it must be classified if it recurs on the successor CI.
- **PR #3751** is still at `807`. The successor chain (`807` → `0723` → `c0a278d6e`) is approved at source and unit level, and hosted CI on the updated PR is the gate.
