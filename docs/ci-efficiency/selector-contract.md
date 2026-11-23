# Affected-test shadow selector contract

This is a reversible **REPORT-ONLY experiment**. No workflow, job condition, required check, shard, environment, release or hosted activation consumes this output. Existing full CI remains authoritative. Remove the three affected-shadow/contract files to revert the experiment. No skip authorization follows from a `selected` report.

## Stable replay interface

```sh
node scripts/ci/affected-shadow.mjs --base <commit> --head <commit> --repo <checkout>
node scripts/ci/affected-shadow.mjs --base <commit> --head WORKTREE --repo <checkout>
```

The installed TypeScript parser is required; nothing is installed or fetched. Git revisions resolve to immutable commit objects. The first form compares the two trees directly, not their merge base, ignores checkout edits, never checks out or executes historical code, and batches code blob reads. The caller must supply the intended push before/head or PR comparison endpoints and retain merge/checkout identity separately. Do not pass an unreviewed merge-base approximation. Outside-cohort historical comparisons read inventories only, making broad replay inexpensive. Revision names beginning with `-` are rejected.

`WORKTREE` compares the base with current tracked on-disk content, including staged additions and deletions. Untracked nonignored files force full fallback. It is a local diagnostic, not immutable historical acceptance evidence. Ignored install/build outputs are outside its source inventory; the existing global Windows path check still examines ignored paths. Use immutable mode for audit/replay.

Stdout is JSON (`schemaVersion: 1`): `reportOnly`, `mode` (`full` or `selected`), `fullSuiteRequired`, resolved `base`/`head`, sorted `changed`, `changedStatuses` (A/D/M; renames appear as delete/add), `tests`, `reasons`, `evidence`, `platforms`, `projectTests` (project/file identities shared by both platforms), `invariants`, parser version and contract/selector SHA256 fingerprints. Successful reads also include base/head config Git object IDs. Unknown history, missing objects, unsupported symlink/submodule boundaries or read failures produce `full` with `input-uncertain`. Its enumerated tests may be incomplete: **`fullSuiteRequired: true` always means the entire normal suite, never just a partial `tests` array**. Invalid CLI arguments exit 2; advisory decisions exit 0. No GitHub outputs are written.

## Eligibility and architecture

The production cohort is exactly `src/renderer/utils/format.ts`, optionally accompanied by its direct `format.test.ts`. This is the duration formatter imported by `TranscriptViewer`, not `features/agents/states/format.ts`. The architecture evidence is [architecture-map.md](architecture-map.md), authored on architecture branch commit `f81c20b65`; this implementation retains an intentionally broad test set.

Both snapshots must contain one exported `formatDuration(ms: number): string` function and no other module statement. A positive AST grammar admits local `const` bindings, arithmetic/comparison expressions, `Math.round`/`Math.floor` with one argument, literals/templates, conditional expressions, blocks, ifs and returns. It excludes imports, aliases, re-exports, assignments, mutable state, property/computed access except those two Math calls, arbitrary calls, loops, new expressions, async/default/rest parameters, globals, OS/locale/time/environment access and module effects. This permits general numeric/output semantic changes without permitting a new capability. Export signature drift fails. No content or historical SHA allowlist exists.

The additional test-only cohort is exactly:

- `src/main/navigation-guard.test.ts`, importing `vitest` and `./navigation-guard`.
- `src/main/build-info.test.ts`, importing `vitest` and `./build-info`.
- `src/renderer/utils/format.test.ts`, importing `vitest` and `./format`.

Only existing assertion expression statements beginning with `expect(` may change string/number literal inputs or expected values. The remainder of the AST must match. Import declarations/bindings, registration names, hooks, mocks, skip/only, effects, operators and arbitrary call changes fail. Every static dependency must remain an import-free, hazard-free leaf; neither snapshot may have a reverse consumer of the test module. A test-only report proposes just those changed suites, preserving their original project/config/setup. Security-sensitive navigation production changes and build-info production changes remain full fallback.

Every changed path must belong to these exact contracts. Docs mixed with code, additions/deletions, renamed/case-only paths, config/setup/mock/fixture/assets/generated/vendor changes, dependencies, workflows, selector edits, main/shared/preload/API/IPC/native/platform changes and unknown paths fan out. Empty input fans out. There is no directory-wide eligibility rule.

## Graph and retained boundaries

The installed TS parser builds static import and export edges from every tracked JS/TS module in both snapshots, including type-only imports. Import declaration text is part of the contract, so changing bindings is a graph change. Local resolution uses canonical POSIX paths independently of host OS, explicit source/index extensions and `.js` to TS source mapping; ambiguous/unresolved local paths are hazards. Reverse traversal includes static transitive/barrel test consumers. Changed module graph signatures must match across snapshots. Cross-feature formatter reverse consumers outside renderer force full fallback.

Dynamic imports (including literals), import types/equals, require, mocks, module resolution/globs, source reads and platform/global capabilities are explicit opaque boundaries. Bare package imports are retained as specifiers, not guessed as local aliases. A newly introduced alias or dynamic edge in an eligible file fails. Existing alias, dynamic, Electron and plugin behavior in retained projects is a stable boundary under unchanged config; this tool does not claim to resolve IPC strings or execute arbitrary loaders.

A production report retains, on **both Linux and Windows**:

- Every renderer/shared/preload/integration test, including direct formatter, transitive TranscriptViewer/UI consumers, shared source readers, bridge and integration contracts.
- Main dispatcher-copy, IPC index integration, Windows PTY, PTY manager, file-watch, auto-update-apply and auto-update-apply-windows sentinels. A missing sentinel fails closed.
- Every main/scripts test with an AST dynamic/runtime/source-reader hazard or fs/path/module/child-process import, and every static reverse test consumer of such a module in either snapshot. This deliberately retains many unrelated tests; unknown source-reader/dynamic behavior is covered by retaining its tests rather than interpreting arbitrary filesystem code.

All existing global setup/teardown, project setups/aliases, test identity, failure status and skipped-test reporting remain mandatory. A consumer must map paths to the unchanged Vitest projects (`src/main` + `scripts`: main; renderer/shared/preload by source root; `test`: integration), keeping the same selection on both platforms. No new minimal config, `--passWithNoTests`, source-only project intersection, or unscoped positional-filter union is authorized. This reporter executes no test command.

All current lint/workflow lint, drift, typecheck, coverage/API/architecture ratchets, Windows-path/denylist planning, Linux/Windows build and every existing E2E/Annex/chat shard remain unchanged, along with SDK/native/glibc/package checks and artifact uploads under their existing triggers. Existing macOS pause/manual/full-ci semantics remain unchanged. Mocked OS sentinels do not establish real Windows execution.

## Evidence and deferred acceptance

Contract tests cover static/export/type/transitive edges, bindings, aliases, unresolved imports, dynamic/require/mock/glob boundaries, config/fixtures/shared/platform/unknown paths, deletion/addition, cross-feature/test consumers, missing sentinels, assertion-only shape guards, immutable Git reads against dirty working trees, untracked files and unavailable history. Synthetic rounding/minute/hour/output mutations remain eligible, and existing direct formatter behavior vectors detect each fault. These are controlled synthetic witnesses, not historical savings.

On the initial selector workspace tree (`817ef3827c266dab9fef40c9ab06cd23d06fb394`), a separately synthesized round-to-floor edit proposed 1,468 of 1,491 test files, retaining 43 formatter reverse consumers. This is an inventory count, not runtime savings, platform acceptance, or fault detection by every retained consumer. The main historical survey/replay belongs to the parent lane. Zero eligible production history is an honest possible result. Historical outcome pairs are never hardcoded to manufacture hits.

Local tests run with one worker. Linux and Windows execution on the exact eventual integration head, independent review of source-reader completeness/alias boundaries, full-baseline differential replay, mutation evidence from behavioral UI consumers and any hosted evidence remain **deferred acceptance**. This report does not establish a false-negative rate or authorize activation. Current source-reader discovery is conservative, not a general proof of JavaScript dependency completeness; independent review may widen retained scope or reject selection.
