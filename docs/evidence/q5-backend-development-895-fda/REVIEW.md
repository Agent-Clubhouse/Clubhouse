# Development receipts: incomplete private Q5 candidate

This is preservation, not a request for partial feature/source acceptance. The
coherent backend/root/receipt/recovery/PB1–5 candidate remains incomplete.

Exact895caf876bf2624b8c791d750692fef6fa177fda (tree
9f60f02b16e4d369e932e5a10f8fe28657c9dcfa): four whole-root barrier tests PASS,
39 other tests unselected by -t; root project types exit0; four-file lint exit1
with one no-unsafe-finally error and three deferred-error-reporting warnings.
All raw output, including Vite config warning, is preserved. These tests do not
execute the new physical backend or legacy codec. Native platform tests were
not selected, and no Windows proof transfers from earlier landed code.

Exactfda9167e29a525206edb08599d232d35640c3a03 (tree
e82cb8be5ad9d0aaf8168432ce4e9f151f16b411) changes only framed-journal.ts:
retain cleanup error for throw after finally and document deferred propagation.
Single-file lint exit0, no diagnostics. No test/type execution on fda is claimed.
The diff is retained; unchanged page/test bytes are a static bridge only.

Every command was normally admitted at min4GiB tests/lint or min6GiB compiler,
maxWorkers2 for Vitest. Clean exact head/tree,35 selected source/config hashes,
sealer hash and before/after identity are embedded in each receipt. Four
commands only; no refusal/retry, CI run, gate change or shared dependency write.
Original worktree dependencies restored; matched lock/811-link cache reuse only.

Procedure exception: the initial restoration helper asserted all three results
were passes before reaching rename; lint1 correctly caused its assertion to
fail, before any restore mutation. The immediate next helper checked terminal
receipts regardless of result and restored dependencies. This is an observed
helper-procedure error, not a child test failure or extra execution. After the
source fix, cleanup-lint reuse was independently restored as well.

No authoritative root, shared receipt manager, active-anchor/recovery proof,
legacy byte bridge, behavioral mutants, GC/storage/heap budget or runtime/app
consumer exists yet. Consult docs/design/q5-framed-root-journal-wip.md for the
remaining source work. Source76e1,895 andfda remain separate immutable freezes;
prepared224e and C1b11/19e acceptance is not widened.
