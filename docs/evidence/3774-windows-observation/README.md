# #3774: one authorized Windows diagnostic observation

**Automatic Validate run44990834408 completed SUCCESS**, attempt1, reviewed PR head `30f8287ccdc8241c3bc046c9ef3dd5833230cbf0`. All37 jobs are terminal:33 success/4 skipped. This completes the authorized observation, not a timeout-cause investigation or landing decision.

Actual Windows shard2 job137111373322 checked out `d17b9af3b22b77b18cd6e73f0979e40c7de8b43e`, the merge of30f into main `e68536e2d292ed0b824230e158e54ff79b2f027d`. Its GitHub tree is `040b9eb93b5dd769920564319f7f3e4becdf2b84`, exactly the reviewed30f tree. The owned watcher ended rc0; there was no second watcher, rerun, manual dispatch, local application proof, workflow or deadline change.

## Actual output and measured phases

The existing grant-gated #3517 target passes. JUnit reports **0.3456768 seconds**, including its fixture lifecycle rather than only body work. It contains one full final diagnostic packet with platform **win32**, Node **v22.23.4**,20 transitions, `observerFailures:0`, `observerUnavailable:false`, no overflow/drops, no abort, and final active=[].

The identical parsed packet appears in the original Windows job raw log. This is actual hosted normal-path raw/JUnit publication, not console-return acknowledgement or Windows failure-phase proof. The complete delivery fixture has68 JUnit cases: **67 pass/1 skip**, with the POSIX multiline-path case skipped; the target itself is not skipped.

| Phase | Observed wall milliseconds |
| --- | --- |
| beforeEach | 102.2641 |
| seed.copy | 80.0867 |
| builtins.ensure | 19.6533 |
| body | 239.9418 |
| git.init | 77.2371 |
| git.add | 54.5770 |
| git.async | 64.9347 |
| delivery | 102.6935 |
| resolve | 3.0723 |
| grant.cleanup | 0.0641 |

Final snapshot offset is343.9005ms. Parent phases contain nested phases: these values must not be summed. They include observer overhead and scheduling, not pure CPU/subprocess attribution. Child-close observation is not independently Git-success evidence.

## Retained evidence and audit

Official raw Windows job log SHA256 is `20cbfe98f8ca78cd75ee87e37f61b8e047a8b758af5c1b55164ee8c0859a550e`. It is retained losslessly as `windows-shard2-original.log.gz`; decompressing recovers the original bytes.

Original JUnit archive SHA256 is `002d7f42224065756ddca4d1f2d95ad2b1041e05c894d8925a95ea30ee2fe512`. Its sole `test-results.xml` member is15,910,287 original bytes, SHA256 `e0f78e38c3a73f413b3ae664d011d249f4433c92ed9dc9f474b14b83eade63c8`. The original zip is retained rather than adding16MB of uncompressed XML to Git. No raw/XML normalization or failure deletion occurred.

Registration/terminal/jobs/artifact metadata, actual checkout commit, target packet, PR terminal body/head readback, original watch output gzip and owner capture source are retained. `hosted-verification.json` records actual counts, phase walls and lossless archive checks; the manifest hashes every retained artifact.

The first file-only artifact audit failed because it assumed the macOS fixture's zero-skip count also held on Windows. Its original three-line failure is preserved in `artifact-audit-01-fail.txt`. Reading the actual Windows XML identified67 pass/1 POSIX skip, not an application/CI failure. The corrected artifact audit uses that observed count; it performs no application rerun.

## Bounded disposition and remaining limits

Read exact [R1 RESOLVED/APPROVE908a](https://github.com/Agent-Clubhouse/Clubhouse/blob/908aef3b47d51223a186ed8356458dbe14c37e2a/docs/qa-transfer/2026-11-22/reports/3774-phase-r1-15f54f5ec-independent-review.md) authorized this one normal observation. Diagnostic source15f/evidence30f and the #3714 production source720/approval592 are unchanged. The diagnostic branch's new evidence commit does not advance SAME #3774 beyond30f.

**Disposition:** the bounded normal Windows diagnostic-publication observation succeeded. No cause-supported fixture or production correction follows from this healthy sample; retain the reviewed bounded observer and immutable evidence, without extra probes or scope expansion. Parent-owned acceptance/landing remains separate.

Original [run44981401024](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44981401024) remains a real unresolved5000ms Windows failure, preserved with [forensics1df](https://github.com/Agent-Clubhouse/Clubhouse/blob/1df05ad1aa681ca0253d8898f93369d986f4858e/docs/evidence/3774-managed-delivery-blocker/README.md). No unfinished/failure phase was observed in the new successful target. These data do not establish the old timeout's cause, a flake, a fix, Windows setup/deadline-failure publication, phone/current-app/full-duplex/security closure, release or landing authority.
