# #3774 final-publication R1: narrow source successor

**Source:** [15f54f5ec7eac7e6d8ef0f14a730d8dac4413181](https://github.com/Agent-Clubhouse/Clubhouse/commit/15f54f5ec7eac7e6d8ef0f14a730d8dac4413181), tree `69a47d66e02836cba39436cf3bfe235e1273b58f`. Exact independent successor review remains pending. No PR/CI update or Windows observation has occurred.

Read the complete immutable [SOURCE BLOCK611f](https://github.com/Agent-Clubhouse/Clubhouse/blob/611f19a65030fdff8787089aa03dff22cffded0c/docs/qa-transfer/2026-11-22/reports/3774-phase-source-7d816673e-independent-review.md), SHA256 `d302a195d9a0f4824fa053d2571f2c581a22f6ab1752e322f99a041c69bed3bb`. It identifies only R1 as remaining: after freeze, a final raw-write exception could still publish a complete zero-failure packet through the surviving console channel, and optional post-freeze clock failures were discarded. This is diagnostic fidelity, not a production vulnerability.

The sole executable delta from source7d/evidence43a is the fixture's final publisher at `delivery.test.ts:188-195`: **5 added / 10 removed lines**. The local raw-write success boolean selects either the already prepared packet or the fixed `{"version":1,"observerUnavailable":true}` envelope for console publication. A console exception has one bounded remaining raw unavailable notice. No frozen state mutation, recursion, retries, new callbacks, native forwarding, phase timing before freeze, original assertions, grant cleanup, deadlines or workflow change. Optional post-freeze console timing/status sampling is deliberately omitted altogether, rather than recording an unaccounted observer failure.

The unavailable envelope reports an observation loss; it does not assert that a write returning is durable acknowledgement. If both channels fail, the primary/native outcome remains untouched and no observation proof is invented. The old immutable implementation report's console-emission timing description applies to7d, not this successor.

## New bounded evidence

All original commands, gate minimums, selected input/installed identities, before/after seals, raw outputs and exit codes are retained in each receipt. No refusal/retry occurred. These are darwin/Node24.22.1 results, not the original Windows/Node22.23.4 environment.

| Attempt | Actual input and result |
| --- | --- |
| 08 final-output red / min4 | Source43a (runtime7d) plus exact archived overlay: **2 FAIL, 1 PASS, 67 SKIP**. Only-final-raw-write fault still produces JUnit `observerFailures:0/observerUnavailable:false`; clock control sees2 post-freeze reads. Original #3517 target assertions pass. |
| 09 final-output fixed / min4 | Same base plus archived full corrected-control patch: **3 PASS, 67 SKIP**. Actual JUnit final-write-only packet is exactly the fixed unavailable envelope. Post-freeze clock assertion sees0 calls; original target still passes. |
| 10 restored types/lint / min6 | Clean exact15f source: strict actual complete fixture plus inherited production graph **PASS**, scoped eslint **0 errors / 0 warnings**. |
| 11 restored original target / min4 | Clean exact15f source: **1 PASS, 67 SKIP**, one actual final JUnit packet identical to merged raw,20 transitions, no active work or observer failure. No unchanged full fixture/control matrix was rerun. |

08/09 command: `npx vitest run --project main src/main/services/managed-agents/delivery.test.ts --maxWorkers=2 -t 'phase r1|does not claim installation of a grant-gated skill left to the project' --reporter=default --reporter=junit --outputFile.junit=<retained XML>`.

10 command: `npx tsc --noEmit -p docs/evidence/3774-phase-observation/fixture-tsconfig.json && npx eslint src/main/services/managed-agents/delivery.test.ts`.

11 uses the same existing runner/reporters, selecting only `does not claim installation of a grant-gated skill left to the project`. The now intentionally changed publisher is **not** subjected to the earlier d333 emitted-JS equality test.

## Honest source/control bridge and preserved acceptance

`08-final-output-controls.patch` and `09-final-output-fixed-controls.patch` reconstruct the exact receipt fixture hashes from43a. Removing the owned08 overlay from09 reconstructs the exact frozen15f fixture bytes. The two disposable fault cases/hook/spies are not shipped. Their actual afterEach publisher output, not console return alone, is asserted and checked in JUnit/merged raw. For the write fault there is deliberately no successful direct final raw-write record; the surviving unavailable console record appears in the captured raw/JUnit output.

`r1-audit.py` checks four before/after/raw receipts, counts/packets,58 restored selected identities, exact patch byte reconstruction, and unchanged prior manifest/31 artifact hashes. Its retained output is `attempts/12-r1-attribution.json`. It performs file/source attribution only, not another application test.

The prior [43a manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/43a20457f8091ebe5d450b6e52953ec30d005554/docs/evidence/3774-phase-observation/manifest.json), SHA256 `99438287d9668360f0bdd332641c4a2041cfd98a3fa4536d082672787638499d`, remains byte-identical. BLOCK611f independently verified its89 blobs/7 receipt pairs, accepted the explicitly erased d333-to7d typing bridge, and assessed prior setup failure, unchanged5000 abort, native forwarding/error/stop, listener detach, retired/fresh isolation, bounds and output controls. Those accepted proofs remain precisely attributed to their original sources; they are not relabeled as15f execution.

Original44981401024 failure, forensics1df, rejected8a/4c lifecycle, corrected66a/b1a design, source7d/evidence43a and all original FAIL/NOT RUN evidence remain preserved. No prior Windows cause, flake, timeout fix, grant/security/full-duplex/phone closure, waiver or landing claim follows. SAME #3774 stays at e566 pending independent exact successor review.
