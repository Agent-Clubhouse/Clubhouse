# Git Integration

Clubhouse provides built-in Git awareness — branch tracking, file status, and worktree isolation for agents.

## Git Detection

When you add a project, Clubhouse checks for a `.git` directory:
- **Found** — Full Git features enabled automatically
- **Not found** — A yellow banner appears with a one-click **git init** button. Dismiss if you prefer to work without Git.

## What Clubhouse Tracks

| Feature | Description |
|---------|-------------|
| **Branch** | Current branch displayed in the UI; auto-updates on external changes |
| **File status** | Staged, unstaged, and untracked files |
| **Ahead/Behind** | Commit count relative to upstream remote |
| **Stash count** | Visual indicator of stashed entries |
| **Conflicts** | Merge conflict detection in working directory and agent worktrees |

## Git Operations

Available through the project's Git UI:

Checkout, Stage/Unstage, Commit, Push, Pull, Diff, Stash/Pop, Create Branch

These execute standard Git commands — fully compatible with other Git tools.

## Worktrees

Worktrees are central to how Clubhouse isolates agent work. Each durable agent gets its own Git worktree on a dedicated branch.

**How it works:**
1. You assign a branch when creating a durable agent
2. Clubhouse creates a worktree in the project's `.clubhouse/agents/` directory
3. All agent file operations are scoped to its worktree
4. Your main checkout stays untouched

**Benefits:**
- No conflicts between your work and agent work
- Multiple agents can work on different branches simultaneously
- Clean diffs make pull requests straightforward

**Merging agent work:** Use standard Git operations — merge, PR, or cherry-pick. Clubhouse doesn't merge automatically; you retain full control.

**Lifecycle:** Worktrees persist as long as the agent exists. Deleting an agent prompts cleanup options for the worktree and branch.
