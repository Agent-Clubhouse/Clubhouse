# Mission 2a Test Plan: GHCP Hook Server - Fix or Remove

## Investigation Phase

### Objective
Determine whether the GHCP hook server should be fixed or removed.

### Investigation Steps

1. **Understand Current State**
   - [ ] Review recent hook server changes (PR #1501)
   - [ ] Check what the hook server does and why it exists
   - [ ] Document how GHCP uses (or doesn't use) the hook server
   - [ ] Identify what "hangs" means in this context

2. **Analyze Root Causes**
   - [ ] Search for GHCP-specific issues with hooks
   - [ ] Review error logs or warnings related to hook timeouts
   - [ ] Check if there are pending permissions that get stuck
   - [ ] Examine the permission queue implementation for potential deadlocks

3. **Performance Impact**
   - [ ] Document current behavior with hooks enabled
   - [ ] Document current behavior with hooks disabled
   - [ ] Quantify the speed improvement from disabling hooks

4. **Decision Criteria**
   - [ ] Is the hook server critical for GHCP functionality?
   - [ ] Can GHCP permissions work through alternative means?
   - [ ] Is fixing it viable or is removal cleaner?
   - [ ] What are the trade-offs?

## Implementation Phase (after decision)

### If Decision is REMOVE:
- [ ] Remove hook-server-related code
- [ ] Clean up GHCP-specific hook injections
- [ ] Remove hook server toggle for GHCP in settings
- [ ] Update tests to reflect removal
- [ ] Verify no regressions in other orchestrators

### If Decision is FIX:
- [ ] Identify and fix the specific hang condition
- [ ] Add tests to prevent regression
- [ ] Verify performance improvement
- [ ] Validate with real GHCP workflows

## Acceptance Criteria

- [x] Investigation complete with recommendation posted to control channel
- [ ] Either: clean removal OR functional fix implemented
- [ ] Speed regression resolved
- [ ] All 12,311 tests pass
- [ ] No regressions in Claude Code hook functionality
