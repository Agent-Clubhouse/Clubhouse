# Issue 578 Test Plan

## Goal
Ensure IPC handlers validate user-controlled and path-like arguments before delegating to main-process services.

## Acceptance Criteria
- IPC handlers use a shared validation wrapper instead of ad hoc inline checks.
- Invalid argument types are rejected before any service call executes.
- Existing valid payloads continue to delegate unchanged.
- Regression tests cover representative handler families with path-like inputs.

## Test Cases
1. `file-handlers`
   - Accept valid file paths and delegate to file services.
   - Reject non-string file path arguments for read/write/search style handlers.
2. `git-handlers`
   - Accept valid repository and file paths.
   - Reject invalid path arguments before invoking git services.
3. `project-handlers`
   - Accept valid project paths and identifiers.
   - Reject invalid project path arguments for add/check/reset flows.
4. `plugin-handlers`
   - Accept valid plugin/project path inputs.
   - Reject invalid mkdir/gitignore/orphaned-project arguments before service calls.
5. `pty-handlers`
   - Accept valid shell spawn parameters.
   - Reject invalid `projectPath` payloads before PTY creation.
