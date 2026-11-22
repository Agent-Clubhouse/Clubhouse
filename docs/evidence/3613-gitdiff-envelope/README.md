# #3613 existing GET Git-diff envelope: RED and design only

**Production policy is unchanged.** The proposed bounded envelope below requires the existing independent security/delta reviewer before implementation. Details ownership and held query/page/receipt hunks are untouched.

Baseline is actual main `63f140b2a0ba00e686fb727a931d6b340fc3ee7e`, tree `040b9eb93b5dd769920564319f7f3e4becdf2b84`, verified through GitHub and origin. Test-only source `9eff428ebeb70c6b7d0996b6600713a50b4928ed`, tree `2bc1e5b37e8e8f89898982641359c47b580b59d6`, adds seven focused cases and an evidence capture helper; every production source remains byte-identical to main.

## Actual baseline

Normal gate `lane-p2`, min4:

```text
npx vitest run --project main src/main/services/annex-control.test.ts --maxWorkers=2 -t 'GET Git diff envelope boundary' --reporter=default --reporter=junit --outputFile.junit=docs/evidence/3613-gitdiff-envelope/attempts/01-gitdiff-boundary-red.xml
```

Admitted START2026-11-22T06:56:44Z / END06:56:45Z, rc1: **2 FAIL / 5 PASS / 190 selector skips**. Before/after source/config/gate/selected installed identities are equal; original raw and JUnit are retained, not normalized. No retry, install or application E2E.

Both failing cases return the actual `ControlRequestError`, code `response_too_large`, indeterminate=false, at **8,454,145 JSON bytes**: GET `/api/v1/projects/project%20name/git/diff`, with and without `?file=large%20file.txt&staged=false`. This is the old8MiB+64KiB envelope plus one byte. The well-formed `{original, modified}` body uses the existing response shape.

The exact8,454,144-byte case passes. Non-GET and suffixed-route cases retain the old budget; stricter caller64KiB bound rejects before credit; no-bulk retains frame refusal. In each red case a separate fresh request and subscription event succeed and both sockets remain open **before** the boundary assertion fails. Assertions after that failure are not credited: complete large bytes/JSON validation remains unexecuted until a corrected candidate passes.

This fixture uses production control/authorizer/bulk machinery with two connected in-memory sockets, one module instance and a fixture response handler. It is genuine unchanged-policy boundary evidence, **not** actual server/Git/filesystem, TCP/TLS, client-adapter, renderer, native-confinement or end-to-end proof.

## Source-bound defect and policy proposal

The existing desktop `requestGitOperation('diff')` uses the captured single-route common GET request (`annex-client.ts:3097+`). The authorized server route is `handleGitDiffRoute` (`annex-server.ts:3062-3077`), requiring a registered project and nonempty file query before calling `gitService.getFileDiff`. `readFileDiff` (`git-service.ts:407-438`) preserves the validated relative-file and Git-ref checks and returns original/modified UTF-8 strings; the working-tree filesystem read has no body-size cutoff.

`responseBodyLimit` (`annex-control.ts:484-491`) lacks this specific route, so reverse dispatch/receive use the generic8MiB+64KiB budget. Existing direct availability alone is **not** a sufficient reason to remove the reverse memory envelope.

**Recommended narrow disposition:** permit the existing GET Git-diff response up to a finite **32MiB encoded JSON envelope**, rather than Infinity. This is a bounded usable increment, not arbitrary-size direct/reverse parity. Larger diffs remain explicitly refused with existing `response_too_large`; no new pagination, route family, source-file read, filesystem policy or permission.

Proposed implementation, not applied:

1. A module-private `GIT_DIFF_RESPONSE_MAX_BYTES = 32 * 1024 * 1024` names this finite local policy. It is the same size already supported for full-event responses, but is independently named for its different route/meaning. No wire field, configuration or exported permission.
2. Extend `responseBodyLimit(path, method?: ControlMethod)` only to identify the new route when `method === 'GET'`. Missing method remains the existing default for Git-diff paths; existing special routes retain their current behavior.
3. Exact anchored matcher: `^/api/v1/projects/[^/?#]+/git/diff(?:\?[^#]*)?$`. Accept one nonempty encoded project segment and optional ordinary query. Reject suffixes, extra path segments, prefixes, raw project delimiters and fragment-bearing paths; control parsing already rejects fragment/whitespace/backslash. Encoded IDs/filename values still pass through the original host parser/project lookup/relative-file validation. Query syntax grants no new operation or host authority. Unknown/missing file queries keep the host's existing response.
4. Thread the already captured method at exactly three call sites: bulk response `accept` at517, owned response `rejectStart` at529, and dispatch `ctx.responseLimit` at860. No dependency on peer-controlled response metadata for path/method: these come from the original pending request.

POST/PATCH/DELETE/HEAD, commit-diff/show-commit, bulletin, transcript and unrelated routes remain unchanged. The pre-existing uncapped `files/read` behavior is neither expanded nor claimed newly accepted. The historical fde1fa unbounded Git-diff proposal is prior art only and will not be imported.

## Authority and failure boundary

The principal is still an authenticated pinned eligible desktop, authorized on request dispatch and after await. Original route/peer/project/file confinement, exact read-only request ownership and link retirement/cancellation checks remain. No alternate-route fallback or automatic replay.

The existing parser, token reservation/replay exhaustion, metadata/count/same-ID, direction/feature/current-pending checks remain before admission. The #3714 predicate stays grouped under all its current gates. A known owned response exceeding **either** its finite route cap or stricter caller `maxResponseBytes` is cancelled/refused before receive-body retention or credit. Unknown/malformed/replayed/stale/authority/sequence/digest/credit failures retain their fatal behavior. No broad oversized-message tolerance.

No-bulk peers retain their existing frame budget and refusal path; passing a GET method cannot negotiate bulk or widen a frame. No phone/control/network contract, grant or human-consent changes.

## Allocation and resource implications

The finite32MiB limit is **encoded response bytes**, not each decoded string. The caller's stricter limit still rejects declared starts before receiving any body chunk. No local cap is sent to the host, so it does not prevent original server materialization.

`ControlBulkLane` retains no buffer sized from a declared start. It checks ownership/size before recording an incoming transfer or issuing credit; each accepted credit admits at most64KiB. Up to4 incoming transfers are retained per link, chunks are kept through verified finish, and `Buffer.concat` constructs a complete body after digest/size/currentness checks. At this route cap that permits up to128MiB of accumulated incoming chunks on one lane; completion transiently adds another body copy. This is an accounting bound for this route, **not** a process/global RSS limit. Other already-supported transfers, socket copies and consumer decoding also consume memory.

The target already reads and JSON-serializes complete original/modified strings before `ReverseResponse` can clip to its envelope. `ReverseResponse.write` first creates a Buffer, then retains at most cap+1; raising its cap increases retained target output from8MiB+64KiB to32MiB+1. It does **not** bound preexisting disk/string/serialization allocation. Up to16 target runs/replies and64 pending requests exist;4 bulk sends and16MiB queued-socket budget are separate controls. Queued-body and decoded-string memory are not reduced to the credit window.

Cancellation/close releases incoming chunks, outbound ownership and timers through existing cancel/done paths; continued authorization is rechecked before chunks and delivery. A stalled transfer retains its existing30s idle deadline. No per-chunk credit accumulation, request concurrency, retry, timeout or queue policy is changed. Independent review must assess this explicit bounded increase rather than infer safety from the historical direct API or chunk size alone.

## Finite implementation milestone after design review

Implement only the constant/matcher and three method call-site arguments in `annex-control.ts`; directly document the32MiB limit. Continue this Git-diff slice rather than switch to Details mid-proof.

Risk-targeted acceptance:

- Original two RED cases become byte-identical GREEN, with same-socket sibling request/subscription liveness.
- Exact32MiB and32MiB+1: accept only the former, reject the latter before credit; preserve stricter caller caps and all method/path/query negative boundaries.
- Actual `requestGitOperation('diff')` adapter over the production control pair receives the exact encoded JSON bytes; actual existing server/Git read composition is separately attributed if executed, never substituted by a mocked handler claim.
- Cancel/revoke during held bulk delivery discards remaining work, stops owned send/credit/body publication and leaves eligible independent work live where existing semantics allow; retain unknown/token/sequence/digest fatal controls.
- No-bulk/old-peer and direct-priority/no-fallback behavior unchanged. No extra unchanged #3772/#3773/#3774 proof or full suite/E2E.
- Exact-head targeted Vitest <=2workers/min4, production and actual fixture types/min6, scoped lint/min4; byte-identical phone fixtures and independent exact source/delta review before one ordinary PR/CI.

The current milestone is **test-only RED plus this frozen design**, not implementation approval or parity closure. Details selected-board/query/page reservations, provider login, refused federation, Q5, current-app/P8, phone/release and whole-duplex acceptance remain separate.
