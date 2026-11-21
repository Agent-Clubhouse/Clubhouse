# Installation markers and explicit durability observations

Unintegrated source `8142a812ad032b0c365001e5796d349b4ad92e50`, tree
`9e1f4ad4bec23bacf75845e18b68464023828f5e`. Canonical #3758.
Source181 and its pages-only proof remain preserved; its refused compiler is
not retroactively called a pass. Foundationc504 acceptance remains separate.

## Exact source checks

- 53 targeted tests /4 files passed,22.86s: journal, pages, installation and
  durability. Unchanged standalone state/interval suites were not broadly rerun.
- Full root ES2020 typecheck exit0 on814 (tests excluded by existing config).
- Scoped six-file lint exit0:0errors/0warnings.
- All3 admitted commands have equal clean before/after exact head/tree and22
  source hashes, with exact argv/exit/raw/gate output. No refusals/retries in
  this814 round. Prior gate refusals remain preserved under their original heads.
- Manifest now indexes23 admitted receipts; previous20 entries/raw are unchanged.
  Evidence head is not the tested source and gains no retroactive execution seal.

## Implemented boundary, still not activated

The fixed local `.required` marker and ledger envelope have matching installation
UUID/version. Reads are bounded/stable and preserve supported optional fields
without rewriting existing bytes. Concurrent main calls join one creation.
Missing marker/directory/envelope, future/corrupt metadata and UUID mismatch
refuse without a new baseline or overwriting the original. Unrelated settings
and even invalid legacy receipt bytes remain untouched.

Three actual synthetic child processes exit77 after marker sync, after directory
creation and after envelope sync. Reopen refuses incomplete initialization for
the first two, and reads the complete matching identity after the third. Bytes
stay intact. This is process-bootstrap evidence, not migration, nonce/root
activation or physical power-loss proof. Explicit incomplete-bootstrap repair
is still pending; this safe refusal has a visible operational liveness cost.

The private directory flusher records `directory-synced`, `file-sync-only` for
narrow known Windows directory-open/sync results, or `not-observed`. Actual IO,
disk-full/access/not-found errors propagate; the store cannot manufacture commit
success. A later sync cannot promote an earlier weaker observation. Windows
results are **simulated policy controls**, not execution on native Windows.
File flush, directory flush and power-loss guarantees remain distinct.

Journal and page writers use this private helper. There are no edits or imports
to settings-store/replaceFile/renameOver, shared committed-publication hooks,
group registry/bulletin or legacy notification budget writers. No app startup,
provider/runtime, controller/phone or live settings call imports these modules.
The metadata factory alone grants no migration/baseline/dispatch authority.

## Remaining gates

Authoritative lazy-state wiring still needs to replace all-sparse-row
materialization. Legacy migration, R1 large-baseline/adoption commit+nonce+
partial-record/process-crash proof, strict local-human IPC/UI, shared runtime
generation/export/sink composition, wake and full product-latency/native-platform
checks remain. No feature/PR/activation/merge/release acceptance is claimed.
Dependency linkage is worktree-local and reversible; original node_modules was
restored after this round, with layout/provenance retained externally. No install
or shared dependency/settings mutation was performed.
