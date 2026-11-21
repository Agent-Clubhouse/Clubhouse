# Independent QA: PR #3749 at 879064193 (seals), helper-fence discriminator, and the main daa7 base check

Reviewer: qa-details-local-composition. November 21, 2026. I read source and artifacts and ran no tests. I did one throwaway trial merge with main, then removed it.

## 879064193: seals verified for the ordinary update

- **Head:** `879064193e9301e663bdf7b26ed0f6d2efd49776` is the #3749 PR head (`gh pr view` confirms). It is the approved `a2bb86472` plus one docs-only commit, and no path outside the evidence directory changes.
- **Seals:** all 11 in `evidence/3733-main-535241/` match.
- **52bb runs:**
  - `validated-head-52bb` = `52bbebb21`, with an empty pre-status;
  - `focused`: **13 files, 1866 passed**, exit 0, with a fresh default-depth TMPDIR. A clean post-status is printed at the end;
  - `tsc` exits 0. `lint` has 0 errors and 793 warnings.
- **`win-followup-local`:** **4 files, 274 passed**, exit 0. This ran on the working tree before `a2bb86472` was committed.
- **Gaps, stated in the README and not reconstructed:**
  - the 274 run has no head file and no pre/post status;
  - the `a2bb` typecheck and the lint of its two files were printed to the terminal only.

  Since `a2bb` changes 3 lines and I reviewed them at source level, these gaps are acceptable for a bounded update. **Hosted Windows CI** (run 44880807605 on `879064193`, still running at the time of the request) remains the proof.

## ab1baddd9: helper-fence discriminator (separate test, not current PR coverage)

- **The test** is one new case in `read-only-helper-work.test.ts`. It mocks `fs.realpathSync` (JS) to return the same folder in a different form (a trailing separator) while `.native` is left untouched.
  - With the fix, the helper work is admitted with `{ dirty: 1 }`.
  - It then sets `.native` to return a different real directory for the project, and the result is refused (`error` present, `dirty: 0`).
  - It restores the mocks in `finally`.
- **Logs:** with the fix, 17 passed. Reverting the fence to JS `realpathSync` fails only the new case (1 failed, 16 passed), and the restore is byte-identical.
- **Assessment:** this is a sound discriminator for "same folder, different textual form is admitted, while a different native root is refused". It models the 8.3 difference rather than reproducing it.
- **Minor:** the temporary `other` directory is not removed if the first assertion throws. Moving the `rm` into `finally` would fix that.

## Base check against current main `daa7dab5e` (#3738 landed)

**Not disjoint.** A trial merge of `879064193` with `daa7dab5e` **conflicts in `src/main/services/clubhouse-mcp/binding-manager.ts`.**
- **The conflict:** it is an import-line conflict. #3733 adds `createHash` and display-settings imports, and #3738 adds `initializeBindingToolKey`. Take the union.
- **Bridge-server tests:** `bridge-server.test.ts` was changed by both and auto-merges.
- **Semantic check:** #3733's binding-manager additions are display-only. They are the `BINDING_DISPLAY_*` page rows and receipts, built with `projectBindingRowForDisplay`, and none of them creates or replaces `McpBinding` objects. No #3733 production code calls `buildToolName`/`buildToolKey`, so there is no conflict with #3738's in-place binding identity.

**Before or with the next PR update, the owner needs to:**
1. merge `daa7dab5e`, keeping the import union;
2. run a focused set: importers of `binding-manager`, `tool-registry` and `binding-tool-key`, plus `bridge-server.test.ts`, which carries #3733 test edits on top of #3738's renamed-key expectations;
3. run tsc and lint;
4. let hosted CI on the merged head be the gate.
