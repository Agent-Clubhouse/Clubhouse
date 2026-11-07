---
name: lint
description: Runs the project's lint and type checks the way the project does and reports the result. Use before handing off a change or when a task asks for lint.
---

# Lint

1. Find the lint, type-check and format-check commands in the project's scripts, CI workflow or README. If they disagree, use what CI runs.
2. Run each one. Report the exact command and whether it passed, and on failure the first errors.

Don't apply automatic fixes unless the task asks. If you can't find how the project lints, say so.