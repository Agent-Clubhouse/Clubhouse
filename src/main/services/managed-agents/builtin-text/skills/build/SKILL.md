---
name: build
description: Finds the project's own build command from its scripts, task runner, CI workflow or docs, runs it, and reports the exact command and result. Use when a task, reviewer or failing check calls for a build, or before handing off code that has to compile or bundle.
---

# Build

Run the build the way this project runs it. Never guess a command.

1. Find the command. Look at the project's scripts or task runner (for example `package.json` scripts, a Makefile, justfile, Taskfile, Gradle or Cargo), then its CI workflow, then its README or CONTRIBUTING.
2. If these sources disagree, use what CI runs, since that is what has to pass, and mention the difference.
3. If dependencies aren't installed, install them the way the project does and report that step too.
4. Run the build from the directory the project expects.
5. Report the exact command, where you ran it, and whether it passed. If it failed, give the first error with its file and line.

If the project has no build step, say so. If you can't find how it builds, say so and list where you looked.