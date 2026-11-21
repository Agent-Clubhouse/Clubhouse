# Pre-PR actual-main comparison, source0e6c unchanged

The isolated assembly's recorded parent/base remains e8e178c4. This is a
historical assembly snapshot, not a claim that main is still there. The later
actual fetch resolves main to b02542b5cf3cac51a3aada5919dd5b6c43757a9e. Before
that refetch FETCH_HEAD was e8e178c4 while origin/main was already b02542b5;
after refetch both resolve b02542b5. No branch rebase, merge or test rerun.

0e6c898ad-main-b02542b5-comparison.json records the immutable commits, exact
changed paths and eight equal configuration/dependency/setup SHA256 values
across assembly base, actual main and candidate0e6c898ad. Full intervening
hunks were read. Only three files were added: shared Annex settings parser,
its tests and its proof runner documentation. Parser production import is a
type-only shared-types import; the added files do not call/import the index.
Actual main has none of the five index paths and no notice-index references
in src/test/scripts/.github. Config/lock/workflow/setup remain byte-identical.

This is a static disjointness/identity bridge for QA, not combined execution
proof or automatic current-main/whole-branch approval. Source0e6c898ada85efefb80bc3aec61e07d3d15d2b19
and its actual49pass/1skip/types/lint receipts remain unchanged. No extra checks
were repeated without a changed risk surface. Independent assembled-head QA
must assess this bridge; later normal CI must bind its actual merge checkout
and native Windows JUnit result. Existing catalog/activation/runtime/native
filesystem and memory limits remain open.
