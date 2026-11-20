# Nov 20 desktop continuation ledger

Status: preservation in progress; no Mini recipient has yet fetched and accepted ownership. Sender remains responsible. Wrap begins by 05:00 Pacific; hard cutoff 06:15 Pacific (14:15Z). Use normal Git remotes and authenticated messages, never Clubhouse worktree-Handoff APIs. Preserve independent exact-head review, security and release gates. No job cancellations, access changes, installs, restarts or public release are authorized by this transfer.

Repository: Agent-Clubhouse/Clubhouse. This notes branch is documentation only, not an implementation integration or merge candidate.

## Completed Agent Settings usability

- Remote branch: `agent-settings-usability/wildcard-preview`.
- Reviewed head: `3b6647f3955e9c6ace65a9079fa2d37219880fd7`; tree `43cb8d116c9791b58b73be506875362634b4c05f`.
- Last verified base: `ae56577af786b0db79f21d137d0b334a5f7847dc`, 3 ahead / 0 behind. No PR found in Nov 20 08:32–08:35Z read.
- Scope: Settings/Skills/Instructions/MCP order, wider instruction editor, local unsaved Markdown preview, correctly paired raw/expanded block labels, safe intact legacy preview fallback, truthful Quick defaults copy and committed applicability audit.
- Independent source/artifact review approved this exact head. Original `97aa1092b` was rejected for raw/expanded line-range mismatch; successor has producer-specific optional raw ranges and byte-preserving slices. Do not transfer original validation counts to successor.
- Actual successor checks: 137 focused tests (68 producer + 69 renderer), scoped six-file lint 0 errors/0 warnings, full unchanged-tsconfig source typecheck pass in verified existing dependency-cache environment. Isolated actual-component browser checks at 1280/600/360 widths, modeled IPC/running state; not installed Electron or live provider proof.
- No exact-head hosted Actions/check runs yet. Next: recheck base/head and duplicate PR, create reviewed PR using supported existing access, obtain hosted validation and resolve real failures before any authorized landing.
- Prepared title: Improve agent settings order and instruction previews.
- Suggested body: Reorders agent settings, widens instruction editing and adds local draft previews. Keeps block labels paired with exact raw or expanded text, with intact fallback for older preview metadata. Clarifies desktop Quick defaults without changing launch behavior. Validation: 137 focused tests, six-file lint 0/0, full source typecheck, isolated three-width component visuals; full-app/provider behavior not covered.
- Local audit evidence (not yet remotely transferred): agent-settings-usability-ui1-20261119 manifest SHA256 `63a2758100281add75a387c53e7614961187136c3e8be045d6c89dacce881aa4`; QA report `agent-settings-3b6647f39-independent-ui1-verdict.txt`. Implementation and tests are already on the remote branch. QA owner is preparing remotely accessible safe review notes.

## PR 3744: startup cached Annex catalog hydration

- PR: https://github.com/Agent-Clubhouse/Clubhouse/pull/3744
- Remote branch: `lane-3695-wake-catalog/renderer-hydration-hy4`.
- Reviewed head: `166f8d50ff702081afa3af33e819698482d73a5a`; tree `6e8368316a67b30ee69e45b272c3e4af817d8c1e`.
- Last verified base: `ae56577af786b0db79f21d137d0b334a5f7847dc`, 10 ahead / 0 behind. Open, non-draft; no submitted GitHub reviews/threads at readiness read. Independent exact-head review exists separately.
- Scope: renderer startup cached inventory hydration with newer projection reconciliation and truthful incomplete-state handling. Quiescent optional omissions can remain incomplete; not a universal wake-incident fix.
- Actual local checks: 247 tests / 8 suites; lint 0 errors / 50 warnings; later full source typecheck pass in verified existing cache environment. Earlier environment failures retained; do not imply all checks used one environment.
- Hosted Validate run `44693675446`: FAILED, 32 successful / 1 failed / 4 skipped jobs. Windows unit/component shard 2 job `136145316872` fails `handoff-git-receive.test.ts` root220 path-limit case. Typecheck/API/ESLint passed.
- Failure precision: `path_too_long` is synthesized at `handoff-quarantine.ts:262` because no short verified quarantine root was admitted. `receive.ts:39` fails before Git init/import. This is NOT observed Git-init stderr. Test path-threshold prestates passed; receive-success and later CWD/profile/GIT_DIR/content assertions were unreached. Other root-length cases pass; this does not establish flakiness.
- Actual CI checkout synthetic `82d384973` has the exact reviewed tree and parents main + reviewed head, as independently verified by GitHub. Inspected allocator/test/setup files equal main; no main reproduction or root-cause attribution follows.
- Existing artifact inventory has 27 entries, no separate unit allocator diagnostic. Failed-shard artifact `14610199596`, 524059 bytes, SHA256 `6da37b44b11eac877cceb74220d0d6dafa7ecc60bad8391cda444dbc918ffa26`, contains only XML with same stack, no root-rejection diagnostic/system output. Logs do not distinguish canonical/identity/ACL/verification/recovery/child failure.
- Next supported step: narrow safe failure-output capture for stage/class/attempt/created/elapsed and candidate admission flags. No supported behavioral fix yet. Do not increase timeout, shorten away the discriminator, bypass ACL/root checks, or waive failure as pre-existing. Any correction needs independent exact-head review and green validation.
- GitHub CLI created this PR using existing authenticated credentials after explicit user authorization; earlier MCP integration 403 remains a distinct credential/grant boundary, not a GitHub-wide outage. Do not change credentials/access.

## Active assignments

- Auto routing: `auto-reset-policy-design/implement-reset-aware-auto`, implementation in progress from approved research `f386b143fda60d969c705dcb397c9458b6ae0035`. User authorized opt-in 48h urgency / stronger 24h, configurable provider reserves (10% proposed UI default), no reserve relaxation, retain saved Copilot fallback, fresh quota cold-forecast admission with honest overshoot limits. No rate buffer/probes; pace deferred. Latest reported 204 routing/persistence/UI tests and full source typecheck passed; exact final head/review pending. Owner must publish exact transfer receipt.
- Full remote Details #3733: owner `lane-full-remote-details`, cohesive Connections/shared inventory implementation ongoing. Last bounded accepted slice `2482e8bc2a93f55bcd39d4cd9f5fdcfff8053467`; assigned root `f1220c2a2324d62021a222d24f0e637a8416ecc0` has NOT advanced. No full-parity/PR acceptance. Fresh eight-group local delta checklist must accompany transfer; source owner and QA are publishing safe remote notes.
- #3613: `feat/3613-owned-diagnostic-contract-v2`, exact `233a669e7f38ed52a5f93e080537eccbce1cd7ab`, tree `e3cf643ec106aa8ca3ef683e2e42dcc5cc0756c9`. Calibration only, pending parent source/evidence assessment. Raw delayed resource samples remain missing; prospective contract observed genuine early native exit instead, not watcher disappearance. No route/full-P8 acceptance or alternate replay of historical provider-refused review. Owner publishing existing source and safe evidence index; no new execution.
- Navi queue: Q5 delivery policy remains undecided. Test-only baseline `edce1d072a674bc4d3673296a13b18ad54f535e5` demonstrates unknown-delivery cursor/replay gaps. No policy implementation authorized. Owner publishing safe candidate/baseline/status notes.

## Transfer acceptance ledger

Verified route: sender → Navi → Tael → Mini desktop `bp83o0`. No direct sender-to-Mini wire or transferred grant is assumed.

At 08:45Z, Navi relayed actual authenticated Mini acceptance via Tael:

- Settings: exact `3b6647f3955e9c6ace65a9079fa2d37219880fd7` fetched; PR-readiness/hosted-check coordination accepted. Sender stopped that coordination; retains private/raw preservation responsibility. Original scope came from direct user UI requests; PR sequencing authority came from user-provided Orchestrator AGENTS requiring independent review before opening a PR. No separate specific-PR command or merge authority is asserted; receiving grants remain local.
- PR3744: exact `166f8d50ff702081afa3af33e819698482d73a5a` fetched; PR/CI-blocker coordination accepted. Sender stopped duplicate coordination. Unknown allocator rejection remains unresolved, with no rerun/fix/waiver implied.
- QA: exact `90e30f99b27bea8dde20b90b738d2e5488ffd39e` on `qa-full-card-parity/nov20-transfer` fetched; nine reports verified and accepted as summaries only. Entry point `docs/qa-transfer/2026-11-20/README.md`.
- #3613: three source refs fetched, safe index read; SOURCE/INDEX CUSTODY ONLY accepted. Raw calibration assessment and implementation takeover deferred. Safe index: https://github.com/Agent-Clubhouse/Clubhouse/issues/3613#issuecomment-7034686908 . Existing private transport supports bounded text/temp delivery only; do not tunnel binary packages. Await receiver durable destination and exact saved-file hash receipts for necessary original text evidence.

Further source preservation, not takeover:

- Auto implementation `c29c0c9ab208de37482d8cd8ce387dace1af61c3`, tree `3c963bcb46ec18b0e00aca3ebc95d03d96e0defe`, pushed on `auto-reset-policy-design/implement-reset-aware-auto`; independent source review assigned here, final exact-head checks pending. Owner retains active implementation responsibility.
- Navi Q5 preservation `e2340b51e434c499b5e4f7014e9bc3bcd857920f` on `diagnose-navi-queue/mini-preservation`; entry `notes/diagnose-navi-queue-transfer/README.txt`, 25 safe evidence records with index. Requested preservation-only acceptance; policy decision still pending, no implementation authorization.
- Details source owner continues on pushed `lane-full-remote-details/connections-complete`, with `docs/implementation-notes/3733-continuation.md`. Branch is actively advancing, not a final freeze; obtain exact final owner receipt before takeover. Accepted root remains f122. No concurrent receiver edits authorized by source publication.

For each remaining transfer record exact fetched SHA, explicit remaining-scope acceptance, timestamp and sender stop boundary. Delivery alone is not takeover.

Existing #3613 validation drafts #3736 and #3721 remain DO NOT MERGE. The old #3611 merge hold is superseded; #3706 public desktop release hold remains. No default-branch push, merge or release authority is created by this document.
