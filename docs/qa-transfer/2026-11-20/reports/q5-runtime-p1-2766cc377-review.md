# Independent QA: Q5 runtime P1, exact source and evidence re-review

Reviewer: qa-details-local-composition, November 21, 2026.

- **Executed source:** `2766cc377e766540e4c2e46718a4bcc372ef3d76`, tree `e263078f60e3ab6bf107264fc915f09e6321d8cc`.
- **Evidence successor:** `02f777c5d8c0275477fb200e1dd4fb783a34adb0`, tree `4d1698e81389f7e1ce6b331970b6701027af49f0`, which matches `origin/lane-3613-p2-routes/q5-runtime-p1`. It changes only files under `docs/evidence/q5-runtime-p1/`.
- **README sha256:** `fe825006…4643`, recomputed.

## Source delta since `c61665ca1` (statically reviewed at `fe1d4dc7`)

- `a5781b184` replaces ten `const x: T = Object.freeze({...})` with `Object.freeze<T>({...})`. That is a **typing-only** contextual annotation that fixes TS2322 brand widening, with no runtime change.
- `2766cc377` changes one test fixture annotation (`deref(): undefined`) for `noImplicitAny`, with no behaviour change.
- No target, lib, lint rule, brand or public signature was relaxed. Root `tsconfig.json` is still `bed57c7a…`.
- **The source is identical between `2766` and `02f`**, which I recomputed:

  | File | sha256 |
  | --- | --- |
  | coordinator | `695423ea…` |
  | test | `b74712c6…` |
  | `runtime.ts` | `3d30b01c…` |
  | fixture `tsconfig` | `3b833584…` |

- **No consumers:** git grep finds the coordinator only in itself and its test. No driver, IPC, journal ACK, schema or phone changes.

## Execution evidence at exact `2766`, through ordinary gate admission (the repaired gate)

- **Fixture tsc:** exit 0 (END 19:31:08Z).
- **`npm run typecheck`:** exit 0 (19:31:33Z).
- **Targeted vitest:** **39 of 39** in 1 file (19:31:36Z).
- **Scoped eslint, `--max-warnings=0`:** exit 0 (19:31:37Z).
- **Mutants**, each uncommitted from `2766` and **killed** with exit 1:
  1. unchecked brands (both registries replaced by brand membership): 3 failed, namely fabricated or cloned handoffs, a cloned ticket, and the old registry after reset;
  2. repeated loss (retirement guard removed, loss callback kept): 2 failed. This run was **limited by `--testNamePattern`** to the two non-reentrant retained-promise and latch controls, so 37 were skipped. That's specific and justified, because the reentrant test would recurse without bound under this mutant.
  3. marker exception treated as rejected: 2 failed, covering both the claimed and journal-owned paths;
  4. expiry reopening authority: 2 failed;
  5. a forwarded fabricated approved-ACK: 1 failed.
- **Restored:** the coordinator sha is `695423ea…`, equal to the `2766` blob I recomputed. The tracked diffs are clean, and the admitted vitest gives **39 of 39** (19:36:35Z).
- **Historical runs, preserved and not credited:**
  - the original exit-75 refusal;
  - the first production tsc (ten TS2322 diagnostics) and the fixture tsc failure;
  - the `npm ci` diagnosis. The exporter file was missing locally, the gate admitted one `npm ci` at min 6, the manifests were unchanged, and the post-install physical hashes equal the frozen `c616` blobs.
- **Explicit limitation:** no physical hash sidecar was captured **before** the install. The "before" identity is the frozen Git blob only.

## Evidence limitations

- The raw files are captured terminal output, with the gate's START and END lines plus tool output. **They are not structured receipts with per-command embedded source seals.** The binding to `2766` relies on the README's stated HEAD and seal checks plus the restored sha.
- That's acceptable for this small, typing-only delta, which was identical across `2766` and `02f`. Future pieces should use the structured receipt format with before and after seals.

## Verdict

- **APPROVE P1 (`2766cc377`, with evidence `02f777c5d`) for a PR** as the **unwired** coordinator plus types plus fake-hook controls.
- The `f337` fixes and the WeakRef design are confirmed by execution: tsc 0, lint 0, 39 tests, 5 killed mutants, restoration proven.
- **Not covered:**
  - live-resource only, with dormant argv entry deferred;
  - the real journal `tryMark` and loss claim, the ACK-first fence, and Q5 handling of a `RuntimePreIntentRefusal` after intent (P5);
  - consumers P2 to P6;
  - runtime, ACK, schema and phone.
- Hosted CI on the PR head is still required. The batching principle is retained.
