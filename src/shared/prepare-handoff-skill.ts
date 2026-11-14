/**
 * The built-in prepare-handoff skill's text (#3344, D253). App-owned, not from
 * the builder export: it follows the handoff tools' shapes and ships with them.
 * Shared so Help can show exactly what agents get. Placeholder names only.
 */
export const PREPARE_HANDOFF_SKILL_NAME = 'prepare-handoff';

export const PREPARE_HANDOFF_SKILL_MD = `---
name: prepare-handoff
description: Prepare and offer a handoff of your current task to another agent or to another computer's Dispatcher. Use when the person asks you to hand off, move or continue this work somewhere else.
---

# Prepare a handoff

A handoff moves your task and its files to another agent, or to a computer's Dispatcher, which picks an agent there. The receiver must accept it first. This is not \`hand_off\`, which only records how an orchestrator took a helper's work.

## 1. Write the brief

One plain-text brief, at most 16,000 characters, with these parts:

- **Goal:** what the work is for.
- **Done:** what is finished, with the commits or files.
- **Remaining:** what is left, in order.
- **How to verify:** the commands or checks that show it works.
- **Open questions:** what the person or the receiver still has to decide.

Never put a secret value (a key, token or password) in the brief. Name the setting and say where it is configured.

## 2. Choose the mode

- \`branch\` when everything is committed and pushed: the receiver gets that exact branch.
- \`worktree\` otherwise: the receiver gets a snapshot of the tracked and untracked files.

## 3. Check what would be sent

Call \`check_handoff\` first: it is quick and changes nothing. By default it takes tracked changes and untracked files, and leaves ignored files and \`node_modules\` out.

- Add an ignored file through \`include.ignored\` only when the receiver can't continue without it, such as a test fixture, local data or a built model. Nothing else.
- Leave out anything the receiver doesn't need with \`exclude\`.
- Compare \`totalBytes\`, the file count and each file's size with \`bounds\`. If anything is over, exclude more and check again.

If \`check_handoff\` fails without a result, call \`prepare_handoff\` (step 5): its \`reason\` says what is wrong, and step 4 says what to do.

## 4. Resolve what blocked it

\`ready: false\` says why. Read \`reason\` first:

- **Too big** (\`reason: bounds_exceeded\`): \`largestFiles\` and \`bounds\` show what is over. Exclude the largest files the receiver doesn't need and check again. The limits are the person's; don't ask to raise them unless the person says so.
- **Looks like a secret** (\`findings\` with a path and rule): remove or exclude those files and check again. Never copy a secret's value into the brief or another file to get past a finding. Only the person can allow a specific file, in Project Settings, Handoff secret exceptions.
- **No Git to send from** (\`reason: not_a_repository\`): the project isn't a Git worktree, so its code can't be handed off. Tell the person, or send the task as a message instead.
- **No commit yet** (\`reason: no_commits\`): the repository has no first commit. Make one if the work and the person allow it, then check again; otherwise tell the person.
- **Not at the repository root** (\`reason: invalid_repository\`): the project is registered below the repository root, or isn't on a named branch. Only the person can change how the project is registered, so tell them; check out a named branch yourself if that is the cause.

## 5. Prepare the manifest

Call \`prepare_handoff\` with the same \`mode\`, \`include\` and \`exclude\`. It repeats the checks, also looks at the Git history it would send, and freezes the exact set of files.

- \`ready: true\`: keep its \`summary\` (\`fileCount\`, \`totalBytes\`, \`sha256\`) for the offer. The preparation expires after 15 minutes; prepare again if you take longer.
- \`ready: false\`: handle it as in step 4 by its \`reason\`. Preparation can also find secrets in the Git history it would send. \`uncommitted_branch\` means \`branch\` mode found uncommitted work: commit it, or use \`worktree\`. Then prepare again.

## 6. Choose a computer (optional)

When the person asked for a computer rather than an agent, \`probe_capacity\` shows which computers are there, how busy they are and whether they accept handoffs.

## 7. Offer it and follow up

Call \`offer_handoff\` with \`to\` (an agent name, \`agent@machine\`, or \`machine:<name>\` for that computer's Dispatcher), \`task\` (one line), \`brief\`, \`mode\` and \`manifest\` set to the \`summary\` from step 5. Pass the summary, never the full manifest. Tell the person the handoff id it returns. Check on it with \`get_handoff\`: accepted, declined, applied or expired. Don't keep changing the files you handed off unless it was declined, refused or cancelled.

## Example

- to: \`machine:machine-b\`
- task: Finish the checkout tests in example-project
- mode: \`branch\`
- manifest: the \`summary\` from \`prepare_handoff\`, such as \`{ fileCount: 42, totalBytes: 180311, sha256: "..." }\`
- brief: "Goal: checkout tests cover the discount rules. Done: unit tests for the cart (commit abc123). Remaining: the two discount cases, then the end-to-end test. How to verify: npm test in example-project. Open questions: none."
`;
