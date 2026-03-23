---
name: validate-changes
description: Run full validation — build, test, and lint — to verify changes before pushing
---

# Validate Changes

Run the full validation pipeline to ensure your changes are ready to push.

## Steps

1. **Build** the project:
   ```bash
   npm run build
   ```
2. **Run tests**:
   ```bash
   npm test
   ```
3. **Run linter**:
   ```bash
   npm run lint
   ```

If any step fails, fix the issues and re-run the full pipeline. Do not proceed until all steps pass.
