# Skill library host review

Component/bridge PR #2865 landed on main as `3a51192d9` from reviewed `72002bce0`.
This host targets main and preserves the foundation contract. Held Builder
`38a5777c9`, adoption `139903edc` and their packages are separate and unchanged.
This host does not complete #2819 or #2740 acceptance. Native discovery remains
behind the #2830 confinement hold; import, assignment, adoption, MCP and native
subagent integration remain separate work. A saved bundle is not runtime evidence.

App Settings > Skill library opens a registered-project selector, then catalog
list/detail/editor. Selection is explicit and does not change the active project.
The scope includes library and selected-project catalog assets. Agent-owned
assets require a different agent context and are outside this host. There is no
new asset creation, import, ownership conversion, delivery policy or grant.
Built-ins are read-only and any agent/template/subagent consumer blocks editing.

The existing Settings page stays mounted after first opening. Off-page it has
both `hidden` and `inert`; retained drafts are memory-only and disappear on app
close/remount. Asset/project/list replacement confirms draft discard. Pending
editor operations synchronously block selection/refresh. Returning, focus and
registered context changes revalidate the catalog. Changed/deleted selection or
unknown state suspends further editing/saving while retaining available draft
text. Explicit refresh/discard reopens current saved data. Main's context/revision
checks are still authoritative, including changes not yet observed by renderer.
There is no live filesystem scanner or catalog notification feed. Hidden content
cannot initiate a new operation, but an explicit save already pending may finish;
its success/failure remains visible on return. Host callbacks bind to the editor
instance and monotonic operation number; old list replies cannot replace a saved
revision or release another operation's selection guard.

## Guarded review preparation and launch

Use this worktree's own installed dependencies (`npm ci` if absent). The guard
requires the exact reviewed 40-character head and clean tracked source:

```bash
bash scripts/launch-skill-library-review.sh <exact-reviewed-host-head> --prepare-only
```

This writes a new private temporary fixture and reports its root. It registers
two synthetic projects, empty agent lists and valid catalog bundles through the
existing catalog store. Preparation launches no app, CUA, process or provider.
Its manifest binds source head/private home/profile/catalog location. Preparation
validates private nonsymlink directories and prints the exact `HOME`, `USERPROFILE`,
`CLUBHOUSE_USER_DATA` and `--user-data-dir` destinations without launching the app.
Keep the printed root:

```bash
CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT=<printed-root> \
  bash scripts/launch-skill-library-review.sh <exact-reviewed-host-head> --launch
```

This human-operated macOS launcher runs unpackaged `npm start`, which builds the
`.webpack/main` entry before launch. It passes a throwaway `--user-data-dir` and
sets `CLUBHOUSE_USER_DATA` for app userData/home, plus `HOME` and `USERPROFILE` to
the separately validated private fixture home. All three provider overrides
are verified nonexistent paths and fail closed without normal binary fallback;
model probes/updates are disabled through existing unpackaged seams. Do not use
a packaged app: packaged builds ignore those protective test seams. No fake or
real provider is needed here. Do not create/start/wake agents, enable providers,
run scripts, import/scan native files or invoke CUA as part of preparation.

## Exact human visual checklist

All items below remain **unverified** until a person runs this package. Automated
component assertions, seeded fixtures and successful builds are not visual proof.

1. Open App Settings > Skill library in the default layout. Confirm heading,
   persistent catalog-only notice, comfortable spacing, focus indication and no
   clipped controls at the normal window size. Choose `Skill review one` without
   changing the active project. No list appears before choosing a context.
2. Inspect source/owner/revision in each list row and detail. The project-owned
   bundle appears for project one and disappears for project two. Other library
   bundles remain. There is no implication these skills are loaded by an agent.
3. Open `Editable complete bundle`. Expand folders with keyboard, select
   `SKILL.md`, `scripts/check.sh`, `references/guide.md`, `assets/sample.bin`.
   Verify literal relative paths/wildcards, executable metadata and base64 binary
   display. No script runs and no asset is rendered.
4. Edit text, toggle executable metadata and add/rename/remove a supporting file.
   Review then save. Verify list/detail revision advances together and unedited
   binary/reference/script members retain exact values. Reload saved bundle.
5. Make a draft, select another asset/project and cancel discard. Verify the draft
   remains. Accept discard on refresh and verify saved content is shown on reopen.
6. Make a draft, visit Display & UI and return. Verify it remains and tabbing on
   the other page never focuses a hidden library control. The notice says drafts
   are memory-only, with no recovery claim across app close.
7. Open `Read-only built-in fixture`: all editing/saving controls are absent or
   disabled while member inspection remains usable. Open `Shared consumer blocks
   edits`, change text and review: a visible consumer block prevents save.
8. Enter invalid base64 in a binary member and review. Verify a plain visible
   validation error, unchanged saved revision and retained draft, then reload.
   This exercises validation failure, not a filesystem persistence failure.
9. Close/relaunch only this throwaway profile if checking persistence. Saved
   revisions survive; unsaved drafts do not. Reusing the root does not reseed or
   overwrite edits. No agent/provider is started by the package.

Deferred old-list responses, hidden pending save success/failure, real service
write failures, stale revisions, removed/remapped projects and obsolete callback
guards have synthetic automated regressions. They are **automated-only** evidence;
this fixture does not pretend to produce those timing/failure conditions visually.
