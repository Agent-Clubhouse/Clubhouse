---
name: build
description: Runs the project's build the way the project does and reports the result. Use when a task or check needs a build.
---

# Build

1. Find the build command in the project's scripts, CI workflow or README. If they disagree, use what CI runs.
2. If dependencies are missing, install them the way the project does.
3. Run it. Report the exact command and whether it passed, and on failure the first error with its file and line.

If there's no build step, or you can't find one, say so.