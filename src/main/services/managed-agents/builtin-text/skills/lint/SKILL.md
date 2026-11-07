---
name: lint
description: Finds the project's own lint, type-check and format-check commands from its scripts, task runner, CI workflow or docs, runs them, and reports the exact commands and results. Use when a task or reviewer asks for lint or type checks, or before handing off a change.
---

# Lint

Run the project's lint and type checks the way the project runs them. Never guess a command.

1. Find the commands. Look at the project's scripts or task runner, then its CI workflow, then its README or CONTRIBUTING. Include type checks and format checks if CI runs them. If the sources disagree, use what CI runs and mention the difference.
2. Run each command.
3. Report each exact command and whether it passed. If not, give the first errors and their files.

Don't apply automatic fixes unless the task asks. If you do, list the files that changed.

If you can't find how the project lints, say so and list where you looked.