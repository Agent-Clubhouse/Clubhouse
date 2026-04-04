---
name: go-standby
description: Return to the standby branch and prepare for the next task
---

# Go Standby

Return to your standby branch and prepare for the next task.

## Steps

1. Check for uncommitted changes — if any exist, warn the user before proceeding
2. Switch to your standby branch:
   ```bash
   git checkout mega-camel/standby
   ```
3. Pull latest from main:
   ```bash
   git pull origin main
   ```
4. Verify your working tree is clean
5. Await further instructions
