---
name: create-pr
description: Create a pull request for the current branch using the project's configured source control provider
---

# Create Pull Request

Create a pull request for the current branch targeting main. Include a rich description covering the changes, test cases, and any manual validation needed.

## Creating a Pull Request (GitHub)

Use the GitHub CLI to create a PR:

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points summarizing the change>

## Changes
<detailed list of changes>

## Test Plan
- [ ] <test cases and acceptance criteria>

## Manual Validation
<any manual steps needed to verify>
EOF
)"
```
