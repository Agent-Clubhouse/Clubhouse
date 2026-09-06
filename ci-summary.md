# CI summary

This document is the source of truth for classifying CI failures into buckets that tell us whether the problem is a product regression, a runner/tooling issue, or a dependency-management conflict.

## Bucket definitions

### 1. genuine product regression
Definition: a code change or behavior change in the app itself causes CI to fail.
Owner: feature or area owner for the codepath under test.
Response: investigate the failing assertion, fix the regression at its source, and rerun the relevant checks.

### 2. runner/environment noise
Definition: the failure is caused by the execution environment rather than by project code or dependency metadata.
Owner: CI infrastructure or workflow maintainer.
Response: diagnose the runner, cache, networking, or platform issue and, if needed, retry or stabilize the environment.

### 3. dependency-conflict
Definition: a CI failure is caused by a dependency metadata conflict, typically a Dependabot bump or peer-version mismatch that blocks install or build before product code is exercised.
Owner: whoever maintains `.github/dependabot.yml`.
Response: add or review the relevant ignore entry promptly so the dependency conflict is explicitly acknowledged and the group update can be corrected without leaving the weekly dependency channel red.

The `dependency-conflict` bucket is distinct from both `genuine product regression` and `runner/environment noise`. It represents a maintenance issue in the dependency graph rather than a user-facing product defect or a transient infra failure.

## Historical classification of the `@electron/fuses` runs

The following weekly Dependabot jobs were all caused by the same peer-conflict between `@electron-forge/plugin-fuses` and `@electron/fuses` and should be classified as `dependency-conflict` rather than `runner/environment noise`:

- Run 31358599635 (2026-08-10): `@electron/fuses` peer conflict during `npm ci`.
- Run 32010436497 (2026-08-17): same `@electron/fuses` peer conflict during `npm ci`.
- Run 32706133658 (2026-08-24): same `@electron/fuses` peer conflict during `npm ci`.

Owner for each record: whoever maintains `.github/dependabot.yml`.
Response for each record: add or review the ignore entry promptly to prevent repeated weekly failure.

## Working rule for future triage

When a Dependabot or lockfile update fails before product tests run, classify it as `dependency-conflict` and route it to the maintainer of `.github/dependabot.yml`.

The expected resolution is not to dismiss the failure as infrastructure noise. The expected resolution is to confirm the peer conflict, decide whether the dependency is intentionally blocked, and add or review the ignore guard promptly so the workflow stops failing on the same metadata issue every cycle.
