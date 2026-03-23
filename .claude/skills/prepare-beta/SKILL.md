---
name: prepare-beta
description: Prepare a beta prerelease by analyzing commits since the last tag, classifying changes, proposing version + release notes, and opening a version bump PR for the preview channel
---

# Prepare Beta Skill

Automates the beta prerelease preparation workflow. A beta publishes to the preview update channel so testers can validate before a stable release. The pipeline is tag-driven: a `-beta.N` tag (e.g., `v0.34.0-beta.1`) triggers a preview build.

Beta versions use proper semver prerelease format (`0.34.0-beta.1`) and support multiple iterations (`beta.1` → `beta.2` → … → stable) without consuming version numbers.

## Prerequisites

- You must be on a clean working tree (no uncommitted changes)
- `gh` CLI must be authenticated
- The repository must have at least one existing `v*` tag

## Phase 1: Gather Data

1. **Switch to main and pull latest:**
   ```bash
   git checkout main && git pull origin main
   ```

2. **Read current version** from `package.json` (the `"version"` field).

3. **Find the last tagged release** (stable, beta, or legacy RC):
   ```bash
   git tag --list 'v*' --sort=-v:refname | head -5
   ```
   Identify the most recent tag. This is the baseline. All commits between this tag and `HEAD` are candidates.

4. **Check for existing beta tags on the same base version.** If the last tag is a beta (e.g., `v0.34.0-beta.1`), subsequent betas should increment the beta number (e.g., `v0.34.0-beta.2`) rather than bump the base version — unless new features or fixes have landed since the last beta.

5. **Collect commits since the last tag:**
   ```bash
   git log <last-tag>..HEAD --oneline --no-merges
   ```
   Also collect the full messages for classification:
   ```bash
   git log <last-tag>..HEAD --format='%H %s' --no-merges
   ```

## Phase 2: Classify Commits

For each commit, assign exactly one category using the rules below. Apply them in order — first match wins.

### Classification Rules

| Priority | Signal | Category |
|----------|--------|----------|
| 1 | Prefix `feat:` or `feat(...):`; or commit clearly introduces new user-visible functionality | **Feature** |
| 2 | Prefix `fix:` or `fix(...):`; or commit fixes a bug visible to end users | **Bug Fix** |
| 3 | Prefix `perf:` or `perf(...):`; or commit improves performance, forward-looking API changes, or internal optimizations that *could* affect UX but are invisible | **Internal** |
| 4 | Prefix `chore:`, `ci:`, `test:`, `docs:`, `build:`, `refactor:`; or commit is infrastructure, test coverage, devops, tooling | **Non-User** |
| 5 | Ambiguous commits — read the full message and diff summary to decide. When in doubt, classify as **Internal**. | — |

### Special handling
- **Version bump commits** (e.g., `chore: bump version to X.Y.Z` or `chore: bump version to X.Y.Z-beta.N`) — skip entirely, these are release mechanics.
- **Merge commits** are already excluded by `--no-merges`.

## Phase 3: Coalesce

Reduce the classified list by merging related entries:

1. **Feature absorbs its fixes:** If a feature was added and subsequent commits fix bugs *in that same feature*, collapse them into the single feature row. The feature description should reflect the final working state.
2. **Multiple fixes in one area → one row:** If several bug fixes target the same component or behavior, combine into a single descriptive bug fix row.
3. **Keep distinct items separate:** Don't over-merge. Two unrelated bug fixes stay as two rows.

After coalescing, you should have a clean list with categories: **Feature**, **Bug Fix**, **Internal**. **Non-User** items are dropped entirely.

## Phase 4: Propose Beta Release

Present the following to the user:

### Recommended Version

Determine the base version first, then apply the beta suffix:

- If the classified list contains at least one **Feature** → **minor** version bump (e.g., `0.33.0` → `0.34.0-beta.1`)
- If no features, only bug fixes and/or internals → **patch** version bump (e.g., `0.33.0` → `0.33.1-beta.1`)
- **Never** propose a major version bump

**Beta increment rules:**
- If no existing beta tags for this base version → `<base>-beta.1`
- If there are existing beta tags (e.g., `v0.34.0-beta.1` already exists) and the last tag is a beta for the same base → increment: `<base>-beta.2`
- If the last tag was a beta but new commits warrant a different base version (e.g., new features requiring a minor bump beyond the beta's base) → start fresh at `<new-base>-beta.1`

The beta tag will be `v<version>` (e.g., `v0.34.0-beta.1`).

### Release Title

A brief phrase (not a full sentence, no period) capturing the marquee theme. Guidelines:
- If there is a standout feature, name it: `"New KanBoss Plugin"`
- If multiple features, generalize: `"Plugin System & Agent Improvements"`
- If only fixes/internals: `"Bug Fixes & Performance Improvements"`

### Release Notes Table

Present a markdown table:

```
| Type | Description |
|------|-------------|
| Feature | ... |
| Bug Fix | ... |
| Internal | ... |
```

- **Non-User** items are excluded from this table.
- **Internal** items are included in the table but excluded from the release title.
- If a category is empty, omit its rows entirely.
- Descriptions should be user-friendly, concise, and written in past tense.

### Raw Commit List

Below the table, show the full raw commit list (one-liners) with their classifications for transparency.

### Ask for Feedback

Use `AskUserQuestion` or direct prompting to ask the user:
- Is the version correct?
- Is the release title good?
- Any edits to the release notes table?
- Ready to proceed?

Iterate until the user confirms. Do not proceed to Phase 5 until explicit confirmation.

## Phase 5: Create Version Bump PR

Once the user confirms:

1. **Create branch:**
   ```bash
   git checkout -b release/<full-version> main
   ```
   Where `<full-version>` includes the beta suffix (e.g., `release/0.34.0-beta.1`).

2. **Update version in `package.json`:**
   Change the `"version"` field to the full version **including the `-beta.N` suffix** (e.g., `0.34.0-beta.1`). This is critical — unlike legacy RC tags, beta versions are stored in `package.json` and the release pipeline verifies the tag matches.

3. **Commit:**
   ```bash
   git add package.json
   git commit -m "chore: bump version to <full-version>"
   ```

4. **Push:**
   ```bash
   git push -u origin release/<full-version>
   ```

5. **Open PR** using `gh pr create`. The PR format is critical — the release pipeline extracts release notes from the PR body.

   - **Title:** `chore: bump version to <full-version> (Preview)`
   - **Body:** Markdown with the following structure. The first line **must** be the `Release:` title — the release pipeline parses this to populate the update banner. Skip any section that has no items.

   ```markdown
   Release: <Release Title>

   # New Features
   - Description A from the confirmed table
   - Description B from the confirmed table

   # Bug Fixes
   - Description C from the confirmed table

   # Improvements
   - Description D from the confirmed table
   ```

   Section mapping:
   - **Feature** rows → `# New Features`
   - **Bug Fix** rows → `# Bug Fixes`
   - **Internal** rows → `# Improvements`

   Use a HEREDOC to pass the body:
   ```bash
   gh pr create --title "chore: bump version to <full-version> (Preview)" --body "$(cat <<'EOF'
   Release: <Release Title>

   ...body content...
   EOF
   )"
   ```

## Phase 6: Provide Tag Commands

After the PR is created, provide two command blocks:

### Beta Tag (run after PR merge)

```bash
git checkout main && git pull origin main && git tag -s v<full-version> -m "<Release Title> (Beta)" && git push origin v<full-version>
```

This triggers the preview release pipeline: builds are published to the preview channel (`preview.json`) and the GitHub release is marked as a prerelease.

### Stable Promotion (run after beta validation)

Once the beta has been tested and validated, the same base version can be promoted to stable. This requires a separate version bump PR (use the `prepare-release` skill) to set `package.json` to the clean version (e.g., `0.34.0`) before tagging:

```bash
git checkout main && git pull origin main && git tag -s v<base-version> -m "<Release Title>" && git push origin v<base-version>
```

This triggers the stable release pipeline: builds are published to the stable channel (`latest.json`), `history.json` is updated, and the GitHub release is created as a full release.

**Multiple betas:** If additional testing reveals issues, create another beta (`beta.2`, `beta.3`, etc.) by running this skill again. Each beta increments the beta number while keeping the same base version.

Then return to your standby branch:
```bash
git checkout <agent-name>/standby
```

## Critical Rules

1. **Never tag or push tags yourself** — only the user does this after PR merge.
2. **Never propose a major version bump.**
3. **Non-User changes never appear in the release title, release notes table, or PR body.**
4. **Internal changes appear in the table and PR body (as "Improvements") but not in the release title.**
5. **The PR body format is load-bearing** — the release pipeline parses `Release: <title>` from the first line and the section content as release notes. Do not add extra markdown, emoji, test plans, or co-authored-by lines to the PR body.
6. **Version bump commits from previous releases must be skipped** during classification.
7. **Iterate with the user** — do not open the PR until the user explicitly confirms the version, title, and notes.
8. **The full version including `-beta.N` is stored in `package.json`** — the release pipeline verifies the tag version matches `package.json` for beta tags (unlike legacy RC tags which skipped this check).
9. **Beta tags trigger the preview pipeline** — the release workflow detects `*-beta.*` patterns as preview releases.
