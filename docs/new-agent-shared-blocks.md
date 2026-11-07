# NewAgent shared block reuse

Source-only continuation from c9cf8012. The built/human-review c9 checkout is untouched.

NewAgent can explicitly select existing library or registered-project instruction blocks after requesting a preview. Selected references follow the chosen role, in selection order. Selection invalidates the prior approval; a new preview is required. Main rejects duplicate, unavailable, wrong-kind, agent-owned and foreign-project IDs. No asset or composition is written during preview. The existing source-head map includes the selected blocks; the existing creation fingerprint and guarded rename remain authoritative at commit. An old caller omitting block IDs keeps its existing behavior.

This does not implement NewAgent local block creation/edit/fork/copy, shared-consumer editing, MCP/native delivery or import. The request adds optional validated block IDs; it does not accept arbitrary renderer-authored composition data.

Additional unrun regressions now exercise actual registered IPC optional argument forwarding/rejection, real reserved creation with unchanged versus stale selected-source revisions, unchanged source assets and persisted readiness/failure, and project-switch late reply disposal. Pending independent review and own source/changed-test types plus affected draft/catalog/handler/renderer tests. Existing two new service cases cover selection order/nonmutation and ownership/kind/duplicate refusal; renderer case covers invalidation and explicit re-preview. Nothing has been executed in this checkout; no dependency install/build/app/provider/helper work.
