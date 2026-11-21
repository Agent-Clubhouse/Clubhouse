# Independent QA: #3720 owned listener readiness, implemented source

Reviewer: qa-details-local-composition, the assigned lifecycle reviewer. November 21, 2026.

- **Source:** `19a681f03ec1c62e26ff328dd3f983e07e52986a`, which matches the remote `annex-wake-readiness/3720-owned-listeners`. It sits on top of main `77fa09532` (#3766).
- **Proof:** `90df17c24941444e90d2ef19a92af1a890706837`, which is in `3720-owned-listeners-proof`. It adds only `docs/implementation-notes/3720-owned-listeners/**`.
- **Method:** source read plus hashing. I ran no tests.

## Production equals main plus the approved d64 additions: VERIFIED

- `git diff 77fa09532 19a681f03 -- annex-server.ts` removes **0 lines** and adds 37.
- Every added line appears in the approved `d64c8e6f1` patch. Only the `REVIEW ONLY` comment line is omitted. Nothing is added beyond the patch.
- The helpers are appended after `startVerified`. `start`, `startVerified`, `startServer`, `stop` and every default caller are unchanged.
- **No external consumers:** a git grep over `src` finds `captureSecureListenerReadiness` and `startVerifiedWithReceipt` only in `annex-server.ts` and its test.
- The other changes are `annex-server.test.ts` and `run-proof.py`.

## Behaviour (the source matches my approval of `d64`)

- Ordering: the identity and generation check comes first, then the host-mismatch check, then the readiness capture.
- A superseded attempt or a host mismatch throws with interrupted set and **no STOP**.
- The only `stop()` runs when the same owned attempt, with a matching host, has genuinely lost its listener or port.
- Nothing awaits between the checks and the cleanup.

## Tests (14 focused): what is actually exercised

- **The listener model:** real `net.Server` objects through production `listenServer` promises. `listen`, `address` and `close` are stubbed to model events, so there is **no OS bind or teardown credit**.
- **Default start path retained:** a test drives `start()` under the model.
- **Readiness:**
  - waiting on both listeners before confirming;
  - an unready capture and a capture taken while binding never revive;
  - the wrong host gives false;
  - stop and a replacement with equal ports or profile invalidate the receipt;
  - memory only, with zero settings, profile or broadcast reads;
  - an invalid host gives a `TypeError` with no start;
  - an already-running strict start gives an interrupted failure with no close;
  - the TLS-fallback HTTP server never yields a receipt;
  - a main or pairing bind failure gives an owned cleanup failure that isn't superseded;
  - a replacement arriving between strict completion and the continuation is not stopped;
  - genuine owned loss gives a STOP and a failure that isn't superseded;
  - a not-ready capture with cached positive ports doesn't revive.
- **Constructor reuse is actually exercised:**
  - `vi.mock('http')` and `vi.mock('https')` wrap the **named `createServer` exports** that `annex-server` uses. The reuse tests assert that `listeners` has **length 2** and that `main().server` is the original object, so a restart really reused the objects and ports. The generation fence then makes the old receipt and the old wrapper fail.
  - The **original `d292e339f` candidate failed** exactly this assertion: *"expected … to have a length of 2 but got 4"*. The constructor mock hadn't taken effect, which is a fixture failure.
  - `19a681f03` changes **only** `annex-server.test.ts` (+15/−4) to target the named exports. Production is byte-identical between `d292` and `19a6`.
- **RL-1:**
  - It uses a real `createSettingsStore` in a temp directory, with the real `pendingWrite`/`update` lock, primary A then B. The annex settings getter delegates to `store.get()`, and the profile is mocked by loopback.
  - Old operation A's expected host is `0.0.0.0`. Another write commits `loopbackOnly: true`, durable on disk, **before** the start. The strict start then binds `127.0.0.1`.
  - The result is an interrupted failure with **zero closes**. The newer listeners stay ready, and the store remains B.
  - This is the real store queue, sequential, **not** the actual SAVE, MCP, Ask or grant composition, and not RS1 to RS5. That is stated correctly.

## Evidence verification (hashing)

- 32 of 32 seals ok.
- **19 receipts**, each with inputs equal before and after. Clean runs match the head blobs, and mutants carry diffs.
- **Historical runs, preserved and not transferred:**
  - `missing-api-red` at `fac520810`: 10 failed and 1 baseline passed.
  - `first-implementation`: 11 passed, untracked (2,870-byte diff).
  - `candidate-green` at `d292`: 1 failed. `full-server-suite` at `d292`: 1 failed and 657 passed. Both are the constructor-mock fixture failure.
  - `fixture-correction`: 14 passed, before the commit.
- **Final, at `19a681f03`:**
  - targeted: 14 passed;
  - **full server suite: 658 of 658;**
  - types: exit 0;
  - lint: exit 0;
  - diff check: exit 0.
- **8 mutants,** each failing only on assertions:

  | Mutant | Failures |
  | --- | --- |
  | accept HTTP fallback | 1 |
  | capture without generation | 1 |
  | equality-only adoption | 2 |
  | **STOP on host mismatch** | 1 |
  | ignore listener state | 2 |
  | no ready-at-capture latch | 3 |
  | **STOP on the superseded branch** | 2 |
  | wrapper without generation | 1 |

- Restored targeted run: 14 passed.

## Verdict

- **APPROVE `19a681f03`** as the additive owned-listener helpers plus tests, ready for a standalone PR.
- **Not covered:**
  - consumers, RS1 to RS5, the real SAVE, MCP, Ask and grant queue;
  - independent client-off and control effects when TLS fails;
  - real OS bind and teardown;
  - corruption of private ports alone.
- Hosted CI on the PR head is still required.
