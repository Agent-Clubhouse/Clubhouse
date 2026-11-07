---
name: post-result
description: Delivers a finished result or review verdict to the right place, choosing between the parent agent, the Clubhouse group project board, the pull request and the conversation. Use when a task or review is done and its result needs reporting.
---

# Post a result

Send the result to one place, using the first rule that applies.

1. The task names a place. Use it.
2. Another agent started you, so you're a helper. Send it with the Clubhouse `message_parent` tool.
3. You're working in a Clubhouse group project. Post it with the project's `post_bulletin` tool. Set `topic` to the channel where the work was assigned, or to `inbox-[agent-name]` of the agent who asked if the request came to your inbox.
4. You reviewed a pull request, or your work has one. Comment on it as described below.
5. Otherwise, reply in the conversation.

Lead with the result (for a review, Approve or Reject), then the branch and latest commit if you changed code, the evidence (what you checked and ran, with results), and anything someone has to decide. Keep it short.

## Commenting on a pull request

- Find the host with `git remote -v`. For any host other than GitHub or Azure DevOps, give the comment text in the conversation instead.
- Start the comment with Approve or Reject, or with the outcome for finished work.
- GitHub: `gh pr comment [number] --body-file [file]`.
- Azure DevOps: `az repos pr` has no comment command. Get the project and repository from `az repos pr show --id [id]`, then post a thread:

  ```sh
  az devops invoke --area git --resource pullRequestThreads --http-method POST --api-version 7.1 \
    --route-parameters project=[project] repositoryId=[repository-id] pullRequestId=[id] \
    --in-file thread.json
  ```

  where `thread.json` is `{"comments":[{"parentCommentId":0,"content":"[comment]","commentType":1}],"status":1}`. Add `--org [url]` if no default organization is configured.
- The comment is the verdict. Don't add a formal approval or vote unless the task asks for one, and never on a pull request opened from the account you're signed in as.