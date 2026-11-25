# #13 selected-board preview: implementation evidence

Implementation commit `ea9ca416922129531fccbf7b11b828a26be9aec4`, tree `3d7112f45389de188bd4ba3762e3742d8aad4eeb`. It's on top of the QA-cleared contract `e6fc2201feb28cd8f0af6bb152ea831935188aef` (`3733-selected-board-read-contract.md`), which sits on `main` `be0091d16`.

- **Partial:** this delivers a bounded, read-only preview. **Canvas-tab navigation to omitted boards stays OPEN**, and this doesn't complete #13 or #3733. The canvas plugin is unchanged.

## Exact-head proof (`run.sh.txt`)

- **vitest:** 42 affected test files (`scope.txt`: every test that imports a touched module), with `--no-cache --maxWorkers=4` and a fresh TMPDIR. Exit 0: 42 files, 2206 tests (`vitest-raw.txt`).
- **tsc:** `tsc --noEmit` over the whole project, exit 0, empty output.
- **eslint:** the 25 files changed from `e6fc`, exit 0 with 0 errors. No finding falls on a changed line or a new file; the warnings are existing ones.
- **Identity:** head, tree and clean status were identical before and after (`state-*.txt`). Every changed source file's working-tree sha256 equals its commit blob, before and after (`hashes-*.txt`).
- **Scope:** not a full-suite run.

## RED baseline (`red-e6fc-raw.txt`)

- **Method:** the new and changed test files were run against the `e6fc` source tree in a temporary detached worktree (removed afterwards).
- **Result:** 8 files and 15 tests failed, 1247 passed. The two files for new modules fail at import. Every failing test is listed in the raw log.
- **Regression guard:** the frozen old-client overview test passes on `e6fc`, by design: it guards against regressions and isn't a RED test.
- **Ordering:** the tests were written alongside the implementation, not before it. This baseline shows they fail without the change.

## Mutations (`mutations-raw.txt`, script `mutations.py.txt`; all restores byte-identical)

17 of 19 are discriminating:

- **M1:** wrong focus (the member key isn't bound).
- **M2:** wrong board (`canvasId` isn't bound).
- **M3:** the renderer adapter drops its captured context. It's caught by the renderer test of a page main would accept but that belongs to another board, row or project.
- **M4, M5:** the main-process member and selection bindings.
- **M7:** advertising the board source.
  - The frozen old-client test fails, along with 91 other overview tests. See `mutation-m7-full-raw.txt`; the batch log stops at 6 lines.
- **M8:** admission by the unadvertised source.
- **M9:** no premeasure.
- **M10:** dispatch to the membership reader.
- **M11:** the route accepting `member` on every source.
- **M12:** settlement ignoring the transition generation (the A→B→A case).
- **M13:** other agents labelled with their names.
- **M14:** the member view not keyed by the row.
- **M15:** no 500-view limit.
- **M16:** no `isRemoteInventoryPage` board branch.
- **M17:** the board page bound to its own source, not membership.
- **M18:** no `isRemoteDetailsQuery` board branch.

Two are **equivalent, no credit**:

- **M6, the main-process agent binding.** `isRemoteAgentDetails(body, agentId)` binds the Details agent, and the shared validator binds the board page's `agentId` to it. Dropping the redundant check can't change acceptance.
- **M19, the hook using the general inventory guard.** The hook only admits a page whose `source` equals its row-paged query source, and a board page can never match. The row-paged guard is defense in depth. The narrowing is enforced at compile time (the exhaustive `cardFor`).

## Implementation notes against the contract

- **Premeasure:** applied to the finished page-only envelope. The board page is fitted to `budget − envelope bytes` (`fitSelectedCanvasBoardPage`). Oversize returns a 200 `unavailable: limit` page. The outer throw is kept as defense.
- **Preview A→B→A:** when the row becomes navigable, the open preview closes. When it's omitted again, nothing reopens. A stale read is never shown, and a fresh read needs an explicit "Preview board (read-only)" click.
  - After any other discard while still previewable, the status reads "the preview was discarded", with a "Read the board again" control and no auto-retry.
- **Main/renderer seam:**
  - Main binds agent, member and selection from the frozen pre-await query, plus the standalone shape check.
  - The renderer adapter (`readCanvasBoardPage`) binds the full context captured from the membership page row before the request: project, scope, `canvasId`, `viewId`, member and selection.
  - Neither side derives expectations from the response or the snapshot.
- **Frozen old-client fixture:** `src/shared/__fixtures__/be00-validators/` holds test-only copies of the `be0091d16` versions of `remote-agent-details.ts`, `remote-inventory-page.ts` and `remote-details-query.ts`. Only relative imports were rewritten, and the blob sha256 of each source is recorded in its header.

## Portability

The committed copies are path-normalized (`<worktree>`, `<red-worktree>`, `<TMPDIR>`, `<home>`). `raw-originals.sha256` holds the digests of the host-local originals, which aren't in the repo. `SHA256SUMS` seals the committed copies.
