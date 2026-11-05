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

From this integration checkout on macOS:

```sh
npm ci
npm run package
```

The package is `out/Clubhouse-darwin-arm64/Clubhouse.app` on this Apple Silicon workspace. This builds an artifact; it does not install it. To review without touching ordinary app registries, launch the compiled **unpackaged** app with both the app-data override and Chromium user-data switch. The unpackaged test seams ensure that no real CLI can be selected. Use an existing Electron 45.1.0 development executable, such as the preserved Builder checkout's executable on this workspace:

```sh
review_dir="$(mktemp -d /tmp/clubhouse-adoption-review.XXXXXX)"
electron_bin="/Users/masonallen/source/Clubhouse/.clubhouse/agents/v1-builder-slice-1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
CLUBHOUSE_USER_DATA="$review_dir" \
CLUBHOUSE_TEST_NO_MODEL_PROBES=1 \
CLUBHOUSE_TEST_CLI_BINARIES='{"claude-code":"/nonexistent/adoption-review-claude","codex-cli":"/nonexistent/adoption-review-codex","copilot-cli":"/nonexistent/adoption-review-copilot"}' \
"$electron_bin" . --user-data-dir="$review_dir"
```

Run that command with the integration checkout as the working directory. It reads the preserved Electron binary without changing the held checkout or package. `CLUBHOUSE_USER_DATA` redirects both userData and home-based app registries; the user-data switch alone is insufficient. Nonexistent CLI overrides refuse rather than fall back. Do not press Start, resume, wake or any provider sign-in/probe control during this visual review.

## Exact human visual checklist

All items below remain unverified until a person performs them; automated component tests are not visual proof.

1. Default layout: an existing local agent's Settings navigation has its own Builder page. Instructions remains separate. Classic layout hides Builder and shows its one-line note.
2. Builder's saved-only notice is visible with the editor. Next-start adoption has a separate persistent explanation that adoption does not start or wake the agent. Check narrow-window wrapping, scroll reachability, contrast and ordinary theme tokens; no accent bars, glows, tinted callouts, all-caps labels, chips or em dashes.
3. Both policy selects initially show Choose. Preview saved delivery is disabled until both are selected and drafts are saved/discarded. Editing a block removes any adoption preview/approval. Keyboard focus follows ordinary selects/buttons and remains visible.
4. In the no-CLI isolated launch, request a delivery preview and confirm a visible refusal/error, no adoption-success state, no process start and no hidden setting changes. Refresh and target navigation remain usable.
5. In a separately authorized fake-capability fixture, inspect **Appended managed instructions**, exact literal `@@` tokens, ambient CLAUDE.md notice, qualified skill names, the no-reference-rewriting notice and CLI flag-evidence-only wording before the explicit adoption button. This fixture is not installed runtime/load proof.
6. With mocked retained receipts, compare desired, prepared, materialized and PTY observation labels. A created PTY is labelled a shell observation; unconfirmed cleanup does not say stopped. Verify long names/timestamps and empty history fit without clipped controls.
7. After fake adoption, refresh and reopen: the desired snapshot remains. Remove future adoption: history remains and no stop/wake occurs. Failed/stale saves show errors and refresh actual state. Change target or policy while a reply is deferred: no old preview/receipt/error appears under the new selection.

Positive adoption/lifecycle states are currently validated with injected fixtures, not a real installed CLI or native instruction/skill-load observation. The existing Linux/Windows Stable-mode scenario tests unset policies and unsupported delivery refusal within its existing 90-second budget. No local Playwright was run. UI/integration visual acceptance, real installed-path validation, broader delivery, hooks/MCP, native subagents, runtime reconciliation, inventory boundaries and retention policy remain follow-ons.
