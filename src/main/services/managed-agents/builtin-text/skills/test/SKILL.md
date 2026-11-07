---
name: test
description: Runs the project's tests the way the project does and reports the result. Use after changing behavior or when a task asks for tests.
---

# Test

1. Find the test command in the project's scripts, CI workflow or README. If they disagree, use what CI runs.
2. For a small change, run the nearest tests first, then the full suite.
3. Report the exact command, the passed, failed and skipped counts, and each failing test with its first error.

A test that passes only on a retry is flaky, not passing. If tests need something you don't have, say what. If you can't find how to run them, say so.