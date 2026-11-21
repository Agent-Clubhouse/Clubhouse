# Independent QA final review: #3738 preview-consistency successor

Reviewer: qa-details-local-composition. November 21, 2026.
Source: `0723c341045212306c3966f6b8951b626d95e10f` (`fix/3738-preview-consistency`, one commit on `807360c54`).
Evidence: `e8a55d50b7b1b1fc1651f712595b5e30be162e03` (`origin/evidence/3738-preview-consistency-0723c3410`), directory `docs/evidence/mcp-stable-binding-preview-successor/`. `manifest.json` SHA256 is `df131005…7cc2ed8`, which matches.
Method: I read artifacts only and ran nothing.

## Verdict

**APPROVE `0723c3410`, scoped to the preview-consistency delta.** That delta is the shared `buildBindingToolDescription` plus the connection-guidance and dispatcher-wire-source tests. The source review is in my earlier message.

This is **not** a claim that #3751 CI is resolved. The E2E consumer failures (dispatcher.spec.ts:405 and agents-across-machines.spec.ts:400) are classified as contract consumers and are being fixed on a separate branch. PR #3751 is still at `807`.

## Evidence verified

- **Seals:** all 32 `SHA256SUMS` entries match the committed blobs.
- **`importers-exact`:**
  - head is `0723c3410` before and after, exit 0;
  - **14 files, 633 passed**;
  - all 14 source SHA256s are equal before and after **and equal the blobs at `0723c3410`**.
- **Typecheck and lint:** typecheck exits 0; lint has 0 errors and 8 warnings.
- **`mutation-preview-divergence`:** in `connection-guidance.ts`, removing the Target line from the preview path alone makes 3 tests fail (72 skipped), exit 1. The source hash before and after is `c59ed8e8…`, so it was restored byte-exact.
- **`baseline`** (the `807` production code with the new tests): 3 failed, 105 passed, exit 1.
- **Hosted context** from run 44876043424:
  - the Ubuntu-2 and Windows-1 JUnit ZIPs, with API digests equal to the download SHA256s. Ubuntu-2 fails the connection-guidance preview case, matching the defect;
  - the job logs and the three E2E trace ZIPs are retained;
  - main `c0cf2f197` Validate 44875569706 succeeded, as the comparison.
