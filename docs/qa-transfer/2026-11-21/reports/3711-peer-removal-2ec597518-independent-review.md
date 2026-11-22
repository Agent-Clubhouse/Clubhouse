# Independent #3711 peer-removal review

**APPROVE — the bounded legacy outgoing-owner correction is PR-ready from this source/evidence review.** No concrete code blocker was found. Ordinary fresh-main/composition/exact-head/push guards and hosted CI remain; this verdict does not close whole-duplex, phone or current-app acceptance.

Reviewed source [`2ec597518433a1aca5625e61d01b183a31c01b31`](https://github.com/Agent-Clubhouse/Clubhouse/commit/2ec597518433a1aca5625e61d01b183a31c01b31), tree `a6435fdb4bc205ade5c8ebc849d9534e675a869b`, against base `7dfc8b1541bc8c77980faaff782f573c2fa85a15`.
Evidence [`227ecc483d7226c8d33e3777005485175a186b87`](https://github.com/Agent-Clubhouse/Clubhouse/blob/227ecc483d7226c8d33e3777005485175a186b87/docs/evidence/3711-peer-removal/README.md), tree `94f522c365e6afeefaaeaf8b0d0b6c80b8615fa7`, has [manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/227ecc483d7226c8d33e3777005485175a186b87/docs/evidence/3711-peer-removal/manifest.json) SHA256 `6be22017a80c7b765fd6481263000452f055e9988572b3ad80e42eddf183a4d2`.

Reviewer `auto-reset-policy-design` independently inspected the source delta and necessary existing cleanup/revocation/validation dependencies through the existing authenticated `gh` route. I did not author the change, run tests/types/lint, edit production, create a PR, touch account/settings or change access. Q5 WIP remains clean at `079a257acf38b168b529fb7745dae97f686b72b8` on its original branch.

## Production correctness

Only [the two legacy removal handler bodies](https://github.com/Agent-Clubhouse/Clubhouse/blob/2ec597518433a1aca5625e61d01b183a31c01b31/src/main/ipc/annex-handlers.ts#L213) change production behavior.

Single removal calls `revokePeer` first and then unconditionally calls `forgetSatellite`. It still returns the original revocation boolean and conditionally emits the same peer-list notification only when revocation reported removal. An already absent pairing therefore no longer suppresses cleanup of a retained outgoing owner. Client-state notifications performed by the existing forget helper are distinct from that peer-list notification; the unit mock's no-broadcast assertion is not a claim that the real helper emits no state updates.

Calling server revocation before client forget preserves the existing server-side order: membership notice and removed-phone notification, trust removal, then incoming socket closure. The existing server code and its authority policy are unchanged. Actual phone notification delivery is not tested by this candidate.

Bulk removal copies **fingerprint strings** from the paired-peer list before `revokeAllPeers` clears it. The later loop therefore does not depend on a live or mutable peer array. It forgets each captured owner and emits the existing bulk peer-list notification. The client remains enabled, and discovery/settings are not globally stopped. Single removal leaves unremoved peers live.

The reused [forget operation](https://github.com/Agent-Clubhouse/Clubhouse/blob/2ec597518433a1aca5625e61d01b183a31c01b31/src/main/services/annex-client.ts#L2171) pauses reverse reads, retires owned requests/streams, clears timers and socket ownership, removes the satellite map entry, and closes the peer's channels/control links. Its missing-satellite branch is safe; repeating cleanup does not need a present owner or recreate trust. Repeated membership removal becomes a no-op after trust is absent. This idempotence statement is source reasoning plus existing-helper behavior, not a newly executed repeated-real-IPC test.

Late socket message/open/close/error callbacks check the original owned socket; forget nulls it and removes the map entry. Reconnect scheduling also rejects records no longer owned by the map. Thus the retained old record cannot resume commands or resurrect itself through those callbacks. Existing pairing/consent/IPC argument validation and membership/unified-device-removal hooks are unchanged; there is no new permission, grant, route, protocol or removal channel.

## Focused behavioral evidence

I inspected both test layers, keeping their limits separate:

- Handler tests mock server/client helpers and prove revoke-before-forget ordering, unchanged return/list-notification semantics, unconditional forget after a false revocation result, and bulk capture before a mocked destructive store clear.
- Client composition tests import the real registered IPC handler, real server revocation function and real client lifecycle callbacks. Peer storage, socket/TLS/discovery and membership/network boundaries are deterministic mocks; there is no real Electron transport or TLS handshake. Each case first establishes two connected owners, an accepted snapshot publication on the actual satellite-event channel and a successful send to its fixture socket.
- Single and bulk removal then require no retained satellite, no further command write, closed outgoing socket, no late satellite event, no response to late message/close/error/open callbacks, no extra dial and no resurrection after **120 seconds of fake time**. The single case also proves the unremoved peer can still send and publish a fresh snapshot. Bulk removal actually clears the mocked peer store.

Corrected negative source `8ad8363bb4cec974b57b2ae889a697689e03a97f` differs from the base only in the two test files; I independently checked that production is unchanged. Attempt03's **five failures / 405 skips** are meaningful negative controls: missing forget/order/capture and retained outgoing sends/late snapshots/publication. Final attempt09 records **457 passed across three files** with at most two workers. Attempts08 and10 record complete fixture typing and production root typing passes; the manifest records compiler min6 and tests/lint min4. Attempt11 records zero lint errors and 146 warnings.

The final typing-only successor uses Vitest's existing partial-mock typing on 21 old incomplete settings/status mock values, and provides context for one new null-containing expected result. Runtime values/assertions are preserved; there is no cast, suppression, compiler-option relaxation or production follow-up. The fixture project adds the changed handler test to its explicit file list.

## Evidence integrity and honest limits

All **25 source input blobs and 20 archived artifacts** were fetched at immutable refs and verified against manifest SHA256, Git blob identities and sizes. The evidence commit has the execution source as its direct parent and changes only documentation/artifacts. Source notes identify the recorded execution head/tree; raw files contain actual command, gate START/END and exits. **These are adjacent owner attribution notes, not embedded per-command before/after source/status/gate seals.** The manifest supplies supplemental committed-blob identities; neither this review nor its companion verification JSON retroactively creates a stronger execution seal. I found no source/evidence contradiction and request no redundant local run for this bounded review.

I independently parsed the original baseline/final ESLint JSON, used exact paths rather than array position, compared embedded test-source bytes with immutable base/final source, and mapped diagnostics through unchanged source lines. All final diagnostics match baseline **line, column, rule, severity and message**: production handler0, handler test3, client test143; **0 introduced diagnostics**, **0 errors**, **146 measured existing warnings**. The companion JSON records this bridge. No lint rule/config or dependency changed.

Preserved failures retain their actual meaning: attempt01 has three genuine missing-forget assertions but two cases stopped at a missing mock export; attempt02's first late-IPC filter used the wrong constant, so it is not late-publication proof; attempt03 corrects that with the real event channel and a positive publication control. Attempt06 genuinely failed on 21 old incomplete mock types plus the new uncontextualized null expectation. The initial position-based lint readback assertion was wrong because JSON file order differed; the later path/line bridge corrects interpretation without rerunning or rewriting the original lint output. None of these earlier outcomes is relabeled as a pass.

Approval is limited to this desktop legacy outgoing-removal correction and its deterministic composition proof. Real TCP/TLS, phone notification execution, current-app/Electron, native PTY/process-tree, federation/handoff and full-duplex/security closures remain outside this verdict. Historical #3772 evidence is retained without duplicate review or new execution credit. No source change or extra test run is required by this review.
