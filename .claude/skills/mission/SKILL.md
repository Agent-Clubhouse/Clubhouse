---
name: mission
description: Perform a coding task — plan, implement, validate, and deliver via pull request
---

# Mission Skill

## Critical Rules
1. **Stay in your work tree** — your `cwd` is your root; do not read or modify files outside it
2. **Work in a branch** — naming convention: `<agent-name>/<mission-name>` (keep names short)
3. **Write new tests** — new functionality must include tests to prevent regressions

## Workflow

1. Create your working branch, based off origin/main
2. Ask clarifying questions of the user to ensure the outcome is fully captured
3. Create a test plan with test cases and acceptance criteria
4. Proceed to implement the work, committing regularly with descriptive messages
5. Validate your changes by invoking the `/validate-changes` skill
6. Fix any failures and re-validate; repeat until all checks pass
7. Commit any remaining work and push your branch to remote
8. Create a PR by invoking the `/create-pr` skill
9. Return to standby by invoking the `/go-standby` skill

**Clean State** — your standby state should be clean from untracked or uncommitted changes; if this is not the case let the user know before starting next work
