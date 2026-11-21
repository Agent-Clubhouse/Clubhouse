# Evidence for the 28 inherited full-suite failures, plus c229/c555 logs

Branch `details-local-composition/3733-f1-parity`. These are copies of raw output with path prefixes replaced. `SHA256SUMS` lists the raw host-local files and these copies.

## Full suite on `d702a2705`

| File | Command | Result |
| --- | --- | --- |
| `validated-head.txt`, `pre-status.txt`, `post-status.txt`, `load-before.txt` | `git rev-parse HEAD`, `git status --short` before and after, and `uptime` | `d702a2705`, clean before and after |
| `lint-scope.txt`, `lint.txt` | `git diff --name-only 69ef383ce HEAD -- '*.ts' '*.tsx' \| xargs eslint` | Exit 0 |
| `tsc.txt` | `time tsc --noEmit -p .` | Exit 0 |
| `full.txt` | `time vitest run --no-cache --maxWorkers=4` | 1463 files passed, 13 skipped. 35527 tests passed, 114 skipped, 0 failed. Exit 0. |

The baseline with 28 failures is `../3733-full-suite-11fc/`.

## Per-cause mutation logs

Each run started from the uncommitted fixed tree on `782e08cde`, which equals the committed `d702a2705` source for these files. Each log contains the applied diff, the test output, a byte-identical restore check and post-restore `git status --short`.

| File | Mutation | Result |
| --- | --- | --- |
| `mutation-identity.txt` | `annex-identity.ts` reverted (the ephemeral origin resolves the profile path again) | `annex-ephemeral-session` 1 failed, exit 1 |
| `mutation-routetemplate.txt` | `annex-telemetry.ts` reverted (literal groups kept) | Route coverage test 1 failed, exit 1 |
| `mutation-allowlist.txt` | `attributes.ts` reverted (three templates unregistered) | Route coverage test 1 failed, exit 1 |
| `mutation-chatleak.txt` | `RemoteAgentDetailsView.tsx` session set to the local chat | `SettingsCard` remote case 1 failed, exit 1 |

The headless fix is test-only. Its discriminator is the 25-test baseline failure in `../3733-full-suite-11fc/classify-*.txt`.

## Surviving c229 and c555 logs

These are the actual runs, kept as they were.

- `c229-c555-waking-mutation.txt`: dropping the `details.running` session guard fails the waking test (exit 1). The restore happened outside this log. Post-restore status was printed to the terminal only and is **not recorded here**.
- `c229-c555-view-pass.txt`: `RemoteAgentDetailsView.test.tsx` 79 passed, exit 0, on the tree with the waking test before `c2297c45b` was committed.
- `c229-c555-central-align-mutation.txt`: reverting `RemoteAgentDetailsView.tsx` to `c2297c45b` fails the older-host test, while the four withholding cases pass. The log includes post-restore status and the byte-identical check.

## Unclassified observation

`src/main/services/group-project-remote-create.sim.test.ts` failed one case ("a crash after the create but before its answer was saved still answers created after a restart (QA #3569)", 1205 ms) once, in a parallel run of 48 `annex-identity` importer files on the tree with the identity fix. It then passed 23/23 alone twice with the fix and once without, and it passed in both full suites. The cause is **unclassified**. The failing run's output was not kept (only the summary line was printed), so no log exists.
