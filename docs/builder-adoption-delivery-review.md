# Builder, adoption and Skill library acceptance package

This is one source integration and one acceptance record for the existing-agent Builder, next-start adoption and the separate App Settings Skill library. Option C (#2819, #2820, #2821) remains core 1.0 work. This package preserves the original ten Builder checks, seven adoption checks, and eight required Skill library checks plus conditional persistence item 9. Every human observation remains **unverified**. Source integration and earlier CI do not close these checks.

The delivery handoff supplies the exact reviewed 40-character commit, tree, branch and worktree. Use that commit for both launchers. Original heads remain preserved: Builder `38a5777c9bea5448b4223341503c4fac9666befe`, adoption `139903edcdd697b464e50e38163774a4f66dd681`, and host `7722568f8ca0e6ce6080f8cad29f6586656a6d5a`. Earlier fixtures remain bound to their original heads; do not relabel them or point the combined checkout at those manifests.

## Preparation and execution sequence

Root first independently reviews this source/package and allocates the local heavy slot. This checkout initially has no `node_modules`; install provenance, exact-head tests, type/static validation, fixture preparation, build and launch are pending. The [core delivery inventory](builder-core-delivery-status.md) nominates the bounded commands. No command below has been executed for this integration.

After those prerequisites, root can authorize preparation on the final reviewed, tracked-clean checkout. Use the existing Node 24.22.1 environment. Substitute the exact head from the handoff:

```bash
bash scripts/launch-adoption-review.sh <reviewed-head> --prepare-only
```

Preparation invokes the named fixture test and capability-only fake, so it requires allocation. Record the newly printed root and manifest hash. A person then separately launches the guarded **unpackaged** app with the same head and root:

```bash
CLUBHOUSE_ADOPTION_REVIEW_ROOT=<new-adoption-root> bash scripts/launch-adoption-review.sh <reviewed-head> --launch
```

Run the Builder and adoption checks below sequentially. For adoption item 4 close only this isolated instance, then use a fresh no-CLI root through `--launch-no-cli`, as described in [the preserved guide](managed-activation-ui.md#refusal-mode-for-item-4). Use the positive root again for positive adoption; earlier Builder template edits can remove its selected fixture skill, so root may authorize a fresh positive fixture when needed. Keep every manifest and action history; never reseed an edited root.

The fake answers exact help/version only. Do not Start, wake, resume or sign in, invoke provider probes, or use a packaged application. Both `CLUBHOUSE_USER_DATA` and `--user-data-dir` are supplied by the launcher. Do not use the preexisting Node 22 binary that previously failed to load a system library, or change the system to repair it. The fixture's preselected terminal/hooks/MCP settings are synthetic preparation, never an adoption-side mutation or a grant.

For the separate Skill library checks, close the adoption instance and follow its existing launcher on the **same reviewed source head**, with a separately bound Skill library fixture only after root authorizes it:

```bash
bash scripts/launch-skill-library-review.sh <reviewed-head> --prepare-only
CLUBHOUSE_SKILL_LIBRARY_REVIEW_ROOT=<new-library-root> bash scripts/launch-skill-library-review.sh <reviewed-head> --launch
```

The host fixture has empty agent lists, separate registered projects and complete bundle samples needed for H1–H8. Keep its private HOME/USERPROFILE/profile guard intact. No native scan/import, fixture script execution, provider launch or capability grant is part of this package. The current host-only `7722568` package and historical `52d` fixture remain retained; neither has been launched and neither is a combined-head fixture. No additional fixture has been created by this integration task.

## Fixture mapping for the original Builder checks

Read B1–B10 verbatim below, applying these substitutions from the preserved adoption guide:

| Original reference | Combined fixture |
| --- | --- |
| Add printed `builder-review-project` | Already registered **Fake adoption review** project; exact path in `review-manifest.json` |
| `builder-review-agent` | UI `review-agent`, stored ID `adoption-review-agent` |
| Existing instructions sentinel | `Ambient fixture instructions. Adoption must leave this unchanged.` in `project/.clubhouse/agents/review-agent/CLAUDE.md` |
| Original saved-only copy in B2 | `Builder edits are saved only. Review a separate snapshot below for next-start adoption.` plus the separate no-start/no-wake explanation |

B1–B10 below preserve the original wording for traceability. The substitution above is deliberate: a separate explicit adoption action now exists; editor actions still save only, and their draft preview cannot authorize adoption. Do not fail the old “no activation” wording solely because the separate adoption section is present. Check its distinct approval boundary under A1–A7. Builder persistence B8 remains required. Host persistence H9 is conditional only and does not waive B8 or adoption A7.

## B1–B10: original Builder checklist

1. Add the printed project with the sidebar's Add project control. Expand Sleeping if folded. Right-click `builder-review-agent`, choose Settings, then Builder. It must have its own nav page, separate from Instructions.
2. At normal window width, verify “Saved in Builder only” and “Changes are saved here and aren't used by this agent yet.” are visible immediately. Scroll through a long role and the preview: that notice must stay visible while the section is on screen. No activation/apply/status claim should appear.
3. Preview each template. Orchestrator, Project Manager and Researcher must show Identity followed by a role; Custom must show only Identity. Cancel must keep the saved list. Save template must be an explicit second action after the replacement warning.
4. Drag a block, then use Move up/Move down. Tab to a reorder button and press ArrowUp/ArrowDown. Check that focus remains usable, endpoint buttons disable, the live announcement names the position, and the preview follows the new order. Check the Custom order label and Use base order action.
5. Fork Identity. Verify “Fork of Identity at revision 1”, an editable textarea containing `@@AgentName`, `@@Path` and `@@StandbyBranch`, and Save block/Discard edit. Save an edit, then Return to template. The original source must return.
6. Append a named local block, edit it, save it and remove it. Its source must say “This agent's”. Start an edit and try leaving settings: the unsaved-changes guard must appear. Switch settings pages and return: the draft must remain.
7. Check the effective preview at a narrow width and with long text. Boundary names, source labels and line ranges must be beside the text, with no markers inserted into it. Wildcards must remain unexpanded. Check light and dark theme contrast, textarea resize, wrapping and button crowding.
8. Restart with the same launch command/profile. The saved template, order, fork and local text must return. The fixture's existing `worktree/CLAUDE.md` and `.clubhouse/agents.json` must remain unchanged.
9. For the visible stale-write message, keep Builder open, then in DevTools run the snippet below. Click a Move button in the UI afterward. It must say the saved Builder changed elsewhere, reject the stale edit and reload the newer list without a toast-only error.
10. In Settings > Display & UI, enable Classic layout and restart the same profile. The Builder editor must be absent, with a one-line note pointing to the new layout.

## A1–A7: preserved adoption checklist

All items below remain unverified until a person performs them; automated component tests are not visual proof.

1. Default layout: an existing local agent's Settings navigation has its own Builder page. Instructions remains separate. Classic layout hides Builder and shows its one-line note.
2. Builder's saved-only notice is visible with the editor. Next-start adoption has a separate persistent explanation that adoption does not start or wake the agent. Check narrow-window wrapping, scroll reachability, contrast and ordinary theme tokens; no accent bars, glows, tinted callouts, all-caps labels, chips or em dashes.
3. Both policy selects initially show Choose. Preview saved delivery is disabled until both are selected and drafts are saved/discarded. Editing a block removes any adoption preview/approval. Keyboard focus follows ordinary selects/buttons and remains visible.
4. In the no-CLI isolated launch, request a delivery preview and confirm a visible refusal/error, no adoption-success state, no process start and no hidden setting changes. Refresh and target navigation remain usable.
5. On **Fake adoption review, no live agent** (`review-agent`), inspect **Appended managed instructions**, exact literal `@@` tokens, ambient CLAUDE.md notice, qualified skill names, the no-reference-rewriting notice and CLI flag-evidence-only wording before the explicit adoption button. This fixture is not installed runtime/load proof.
6. On **Seeded receipts only, not observed** (`seeded-receipts`), compare desired, prepared, materialized and PTY observation labels. A created PTY is labelled a shell observation; unconfirmed cleanup does not say stopped. Verify long names/timestamps and empty history fit without clipped controls.
7. On `review-agent`, after fake adoption, refresh and reopen: the desired snapshot remains. Remove future adoption: history remains and no stop/wake occurs. Failed/stale saves show errors and refresh actual state. Change target or policy while a reply is deferred: no old preview/receipt/error appears under the new selection.


## H1–H8 required; H9 conditional: separate Skill library

1. Open App Settings > Skill library at normal size: readable heading/catalog-only notice, visible focus/unclipped controls, no list until explicit project choice; active project unchanged.
2. Check source/owner/revision; project-owned bundle appears only for project one, library bundles remain across contexts; no runtime-loading implication.
3. Keyboard-inspect editable bundle text/script/reference/binary members: literal paths, executable metadata and base64 shown without executing/rendering contents.
4. Edit text/metadata and add/rename/remove a member; review/save/reload. List/detail revisions advance together; unedited members retain exact values.
5. Cancel asset/project discard and retain draft; accept refresh/discard and recover saved content.
6. Navigate to Display & UI and back: draft retained, hidden library controls never receive tab focus; memory-only notice present.
7. Built-in stays inspectable/read-only; shared-consumer fixture visibly blocks saving.
8. Invalid binary base64 shows a clear error, retains draft and leaves saved revision unchanged; then reload.

Optional9, only if checking persistence: close/relaunch this same private profile, verify saved revisions survive, unsaved drafts disappear and fixture is not reseeded. Otherwise record not exercised; do not claim persistence acceptance.


## Evidence to retain and acceptance limits

Use one result record with B1–B10, A1–A7, H1–H8 and H9, recording pass/fail/unverified or conditional-not-exercised for each. Record operator/date, exact head/tree, source worktree, OS/window size, fixture roots, manifest SHA256 hashes, screenshots or short keyboard/action notes and observed revisions/member-value comparisons. Preserve failed observations and their original logs before any correction; do not retry away evidence. Root owns fixture cleanup after artifacts are retained.

The preserved [adoption guide](managed-activation-ui.md) supplies current stale Builder write, external unassign, stale binary and delayed-preview procedures. Use its exact project/agent substitutions. Delayed same-target receipt races and actual receipt persistence failures remain automated-only; year-2000 seeded receipts are explicitly synthetic presentation samples. Fake preview/adopt/unassign can show local UI/catalog persistence only. It cannot establish installed CLI operation, authentication, tool visibility, instruction or skill loading, or a running provider.

The [Skill library guide](skill-library-review.md) supplies detailed H1–H8 evidence expectations. Shared-consumer saving is refused by the current editor; successful H7 proves that refusal, not full shared-edit/adoption delivery. Saving a bundle never assigns, enables or runs it. Builder/adoption do not yet expose the four complete #2819 actions. Keep every core gap in [the delivery inventory](builder-core-delivery-status.md) open. Broader runtime, native import confinement and root permission design have their own evidence boundaries.
