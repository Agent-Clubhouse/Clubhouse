# Independent QA: #3733 local successor (lint, O1, O2)

Reviewer: qa-details-local-composition. November 20, 2026.
Review target: `5e3e21cfe90038332ee8782e9d3a8451ec2a2f10` (notes and evidence only on top of the tested source `8cd17005cb30e382b0e5cb61c942aee780a37434`), branch `details-local-composition/3733-inherited-lint-fixes`.
Method: read source and committed artifacts only. I ran no tests, lint or typecheck, made no edits and did no live checks.

## Verdict

**APPROVE the source changes:** the lint fixes `6fad09027`, O1 `42331c3b5` and O2 `8cd17005c`, with O2 confirmed rather than dropped.

**The tree is NOT green.** F1 (2 failing cases in `remote-connection-endpoint-fields.test.ts`) remains at `8cd17005c`. The F1 test-only fix `7daca0e3e` was reviewed separately: its arithmetic and source agree, but it was **not pushed** when reviewed. Full `npm test`, hosted Validate and the live matrix have not been run. This is not full-parity acceptance.

## Binding and evidence

- Ancestry: `a4edf7adf` and main `69ef383ce` are ancestors. `8cd17005c..5e3e21cfe` adds only the notes file and `evidence/3733-local-successor/*`.
- All 11 committed copies match their `SHA256SUMS` entries. The 11 raw entries name host-local files and cannot be checked here. `validated-head.txt` = `8cd17005c…`.
- `lint.txt`: `eslint exit=0`, 0 errors, 784 warnings (319-file scope).
- `tsc.txt`: `tsc exit=0`.
- `focused.txt`: 130 files, 5472 passed, 1 skipped, **2 failed**, `vitest exit=1`. Both failures are the F1 cases (`bounded-page` received 142, expected 112; `bounded-identity-page` received 21, expected 20).

## Lint fixes (`6fad09027`)

- `src/shared/ascii-control.ts` loops over UTF-16 code units.
  - `hasAsciiControl` is `c < 0x20 || c === 0x7f`. `hasC0Control` is `c < 0x20`. Both match the original non-`u` classes.
  - `replaceAsciiControl` builds the output per code unit, so surrogate pairs pass through unchanged and the default replacement is `' '`. That equals the original global replace.
  - An exhaustive 0 to 0xFFFF test compares against runtime-built copies of the original classes.
- All 20 call sites are mechanical one-for-one substitutions.
  - In `remote-session-history`, `/[\\/\x00-\x1f]/` becomes `/[\\/]/ || hasC0Control`, which is equivalent and still lets DEL through as before.
  - `managed-agents/service` used `\u0000-\u001f\u007f`, the same set.
- The unused-variable removals are dead imports and helpers only (`display`, `updateDurableConfig`, `flushAgentConfig`, `peekCachedDurableConfig`, `RemoteAgentChanges` type, unused `read`/`assertNoReadEffects`). ESLint flagged each as unused, so no assertion was removed.
- `read-only-diff`: the comma expression becomes a block, with the same order of side effects.
- I found no behaviour change.

## O1 (`42331c3b5`)

- `requestAgentDetails` captures `receipt` next to `epoch` before the await. `invalidateSnapshotAdmission(sat, admitted)` revokes only while `sat.snapshotReceipt === admitted`. The role path passes its captured receipt, and its `current()` already refused a changed receipt, so it is unchanged.
- Tests cover both directions for full Details and Canvas page reads: a late old-receipt 403 keeps the newer receipt and does not broadcast, and a current-receipt 401 revokes it and broadcasts once.
- **Residual (acceptable, noted):** a denial whose request began before a newer snapshot no longer revokes the newer receipt. Admission survives until the next read under that receipt. Both consumers re-read on a receipt change: the central view through its admission key (`426e08593`), and the role pane through its context key. So the window is one host round trip, and the next denial revokes the correct receipt.
- A request that began with no receipt can never revoke a later one. That is intended.

## O2 (`8cd17005c`): recommend keeping it

- The snapshot-only path needs all of: `eligible` (connected, paired, snapshot available, not paused, valid generation), a role read resolved to `unavailable` under the current context key, and a positive `snapshotReceipt`.
- It exposes only snapshot `dispatcher.enabled` and `dispatcherPresence.remotes`, labelled "host snapshot". Role Settings, Connections and Actions stay withheld. `forbidden`, `offline`, `error`, `rate_limited` and `loading` still withhold everything.
- **Host-side check:**
  - `handleSelectedDispatcherDetailsRoute` (annex-server.ts) checks mTLS and `desktopDetailsAuthorized` first and returns 403 otherwise.
  - 404 (`dispatcher_role_unavailable`) and 409 (`dispatcher_role_changed`) come only after authorization, from `readSelectedDispatcherDetails`.
  - So on a current host, `unavailable` never stands in for a denial. On an older host without the route, the 404 is the router's.
  - In that case the pane goes back to the base `c5d6c20` behaviour, where receipt-attested snapshot fields were shown with no Details read.
- **Observation (parity, not blocking):** the central real-chat Dispatcher view (`RemoteAgentDetailsView`) still requires a successful Details read (`result.status === 'ok'`) before showing Other machines. An older host that lacks Details therefore shows Other machines on the no-chat pane but not on the chat pane. Decide whether the two should match. Neither surface leaks anything beyond the attested snapshot.
- The test narrowing (removing `unavailable` from the no-fallback list) is matched by the positive fallback test and the forbidden-with-receipt test. The receipt-removal and pause steps are covered.

## F1

- Bisect evidence: first bad commit `9f2354d0d`, an ancestor of both `a4edf7adf` and `b458b4c89`. The test file and `selected-outgoing-wires-display` are not on main.
- F1 is therefore #3733-stack drift that was already present at `a4edf7adf`, outside the earlier 26-file focused set. It is not a successor regression and not a main failure. It still blocks green.
- Test-only fix `7daca0e3e`, separately checked:
  - Per-pair `fields` (remote-connection-card.ts:262) went from manual 2 to 3. Per-row omission past the cap is counted in `row()`, and whole pairs in `fields`.
  - Bounded page: 30 manual pairs with memory fields give 3 + 3 + 2 = 8 each, so 2 + 240 - 100 = 142.
  - Identity page: the manual pair is entirely past the cap, adding 21 rather than 20.
  - Both values equal those received at `5e3e21cfe`.
  - Not pushed at review time, and no execution of my own.

## Parity checklist

The notes' 18-item checklist is a reasonable finite list. I did not verify its "Delivered" entries beyond the slices reviewed here.

The open items are:
- 2: configured effort
- 6: structured Dispatcher card
- 7: asleep subagents
- 12: sleeping, unbound and resumed history
- 13: omitted-board navigation
- 14: role pagination
- 16: waking state
- 17: live same-version and mixed-version matrix
- 18: full `npm test` and hosted CI
- F1 landing
- the O2 and chat-pane consistency decision

## Limits

The renderer was proven with jsdom and mocks, and main with fake sockets and a fake HTTP responder. All run results are the owner's committed logs. No live host was used.
