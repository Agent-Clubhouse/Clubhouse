# #3720 owned secure listener helpers: separate utility piece

Source `19a681f03ec1c62e26ff328dd3f983e07e52986a` on `annex-wake-readiness/3720-owned-listeners`; actual base main `77fa095320f2184ebf8870a5251ad0fd26a46501` (#3766 landed primitives). The prepared test checkpoint c0b5cc88e was composed with that main at fac520810 before execution. This proof branch adds documents only; source/test/package bytes equal the candidate.

Design: corrected RL-1 proposal `d64c8e6f125eea05a51fa3d9153f08342a7e0f40`, independently approved at `8218d7c84280490811afbbeeae1a4f7a67af4d90:docs/qa-transfer/2026-11-20/reports/3720-runtime-readiness-rl1-d64c8e6f1-review.md`. Preserve original c4daf8bef proposal and QA631509 RL-1 rejection/required-change history; its wrapper cleanup had no unqualified clearance. Lane append-site concurrence is coordination, not consumer acceptance. The source invariant check reconstructs the current server file from base plus exactly the approved d64 functions, removing only the artifact's first REVIEW ONLY comment. All existing default start/startVerified/stop/listen and other production bodies remain byte-identical.

## Scope and behavior

Only two opt-in functions are added next to startVerified; no existing production caller imports/calls them. No handler, MCP host, client, startup/shutdown, REST/mobile/auth or name/store consumer changes.

- `captureSecureListenerReadiness(expectedHost)` captures existing serverGeneration, exact TLS/pairing objects, ports and host. It latches ready-at-capture and observes unchanged ownership plus current listening state. Captured unready never becomes valid. Pure memory observation: no settings/profile/status/identity reads, timers, emits or IO. It confirms local secure listeners, not remote connectivity, authority or intent.
- `startVerifiedWithReceipt(expectedHost)` invokes the existing strict verification, captures its actual attempt synchronously before await, and returns an owned predicate only after rechecking that attempt. Generation/object replacement and original expected-host mismatch throw typed superseded/unconfirmed **without STOP/rollback/refresh**. Only genuine still-owned readiness loss reaches the new behavioral cleanup (stop then typed owned failure). This cleanup is not described as observation-only. Default startVerified failure behavior and already-running refusal are unchanged; no expected-profile parameter is added to strict start.

A false listener predicate alone never authorizes STOP. The receipt has no caller/grant/settings/intent authority and is main-only, not an IPC DTO. Desired host must come from an admitted caller's actual owned committed settings/profile. No new retry, deadline, timer, keepawake or product policy.

## Actual final proof on 19a681f03

- **14/14 new controls pass**, 644 other tests intentionally skipped in the focused command.
- **658/658 complete server tests pass**, including pre-existing default/start/verified-MCP and listener-drain tests. That full file includes existing controlled loopback socket tests; it is not a live app/host or OS shutdown/suspend test.
- Full `tsc --noEmit` exit0; two-file ESLint `--quiet` exit0 under the repository's existing errors-only gate (not a zero-warning claim); base-to-head diff check exit0.
- Eight mutants fail on assertions, then byte-exact restored source passes **14/14** again:

| Deliberately weakened rule | Actual failed controls |
| --- | ---: |
| Capture generation removed | 1 |
| Wrapper generation removed | 1 |
| Replacement adopted by port/host equality | 2 |
| STOP on superseded attempt | 2 |
| STOP on expected-host mismatch | 1 |
| Ready-at-capture latch removed | 3 |
| Listener listening state ignored | 2 |
| HTTP fallback accepted as secure | 1 |

New controls cover held main/pairing readiness, captured-unready latch, equal-port/profile replacement, independent capture/wrapper generation checks, pure-memory observations, invalid expected-host refusal, already-running refusal/no stop, TLS fallback/no receipt, main/pairing bind errors, replacement between strict success and wrapper continuation, genuine owned close cleanup and RL-1 profile interleaving. The owned-loss control closes a modeled listener after strict verification and observes cleanup/port retirement; it does not separately inject a private cached-port-only corruption or claim OS teardown.

## What is real and what is modeled

The new helper cases use real Node server objects and production server/listen promises, with listen/close/address/listening modeled in the test. They bind **no OS sockets**. One-shot listening getters queue a close/replacement between strict verification and the wrapper continuation. Deliberately reused modeled constructor objects isolate each generation fence, with an explicit two-object assertion; default production constructors are not claimed to reuse objects. Mocks are not OS teardown credit.

RL-1 uses the **actual createSettingsStore pendingWrite/updateLock and actual temp-file fsync/primary replacement** in a test-created unique directory: A is saved, independent B updates loopback, the primary file is read back as B, then old expected-A starts against B. The actual helper refuses without STOP while B's modeled runtime remains listening. annexSettings.getSettings delegates to that store and the profile function is mocked; this is not the real SAVE handler/MCP host/Ask/grant queue composition. It establishes the helper discriminator, **not RS1 consumer proof**, commit-version authority or process/power-loss durability beyond the existing store behavior. The test removes only its own temporary directory.

## Original negatives and attribution

- missing-api-red on fac520810: **10 failed/1 passed/644 skipped**. The default-start driver control passes; failures are absent additive APIs. Test-only credit, no existing Annex defect proved.
- first-implementation:11 controls pass while implementation is untracked. Historical only, not final-head proof.
- candidate-green on d292e339f:13 pass/1 fail. The reuse fixture incorrectly spied default constructor properties while the server uses named imports; it observed4 objects rather than2. Its earlier capture-reuse assertion also lacked the count discriminator, so that run does not isolate the generation fence.
- full-server-suite on d292e339f:657 pass/1 fail, the same fixture failure. I launched that full check before inspecting the focused exit; both original failed outputs are retained, not credited as green.
- fixture-correction on d292e339f with captured test diff:14 controls pass. The correction mocks the named constructor exports with default delegation, asserts actual reuse, and is committed at19a681f03. Final full658 validates no leakage to existing cases. Product helper code is unchanged by this fixture correction.

All19 command receipts preserve actual execution head, argv/timestamps, input hashes before/after, tracked diffs, full stdout/stderr and exits. Failed expected0 receipts remain failed. Mutants carry their source diffs and are not clean-commit runs. source-invariants.json plus the copied approved artifact bind the only production additions and lack of consumers; verify-evidence.py independently reconstructs that equality. SHA256SUMS.txt seals the archive. No old receipt is reconstructed.

Admission:16 CPUs/load2.57, all1,176 nonoptional dependency versions verified against the existing matched lock/cache SHA256 bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d. Before final full suite load1.71; before two concurrent read-only type/lint checks load2.27. Vitest uses one worker/no file parallelism, task-local cache-disabled runner config, NODE_DISABLE_COMPILE_CACHE=1. No install/shared dependency write. Original measurements/config are retained.

## Deferred integration and reproduction

No helper consumer, actual operation/admission receipt, committed-settings publication, grant/Ask migration, name activation, client/discovery readiness, emergency/recovery, real app teardown, live host, release or install acceptance. RS1–5 remain required for future exact consumer source/review: real SAVE/store/MCP queue composition; original r3 admission/owned versions after wrapper and before effects/activation/ACK/status; emergency fences; every catch/STOP/status ownership check; offline Alias independent of network. Preserve abortControllerReads before devicesChanged. TLS start failure must still perform admitted independent client-off/control effects unless genuinely superseded; no early failure return bypass. None of that missing consumer work is fulfilled by these helper tests.

With the verified cache, copy vitest.proof.config.ts.txt to `.cache/3720-owned-listeners/vitest.config.ts` and run the recorder with a NEW_LABEL and the desired focused/full command. The recorded full command runs this server test file without -t; the focused command uses `-t 'owned secure listener readiness'`. Choose new labels to preserve original task-local records. verify-evidence.py validates the retained archive without executing tests/installing. Exact-source independent review and hosted CI are still required before PR/landing.
