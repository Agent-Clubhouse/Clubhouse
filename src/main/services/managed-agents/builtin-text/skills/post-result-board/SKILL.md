---
name: post-result
description: Posts a finished result or review verdict on the Clubhouse group project board with the post_bulletin tool, in the channel where the work was assigned or the requester's inbox. Use when your task or review in a group project is done.
---

# Post a result on the board

Post once with the group project's `post_bulletin` tool, unless the task names another place for the result.

- Set `topic` to the channel where the work was assigned. If the request came to your inbox, use `inbox-[agent-name]` for the agent who asked.
- Post where the work is happening. Don't cross-post to `general` or `control`.
- In `body`, lead with the result (Approve or Reject for a review), then the branch and latest commit, the evidence, and anything someone has to decide. Keep it short.

Before posting, verify the group and recipient with `get_project_info` and `list_members`; do not assume a connection means membership. Use the board for a durable shared result, and a one-off message for a short exchange. React to the named channel in a notice; do not poll every board for acknowledgment. A notice does not wake a sleeping member or prove the result was read. If the host is offline and the post is queued, report it as pending; do not post duplicates or claim it was delivered until the host accepts it.
