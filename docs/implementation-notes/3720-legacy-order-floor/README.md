# Legacy same-label rename ordering correction

Refs #3720. This candidate fixes one current product defect: a newer received
rename with the same text as the current label failed to update the existing
timestamp floor, letting an older different name replace it later.

Base: `c43ffb37d20650c542e449a8a04a9fd84e65b655`.
Test-only red: `44b6702751dac4a1734fda7245bd6cb4787e3f11`.
Fixed source: `8a3aeecf755a0757e409ba9bb5bf2ba4f0c29a34`.

The production change is limited to the existing `member-renamed` case in
annex-network-membership.ts: fresh authorized events always record `renamedAt`;
the peer is rewritten only if its name differs. Existing member/pending/network
checks, strictly-newer comparison, clock-based v1 behavior, save/notification flow,
actors, host grants, pairings and pins are preserved. No frame shape/version,
protocol parser, settings file schema, route, client/server lifecycle or remote
Settings write is changed. Same-stamp conflict remains the legacy first-accepted
behavior; modern `(at, by, id)` ordering is separate work.

The isolated test addition covers newer same-label followed by older text,
equal-stamp conflicting text, the scheduled floor save without rewriting peer
trust/label, and one-to-one/pending/network-off senders that cannot raise a floor.
The existing 90 tests remain intact. Tests use mocked settings persistence,
peer/channel hooks and fixed event times, not real disk/network authentication.
The saved-state assertion proves the legacy save is requested, not crash or
directory durability. A legacy members view still does not transmit this floor.

## Actual exact-source checks

The original root config/global setup/runtime boundary was used with one worker,
no file parallelism, no Vitest/compile cache. Existing matched dependencies were
verified on every command (1,176 nonoptional versions); no installs/shared writes.
Actual per-command local load/CPU and before/after HEAD/input hashes are in raw.

* Red at 44b: **3 failed, 93 passed, 96 total**.
* Green at 8a: **96 passed**.
* Root production `tsc --noEmit`: exit 0.
* Two-file existing-config `eslint --quiet`: exit 0 (errors-only, no warning-free claim).
* Three bounded source mutations: all fail the membership file. Their raw source
  diffs and hashes are explicit; they are not clean-source runs.
  * Put the label comparison back around floor acceptance.
  * Remove the event ordering check.
  * Rewrite peers even for an unchanged label.
* Each mutation restored the source byte-for-byte; final restored run **96 passed**.

Raw records preserve actual stdout/stderr, source diffs, immutable input hashes,
matched cache admission and runner hash. The Vite native-config warning is retained.
No hidden retry, waiver, suite expansion, live app, Mini, provider or phone probe.
The proof-only delivery descendant leaves production/test/runner blobs identical
to the tested source. No PR before independent exact-source review.

## Open naming work and review boundaries

The separate intentionally red branch
`annex-wake-readiness/3720-current-red` at `0522ddd1b` retains actual c43 evidence
that own hello **and** own members still overwrite a chosen network name with the
target's old preference. This correction does not address that defect and must
not be described as the #3720 negotiated fix or full-duplex parity.

The complete committed-store/intent/recovery proposal remains unapplied at
`a2c6b9ab5846692510b211c1493f40cfb5dc6ac3`, proof `63c76cdb8`, while independent
body review is routed. The negotiated durable name record, explicit Alias intent,
shared no-IO name projection/currentness, actual sender/grant/emergency consumers,
mixed-version transport and restart matrix remain unimplemented/unaccepted.
Q5 notice-index/runtime/journal/physical-provider work is not a blanket dependency
for these naming steps. Shared primitive adoption would need its actual contract
and owner clearance; this tiny membership correction imports none.

No readiness or consumer acceptance is transferred from landed utility PRs
#3764–#3767. The current review request is this narrowly bounded product source
and its exact evidence, preserving the larger review gates.
