---
name: test
description: Finds how the project runs its tests from its scripts, task runner, CI workflow or docs, runs them, and reports the exact command, counts and failures. Use after changing behavior, when a task or reviewer asks for tests, or to check whether a change broke anything.
---

# Test

Run the tests the way this project runs them. Never guess a command.

1. Find the command. Look at the project's scripts or task runner, then its CI workflow, then its README or CONTRIBUTING. If they disagree, use what CI runs and mention the difference.
2. If the change is small, run the tests closest to it first, then the full suite.
3. Report the exact command and the result, with passed, failed and skipped counts. For each failure, name the test and give its first error.

- A test that fails and then passes on a rerun is flaky. Report it as flaky, not as passing.
- If tests need a service, secret or setup step you don't have, say what's missing. Don't skip them silently.
- If you can't find how the project runs its tests, say so and list where you looked.