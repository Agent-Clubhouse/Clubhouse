# Evidence for #3720 (rename overwritten by the renamed member's own announcement)

This branch contains documentation only. No product code is changed.

- `comment-draft-3720.md`: a sanitized draft for #3720, pending review before posting.
- `diagnostic-unit-test-run.txt`: the uncommitted diagnostic test diff and its run on `2836db383`. The `annex-network-membership.ts` source there is identical to main `daa7dab5e`. The run fails with the alias reverting after A's own hello. The restore was byte-identical.
- `hosted-*-summary.txt`: failing-test lines from the two hosted Windows Annex E2E job logs.
- `run*-attempt*-error-context.md`: Playwright error contexts for both attempts in both runs. The artifact ids and digests are in the draft.
