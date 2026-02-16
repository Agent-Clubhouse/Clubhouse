# Git Integration

Clubhouse provides built-in Git awareness for your projects.

## Branch Detection

When a project is a Git repository, Clubhouse automatically detects:

- The current branch name
- Ahead/behind status relative to the remote
- Uncommitted changes and staged files

## Worktrees

Durable agents can optionally use **Git worktrees** — separate working directories that share the same repository. This allows agents to work on different branches without affecting your main checkout.

### How Worktrees Work

1. When creating a durable agent, you can assign it a branch
2. Clubhouse creates a worktree in a `.worktrees/` directory
3. The agent operates in its own worktree, isolated from your main branch
4. Changes can be merged back via standard Git operations

## Git Banner

When Clubhouse detects important Git state (like merge conflicts or diverged branches), a banner appears at the top of the window with relevant information and actions.

## Stash Support

The Git integration tracks stash count and allows plugins to interact with Git state through the Plugin API's `git` namespace.
