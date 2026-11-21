# Proposal evidence and limits

Final proposed bodies are frozen at the **docs-only** source commit `a2c6b9ab5`
(full SHA in evidence/checkpoint.json), descended from the retained `542f47a44`
draft. Both are based on actual main `f19eceee25effd264276d70a419bebfe58924876`.
The delivery/proof commit changes documentation only; no product file is patched.

Observed final checks on a2c6b9ab5:

* Full-project typecheck of the isolated proposed-source mirror: exit 0, 10.15s.
* Existing-config errors-only ESLint via stdin under each of the three intended
  product filenames: all exit 0. This is not warning-free or executed behavior.
* 37 static equality/applicability checks pass: existing filesystem helper bodies,
  default-store variables/functions/options/reset, patch applicability to actual
  source and exact patch-to-full-proposed-file equality. notifyLoad is compared
  after removing only its disclosed opt-in source-capture statement.
* The lock matches the existing dependency cache; all 1,176 nonoptional package
  versions matched. No install or shared dependency writes. Final typecheck was
  admitted at 16 CPUs/load 2.99; earlier local memory measurement showed roughly
  25 GiB inactive pages, in addition to free memory. These are local resource
  measurements, not a Mini or live-app probe.

No runtime store tests, compatibility failure tests, mutation kills, IPC/Electron,
name service, actual queue composition, runtime/OS teardown or feature proof was
executed or credited. proof-obligations.json is a required future matrix, not a
result list. Internal CommitResult ownership objects are host-only identity
receipts; future IPC mapping must not serialize them as renderer authority.

All retained check records are under evidence/raw, with stdout/stderr and actual
head/input hashes. They keep original local argv paths; the manifest uses relative
paths and both runners resolve their checkout dynamically for portability. They
are **not sanitized derivatives** of successful/failed execution records.

Historical attribution:

* initial-body-typecheck: untracked draft on f19, exit 2 (three callback annotation
  errors plus mirror-relative Azure dependency path). Corrected-body-typecheck:
  untracked intermediate on f19, exit 0. Neither is final frozen-source credit.
* frozen-542f47a44-typecheck: actual prior freeze, exit 0; historical after the
  explicit forward-state/postcommit-authority clarification in a2c6b9ab5.
* frozen-a2c6b9ab5-typecheck/lint: final body input hashes. The lint runner was a
  newly added untracked evidence helper at execution; its bytes are sealed here.
* The first static collector failed on an incorrect guessed MCP path. Its first
  tool transcript was unsealed. The separately retained repeated actual failure
  is labeled exactly that, with the wrong-path script hash/bytes; it is not a
  reconstructed first-run receipt. Corrected collector output is separate.
* admission-original.json is copied actual dependency-measurement stdout, with
  text-file LF framing; frozen-preflight-tool-response.json is the actual captured
  tool response envelope. Neither is a fabricated command receipt.

The only successor body change after 542 was separating forward original
expected_state checks from postcommit/restore authority and removing an unused
helper. An expected_state check must not compare the old value after its own
successful commit. Actual MCP/Ask/host/grant consumer bodies remain absent.

New design choices requiring independent review are the specialized facet overload
and witness schema concretization. The standalone source pieces already landed in
#3764/#3765/#3766/#3767 retain their own immutable proofs and limited acceptance;
their green checks do not transfer to this unexecuted store proposal.
