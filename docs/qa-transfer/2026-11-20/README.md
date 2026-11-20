# Independent QA continuation — 20 November 2026

This is a documentation snapshot from qa-full-card-parity, task t_mwnsu8yl, for Clubhouse-Orchestrator. Repository: Agent-Clubhouse/Clubhouse. Remote task branch: qa-full-card-parity/standby. The branch starts at old source commit 596e7bc2bf6ba4766de7af120bb624f28981992a; this snapshot adds documentation only. Do not treat this branch's old product tree as a candidate for landing. The exact documentation commit is the commit containing this note, advertised separately to the orchestrator.

Ownership remains with the sender. No verified Mini receiver identity/link/fetch/acceptance has been supplied. Delivery or availability of this branch is not takeover. Navi coordinates the receiver. Do not invent a route or run Clubhouse worktree-Handoff APIs.

## Current priorities and decisions

1. Await exact Auto implementation head and complete evidence, then prioritize its independent review. The previously approved f386b143fda60d969c705dcb397c9458b6ae0035 is design/replay research only, not implementation or user-default approval. Report is copied below.
2. PR [3744](https://github.com/Agent-Clubhouse/Clubhouse/pull/3744), reviewed head166f8d50ff702081afa3af33e819698482d73a5a / tree6e8368316a67b30ee69e45b272c3e4af817d8c1e, has a real unresolved hosted validation gate. Main/base last observed ae56577af786b0db79f21d137d0b334a5f7847dc, no drift at08:32–08:35Z. Run44693675446 failed Windows unit/component shard2, job136145316872, despite32success/1failure/4skips total. No rerun/cancellation done.
3. Agent Settings branch agent-settings-usability/wildcard-preview remains exact approved3b6647f3955e9c6ace65a9079fa2d37219880fd7 / tree43cb8d116c9791b58b73be506875362634b4c05f, baseae565, last observed no PR/zero Actions or Check Runs. Source approval137PASS/scoped lint0/full-source types0 and isolated component visuals retains its limitations. PR creation and hosted validation remain for authorized owner; current task does not authorize this reviewer to create/merge.
4. Full#3733 remains OPEN. Latest reviewed CA1 slice2482e8bc2a93f55bcd39d4cd9f5fdcfff8053467 / tree1d52067db1dd1726c17c0a0f6af12aa6ac46f023 has bounded approval332PASS/tsc0. Assigned accepted root remains f1220c2a2324d62021a222d24f0e637a8416ecc0; no root/full-matrix transfer. Owner handles Connections/shared bounded inventory. Fresh-local eight-milestone source audit is copied for planning, not acceptance.

## Concrete PR3744 evidence gap

Failed test: handoff-git-receive.test.ts, Windows repository path limit(root220). It constructs exactly220-character staging, then a268-character nested quarantine /273-character repo, deliberately exceeding the policy threshold. Those setup assertions pass. receiveHandoffCommit fails in createHandoffQuarantine before quarantine Git init/import; later short-root/Git-directory/content assertions are unreached.

The displayed path_too_long is SYNTHESIZED when no verified short root is admitted, not actual Git-init stderr. Candidate/profile/canonical/length/identity/ACL/PowerShell timeout/recovery/child failures are not distinguished by that final diagnostic. Failure duration alone proves no timeout/flakiness. All inspected files equal main but no main reproduction exists.

The Actions checkout is synthetic merge82d384973eec65f62cec6a5809cf51bdd729b8e6; GitHub commit metadata verifies its tree equals166f exactly. Existing27-artifact inventory and failed shard ZIP show only JUnit XML from this job, no closed allocator rejection diagnostic. Exact artifact14610199596 digest6da37b44b11eac877cceb74220d0d6dafa7ecc60bad8391cda444dbc918ffa26. It is accessible through existing authorized GitHub reads; original raw archive is intentionally not added to Git.

Next supported step is obtaining an existing matching local diag record or a narrow owner change to expose bounded safe stage/class/attempt/created/elapsed/candidate-admission flags in failure output, without raw paths/SID/ACL/error text. Do not shorten/skip fixture, bypass ACL/profile/no-reparse checks, assume timeout, waive CI or increase timeouts without evidence.

## Remote evidence and copied reports

- [Validate44693675446](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44693675446)
- [Failed job136145316872](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44693675446/job/136145316872)
- [Main ruleset12846624](https://github.com/Agent-Clubhouse/Clubhouse/rules/12846624): squash-only PR/linear-history; visible0required approvals/no exposed status contexts does not waive assignment validation.
- reports/ holds text copies (only redundant EOF blank lines normalized) of the current readiness/diagnostic findings, latest3695 correctness/typecheck reports, SettingsUI1, Auto design, CA1 and fresh-local closeout checklist. SHA256SUMS.json binds these copies.
- Full owner raw local evidence packages/screenshots/compiler receipts are NOT uploaded by this snapshot; those are still owner preservation dependencies. Copied reports preserve observed results and limitations and point to source/evidence identities, but do not substitute for raw artifacts. Do not claim all owner evidence has reached Mini.

## Next steps and deadlines

Corrected deadline: begin wrap/preservation/transfer no later than05:00Pacific/13:00Z Nov20; hard cutoff06:15Pacific/14:15Z. Earlier03:30snapshot/04:30verification are early targets. Prepare now.

Orchestrator should provide verified Mini receiver/link. Receiver must fetch the exact advertised commit, read these notes and explicitly accept named task ownership before sender relinquishes responsibility. Refresh only time-sensitive readiness if subsequently assigned; avoid duplicate accepted source review or validation. New Auto freeze supersedes waiting and has review priority.

No PR/merge/release authority is conferred here. No source edits/tests/live actions/reruns/cancellations/install/reset/deletion/restart/re-pair/access changes are authorized by this transfer. Historical3613 provider-refusal boundary remains untouched;3706 public-release hold remains; superseded3611 phone merge hold is not reinstated. Prior Navi queue unknown-delivery policy work remains separate and pending user decision.
