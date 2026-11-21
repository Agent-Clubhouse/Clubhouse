# #3759 hosted CI: Windows unit 1/2, both attempts (run 44890217794)

#3759 (M1 with M1-a, head `3ca9a5c74c8c3971b889c69d5dfaa2421aa266af`) was merged as `50cb77ab6ccf9f383a39e59db308f4f8336051ea` after a guarded landing check. The single rerun passing was accepted for that bounded landing. **It is not root-cause proof or a timeout fix.**

| | Attempt 1 | Attempt 2 (one authorized failed-job rerun) |
| --- | --- | --- |
| Job | 136804274961 | 136809186483 |
| Result | failure: 1 failed, 19052 passed, 93 skipped | success: 19053 passed, 93 skipped |
| Checkout | `ba88603c`, merging `3ca9a5c74` into `d8c7247a4` | `ba88603`, the same merge and base |
| Artifact | id 14701752838, 601614 bytes | id 14702069542, 605193 bytes |
| ZIP sha256, equal to the GitHub API digest | `e70897298e123ca11d96ae45475fe43ac44a6b76ec101f3a93ffef125a0ff998` | `3edec70dbd57c42d816377c75663291165f0d7b81aa9cb346fc4b3a9c00775ad` |
| `test-results.xml` inside the ZIP | `d46fb30143c79002f538c3eee6c4c5844a9486795063acbf92eb17ca6fbb79e3` | `4e7c4c5caea2c8e665c82f019f59e72d62e359e3b53dd6905f714bfaf31cca1e` |

The `attempt*-test-results-windows-latest-1.zip` files here are those exact artifact bytes. `attempt*-job-log-excerpt.txt` holds the checkout, the target-file lines and the summary lines; each header records the full log's sha256 and size.

## Failure (attempt 1)

`src/main/services/dispatcher-federation-local-work.test.ts:236`, "continues related two-desktop work through local workers beyond eight hops", hit "Test timed out in 5000ms".

The test file and its source are byte-identical to `main` `d8c7247a4`. None of the test's first-level runtime and federation imports reach M1's product files. The deeper import graph was not assessed.

## Timings (`federation-test-timings.txt`, from the XML inside each ZIP)

- The target case took 5.157 s in attempt 1 and 0.557 s in attempt 2. Earlier passing runs took 0.589, 0.640 and 0.644 s.
- In attempt 1 the heavy "hundreds of round trips" case finished early (11.8 s against 20.2 s), and the 12 cases after it ran 5-60 times slower.
- The file totals were nearly equal: 23.92 s and 22.34 s.

**Hypothesis only:** asynchronous work from the heavy case continued past its own end and was charged to later cases. That would be test-isolation timing in an unchanged federation test. **The original trigger is unresolved.** No timeout was changed and no outcome was waived.
