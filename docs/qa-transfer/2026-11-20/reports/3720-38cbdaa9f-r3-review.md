# Independent QA: #3720 r3 combined review

Reviewer: qa-details-local-composition, November 21, 2026.
- **Target:** `38cbdaa9fff26aa28630ad14b5db9c13359d39f1`, which matches the remote `annex-wake-readiness/3720-rename-ordering`. The source contract is `a025ec2ec2a8d317b2ec49ea0f7fd7455d27d973`. r2 `15383280a`, r1 and earlier review history are retained.
- **Seals:** the `successor-r3/SHA256SUMS.txt` SHA256 is `79610890…9d10`, matching. All 15 entries match. The scaffold `corrected-boundaries.review.patch` SHA256 is `e014a9d7…10ee`, matching.
- **Base:**
  - All 8 patch inputs have identical blob IDs at `50cb77ab6` and `be0091d16`, and `annex-settings-ipc.ts` is new.
  - I ran `git apply --check --unidiff-zero` on a disposable `git archive be0091d16` copy, outside the worktree. It succeeded. Note that a plain `--check` fails, because the patch has zero context. The owner's checker uses `--unidiff-zero`, which is correct.
  - Nothing was applied, built or tested. **No parser, race, type, lint, teardown or IPC-clone execution credit.**

## Verdict: ready for bounded implementation start, no remaining contract blockers

r3 resolves every r2 required item and every lane item at contract and scaffold level. Implementation may start piece by piece under writer clearance. This is not feature acceptance, and it is not approval of the unimplemented helpers.

### B1: RESOLVED

- There are three base states.
  - **UNKNOWN:** a strict reread of the fixed private path, with bounded file and provenance checks and full shape validation. It never uses the legacy loader, defaults, migration, temp sweep, name init or equality adoption. The reread runs inside **the same actual store pendingWrite turn**, not just the handler chain. Admission is rechecked at the turn, after the read and before replacement. A newer emergency or reset supersedes the old continuation.
  - **Known with a publication fault:** composes on the retained actual base, never on the stale public tuple.
- A failed reread gives zero replacement, with live-off and degraded status retained.
- A successful reread doesn't heal the public surface, doesn't change the epoch and activates no name.
- Discriminators B1-a through B1-e are named, plus the mutation controls.

### L1: RESOLVED

- One execution in flight and 32 recent completed records globally, with oldest completed evicted first. In-flight work is never evicted.
- A main-issued ready ticket is consumed synchronously at entry, and only main allocates ordinals.
- Status mode never consumes a ticket, reads or rotates.
- Lookup order: authority first, then the retained duplicate, then the healthy short-circuit.
- An explicit table gives `not_retained` or `not_degraded` with zero IO for every missing record.
- 40 failures don't exhaust recovery, and a scope change fences old requests.
- The renderer action owns its generation before the first await.
- This matches my (a) to (e) and the `not_retained` recommendation. Discriminators L1-a through L1-i are named.

### C1: RESOLVED in the scaffold boundaries

- Load settings and status publish inside `acceptLoad`. Errors publish inside an admitted `failLoad` or `failReset` callback.
- The purge path drops the unconditional status, peers and devices clear, and checks `isCurrent(resetOwner)` before reloading.
- The View captures `actionOwner.begin()` before the await, and calls `setSettingsLoadFailed` only if `owner.current()` holds.
- The session and owner helpers themselves are still unimplemented.

### C2: RESOLVED

- `captureOriginalAnnexIpcEntry(event)` runs synchronously in the outer handler, before validation or the queue.
- `withSettingsSurface('ui')` covers the whole path. `withValidatedArgs` is retained; I checked against main `validation.ts` that it passes the validator's **returned** DTO to the handler and rethrows validator errors unchanged.
- A wrong argument count is `invalid_envelope`.
- Only `LocalSettingsInputError` becomes a typed refusal, through `reportLocalSettingsInputRefusal`. Unexpected errors propagate and are not reclassified.
- The entry receipt is disposed exactly once on both paths.

### C3: RESOLVED (`strict-parser-body.review.txt`)

- Ordinary objects: the prototype must be Object or null. Every `Reflect.ownKeys` key must be a string, and each own descriptor must be an enumerable data property. The exact key set is checked across all own keys.
- `unset`: the prototype is checked. `length` is checked through its own data descriptor, non-enumerable and at most 11. The own-key count must equal length + 1, and each index must be an own enumerable data property. No array methods, iterators or getters are called.
- Construction is typed and fresh, then `structuredClone`, with no `unknown` cast. The 8 KiB check runs on the canonical DTO, and reflection or clone throws become `invalid_envelope`.
- An unsafe correlation gets a null requestId. Holes are kept as a preservation control, and the Proxy and IPC reachability limits are stated honestly.

### Startup and runtime readiness

- The committed tuple is established at normal startup before IPC, and GET stays pure.
- `applyNetworkSettings` (void, swallows failures) is explicitly **not** readiness proof. A committed result must report runtime as applied, unknown or failed from actual owned evidence.
- Accepted as a correctly scoped implementation gap.

## Non-blocking clarifications for the implementer, not contract blockers

- **N1 (L1):** state how the renderer learns the next ticket after a failed completion. Either the failed result carries the next ready ticket, or a status read after completion does. Neither path may auto-submit.
- **N2 (B1):** after a successful emergency replacement on an UNKNOWN base, say whether that write's actual base becomes the known actual base for later emergency turns. Rereading again each time is also safe; just pick one.
- **N3 (C1):** `submit` must always resolve to a typed `LocalSettingsResult` and never reject. Otherwise the View's owned setter is skipped and the rejection goes unhandled in `onChange` and `onClick`. Add a control.
- **N4 (C3):** `v !== 1` maps to `schema_invalid`. That is acceptable under "local version" in the contract text, but the fixture should pin the choice.

## Bounded implementation scope (unchanged from r2, plus r3 additions)

- From r2: `annex-settings-ipc.ts` with the strict parser and `LocalSettingsInputError`; the commit session with its owner and draft helpers; the renderer and palette migration; `getSettingsSnapshot` and startup ordering; the settings-store opt-in turn with publication, actual base and UNKNOWN reread; the transaction module with `captureOriginalAnnexIpcEntry` and refusal reporting; network-tools receipt and restore; launch-gate plus Annex consumption; recovery ticket, IPC and UI; and the r1 name service, which stays separately gated.
- New in r3: the runtime-readiness classification seam. Because it touches server start and readiness, it needs **lifecycle-lane review** of the exact seam before landing.
- Each piece needs writer clearance, deterministic red/green, type and lint, the executed race, teardown and mixed-version matrix, and exact-source independent review.

The launch-gate source approval is unchanged, and still source only.
