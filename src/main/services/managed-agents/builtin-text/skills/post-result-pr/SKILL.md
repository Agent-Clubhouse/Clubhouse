---
name: post-result
description: Posts a review verdict or a finished task's outcome as a comment on its pull request on GitHub or Azure DevOps, starting with Approve or Reject. Use when you reviewed a pull request, or finished work that has one.
---

# Post a result to the pull request

Post one comment on the pull request, unless the task names another place for the result.

1. Find the host with `git remote -v`. github.com is GitHub, and dev.azure.com or visualstudio.com is Azure DevOps. For any other host, give the comment text in the conversation instead. If you don't know the pull request number, find it from the current branch (`gh pr view`, or `az repos pr list --source-branch [branch]`).
2. Write the comment. Start with Approve or Reject for a review, or with the outcome for finished work. Then give your reasons and the validation you ran, with results.
3. Post it.
   - GitHub: `gh pr comment [number] --body-file [file]`
   - Azure DevOps: `az repos pr` has no comment command. Get the project and repository from `az repos pr show --id [id]`, then post a thread:

     ```sh
     az devops invoke --area git --resource pullRequestThreads --http-method POST --api-version 7.1 \
       --route-parameters project=[project] repositoryId=[repository-id] pullRequestId=[id] \
       --in-file thread.json
     ```

     where `thread.json` is `{"comments":[{"parentCommentId":0,"content":"[comment]","commentType":1}],"status":1}`. Add `--org [url]` if no default organization is configured.
4. Report the link to the comment.

The comment is the verdict. Don't add a formal approval or vote unless the task asks for one, and never on a pull request opened from the account you're signed in as. To check, compare `gh pr view [number] --json author` with `gh api user`, or the pull request's `createdBy` with `az account show`.