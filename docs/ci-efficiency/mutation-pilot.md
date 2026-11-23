# Portable bounded classifier mutation pilot

This is a local experiment on `scripts/ci/classify-changes.mjs`, using its existing
`scripts/ci/ci-scripts.test.ts` suite. It installs nothing and activates no hosted
job. Production classifier and workflow files are unchanged.

Run from a checkout with the project's existing Node/Vitest dependencies:

```sh
node scripts/ci/ci-efficiency-mutation.mjs /tmp/mutation-results.json
```

The optional argument selects the JSON report destination; without it, the runner
writes `docs/ci-efficiency/mutation-results.json`. Use a different destination to
preserve recorded evidence. Node resolves the already-installed Vitest dependency
through normal ancestor lookup; no `npx` download or new dependency is involved.

The runner copies the original module and existing tests into a temporary checkout
subdirectory. Each hypothesis makes exactly one replacement in the copied module.
It proves non-equivalence using an explicit input and records both outputs. It
runs the original full suite before/after, the original selected test before each
hypothesis, then two fresh processes for each mutant under each strategy. All
processes run serially with one Vitest worker, file parallelism disabled, a 30s
process timeout and a 600s total execution budget. No shared heavy lane is used
concurrently. A final source/test byte comparison and sandbox removal are recorded.
The original files never need restoration because they are never mutated.

`targeted` selects one existing named test; `full` runs all 27 classifier tests.
“Full” does **not** mean the repository suite. This deliberately small portable
comparison excludes packaging, native modules, network calls and hosted CI. The
test CLI subprocess uses Node, including on non-macOS hosts; Linux/Windows runs
have not been observed here.

## Original baseline

Recorded in [mutation-results.json](mutation-results.json), on source base
`817ef3827c266dab9fef40c9ab06cd23d06fb394`, macOS arm64, Node 25.8.1,
Vitest 4.1.12. Input source/test/runner SHA-256 hashes are in the report.

| Hypothesis | Targeted trials | Full trials |
| --- | --- | --- |
| Docs: `every` becomes `some` | survived twice | survived twice |
| Empty diff skips E2E | killed twice | killed twice |
| Unit tests request E2E | killed twice | killed twice |
| Stable candidate requests E2E | killed twice | killed twice |
| Ignore macOS build path | killed twice | killed twice |
| Ignore packaging dependency | killed twice | killed twice |
| Ignore macOS line marker | killed twice | killed twice |
| Ignore removed diff lines | killed twice | killed twice |

Eight non-equivalent hypotheses: **7 killed, 1 survived, 0 invalid, 0 equivalent,
0 unresolved** (87.5% killed). Both repetitions agreed in both strategies. A
survivor is not equivalent: the recorded mixed `docs/ci.md` + `src/main/index.ts`
witness incorrectly produces `docsOnly: true` under `some`. The original suite
has no mixed docs/source expectation and therefore misses this mutant.

Elapsed scope: the entire pilot, including setup, ten original green controls,
32 mutant test processes, witness checks and cleanup, took **13.188s**. Mutation
process wall time alone totaled **4.942s targeted** and **5.128s full** (16 runs
each); targeted saved **0.186s / 3.6%**. There were 16 selected test executions
versus 432 full-suite executions. Fixed targeted-first ordering, just two trials,
and process startup costs limit the timing inference; this is not evidence of a
repository-wide CI saving. The mutation score was identical for both strategies.

## Regression follow-up

Baseline commit `1728ec70f` preserves the original tests, runner and 7/8 result.
The follow-up adds exactly one mixed docs+source expectation to the existing
`docs-only changes need nothing` test. There are still 27 named test cases; the
additional assertion requires `docsOnly: false, e2e: true, macosBuild: false`.
No production classifier or workflow change is needed. The unchanged targeted
selector now includes that expectation as well.

[mutation-results-corrected.json](mutation-results-corrected.json) records
**8 killed, 0 survived, 0 invalid, 0 equivalent, 0 unresolved** (100%). All eight
have explicit non-equivalence witnesses and repeatable assertion failures in
both trials of both strategies. Both original full-suite controls pass 27/27;
all eight selected-test original controls pass 1/1. The repository-configured
classifier test command also passes 27/27 after the regression.

The final corrected pilot took **13.215s total**. Its 16 targeted mutant runs
totaled **4.928s**, versus **5.173s** for 16 full-classifier mutant runs: a
**0.245s / 4.7%** difference. These are subprocess wall times; full-pilot time
also includes ten green controls, witness/setup and cleanup. The score improvement
comes from the added expectation, not a change of production code or runner.
The final timing sample ran without another validation command in this agent's
lane; an earlier corrected sample was discarded because the separate repository
test command overlapped it briefly.

To repeat either state, use a dedicated checkout of baseline commit `1728ec70f`
or the regression follow-up commit, with existing project dependencies available,
and run the same command above. The runner reads the tests in that checkout;
compare its recorded test/source/runner hashes with the corresponding JSON.
For the corrected state, a safe evidence-preserving command is:

```sh
node scripts/ci/ci-efficiency-mutation.mjs /tmp/mutation-corrected.json
```

## Outcome rules and boundaries

Only an assertion failure in a completed test process kills a mutant. Import,
syntax, missing-report and suite/infrastructure failures are invalid. Timeouts,
budget exhaustion, inconsistent repeated outcomes or a missing counterexample are
unresolved. No equivalent mutant was claimed; equality on one witness would not
prove equivalence. Survivors are successful experiment outcomes, so they do not
make the runner exit nonzero. Invalid/unresolved experiments or failed original
controls do. Evidence includes failure names, exit codes and elapsed times per
trial. Exact timings vary across reruns.

The pilot covers eight chosen fault models, not all mutations or all classifier
inputs. It establishes neither cross-platform execution evidence nor hosted CI
economics. Independent review is deferred to the orchestrator; local syntax,
lint, original suite and whitespace checks passed.
