# M1: role Details wrapper fits the 256 KiB cap

Branch `details-local-composition/3733-m1-role-wrapper-budget` from `main` `d8c7247a4dccc1ebff01f0f28f8e61279bdf5437`. Source commit `09e4d6522de2da5cf65972eefe654800448b2eca`. Sanitized copies of output.

## Defect

`readRemoteAgentDetails` trimmed the inner body to `REMOTE_DETAILS_MAX_BYTES` (256 KiB). `readSelectedDispatcherDetails` then wrapped it as `{version, role, agentId, details}` and rechecked the same cap. An inner body at the cap plus the wrapper returned 500 `dispatcher_details_limit`, so the client showed an error for the whole role pane.

## Change (writers: `remote-agent-details.ts`, `selected-dispatcher-details.ts` and tests)

- `readRemoteAgentDetails(..., options: { maxBytes? })`:
  - The budget is clamped to the cap and used by the trim loop and the inventory page limit.
  - An explicitly invalid budget (not a positive safe integer) returns 500 `details_budget_invalid` **after** authorization.
  - Omitting it keeps 256 KiB. The cap is not raised.
- The role read passes the cap minus the serialized UTF-8 wrapper bytes for that agent id. That is `Buffer.byteLength(JSON.stringify({version, role, agentId, details: null})) - Buffer.byteLength('null')`, which accounts for escaping and non-ASCII characters. The outer cap check is kept. Authorization, page and receipt gates are unchanged.

## Proof

- `red.txt` (main `d8c7247a4`, both source files restored, new tests kept): 11 failed, 3 passed. The producer-filled role read returns **500 instead of 200**. Byte-identical restore and post-restore status are shown.
- `mutation-budget-removal.txt` (on `09e4d6522de2da5cf65972eefe654800448b2eca`, the role read passes no budget): 3 failed, reproducing the 500 for both agent ids, and the page budget case fails. The restored hash equals the committed blob.
- `green.txt`: 7 files, 1269 passed, with a fresh `TMPDIR`. Pre- and post-status clean.
- `tsc.txt` exit 0. `lint.txt` (5 changed files) exit 0. `store-*.txt`: shared store unchanged.

The covered cases:
- At the cap: an exact fit for an ASCII id and for an escaped/non-ASCII id.
- One byte over the budget: refused by the outer cap.
- Producer behaviour: at the budget the body passes untouched; one byte under, it trims one row and stays valid; an irreducible budget fails closed; invalid budgets are refused after authorization.
- A role Connections page gets the same budget, and a producer Connections page honours it.
- The omitted-budget path is unchanged.

Not covered: an inventory-page producer fixture at the budget. The inventory limit uses the same `budget`, but there is no dedicated page-at-limit fixture. No full suite was run.
