# P6 validation record

Base: `aa193423d` (origin/main). Branch: `feat/3613-p6-binary`.
This is a PARTIAL slice of #3613; P2/P7 routing and P8 acceptance are separate.
No local E2E, Playwright, full suite, release or PR creation was run.

All npm, TypeScript, eslint and Vitest commands used
`~/.clubhouse/orch/desktop-test-gate.sh lane-3613-p6 <tier> -- <command>`.
Vitest always used at most two workers. Initial npm/tsc attempts at tier 6 were
refused with exit 75 (`go_compiling_hold_heavy`), at intervals exceeding 60 s.
The orchestrator explicitly changed tsc/eslint to tier 4 during iOS compilation;
that override applies to the final static checks below. npm ci remained tier 6.
A root node_modules symlink was used only for iteration and removed before the
successful clean npm ci. Final evidence uses this branch's installed lockfile.
The urgent #3685 explicit gate hold was respected between regression and final
mutation passes, with refused attempts at least 60 s apart.

## Original failures, retained

These are historical runs, not discarded or replaced by later passing results.

| UTC start | Command after the gate | Original result and correction |
|---|---|---|
| 18:13:47 | `vitest run src/main/services/annex-control.test.ts --maxWorkers=2` | FAIL: worker reached its 4 GiB heap limit after 108 tests. Vitest's object matcher expanded a large Buffer. Changed large-buffer assertions to `Buffer.equals`; no heap limit was raised. |
| 18:14:44 | `vitest run --project main` (control, bulk, attachments, mobile-attachments; 2 workers) | FAIL: 4 failures / 150 passed. One close-code fixture expected authorization_revoked but received transport_unavailable; now real close code 4401 propagates. Three new real-I/O fence tests timed out because their call-through spies targeted fs.promises while the service imports fs/promises; fixed the module wrapper to call actual I/O. |
| 18:17:13 | `vitest run --project main` (annex-server, real binary fences; 2 workers) | FAIL: 1 failure / 524 passed. Existing handoff exact-argument assertion omitted the new beforeRead fence; updated it to require the function. |
| 18:22:07 | `vitest run --project main` (six binary/service files; 2 workers) | FAIL: 1 failure / 170 passed. New readdir fence case lacked its call-through wrapper; added the actual readdir wrapper. |
| 18:24:37 | `python3 scripts/qa/annex-p6-binary-controls.py` | FAIL: 22 mutants killed, capability mutation INVALID because its source marker omitted optional chaining. RETRY at 18:25:13 corrected the marker; capability mutant killed. |

The original negative-main and mutant assertion failures are intentional controls.
The script preserves each complete child stdout/stderr in the chosen `--logs`
directory and restores every source byte in finally, including on interruption.
A passing mutation script means assertions failed as expected, not that mutant
implementations passed. Import errors do not count as killed mutants.

## Successful fresh-dependency checks

| UTC start | Tier | Command after the gate | Result |
|---|---|---|---|
| 18:25:27 | 6 | `npm ci` | PASS, lockfile unchanged. Existing package warnings and audit findings reported; no dependency changes. |
| 18:27:xx | 4 (override) | `./node_modules/.bin/tsc --noEmit` | PASS. |
| 18:27:47 | 4 (override) | `npm run lint` | PASS, 0 errors / 3428 warnings across the repository. |
| 18:28:39 | 4 | `vitest run --project main --project shared` for annex-control, annex-control-bulk, chat-attachments, mobile-attachments, annex-binary-fences, handoff-transfer-source and annex-control-protocol, `--maxWorkers=2` | PASS, 210 tests. |
| 18:28:56 | 4 | `vitest run --project main` for annex-server, handoff-snapshot, handoff-host-transfer, handoff-transfer-transport and handoff-transfer-integration, `--maxWorkers=2` | PASS, 648 tests. |

## Negative controls and mutation coverage

`python3 scripts/qa/annex-p6-binary-controls.py` installs origin/main production
sources under the new tests, records their expected assertion failures, then
restores the working sources. It next removes guards one at a time, restoring
between runs. Every child uses `vitest run --project main ... --maxWorkers=1`.

The controls cover transfer count and metadata bounds; admission and byte limits;
sequence, token, length and SHA-256 integrity; subscription and request ownership;
negotiated features and sender direction; one credit per chunk and one write per
callback; reauthorization per frame and at a deferred actual socket send;
cancellation ownership at that send; required use of digest framing; attachment
write/publication fences; handoff read fences and slots held until actual work
settles. The initial negative-main run had 18 expected failures; the final run
includes additional content and concurrency regression controls.

The attachment tests wrap and await actual mkdir/readdir/writeFile/realpath;
the handoff test runs real snapshot verification/open/read and pauses the actual
pinned descriptor's stat. The service methods themselves are not mocked out.

Binary boundary cases include 0, 1, chunk−1, chunk, chunk+1, attachment cap and
cap+1, clipboard cap and cap+1, a 32 MiB full event, an encoded 8 MiB raw content
body, 72 KiB icon allowance, 3 MiB handoff allowance and uncapped text above
32 MiB. Tests also exercise cancellation, concurrent clipboard transfers,
queued control traffic during bulk, revocation and forged owners/directions.

## Final receipts

One tier-4 admission ran sequentially from **18:38:24Z to 18:39:34Z**, exit 0:

- `vitest run --project main --project shared` for control, bulk, staging,
  mobile-attachments, real binary fences, handoff-transfer-source,
  annex-control-protocol and annex-chat-content, `--maxWorkers=2`: **226 passed**.
- `vitest run --project main src/main/services/annex-server.test.ts -t P6 --maxWorkers=2`:
  **3 passed** (real attachment staging/chat.send, real large-file route, shared
  clipboard entry-point bound).
- `tsc --noEmit`: **PASS**.
- `npm run lint -- --quiet`: **PASS**. The earlier full, non-quiet lint run also
  passed (0 errors, 3428 warnings).
- `python3 scripts/qa/annex-p6-binary-controls.py`: **28/28 mutants killed**;
  negative-main produced **41 expected assertion failures**. Every child test
  uses `--maxWorkers=1`. Source bytes are restored in `finally` after each run.
- `node scripts/annex-mobile-fixtures.mjs --check`: **66 passed**; **102 fixture
  files** have identical SHA-256 before and after, and no fixture file changed.

Successful npm ci: tier 6, **18:25:27Z–18:25:37Z**, lockfile unchanged.
The preceding tier-4 server/handoff regression admission (18:28:56Z–18:30:45Z)
passed **648 tests** across annex-server, handoff-snapshot, handoff-host-transfer,
handoff-transfer-transport and real-I/O handoff-transfer-integration.

The mutation harness and the tests are committed and rerunnable. Full stage
logs from the final admission are at `/tmp/annex-p6-final/`; per-mutant and main
negative-control logs are at `/tmp/annex-p6-binary-controls-final/` in this
workspace. Earlier original failures remain in the session transcript and in
the history above, including the invalid capability marker and its successful
RETRY. These temporary logs are supplementary; no implementation or test exists
only there.

