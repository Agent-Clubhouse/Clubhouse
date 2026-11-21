# M1-a: role Connections pages fit the budget by truncating text, not dropping records

Branch `details-local-composition/3733-m1a-page-envelope-budget`, built on the frozen M1 head `9a368410d995fed558991bf7c40e615fff2f261a` (source `09e4d6522de2da5cf65972eefe654800448b2eca`, kept unchanged). It addresses QA `dd2423ddba77c7a2e994bfbb9c909fa5e43bc493`. Source commit `e3dd5eb9303600943378b1c5786de0da5879c8e7`. Sanitized copies of output.

## Defect (QA M1-a)

`selectedConnectionPageEnvelope` truncated text against the 256 KiB cap. A role Connections page between the role budget and the cap passed the envelope untouched. The generic trim loop then popped requested rows to meet the budget, silently losing selected records (PG1, #14).

## Change

Writers: `remote-details-presentation.ts` (a shared helper owned by #3733 and not reserved by any other writer), `remote-agent-details.ts` and tests.

- `selectedConnectionPageEnvelope(result, maxBytes = REMOTE_DETAILS_MAX_BYTES)`: the budget is clamped to the cap, and the cap stays the default and the ceiling. The text-truncation loop and the final `details_page_limit` throw both use it.
- The other caller, `remote-quick-details.ts`, is unchanged and uses the default.
- `readRemoteAgentDetails` passes its validated budget to the envelope.
- The generic trim loop never pops rows from a page-only requested Connections card. If nothing else can be trimmed it fails closed.

## Proof

- `red.txt` (frozen `9a368410d`, new tests, source unchanged):
  - The producer window test keeps 89 of 90 requested rows. That is the silent loss.
  - The envelope unit test finds no truncation notice.
- `green.txt`: 9 files, 1319 passed, with a fresh `TMPDIR`. Pre- and post-status clean. The files include every importer of the shared helper: `selected-connection-page-envelope`, `remote-agent-details`, `remote-quick-details` and `annex-client`, plus the role and Connections suites.
- What the tests cover:
  - In the window, every requested row is kept and the notice is present.
  - The inner body is within budget. The wrapped role response therefore stays within the cap by construction; that is the M1 service tests' exact-fit control.
  - The envelope's default is the cap.
  - An irreducible envelope budget throws `details_page_limit`.
  - An irreducible producer page budget gives 500, as in the existing M1 test.
- `mut-envelope-ignores-budget.txt`: an envelope that ignores its budget fails both M1-a tests. The restored hash equals the committed blob.
- `mut-loop-pops-page-rows.txt`: **ineffective, no credit.** Removing the trim-loop page protection still passes, because the envelope already fits the budget, so the loop never pops. The protection is source-supported redundant defense. No artificial test bypasses the envelope (agreed with QA).
- `tsc.txt` exit 0. `lint.txt` exit 0. `store-*.txt`: shared store unchanged.

No full suite was run.
