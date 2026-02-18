# Git Integration

Clubhouse provides deep, built-in Git awareness for your projects. It automatically detects repository status, tracks file changes, and surfaces relevant information throughout the interface — so you always know the state of your code without leaving the app.

## Git Detection

When you add a project, Clubhouse checks whether the folder is a Git repository. This detection happens automatically and requires no configuration.

- If the folder is a Git repository (contains a `.git` directory), Clubhouse enables full Git integration features: branch display, file status tracking, stash indicators, and more.
- If the folder is **not** a Git repository, Clubhouse displays a **yellow warning banner** at the top of the project view. This banner includes a one-click **"git init"** button that initializes a new Git repository in the project folder. You can dismiss the banner if you prefer to work without Git, but certain features (such as worktrees for durable agents) will not be available.

## Branch Detection

Clubhouse continuously monitors the current branch of your project and displays the branch name in the UI. When you switch branches outside of Clubhouse (for example, using the terminal or another Git client), Clubhouse detects the change and updates the display automatically.

The branch name is visible in the project header area, giving you an at-a-glance view of which branch you are working on at all times.

## File Status Tracking

Clubhouse tracks the status of files in your working directory, mirroring the information you would see from `git status`. Files are categorized as:

- **Staged** — Files that have been added to the Git index and are ready to be committed.
- **Unstaged** — Files that have been modified but not yet staged.
- **Untracked** — New files that Git is not yet tracking.

These statuses are reflected in the Clubhouse interface, allowing you to see at a glance what has changed in your project — whether those changes were made by you, by an agent, or by an external tool.

## Ahead/Behind Tracking

When your local branch has an upstream remote configured, Clubhouse tracks how many commits you are **ahead** of or **behind** the remote branch.

- **Ahead** indicates local commits that have not been pushed.
- **Behind** indicates remote commits that have not been pulled.

This information helps you stay aware of sync status without needing to run `git fetch` or `git log` manually. Clubhouse fetches remote status periodically in the background.

## Stash Count

If you have entries in your Git stash, Clubhouse displays a **stash indicator** showing the number of stashed entries. This is a quick visual reminder that you have saved work that has not been applied.

## Conflict Detection

Clubhouse detects **merge conflicts** in your working directory. When conflicts are present — for example, after a merge, rebase, or cherry-pick — Clubhouse highlights the conflicted state so you can resolve it before continuing.

Conflict detection applies to both your main working directory and to agent worktrees. If an agent's worktree encounters a conflict during a Git operation, the conflict will be surfaced in the Clubhouse interface.

## Git Operations

Clubhouse provides access to common Git operations directly from the interface. Available operations include:

| Operation | Description |
|-----------|-------------|
| **Checkout** | Switch to a different branch or create a new branch |
| **Stage / Unstage** | Add or remove files from the Git index |
| **Commit** | Create a new commit with a message |
| **Push** | Push local commits to the upstream remote |
| **Pull** | Fetch and merge changes from the upstream remote |
| **Diff** | View a diff of changes in the working directory |
| **Stash / Pop** | Save or restore uncommitted changes |
| **Create Branch** | Create a new branch from the current HEAD |

These operations are available through the Git section of the project view. They execute standard Git commands under the hood, so the results are fully compatible with any other Git tooling you use.

## Worktrees

**Git worktrees** are a core feature of Clubhouse's agent isolation model. A worktree is a separate working directory that shares the same underlying Git repository. Clubhouse uses worktrees to give durable agents their own isolated environment, so multiple agents can work on different branches simultaneously without interfering with each other or with your main checkout.

### How Worktrees Work

When you create a durable agent and assign it a branch, Clubhouse sets up a worktree for that agent:

1. Clubhouse creates a `.worktrees/` directory inside the project root (if it does not already exist).
2. A new worktree is created within `.worktrees/`, named after the agent.
3. The worktree is checked out to the agent's assigned branch.
4. All of the agent's file operations — reads, writes, terminal commands — are scoped to its worktree directory rather than your main project directory.

This means your main checkout remains untouched while agents work. You can continue editing files, switching branches, and committing in your main working directory without any interference.

### Branch Isolation

Each agent worktree operates on its own branch. This provides several benefits:

- **No conflicts with your work** — An agent modifying files on its branch does not affect the files you see in your main checkout.
- **Parallel development** — Multiple agents can work on different features or bug fixes at the same time, each on its own branch.
- **Safe experimentation** — If an agent's changes are not useful, you can simply delete the branch without affecting anything else.

### Merging Changes Back

Agent worktree changes are merged back into your codebase using standard Git operations. Common approaches include:

- **Merge** — Merge the agent's branch into your main branch using `git merge`.
- **Pull request** — Push the agent's branch to a remote and open a pull request for code review.
- **Cherry-pick** — Select specific commits from the agent's branch to apply to your own.

Clubhouse does not perform merges automatically. You retain full control over when and how agent changes are integrated into your codebase.

### Worktree Lifecycle

Worktrees persist as long as the durable agent exists. If you delete a durable agent, Clubhouse cleans up the associated worktree and branch (with a confirmation prompt). You can also manually manage worktrees using standard `git worktree` commands if needed.
