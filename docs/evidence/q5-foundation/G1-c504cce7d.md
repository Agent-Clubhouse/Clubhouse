# G1 entered-attempt guard and exact proof

Unintegrated source `c504cce7db87c5e71e73b60cfc9efb898f7be9ad`, tree
`88d80f049df7d6bdda1b898575feea7ad93bfb16`. Prior0d source/583 evidence and
review74cd7dec remain preserved. This is not product/PR acceptance.

Journal entry now records the attempt ID independently of callback-handle
lifetime. A later `unsubmitted` request for an entered attempt is coerced to
`uncertain/handoff_unknown` and persisted; releasing the handle cannot release
the post. Never-entered proven-unsubmitted behavior remains available. The
process-local set is receipt-safety state, not runtime/session generation or
another recovery coordinator. Reopen turns in-flight attempts uncertain and
does not create a ready retry.

Exact focused control: capture→enter→release→unsubmitted retains attempt1,
rejects a new intent on the same coverage, reloads uncertainty and still admits
new post2. An isolated in-memory mutant replaces only the journal entered guard
with false. No source blob is modified and no provider is called.

Observed source checks:

- 42 tests/3 files passed, 7.79s.
- Full root ES2020 tsc exit0 (tests excluded by existing config).
- Scoped six-file lint exit0, 0 errors/0 warnings.
- Direct mutation receipt: guarded child exit0, “Entered coverage remained
  uncertain; no resubmission permitted”; removed-guard child exit2, “SAFETY
  ASSERTION FAILED: entered coverage became ready”. Overall proof command exit0
  means that the expected negative control was actually observed, not that
  mutated code is safe. Test reporter did not emit console child output, so this
  separate narrow command captures the exact child result directly.

All4 commands admitted through min4/min6 desktop gate, unchanged clean
before/after source head/tree and15 hashes; no refusal/retry. Exact inline
mutation-runner argv and raw output are sealed in `c504cce7d-mutation-attempt1/`.
Source mutation target must exist exactly once or the child refuses. No install,
live app restart, notification dispatch or runtime/phone integration occurred.
The actual synthetic directories for the direct mutation proof were retained;
their paths are in raw output, with synthetic IDs only.

Manifest now indexes13 receipts; prior9 hashes/raw remain unchanged. The
evidence commit is not the tested source. All other disclosed gaps, especially
lazy bounded hot-detail access, remain pending and are not credited here.
