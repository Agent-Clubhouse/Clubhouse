# #3738 preview/list consistency successor

Frozen source: `0723c341045212306c3966f6b8951b626d95e10f`, branch `fix/3738-preview-consistency`, parent `807360c543a28848e9359564b7917d0bac425e91`. This evidence branch adds no source changes. The original approved source, evidence `7e362e2cc1f0ea153a5569dad86ec5cfedc00a0d`, QA `017eca2e14022abf023682d1915198b7a88b5a7a` and original hosted RED remain intact. This bundle is for independent review of the four-file preview/Dispatcher delta, not a claim that hosted validation is green.

## Observed proof

| Receipt | Observation |
| --- | --- |
| `baseline.*` | On unchanged `807360c54`, the two actual failing files reproduce **3 failed / 105 passed**, exit 1. No assertion or source had been changed. |
| `development.*` | The same two files plus new controls pass **111/111**, exit 0. |
| `importers-exact.*` | Exact successor: **633 passed / 14 files**, exit 0. Includes original identity/authority consumers and both affected files. |
| `typecheck-exact.*` | Full `tsc --noEmit`, exit 0. |
| `lint-exact.*` | All changed TypeScript files, exit 0, zero errors / eight retained warnings. |
| `mutation-preview-divergence.*` | Remove only Target attribution from the preview result, leaving guidance sanitization intact: **3 failed / 72 skipped**, exit 1. Original strict comparison and both agent/group controls detect divergence. Bytes restored in `finally`. |

Exact records bind HEAD and source SHA-256 before/after. `manifest.json` pins the four-file delta, all changed-source hashes and unchanged identity-source hashes. `SHA256SUMS` seals every bundle file except itself. Source/tests used the existing matched dependencies and desktop admission gate, one Vitest worker, 4 GB focused/lint and 6 GB typecheck. No local E2E, dependency install, source rebasing, blind CI retry or PR update was performed for this successor proof.

The production delta extracts the existing current Target attribution and sanitized wire-guidance formatting into one pure `buildBindingToolDescription` function. Live listing and guidance preview use that same function with the same actual current binding. Preview's input validation, live-binding requirement, catalog/authorization and read-only behavior are unchanged. It receives only the same bounded/sanitized public display name/project/address data already shown by the tool list. It does not mutate instructions or introduce private configuration/path fields. The original exact preview/list equality assertion remains; new controls cover both agent/group targets, control characters, bounds, private-field canaries and relabeling without changing the callable key.

Dispatcher fixtures now capture actual live callable names instead of reconstructing descriptors. Real list descriptions change on Dispatcher/project rename while the actual binding and key remain stable. A source-removal/rebuild control uses the real caller gate and declared message grant: it proves old names return `no_binding`, a replacement receives a new key, and exactly two legitimate handler calls occur. No authorization assertion was weakened. `binding-tool-key.ts` and `binding-manager.ts` are byte-identical to `807360c54`; the process namespace, generation, removal and permission behavior were not changed.

## Original hosted RED and exact artifacts

PR #3751's original Validate run is `44876043424`, source `807360c543a28848e9359564b7917d0bac425e91`, base `c0cf2f1974b98a9418f1682284c6535d1a1e396b`, synthetic checkout `4ca724d90afa9ba95c18345add6336ed55a809fd`.

- Ubuntu unit 2/2, job `136760892815`: exact guidance-preview mismatch, **1 failed / 15,679 passed / 64 skipped**.
- Windows unit 1/2, job `136760892841`: two obsolete Dispatcher callable-name expectations, **2 failed / 17,777 passed / 91 skipped**.
- Ubuntu unit 1/2, job `136760892902`: the same two Dispatcher expectations, **2 failed / 17,815 passed / 54 skipped**.

The `hosted-*-junit.zip` files are exact GitHub archives for Ubuntu2 artifact `14696395869` and Windows1 artifact `14696038077`. Their archive SHA-256 values match the GitHub API digests. Each contains the original, unmodified `test-results.xml`; XML byte counts, hashes and actual failed cases are in `hosted-junit-manifest.json`. Extract without rewriting to verify:

```sh
unzip -p hosted-44876043424-ubuntu-2-junit.zip test-results.xml | shasum -a 256
unzip -p hosted-44876043424-windows-1-junit.zip test-results.xml | shasum -a 256
```

Raw hosted logs are stored with deterministic, lossless gzip compression. Their original byte counts and hashes are in `manifest.json`; `gzip -cd FILE.log.gz` restores the original bytes. The three exact Playwright/JUnit trace ZIPs for Annex Ubuntu1 and Chat Ubuntu3/Windows3 are retained too. These additional E2E failures are **not** classified as flakes or fixed by the preview delta:

- `e2e/dispatcher.spec.ts:405/408` selects names containing the full display fragment `conductor`, which bounded opaque keys no longer guarantee. Both platforms fail before the call at `get_status` selection.
- `e2e/annex-v2/agents-across-machines.spec.ts:329/399/400` reuses a pre-crash callable after actually killing and relaunching the sender application. A new process incarnation deliberately invalidates it. The strict receipt hash at line 401 remains required. A consumer correction must rediscover the same exact target's current callable while retaining identical arguments/idempotency and strict receipt checks; it must not restore old-namespace acceptance.

The E2E consumer correction is a separate test-only successor. Original traces, retries and strict receipt assertions are preserved. `pre3738-main-comparison.json` records existing main run `44875569706` on `c0cf2f1974b98a9418f1682284c6535d1a1e396b`: all four unit shards and these same three E2E jobs passed. The two E2E spec files are unchanged between that main source and this successor. No new main execution was requested.

## Portable commands and remaining gates

Every exact command is an argument array in its JSON receipt. Run it through the existing approved resource gate with matched dependencies. To reproduce the original two-file baseline, restore the four paths named in `baseline.json` from its `baseline_source` into an isolated checkout, run the recorded command, and restore the successor bytes. The mutation record contains its exact source path and one-occurrence substitution, with before/mutated/restored hashes. Expected baseline/mutation exit is 1; green/type/lint exit is 0. Do not treat resource refusal 75 as a test result or retry faster than the gate permits.

Independent delta QA is required before updating the single existing PR. The reviewed, updated source still requires ordinary exact-head hosted validation. There is no local E2E authority or waiver of hosted failures, no P8 draft modification, no receipt-threshold weakening, no old namespace alias, no live probes/settings/access changes, and no release or final merge action. The parent orchestrator owns the final guarded merge after green.
