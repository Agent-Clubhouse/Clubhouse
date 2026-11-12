---
name: prepare-handoff
description: Prepares a secret-safe brief and verified transfer preview, then offers work to an authorized agent or computer Dispatcher.
---

# Prepare handoff

Prepare work another agent can safely continue. This does not grant permission to transfer, accept, apply files or wake an agent.

## Availability

Use the live Clubhouse tool schemas, not guessed arguments. You need `offer_handoff` and `get_handoff`, an active `handoff.offer` grant for the target, and a real app-provided safety preview. If tools or the preview are unavailable, stop and say handoff preparation is unavailable. Do not emulate a transfer with `send_file`, an archive upload, shell copying, a shared directory or a second agent.

This is not `hand_off`, which gives an ordinary task to a local helper.

## Brief

Write a bounded brief with these headings:

- Goal: the intended outcome and acceptance criteria.
- Done: changes already made and the relevant branch/commit.
- Remaining: concrete next steps and anything deliberately unfinished.
- Verification: exact checks and results, including interrupted, failed or unrun checks.
- Open questions: decisions and risks the receiver must preserve.

Use only necessary project-relative references. Never paste credentials, tokens, private keys, environment contents, complete transcripts, raw diagnostic dumps or blocked values into the brief, messages or tool arguments. A secret finding is reported by its redacted path and fixed rule identifier, not its matched value.

## Choose and preview the transfer

1. Inspect the worktree without modifying it. Do not reset, clean, stash, commit, push or remove anything merely to prepare a handoff.
2. Prefer branch mode only when the intended changes are committed and pushed, the receiver can obtain the exact base/commit, and Clubhouse advertises the fully verified branch-transfer capability. Pushing is a separate authorized action. A clean checkout alone does not establish that the receiver can obtain the work.
3. Otherwise use worktree mode only if that capability and the receiver's exact base are available. Include the intended final staged/unstaged changes and untracked files. Ignored files are excluded unless explicitly selected; ask which ignored or large required artifacts belong in the handoff. Never include a secret simply because it is required to run the project.
4. Request the app's advertised preparation/preview operation. Review its selected paths, deletions, executable modes, file count, total bytes, individual large files, include/exclude choices and immutable manifest digest. Show the safe preview before offering. Respect the configured file/count/total limits; do not silently omit required files or raise limits yourself.
5. Any secret, invalid path, symlink, invalid hash/bound or incomplete scan blocks the handoff. Remove or replace the unsafe material in the source only with authorization, then request a fresh preview. No agent-created exception or scanner override is allowed. Never copy a blocked value into the brief as a workaround.
6. Bind the offer to that exact verified preparation. If the selected files or bytes change, obtain and review a new preview. Do not fabricate a manifest, digest, scan result or preview identifier.

## Target and offer

An authorized agent may target another agent or a computer's Dispatcher; being a Dispatcher or orchestrator is not otherwise required. Resolve the target from Clubhouse's current identities, not an invented agent id or machine alias.

If useful and available under `device.read`, call `probe_capacity` to compare coarse capacity bands. Unknown is not available, offline is not accepting, and a capacity answer is not receiver agreement. Do not run a benchmark, active provider request, login or destructive disk test.

For example, the brief can describe `example-project` and target the resolved Dispatcher on `machine-b`. These are illustrative names, not real identities or tool arguments.

Call `offer_handoff` with the resolved target, short title, brief, selected mode and the app's verified preparation as required by its live schema. If approval is requested, wait for the person. Refusal, changed grants, a disabled accepting setting or a failed persistence/transport operation is not success.

## Follow through

Keep the returned handoff id. Use `get_handoff` to reconcile authoritative state; a timeout or unknown delivery outcome is not permission to create a duplicate offer. Report the id, current state and the next responsible party.

An offer is not acceptance, acceptance is not transfer completion, and neither means files were applied or the receiver woke. The addressed receiver must explicitly agree. Do not claim completion until the verified `applied` result names its fresh worktree, branch and receiving agent.

Cancellation must be durably acknowledged by the receiver before the applying boundary. Never mark a remote handoff cancelled unilaterally or delete files as a supposed rollback. Failed or indeterminate apply requires preserving the durable checkpoint and artifacts for recovery, not an automatic retry or a claim that no side effects occurred.
