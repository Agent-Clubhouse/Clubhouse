---
name: validate
description: Checks that a change is ready by running the build, test and lint skills in order and reporting each result. Use before pushing, opening or updating a pull request, or calling a task done.
---

# Validate

Check that a change is ready by running these skills in order.

1. `build`
2. `test`
3. `lint`

Run all three even if one fails, so the report covers everything. If one of these skills isn't available, report that step as not run. Don't substitute a command of your own.

Report each step with the exact command it ran and its result, then say plainly whether the change is ready.