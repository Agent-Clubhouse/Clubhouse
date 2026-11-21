# Main reconciliation for #3749: daa7dab5e (#3751)

Head `b28fbae691be9cab1286164b8970a1c9d12ac52c` merges `main` `daa7dab5e` into the #3749 head `879064193e9301e663bdf7b26ed0f6d2efd49776`. These are sanitized copies of output.

## Overlap, verified as real (not disjoint)

`git merge-tree` against `daa7dab5e` reported a content conflict in `src/main/services/clubhouse-mcp/binding-manager.ts` (`merge-output.txt`). It was an import-only conflict, resolved as a union:
- the stack's `createHash` and display-settings types
- #3751's `initializeBindingToolKey`

Each import is used once or more in the merged file. #3751's only other change there initializes a stable tool key when a binding is created. The stack's read-only binding display does not create or replace bindings, and does not read tool keys. `bridge-server.test.ts` auto-merged and contains both sides. See the `union-diff-*` files. Lockfile unchanged.

## Checks on `b28fbae691be9cab1286164b8970a1c9d12ac52c`

- `daa7-tsc.txt`: exit 0.
- `daa7-lint.txt` (scope `daa7-lint-scope.txt`, changed from `daa7dab5e`): exit 0.
- `daa7-focused.txt`: `vitest run --no-cache --maxWorkers=3` with a fresh default-depth `TMPDIR` over 70 files (listed in the log). Those are every test importing `binding-manager`, `readBindingsForDisplay` or `selected-outgoing-wires-display`, plus `bridge-server`, `binding-incarnation` (the only `binding-tool-key` importer), `tool-registry`, `persisted-bindings` and `test/mcp-target-tools`.
  - Result: 3056 passed, 6 skipped, **1 failed**, exit 1. Pre-status is clean; post-status is printed in the log and clean.
  - The failure is `group-project-remote-create.sim.test.ts`, "a crash after the create but before its answer was saved still answers created after a restart (QA #3569)", a `vi.waitFor` timeout at line 338.

## Intermittent observation, cause unclassified

- This is the second observation of this case under parallel load. The first was on a tree without #3751, during the 28-failure fixes, and was not logged.
- One isolated run each, not retried until green:
  - `sim-isolated-head.txt` (this head): 23 passed.
  - `sim-isolated-main.txt` (main `daa7dab5e`): 23 passed.
- Not introduced by #3751. Not waived. The cause is still unclassified.

No full suite was run on this head. Hosted CI on this head would be the next proof.
