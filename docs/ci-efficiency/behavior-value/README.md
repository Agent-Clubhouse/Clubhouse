# Prompt codec behavior-value experiment

Local run at base `f5c566f89e093f4cb9322cc59b37de7ee2798331`.
Production `prompt-codec.ts` was never changed. Seven single-edit variants lived
only in an automatically removed temporary source tree. No hosted work, network,
package-manager install, lifecycle scripts, or shared dependency edits occurred.

88 test subprocesses, one worker, 61.958 seconds measured aggregate execution,
including two invalid dependency-setup attempts. No timeouts. There were 86 valid
runs. `results.json` preserves every test identity, status, duration and assertion
failure; failures alone do not imply a kill: the runner requires assertion-shaped
failures, nonempty execution and exact selected codec identities. Initial setup
runs executed zero tests and are explicitly invalid in `setup-attempts.json`.

The original local dependency tree lacked usable ProseMirror packages. The
orchestrator supplied `/tmp/codec-audit-VUZtL9/node_modules`: twelve cached package
archives verified against lockfile integrity, in a private overlay, plus existing
local dependencies. Runtime was Node 25.8.1 and the Vitest version recorded in
`results.json`; reused tooling can differ from the lockfile. These results are a
local codec experiment, not full repository CI acceptance or a historical replay.

## Outcomes

| Fault | Baseline 55 tests | Baseline kill disappears when omitting | Final shipped assertions |
| --- | --- | --- | --- |
| Disable exact fallback | assertion kill | exact | Existing baseline kill retained |
| Default exact=true | assertion kill | structure | Existing baseline kill retained |
| Drop parsed marks | assertion kill | structure | Existing kill retained; direct marks assertion added |
| Shift cached source positions +1 | survives | all complements survive | assertion kill, visible selected substring |
| Prefer later equally near position | survives | all complements survive | survives; tie direction acceptance deferred |
| Increment ordered marker before emit | assertion kill | none | Existing baseline kills retained |
| Interpret emphasis within fence | survives | all complements survive | assertion kill, visible literal text and no marks |

Baseline kills 4/7. Final assertions add two justified behavior kills (6/7 union
with unchanged baseline). The final five direct reruns cover original,
equivalent control, cached-position, boundary-tie and fence-literal. All 58 tests
pass for both controls; cached-position and fence-literal fail assertions;
boundary-tie passes. The other four baseline kills remain supported by their
unchanged executed baseline tests; they were not rerun with the final subset.

The property checking canonical document semantics is the only baseline killer
of dropped marks. Literal byte round-trips and text-only crossing checks do not
prove retained supported marks. The slash endpoint inverse test missed a shifted
mapping; the final test derives text positions from ProseMirror descendants,
checks the selected visible text, and independently checks selected source
substrings `/co` and `hello`, including absence of literal marker syntax.

The small unchanged consumer set is all 10 `PromptMarkdown.test.tsx` tests, run
for all nine variants. It kills default-exact and dropped-marks, passes the other
five faults and both controls. No claim is made about other consumers.

## Groups and actual complement execution

Groups were declared before results in `predeclared.json`; they partition all
55 baseline codec identities exactly once. The baseline full run adds one
observational witness test. For each of nine variants (original, equivalent
control and seven faults), all five leave-one-group-out selections actually ran:

| Omitted named contract | Removed | Executed codec tests |
| --- | ---: | ---: |
| preservation | 34 | 21 |
| structure | 4 | 51 |
| exact | 7 | 48 |
| marks | 9 | 46 |
| mapping | 1 | 54 |

Every complement checks the exact expected identity set, not just its count.
The equivalent control replaces `1` with `Number(1)` in initial position state.
It passes full, all complements, stronger and consumer selections. These finite
faults show marginal detection evidence, not universal test redundancy or an
estimated production failure rate. Single-run per-test durations include local
noise; subprocess duration includes startup. No runtime optimization is claimed.

## Witnesses, assertion provenance and limits

`differentials` contains paired public inputs and outputs for each fault, plus
separate `inputReached` and `observableDivergence` fields. All seven public
witness calls executed and all seven outputs differ. Reach means the public
input was invoked, not instrumented internal branch coverage. Witnesses write
observations without correctness assertions; divergence never counts as a kill.

Run ordering in `results.json` (zero-based, excluding setup attempts):

* 0–71: nine variants × full baseline, five complements, initial stronger, consumer.
* 72–80: experimental stronger refinement, all nine variants.
* 81–85: final shipped subset on the five variants identified above.

The initial experimental stronger assertions included a full numeric mapping
array and a fractional tie input (`1.5` for `a\nb`). The next exploratory revision
used integer offset 2 in `a *b*`, added fenced semantics, and killed all seven
faults. Both mapping array and tie-direction assertions were removed from the
shipped test file. Fractional API divergence is not evidence of a real editor
cursor, and equal-distance preference has no established product acceptance
criterion here. The final suite deliberately gives that mutant no product kill
credit. `finalShippedAssertions` records the actual final subset; hashes and
refinement history distinguish experimental revisions. Initial paired tie
witnesses remain fractional for honest provenance. No editor input reach or
product regression is claimed for that witness. Integer-boundary exploration
is only an experimental assertion receipt, not shipped acceptance.

## Reproduction

With an existing complete local dependency directory:

```sh
CODEC_NODE_MODULES=/absolute/path/to/node_modules node scripts/ci/prompt-codec-behavior-value.mjs
```

The runner copies source and setup into a temporary tree, retains the historical
setup-attempt cost in its limits, checks unique mutation anchors, runs selections
sequentially, and removes isolation in `finally`. It overwrites reports, so copy
this evidence elsewhere before reproducing. The default now uses the final
three shipped assertions. `--refine` appends stronger runs to existing results;
`--final-subset` appends the five control/survivor checks. Both enforce aggregate
90-process/180-second limits. A fresh default run differs from the historical
three-phase sequence above. Original codec preservation is recorded as true.
Independent review is owned by the orchestrator; integration acceptance remains
subject to that review and normal project checks.
