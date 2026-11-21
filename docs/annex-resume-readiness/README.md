# Annex resume readiness proof

Scope: deterministic desktop source behavior from main `69ef383cefec405d811f1c199f25c10cdc0395b6`, compared with `v0.43.0-beta.7`. No live device or mobile behavior is asserted. Branch `annex-wake-readiness/resume-freshness` remains frozen at `a31e81dbf`; this correction is on `annex-wake-readiness/resume-callback-successor`.

## Historical baseline and correction

The beta7 and main-baseline `resumeAllConnections` implementations are identical. The Electron resume hook still calls that function; index changes since beta7 concern durable initialization, not power handling. Other Annex saved-route, membership, approval and buffer changes do not invalidate connected/connecting sockets on resume.

The original regression-only commit `b9fbe1b71` records 9 failures and 2 passing controls in `baseline.txt`. The subsequent heartbeat cleanup regression is preserved in `review-regression.txt`. These original failure artifacts are unchanged. One original expectation, keeping a clock stop halted across wake, is superseded by the existing clock-recovery contract below; its old failure must not be counted as a product defect.

Resume retires pre-sleep connected/connecting sockets, cancels their heartbeat/backoff timers and starts one fresh attempt through the existing pinned/authenticated path. Readiness stays false until the replacement opens. Discovery still discards the pre-sleep announcement and restarts through the existing profile gate. Pong and heartbeat callbacks require their owning socket. Current-socket close/error stops its heartbeat; close/terminate detaches the socket before callbacks can run. No request timeout or retry backoff changes.

Independent QA requested changes at `a31e81dbf` / `92ad84430`: W1 identified a concrete deferred upgrade-refusal body race, W2 identified the changed clock-stop wake behavior, and E1 identified missing raw final-pass evidence. Earlier notes incorrectly attributed W1 to #3733. That task's O1 fix concerns Details/role denial receipts and does not touch this upgrade-refusal path. This successor owns W1.

## W1: a refusal belongs to its connection attempt

Every `connectToSatellite` invocation creates a unique in-memory attempt token before changing connection state. Disconnect and halt invalidate that token. The deferred `readSmallBody(...).then(...)` always retires only its captured refused request/socket. It checks both record identity and attempt ownership before parsing or applying the body, changing state, marking pairing, or scheduling a reconnect.

A stale `needs_pairing` or `peer_not_paired` body is **not treated as a timeless peer revocation**. It reports the old attempt's authentication result and cannot overwrite a newer attempt's result or a manual disconnect. The newer attempt still goes through the existing pinned TLS and stored-pairing checks and must accept its own current refusal. This preserves current pairing/authentication authority; it does not waive those checks.

The test-only successor commit records 8 failures and 3 passing current-refusal controls on frozen a31 production code (`evidence/successor-baseline.txt`). Six cases resolve an old 503, `needs_pairing`, or `peer_not_paired` body after resume with a replacement connecting or connected. Another resolves it after manual disconnect retains the same record. The clock case below supplies the eighth failure. Current 503 and both pairing refusals remain three positive controls. After correction, all 23 freshness cases pass: old resources alone are retired, replacement sockets/channels remain usable, no extra reconnect is scheduled, and manual disconnect remains disconnected without a timer.

## W2: preserve the existing clock-recovery contract

Main/beta7 retried disconnected `CERT_NOT_YET_VALID` records on wake. The existing clock stop suppresses automatic scheduled reconnects between explicit retry/wake attempts, and `retry()` remains available. The successor preserves one pinned attempt per wake for `halt === 'clock'`. If TLS still reports `CERT_NOT_YET_VALID`, it stops again without an automatic retry loop. A later wake or manual retry can try through the same pinned path again. Readiness requires that path's `open`; no clock/certificate validation is bypassed.

Pin mismatch, expired-certificate/pairing and removed-pairing stops remain stopped across wake. Client-off still starts neither discovery nor a connection. This restores existing clock wake behavior while preserving explicit pin/pairing stops; it introduces no permanent clock-halt product policy.

## E1: original outputs and new sealed validation

`evidence/historical-92ad84430/` contains surviving original 311-test, typecheck and lint outputs, copied byte for byte from the earlier run. Its SHA256 manifest was created during successor work and labels the source-head association as historical attribution from the earlier transcript. The old outputs contain no embedded head/exit-code receipts. An empty historical typecheck file alone proves no success. No standalone old diff output or exit-code receipt survives, and none was reconstructed. Earlier green/diff assertions remain historical claims with these explicit limits.

For a fresh seal, run from a clean tracked checkout with dependencies matching the committed lock:

```sh
node scripts/annex-resume-readiness-proof.mjs --out /path/to/new-output-directory
```

The runner captures the actual starting/ending HEAD, source/scripts tree IDs, commands, timestamps, exit codes, signals, unmodified combined stdout/stderr, byte counts and SHA256 hashes. It emits `.txt` payloads plus `manifest.json` and `SHA256SUMS.txt`. The output directory must be new. A following evidence-only commit can preserve the receipt; it must not be described as having run at that later commit. Exact code identity is checked by the manifest's source/scripts tree IDs. Independent review must inspect both the exact successor head and these bindings.

The runner uses one test worker without file parallelism; typecheck and lint follow sequentially. It copies the committed Vitest config to a temporary workspace-local file for the runner loader, disables test caching and places any caches in the chosen output directory. Shared `node_modules` remains untouched. Raw outputs retain terminal whitespace, so diff-check excludes only the evidence payload directory; SHA256 checks protect those original bytes. Every other PR path is whitespace-checked.

The existing dependency cache matches package-lock SHA256 `bd9cc80304b81d317f2ffb295d9af5abbc484bf8efb64fc8d7f118e1288c212d`; nonoptional installed version/integrity metadata was verified. No installation is used. Resource admission is remeasured before running the full successor seal.

## Evidence boundary and acceptance

Fake wall time advances across sleep without running JS timers, and captured socket/timer callbacks exercise ownership. These tests do not assert OS callback frequency or cross-host clock equivalence. The Mini trace crossed OS sleep; all 122 watchdog stalls overlap sleep and the residual 34 seconds after wake remains UNKNOWN. Historical OS sleep receipts are supplied context, not locally verified proof. There is no inferred mobile fix, keepawake, power-policy change, deadline increase, blanket request cancellation, settings change, restart, installation, release, merge or live probe.

W1/W2/E1 successor acceptance requires independent exact-head review of source and sealed evidence before any new PR. The original draft PR #3747 remains frozen; no merge or release is authorized.
