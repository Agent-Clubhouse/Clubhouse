# Q5 sequenced persistence foundation evidence

Canonical issue: #3758. This is an **unintegrated WIP slice**, not feature/PR
acceptance. No app import, notification dispatch change or live action occurred.
Code branch: `auto-reset-policy-design/q5-durable-delivery-ledger`.
Audited source: `36e66d2bc938a8dc93bc95725e95ffbcc4aa88f3`,
tree `3d1d55370febb4e2275dd0c449599ed1d1457b33`.
Evidence branch: `auto-reset-policy-design/q5-ledger-evidence`.

## Observed checks

| Exact source | Check | Actual result |
| --- | --- | --- |
| 922542843ddbc3454c4fbc28d0c163aa837f3132 | Three focused suites | 34 passed; 1.60s |
| same922 | Full root ES2020 tsc | exit0 |
| same922 | Six-file scoped lint | exit1; 1 no-control-regex error, 0 warnings |
| 36e66d2bc938a8dc93bc95725e95ffbcc4aa88f3 | Three focused suites | 36 passed; 6.50s |
| same36 | Full root ES2020 tsc | exit0 |
| same36 | Six-file scoped lint | exit0; 0 errors, 0 warnings |

No old warning baseline or cross-head pass transfer is claimed. Correction36
replaces the control-character regex and adds257-hole persistence/later-flow
and automatic segment-rollover controls. The six original command receipts,
raw child outputs and gate outputs are preserved unchanged. Root tsconfig
excludes tests as usual; successful test transpilation is not a test typecheck.

All commands were admitted sequentially inside desktop-test-gate: min4
tests/lint, min6 compiler, maxWorkers2 for the focused Vitest run. There were no
refusals/retries/cancellations. The wrapper inside admission records exact
clean before/after head/tree and source hashes, argv, time, exit and raw hash.
`manifest.json` verifies each saved receipt and raw hash; it is a packaging
index, not a new execution seal. This evidence-only branch does not retro-seal
its own head as the tested code head.

## Environment and limits

Current root package-lock SHA256 is
`bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d`.
An existing cache with byte-identical lock was reused through811 reversible
per-package symlinks in this worktree's ignored node_modules. Shared cache
directories `.vite`, `.vite-temp`, `.cache`, `.package-lock.json` were excluded;
Vite's new caches remain local. Original node_modules is preserved externally,
and restoration is tracked by the owner. No installs, shared writes, lockfile
changes or credential/access changes. Raw linkage provenance is external under
`~/.clubhouse/orch/evidence/q5-implementation/dependency-linkage.json`.

The child-process fixture registers a TypeScript transpile-only loader with
ES2020/CommonJS and imports the actual new journal modules. It exits77 at
synthetic storage barriers, then a different process/reopened journal reads the
same temporary directory. It invokes no app/driver/provider/runtime. These are
actual fixture-process exits, not an installed-app restart or power-loss proof.

Observed scope includes interval compression, exact sparse ownership, disk
reload, uncertain-after-commit, immutable checkpoint references, version and
corruption refusal, callback ordering in the model, bounded on-disk attempt
pages and segments. It does **not** prove lazy bounded hot-memory access,
installation-marker migration, post-ID/adoption R1 controls, strict IPC/UI,
shared recovery generation, queued/immediate/wake integration, provider
processing, physical power-loss durability or latency at full product bounds.
Those remain explicit in `docs/design/q5-implementation-progress.md`.

Main78092f9b2 was integrated before36; later renderer-only main movement is not
credited as part of these exact checks. Independent bounded foundation review
is requested. No PR/activation/merge/release follows from this package.
