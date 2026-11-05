# Next-start adoption integration

This integration builds on backend #2847, landed as main `b0e0b0d9690a84b1a0fcdddfa196d2b1d2a3a636`, and the held Builder surface in #2842. Its draft targets `dev/activation-adoption-integration-base`, which combines those reviewed source heads; the diff contains integration work only. Retarget after the Builder dependency lands and resolve the squash histories without changing the preserved Builder checkout/package. Neither this draft nor the backend completes #2819 or #2739 acceptance. Native subagents remain a core follow-on.

## What a person can do

On the default layout, open an existing local agent's Settings, then Builder. Builder text edits remain saved only. A separate **Next-start adoption** section requires explicit content-revision and template-structure choices; neither is preselected. Save or discard drafts before previewing the saved delivery. The preview shows exact literal appended managed instructions, the ambient-context limitation and effective qualified skill names. Adoption saves that reviewed snapshot for a later supported fresh start; it never starts or wakes the agent.

Refresh receipts to see desired/prepared/materialized state and PTY observations separately. Unassignment removes future references and retains history, pins and files. A PTY observation means shell creation or actual exit, not provider execution, instruction loading, tool visibility, sign-in or authorization. Existing sessions are not changed by adoption/unassignment.

The classic layout keeps Builder hidden with its existing note. Linux/Windows and unsupported providers/modes refuse delivery visibly. On macOS, the current adapter also refuses enabled hooks/MCP/Clubhouse materialization, wrappers and other incompatible settings. It never silently disables them. Installed-path capability checks execute help/version only and establish advertised flag support, not runtime readiness. No real provider or authentication probe is part of this validation.

## IPC and stale state

The local-user bridge exposes read, saved delivery preview, adopt and unassign. Requests contain registered project/agent IDs, separate saved-composition and receipt revisions, explicit policy choices and an opaque delivery token. Main owns target resolution, capability evidence, policy expansion and frozen payloads. Dispatcher, helper, creating, disposed and unavailable targets are refused. Extra renderer fields, private paths, capability objects, manifests and arbitrary hold maps are rejected.

A Hold choice binds all selected catalog revisions shown by that delivery preview. Drafts, target, saved revision, receipt revision or policy changes invalidate the approval. Main revalidates target registration inside the agent transition reservation at mutation commit, including pending real project-store writes. Late reads/errors cannot overwrite newer same-target adoption/unassignment receipts. Errors are fixed public messages; private text and raw filesystem/capability errors are not logged or returned.

## Runnable build and isolated launch

From this integration checkout on macOS, `npm ci` installs development dependencies and `npm run package` builds `out/Clubhouse-darwin-arm64/Clubhouse.app`. Packaging moves bundles under `.webpack/arm64`; `package.json` points at `.webpack/main`, so **direct `Electron .` after packaging is not a working development launch**. Do not launch the packaged app for this review: packaged builds ignore the protective test CLI/model-probe seams.

Use the guarded fixture launcher with the exact reviewed commit supplied by the handoff (a full 40-character SHA). It verifies head, tracked source, macOS and the existing Node 24.22.1 environment. Preparation uses one explicitly selected fixture test file, real catalog/service APIs and only a private executable that answers exact `--version`/`--help`. It does not launch Electron, a PTY, a provider or CUA:

```sh
bash scripts/launch-adoption-review.sh <reviewed-integration-head> --prepare-only
```

Keep the printed fixture root. A person can then run the printed restart command, ending in `--launch`, to build and open the **unpackaged** app through `npm start`. Internally that launch is:

```sh
CLUBHOUSE_USER_DATA="$CLUBHOUSE_ADOPTION_REVIEW_ROOT/profile" \
CLUBHOUSE_TEST_NO_MODEL_PROBES=1 \
CLUBHOUSE_TEST_CLI_BINARIES='<private fixture Claude path; nonexistent other providers>' \
npm start -- -- --clubhouse-new-chrome --user-data-dir="$CLUBHOUSE_ADOPTION_REVIEW_ROOT/profile"
```

Use the script rather than copying the illustrative environment value. Both the app-data override and user-data switch are required; the former redirects home-based registries too. The profile has fixture-only hooks/MCP/Clubhouse materialization disabled before first launch, terminal runtime selected, auto-update/export/Dispatcher disabled, two registered fixture agents and saved catalog blocks/skill. Adoption changes none of those settings. No production gate or capability seam is added.

The fake executable cannot forward commands or look up a real provider. Every invocation except exact single-argument `--help`/`--version` exits 64 and logs only `REFUSED_NON_CAPABILITY_INVOCATION`, never arguments or prompt text. Actual preview/adopt/unassign remain subject to ordinary platform, compatibility, binary identity, target, token and revision checks. Do not press Start, resume, wake or provider sign-in/probe controls. Do not launch or retry CUA as part of fixture preparation.

## Exact human visual checklist

All items below remain unverified until a person performs them; automated component tests are not visual proof.

1. Default layout: an existing local agent's Settings navigation has its own Builder page. Instructions remains separate. Classic layout hides Builder and shows its one-line note.
2. Builder's saved-only notice is visible with the editor. Next-start adoption has a separate persistent explanation that adoption does not start or wake the agent. Check narrow-window wrapping, scroll reachability, contrast and ordinary theme tokens; no accent bars, glows, tinted callouts, all-caps labels, chips or em dashes.
3. Both policy selects initially show Choose. Preview saved delivery is disabled until both are selected and drafts are saved/discarded. Editing a block removes any adoption preview/approval. Keyboard focus follows ordinary selects/buttons and remains visible.
4. In the no-CLI isolated launch, request a delivery preview and confirm a visible refusal/error, no adoption-success state, no process start and no hidden setting changes. Refresh and target navigation remain usable.
5. On **Fake adoption review, no live agent** (`review-agent`), inspect **Appended managed instructions**, exact literal `@@` tokens, ambient CLAUDE.md notice, qualified skill names, the no-reference-rewriting notice and CLI flag-evidence-only wording before the explicit adoption button. This fixture is not installed runtime/load proof.
6. On **Seeded receipts only, not observed** (`seeded-receipts`), compare desired, prepared, materialized and PTY observation labels. A created PTY is labelled a shell observation; unconfirmed cleanup does not say stopped. Verify long names/timestamps and empty history fit without clipped controls.
7. On `review-agent`, after fake adoption, refresh and reopen: the desired snapshot remains. Remove future adoption: history remains and no stop/wake occurs. Failed/stale saves show errors and refresh actual state. Change target or policy while a reply is deferred: no old preview/receipt/error appears under the new selection.

## Refusal mode for item 4

Use `bash scripts/launch-adoption-review.sh <reviewed-integration-head> --launch-no-cli` with `CLUBHOUSE_ADOPTION_REVIEW_ROOT` unset to create a fresh fixture. This mode supplies a nonexistent private Claude path plus nonexistent other providers; the unpackaged override throws rather than falling back. The same ordinary compatibility/capability checks run. On `review-agent`, choose both policies and request saved delivery: expect a visible refusal/error and no new desired receipt or process. A fresh fixture avoids confusing previously adopted history with success from this refused request. The original private fake executable is never moved or altered, and ordinary `--launch` restores fake-capability mode on the same root if needed. Preparation alone still uses `--prepare-only` and never opens the app.

## Original Builder checklist mapping

Keep every one of the original ten Builder items in the consolidated review package, plus the seven adoption items above. Apply these substitutions when performing them on this combined fixture; missing old fixture names are not a failed item:

| Original Builder review reference | Combined fixture equivalent |
| --- | --- |
| Printed `builder-review-project` to add (item 1) | The already registered **Fake adoption review** project; path in `review-manifest.json` under `project` |
| Agent `builder-review-agent` (item 1 and stale-write snippet) | `review-agent` in UI, stored ID `adoption-review-agent` |
| Existing instruction sentinel | `Ambient fixture instructions. Adoption must leave this unchanged.` in `project/.clubhouse/agents/review-agent/CLAUDE.md` |
| Original saved-only literal copy (item 2) | `Builder edits are saved only. Review a separate snapshot below for next-start adoption.`; separate adoption copy must still say no start/wake |

Use the original stale Builder write procedure with the registered fixture path and current ID. Obtain the path from the printed manifest rather than the old printed project. For example:

```js
// Read the current saved revision before using the original stale-write procedure.
const project = '<project from review-manifest.json>';
const agentId = 'adoption-review-agent';
const saved = await window.clubhouse.agentSettings.builderRead(project, agentId);
if (saved.ok) await window.clubhouse.agentSettings.builderCommand(project, agentId, saved.view.revision, { type: 'append', name: 'Changed elsewhere', content: 'Saved from another view.' });
```

The `seeded-receipts` agent is presentation-only and is not a replacement for Builder persistence/failed-save checks. Preserve the original checklist wording alongside this mapping for traceability.

## Concrete fixture review for items 5–7

Use a fresh fixture root for this group if earlier Builder template/edit checks changed its saved selection. The project is already registered. Select `review-agent`, open Settings > Builder, choose both policies and Preview saved delivery. Its saved composition contains literal wildcards and a selected `review` skill, so the ordinary main IPC should return exact appended bytes and a qualified `clubhouse-agent-…:review` name. Adopt and Refresh receipts, close only this isolated instance, then use the printed restart command with the same root. The desired snapshot should remain. Remove future adoption should preserve history. These are actual local preview/adoption persistence actions against fake flag evidence, not process creation or observed instruction loading.

Switch to `seeded-receipts` for six **seeded, synthetic presentation samples**: prepared, materialized, PTY-created/exit, receipt-persistence-failure with unconfirmed cleanup, known non-creation and unresolved intent. All use year-2000 timestamps and an explicitly labelled agent. No process, exit, private file publication or persistence failure was observed to create these examples. They do not prove the lifecycle behavior; automated service/PTy regressions cover that separately. The unended samples also block any managed start rather than suggesting a stopped process. Never Start this agent.

For a reproducible stale-save message, first adopt on `review-agent` and leave its displayed receipt unrefreshed. In this isolated instance's renderer DevTools, use the ordinary public DTO bridge to unassign externally:

```js
(async () => {
  const target = { projectId: 'adoption-review-project', agentId: 'adoption-review-agent' };
  const result = await window.clubhouse.agentSettings.activationRead(target);
  if (result.ok) await window.clubhouse.agentSettings.activationUnassign({ target, receiptRevision: result.view.receiptRevision });
})();
```

Then click the still-visible Remove future adoption button. Its old revision should show a stale message and refresh actual state, with no start/wake. For a binary-stale refusal, make a new preview, run `touch "$CLUBHOUSE_ADOPTION_REVIEW_ROOT/capability-only-claude"` in a shell retaining that root, then Adopt: the identity check should refuse and the UI should refresh. This is a stale-capability rejection, not a simulated I/O failure.

To defer a preview without altering production code, create `"$CLUBHOUSE_ADOPTION_REVIEW_ROOT/capability-only-claude.delay-help"` using `touch`. The fake help response then waits two seconds. Click Preview saved delivery and immediately navigate to the other agent or edit a Builder draft; after the delayed reply, no old approval may appear under the new selection/draft. Remove the `.delay-help` file to restore immediate help. Late same-target receipt reads/errors after successful mutations remain deterministic **automated component regressions**, not a manually delayed read claim. Actual failed receipt persistence likewise remains automated validation plus explicitly seeded presentation.

The fixture path and safety checks are validated without launching the app. All human checklist items remain unverified. Positive adoption/lifecycle tests do not establish a real installed CLI or native instruction/skill-load observation. The existing Linux/Windows Stable-mode scenario tests unset policies and unsupported delivery refusal within its existing 90-second budget. No local Playwright was run. UI/integration visual acceptance, real installed-path validation, broader delivery, hooks/MCP, native subagents, runtime reconciliation, inventory boundaries and retention policy remain follow-ons.
