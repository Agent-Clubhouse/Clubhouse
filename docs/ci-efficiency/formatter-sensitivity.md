# Local formatter sensitivity witnesses

Three report-only semantic faults were tested from approved baseline
`2c1397f519807739083f38d7f76f250c4c6556c5` in a temporary detached worktree.
No product, test or workflow change was committed. The real existing tests ran
through the ordinary, unchanged `vitest.config.ts`, including renderer jsdom,
renderer setup and global setup, with one worker and file parallelism disabled.
Dependencies were linked to the existing installation; nothing was downloaded.

The agreed **fault-witness subset** is exactly:

- `src/renderer/utils/format.test.ts`: four existing `formatDuration` tests.
- `src/renderer/features/agents/TranscriptViewer.test.tsx`: ten existing real
  component tests, rendering the actual consumer and importing the formatter.

This is not the complete proposed or retained shadow-policy suite. The actual
shadow policy retains a broader set: all renderer/shared/preload/integration
tests plus main sentinels. This trial does not execute or time that retained set,
run a selector implementation, activate hosted execution, or prove coverage for
other imports. It supplies sensitivity evidence for two members of that set.

## Results

[The raw receipt](formatter-sensitivity-receipt.json) preserves all 14 exact test
identities, their statuses, failure messages/stacks, original controls, invocation
arguments, input hashes and environment. Both original controls pass **14/14**.

| Semantic fault in temporary `src/renderer/utils/format.ts` | Explicit counterexample | Formatter suite | TranscriptViewer suite | Failed tests |
| --- | --- | --- | --- | --- |
| Seconds rounding: `Math.round` → `Math.floor` | 500ms: `1s` → `0s` | detected | escaped (10/10 pass) | 2 formatter |
| Minute boundary: `< 60` → `<= 60` | 60,000ms: `1m` → `60s` | detected | escaped (10/10 pass) | 1 formatter |
| Displayed seconds suffix: `s` → ` sec` | 30,000ms: `30s` → `30 sec` | detected | detected | 2 formatter + 1 consumer |

All three are non-equivalent, demonstrated by the recorded original/mutated
outputs. The formatter suite detects **3/3**; the real consumer detects **1/3**
and has **2/3 escapes**. The two-suite union detects **3/3**. These are deliberately
chosen faults, not a statistically representative mutation score.

Exact failing identities:

- Rounding: `formatDuration formats sub-minute durations as seconds` and
  `formatDuration rounds seconds correctly`.
- Unit boundary: `formatDuration formats durations under an hour as minutes and seconds`.
- Displayed text: the same two formatter identities as rounding, plus
  `TranscriptViewer shows cost and duration for result events`.

The consumer's existing result-event fixture uses `duration_ms: 30000`; its
duration assertion looks for `30s`. Thus it is sensitive to the displayed suffix,
but these inputs do not exercise half-second rounding or a minute boundary.
Passing consumer tests on those faults are escapes, not evidence of equivalence.

Detection is scoped: formatter failures must be the known `expect(...).toBe(...)`
AssertionError messages with the expected named test among the failures. The
consumer failure must be the exact cost/duration test's lookup error for `30s`,
with `30 sec` present in the rendered DOM receipt. Runtime/suite errors and
unrecognized failures are invalid rather than detections. No invalid or unresolved
observations occurred in this run. No custom assertion or consumer stub was added.

## Timing, bounds and reproduction

Observed on macOS arm64, Node 25.8.1, Vitest 4.1.12. The complete accepted trial
took **6.522s**, including worktree setup, five serial test subprocesses, witness
checks and cleanup. Original controls took **1.02218s before** and **0.91004s
after**. Mutant subprocess wall times were **0.90163s rounding**, **0.89713s
boundary**, and **1.91943s text**. Each subprocess ran both suites (14 tests),
so these are not isolated formatter or consumer runtimes. The text fault includes
the real component's `waitFor` failure delay. There is one trial per fault; no
targeted/full timing comparison or broad CI savings claim is made here.

The runner limits execution to 110 seconds, reserving up to ten seconds for
cleanup inside the 120-second envelope; each subprocess is capped at 30 seconds.
There are at most three mutants, one worker, and no overlapping local test runs.
The original formatter, tests, config and renderer setup hashes are unchanged;
the temporary worktree was removed. The runner uses the installed Node's native
TypeScript stripping only for the explicit formatter counterexamples. The actual
tests always use the ordinary project config.

From this task branch with the existing dependencies available:

```sh
node scripts/ci/ci-efficiency-formatter-sensitivity.mjs /tmp/formatter-sensitivity.json
```

The optional destination avoids overwriting the recorded receipt. The runner
creates a detached worktree from the invoking checkout's HEAD, verifies the
formatter/test/config/setup inputs against that baseline, mutates only its copied
formatter, restores the copied source between faults, runs the original green
control again, and removes only the worktree it created. The receipt's baseline
commit and input/runner hashes identify the exact observed state. One earlier
development trial produced the same detections/escapes before tightening the
consumer-message discriminator and reserving cleanup time; the committed receipt
is the final bounded run. Independent acceptance review remains with the
orchestrator.
