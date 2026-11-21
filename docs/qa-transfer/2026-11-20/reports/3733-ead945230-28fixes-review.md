# Independent QA: #3733 inherited 28-failure fixes and #12 reconciliation

Reviewer: qa-details-local-composition. November 20, 2026.
Review target: `ead9452306ee273e6ace6b96f12517a0c397e870` (`origin/details-local-composition/3733-f1-parity`, fetched fresh). It adds docs only on top of the source `d702a27053e0d5fe874a2ead62b810196db6e9c3`, whose chain is `2fa5dd57e`, `36a06057a`, `25d38c962`, `d702a2705` on `782e08cde`.
Method: I read source and committed artifacts only and ran nothing.

## Verdict

**APPROVE** the four fixes. The full suite for `d702a2705` is green on the owner's sealed evidence. That is local Vitest only; hosted CI and the live matrix have not been run. No unrestricted full parity is implied.

The following stay on record:
- the earlier 28-failure classification (`evidence/3733-full-suite-11fc/`);
- the intermittent parallel group-simulation failure, which is unclassified and whose failing log was not kept;
- the absent restore status for the waking mutation.

## Source

- **`2fa5dd57e` (test only):** the pty-manager mocks gain `isRunning: () => false`, and four spawn-argument assertions add `observeStarted` (`expect.any(Function)`). This matches the stack's production hooks. No product change.
- **`36a06057a`:**
  - `routeTemplate` unwraps single-literal groups only (`/\(([a-z-]+)\)/`). It runs after the id, op and query replacements, and its class excludes `|`, `?` and `:`.
  - Three route values without ids are allowlisted.
  - The two-way template and allowlist test guards against drift.
- **`25d38c962` (real defect):** the memory-only session uses a fixed `ephemeral:memory` origin and never calls `getIdentityPath()`. The origin only lives in memory and is compared together with the generation Symbol and the loaded fingerprint (`identityDisplayReceipt`), so no cross-session match is possible. Disk mode is unchanged.
- **`d702a2705` (test contract):** a remote agent's SettingsCard never takes Access from local chat state. `RemoteSettingsCard.test.tsx:39` still checks that Access comes from the host read.

## Evidence (`evidence/3733-inherited-28-fixes/`)

- **Seals:** all 15 committed copies match `SHA256SUMS`. The raw entries are host-local.
- **Head and tree state:** `validated-head.txt` = `d702a2705…`. `pre-status.txt` and `post-status.txt` are empty.
- **Results on `d702a2705`:**

| Check | Result |
| --- | --- |
| `full.txt` | Files 1463 passed, 13 skipped (1476). Tests **35527 passed, 114 skipped (35641)**. `vitest exit=0`. |
| `lint.txt` | `eslint exit=0` |
| `tsc.txt` | `tsc exit=0` |

- **Mutation logs:** each records the change, `exit=1`, a byte-identical restore and an empty post-restore status.

| Mutation | Result |
| --- | --- |
| allowlist | 1 failed of 15 |
| route template | 1 failed of 15 |
| identity | 1 failed of 2 |
| chat leak | 1 failed of 36 |

- **c229/c555 logs:**

| Log | Result |
| --- | --- |
| `c229-c555-view-pass` | 79 passed, exit 0 |
| `central-align-mutation` | 1 failed, exit 1 |
| `waking-mutation` | 1 failed, exit 1. Restore status is absent, as declared. The committed tree at `c2297c45b` changes only tests. |

- The headless fix baseline relies on the earlier `11fc` package, where the 28 tests had identical names on `b458`, `26ca`, `cb1c` and `11fc` and passed on main.

## #12 reconciliation

- **Local Last session fields** (`AgentDetails.tsx:426-439`): Runs on, Ended, Why, Usage, Duration, Cost, Folder, Branch and the "No earlier session" note. The remote source maps each one.
- **Retained limits, all confirmed in `remote-session-history.ts`:**
  1. If the provider is ambiguous, the row reads "Not recorded unambiguously" (:28).
  2. Passive lookup covers only claude-code, codex-cli and copilot-cli (:34).
  3. With a cold shell cache, usage is unknown and the shell is never initialized (:40-42).
  4. An unsafe session id is refused before any query (:20).
  5. The read is capped by `SUMMARY_TRANSCRIPT_MAX_BYTES`, with passive lookup (:45).
- **Wording:** the notes say "parity met with stated limits". Please read that as **field parity with retained limits**. Usage can be unknown or partial remotely in cases where local shows a value (limits 1, 2, 3 and 5). That is not unrestricted parity.

## Remaining

- #13: navigation after a board backfill
- #14: role paging
- #17: live matrix
- #18: hosted CI
- the unclassified group-simulation intermittent failure
- #3738, which is separate
