# Independent QA (lifecycle): #3720 runtime readiness RL-1 successor, read only

Reviewer: qa-details-local-composition, November 21, 2026.

- **Target:** `d64c8e6f125eea05a51fa3d9153f08342a7e0f40`, which matches the remote `annex-wake-readiness/3720-runtime-review-rl1`. Its parent is `c4daf8bef`, which is preserved. The base is `b02542b5c`.
- **Seals:** the 9 `SHA256SUMS.txt` entries are all ok.
- **Patch:** the patch JSON's `patchSHA256` `0ece8c14…` equals the sha256 of its embedded patch text.
- **My own execution:** `git apply --check` of that exact patch against a `git archive b02542b5c` copy of `annex-server.ts`, outside the worktree, which passed. Every line of `secure-listener-functions.review.ts.txt` appears in the patch's added lines.
- **Attribution note:** `patch-check.json` records `headAtCheck: c4daf8bef`. The check ran with the new patch (`0ece…`) before the successor commit existed. The base and patch identity are what matter, and I reproduced both.
- **No build, type, race or runtime credit.**

## Exact ordering in `startVerifiedWithReceipt`: VERIFIED

1. It validates that `expectedHost` is a non-empty string.
2. It calls `startVerified()`, which runs `startServer(true)` synchronously and so creates this attempt's generation and objects.
3. It captures the generation, `tlsServer` and `pairingServer`, then awaits the existing strict readiness and its owned failure cleanup, unchanged.
4. **If the generation or objects differ:** it throws `AnnexStartFailure(…, generation, true)`, with **no STOP**.
5. **If `boundHost !== expectedHost`:** it throws `AnnexStartFailure(…, generation, true)` with interrupted set, **no STOP**, no rollback, no refresh of `expectedHost` or admission, and no settings read.
6. Only then does it capture `captureSecureListenerReadiness(expectedHost)`.
7. If that predicate is false, it calls `stop()` and throws with `generation + 1` and `interrupted = false`.

**No hidden STOP for a mismatched host:**

- The patch contains exactly **one** `stop()`, the one in step 7.
- Step 7 is reached only after steps 4 and 5 pass, with **no await** between step 5 and step 7. So `boundHost` still equals `expectedHost`, and the predicate's host check holds.
- In step 7, a false predicate can therefore only mean genuine loss of listening or ports for the same owned attempt.
- `startVerified`'s own pre-existing catch still stops only an attempt that it started and that **failed** strict startup. A healthy newer-profile server is never stopped by this code.
- The capture predicate itself is unchanged from `c4daf8bef`, which I approved.

## Contract additions: ACCEPTED

- **The RL-1 discriminator:**
  1. Hold operation A with its expected host.
  2. Another writer commits profile B **on the real store queue outside `settingsWrites`**, before the start.
  3. Strict startup produces a healthy runtime matching B.
  4. Operation A must get typed superseded or unconfirmed, with no STOP, rollback, refresh or name activation. B stays running.
  - Plus mutants for a STOP on host mismatch and for equality-only adoption, which must fail.
- **Effects that stand on their own:** a TLS bind failure must not early-return past client and control actions that are still permitted. Turning the server on and the client off must still stop the client, unless the operation was genuinely superseded. The result reports an honest failed or partial runtime, and every action rechecks the original operation. This includes the lane's discriminator and its superseded negative.
- **RS1 to RS5** are carried into the future consumer. RS1 must use the real handler, store and MCP queue composition; a fake shared queue proves nothing.
- **No expected-profile parameter for strict start** is proposed, and none is approved.
- The lane's retraction of its earlier unqualified wording is recorded.

## Verdict

- **APPROVE `d64c8e6f1` helper source and design, with RL-1 resolved.** The owned-cleanup branch is acceptable as narrowed: a STOP only for the same owned attempt with a matching host and genuine listener or port loss.
- **Still missing before any shared edit is accepted:**
  - the consumer bodies and operation receipts;
  - executed controls: the RL-1 discriminator, the TLS fallback never yielding a receipt, a genuine owned close or error after strict success, an already-running strict refusal with no stop, the listed mutants, and the TLS-failure-turns-client-off control with its negative;
  - lane coordination for the reserved sites.
- No strict-start or broader lifecycle scope. No OS teardown credit.
