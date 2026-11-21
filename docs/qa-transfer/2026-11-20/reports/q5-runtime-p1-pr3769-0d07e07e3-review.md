# Independent QA: PR #3769 successor, P1 diagnostics wording

Reviewer: qa-details-local-composition, November 21, 2026.

- **Executed source:** `0d07e07e36d144d4668bec378f2faf3e06d59695`, tree `92eedd815…`.
- **Evidence and PR head:** `4e576b9e9287f5962120816f61e16f45085becd2`, tree `0193de3b749c243667983176c9807b9fe9749f8e`. PR #3769 is OPEN, not a draft, with head `4e576b9e9`, which I read back with `gh`.
- **README sha256:** `696529a3…5f40`, recomputed.

## Source hunk: exactly three strings

The only change between `02f777c5d` and `0d07e07e3` is in `runtime-coordinator.ts`:

| Location | Before | After |
| --- | --- | --- |
| `reject` log | `Runtime coordinator operation rejected` | `Runtime operation rejected` |
| `reject` error | `Runtime coordinator: ${reason}` | `Runtime operation: ${reason}` |
| `refused` log | `Runtime coordinator operation refused` | `Runtime operation refused` |

- No logic change.
- The change between `0d07e07e3` and `4e576b9e9` is evidence only.
- **Cause:** the hosted run `44942563638` failed because `dispatcher-copy.test.ts` forbids `\bcoordinators?\b` in strings the app can show. `gh` confirms the run's conclusion was `failure` on head `02f777c5d`. The preserved Linux excerpt names exactly those three strings at `runtime-coordinator.ts:141/142/146`.
- **The copy guard is unchanged.** The test's `FORBIDDEN` regex still includes `coordinators?`. Identifiers and comments may still say "coordinator".

## Structured receipts at exact `0d07e07e3` (verified)

- All four receipts have:
  - head `0d07e07e3`, with a clean status before and after;
  - a source block that's identical before and after;
  - all 10 input hashes recomputed against the head blobs, with **0 mismatches**: `runtime.ts`, the coordinator, the coordinator test, `dispatcher-copy.test.ts`, `package.json`, the lockfile, `tsconfig`, the vitest config, the eslint config and the fixture `tsconfig`;
  - `rawSha256` matching the committed raw output;
  - gate sha `d45cbfb0…` before and after.
- **diagnostics-tests-01:** `npm test` on the coordinator test plus `dispatcher-copy.test.ts`, exit 0, **2 files and 44 tests** (39 coordinator tests plus 5 copy-guard tests).
- **diagnostics-prod-tsc-01:** `npm run typecheck`, exit 0.
- **diagnostics-fixture-tsc-01:** exit 0.
- **diagnostics-eslint-01:** exit 0.
- These are the structured per-command receipts I asked for in `b2c95b9c`. Good.

## Scope

- **The historical mutants weren't rerun and aren't credited as new execution.** That's acceptable, because the change is three diagnostic strings with no effect on the guards those mutants targeted.
- The old hosted failure (`44942563638`, 31 passed, 2 failed and 4 skipped as reported) is preserved, along with the Linux and Windows excerpts.
- The new run `44945220344` on `4e576b9e9` is **in progress**. I read that back with `gh`.

## Verdict

- **APPROVE `0d07e07e3`, with evidence and PR head `4e576b9e9`,** as the corrected P1. The scope is unchanged from `b2c95b9c`: an unwired coordinator, types and fake-hook controls.
- **No merge until** hosted run `44945220344`, or its successor on the exact head, is green.
- No consumer, ACK, journal or phone approval.
