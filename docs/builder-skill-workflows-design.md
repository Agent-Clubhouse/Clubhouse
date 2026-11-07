# Existing-agent Builder skill workflow

Source-only slice from preserved `29fc08713` (PR #2884). The prior worktree,
original review fixtures and file viewer are outside this slice. Fresh Auto
receipt supplied by root: 00:45:27.924Z, auto/hard, model/effort null, selected
codex-cli/gpt-6.1-sol/high, sticky, no fallback, Claude 0 / Codex 1.

## Contract

Use the installation catalog, existing composer/planner and complete bundle
editor. `catalogSkillBundles.create({context,name,scope,payload})` resolves
library/project/agent ownership in main; no caller-supplied owner or path.
`copy({context,assetId,expectedRevision})` requires an existing agent, checks
visibility and copies the entire immutable revision through `copyAsset`, recording
origin ID/revision. Both return an unassigned document. Neither assigns, runs,
loads, activates or changes provider settings. A failed later assignment leaves
an explicitly visible unassigned library bundle/copy; no destructive rollback.

Builder adds `skill` and `removeSkill` commands with preview/confirm phases.
Selection binds source revision, composition revision and planner fingerprint;
confirmation commits exactly that desired composition. Shared references preserve
asset identity. Copies have independent identity and agent ownership before
assignment. Remove deletes an explicit addition or excludes a template reference;
it never deletes an asset or edits another consumer. Re-selecting an excluded
skill removes that exclusion. The effective preview includes exact complete skill
payloads, metadata, content hashes, ownership, origin and reference provenance,
plus excluded references. Instruction text continues through the shared composer.
Template replacement explicitly warns that selected skills are also replaced.

The saved-only snapshot policy pins selected skill revisions in composition
floors; it is not an activation/adoption default. Existing separate adoption
review remains the only next-start path. UI says saved, provider loading unverified.
Unsupported MCP/native delivery and activation capabilities remain visibly blocked.
No provider, auth, lifecycle, helper routing, grants or agent API is added.

## Safety and regression fixtures before implementation

Fixtures cover complete create/no implicit assignment, invalid bundle and scope,
copy of binary/executable members and origin independence, stale source revision,
foreign ownership, preview with zero writes, exact confirmation fingerprint,
collision refusal, remove/exclude/reselect without deletion or other-consumer
mutation, and immutable source preservation. Main context checks reserve the
existing transition gate, validate registered project/agent and use the catalog
rename guard. Shared-consumer bundle edits remain refused. Source-head guards
are checked inside serialized catalog mutations to close preview/commit races.
Renderer fixtures cover explicit create then assign, preview/cancel/confirm,
whole-payload read-only preview, late target replies, and truthful saved-only text.
No fixture is executed before independent root source review and slot allocation.

## New agent handoff

Reuse the bundle bridge and skill selection panel with a reserved durable ID,
registered project ID and the existing creation transition. Current context guard
intentionally rejects partial creation, so NewAgent needs a dedicated reservation
resolver; do not bypass it or invent an agent. Carry one draft CompositionInput
through create/cancel/failure and commit with the existing catalog planner only
after durable config creation succeeds. Design explicit retention/cleanup of
unassigned agent-owned copies on cancelled creation. Reuse exact preview and
fingerprint confirmation; preserve legacy persona transition behavior. This slice
does not rewrite NewAgentPage, AddAgentDialog or TemplateConfigDialog.

## Commit ordering and failure semantics for root review

Only `createCatalogSkillBundleEditor.copy` supplies the new optional
`copyAsset.expectedHeadRevision`. It checks visibility and expected revision,
then the catalog repeats the source-head check inside its existing per-directory
serial transaction, before reading the complete immutable payload or allocating
a copy. Existing block-fork and ordinary catalog callers omit this option and
retain their previous behavior.

Only Builder's confirmed `skill` command supplies the new optional
`saveComposition.expectedAssetRevisions`. The catalog checks those source heads
inside the same serial transaction as planning, expected composition revision,
complete composition validation, blocker refusal and preview fingerprint checking.
No index write occurs until all these checks pass. Remove commands use the same
planner fingerprint/revision checks without inventing a source-edit requirement.
All ordinary composition callers omit the additive option and are unchanged.
No renderer gets either store object or either main-only option.

Bundle create/copy and existing edit/save all run through the existing local-user
origin check and registered ID resolver. Agent targets reserve the existing
transition gate. Builder read/command now resolve the registered project from its
legacy path request and pass that exact path back to the common resolver, closing
a remap between lookup and validation. The resolver captures registry generation,
pending writes and agent-config generation; it refuses Dispatcher, helpers,
disposed and partial-creation agents. The production per-request catalog rename
hook rechecks that guard immediately before synchronous rename, without an await
gap. Tests inject a catalog store; the production path always uses the guard hook.

These are catalog-only transactions. A failed index commit preserves the previous
composition. Staging may leave unindexed payload files under the catalog, as in
the existing store. Successful create/copy is intentionally independent from
assignment: cancel, collision, stale preview or failed assignment retains an
unassigned asset and never rewrites or deletes its source. A post-commit response
failure can leave a successful saved operation; UI failures ask for reload and
make no claim of rollback. No provider/lifecycle/identity/session/wire/worktree
write is added. Shared-consumer edit refusal and normal impact fingerprints are
unchanged.

The skill UI keys operations to project, agent and composition revision, ignores
late target replies, serializes mutation callbacks and invalidates reference
preview on target/revision change. Its parent blocks instruction/template changes
and next-start adoption while skill creation/review or an operation is pending.
Create/copy returns an explicit unassigned notice; selection/removal requires a
second preview/confirm. Copy preserves the directory name, so a conflicting
existing reference must be explicitly removed before assigning the copy.

## Minimal validation nomination (not run here)

Root first independently reviews the immutable diff and preserved parent, then
owns offline preparation in this worktree and the coordinated slot. No borrowed
or symlinked dependencies, lifecycle scripts or online fallback. Nominate one
`npm run typecheck`, ESLint limited to changed TS/TSX paths, and this affected set:

```sh
npm test -- src/main/services/asset-catalog/builder.test.ts src/main/services/catalog-skill-bundles.test.ts src/main/ipc/agent-builder-handlers.test.ts src/main/ipc/skill-bundle-handlers.test.ts src/preload/skillBundle.test.ts src/shared/ipc-channel-sync.test.ts src/renderer/features/agents/AgentBuilderSkills.test.tsx src/renderer/features/agents/AgentBuilderSection.test.tsx src/renderer/features/skills/CatalogSkillBundleEditor.test.tsx src/renderer/features/settings/SkillLibrarySettingsView.test.tsx --reporter=default
```

Broader standard readiness/CI and landing remain root-owned. No prior fixture,
human app package, provider verification or original 29fc acceptance is altered
or claimed by these synthetic fixtures. Preserve this handoff before retiring
the helper; do not reuse it for unrelated work.
