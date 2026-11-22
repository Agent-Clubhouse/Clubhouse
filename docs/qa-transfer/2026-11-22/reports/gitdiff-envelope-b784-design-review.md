# GET Git-diff envelope: bounded DESIGN APPROVE

**APPROVE the finite GET-only32MiB encoded-JSON boundary for bounded implementation**, carrying D1's resource qualification and the matcher/proof requirements below. No authority or method-provenance blocker was found. This is not exact implementation, performance, native/network, PR/CI, full-duplex or release acceptance. No production change or test/compiler/lint/CI rerun was performed by this reviewer.

Reviewed frozen design `b7843d9889cd004098590a1aac5578518b19c788` / tree `014f75de3c78dc3969da8f3dd09eb4111bbaa24f`, README SHA256 `0db91d139800e1ab808c64eafd612a5a200ef89f208f36d38d3bf3bea6c60a11`, manifest SHA256 `6aa0a97b476d1f98672d80c579576d3308de300bdc0fca2b378bfa9829290761`. Source baseline is63f; test-only9eff is its direct child and changes only `annex-control.test.ts` plus the evidence helper. Production is unchanged. All six artifact blobs and31 selected input hashes were verified; the actual receipt matches the manifest's clean9eff execution seal and stable before/after inputs.

## Required resource precision

| # | Severity | File | Lines | Vulnerability | Confidence |
| --- | --- | --- | --- | --- | --- |
| D1 | Low, claim precision; preexisting allocation behavior | `docs/evidence/3613-gitdiff-envelope/README.md`; `src/main/services/annex-server.ts` | README54; server5055–5057 | “retains at most cap+1” describes the logical view length, not physical backing allocation. `Buffer.subarray` can retain the entire originally allocated oversized buffer until the view is released. | High, exact-source inspection; no heap measurement. |

Carry this qualification in implementation/evidence documentation. It does **not** require changing `ReverseResponse` or expanding this production patch: retaining the existing materialization behavior is acceptable for this bounded policy increment, with honest limits. Do not claim the cap bounds target allocation, or that clipping releases excess bytes. `ReverseResponse.write` constructs the full Buffer first, then clips a view. Complete disk/string/JSON materialization is already outside this cap and remains so; the backing-buffer retention persists beyond the clipping expression. This is not a newly demonstrated production incident or a measured RSS result.

The new allowance increases this route's accepted receive budget from8,454,144 to33,554,432 bytes. Four incoming transfers can retain128MiB of this route's chunk bodies on one lane; finish constructs an additional complete body copy. Completed results can outlive the lane, and decoder strings/JSON, socket copies, target work and other supported transfers are additional. Sixteen runs/replies,64 pending requests, four outgoing bulk transfers and16MiB socket backlog are separate controls, **not** a32/128MiB global-process guarantee. Finite32MiB is a usable bounded increment; it is not arbitrary-size direct/reverse parity or evidence that32MiB is a measured optimal budget.

## Matcher and method provenance

The proposed `^/api/v1/projects/[^/?#]+/git/diff(?:\?[^#]*)?$` must be gated by exact `method === 'GET'` and applied to the **original raw request path**, with no decode or URL normalization. Missing method must not default to GET. The current protocol parser already refuses raw whitespace, fragments and backslashes and limits path length; the matcher itself must still anchor the complete path.

One nonempty raw encoded project segment and optional query are accepted. Empty project, prefixes, extra segments, suffixes, trailing slash and raw fragment fail this new rule. Encoded delimiters remain data for the existing project decoder/lookup and file-query/relative-file validation; matching the envelope pattern grants no project/file authority. Empty/missing/unknown file queries retain the handler's current responses. Do not turn budget matching into a new route validator or change malformed-query semantics.

**Place the exact GET Git-diff branch before loose legacy special-case regexes.** Existing `responseBodyLimit` rules inspect substrings, including query text (`/icons/`, `/chat/events/...`, `/content`). A raw Git-diff query containing such text must not accidentally shadow its intended32MiB policy. Conversely an unrelated path whose query contains a Git-diff-looking substring must not gain the new allowance. Preserve all old behavior for other methods/routes, including preexisting special cases and uncapped files/read; this review does not newly approve those older policies.

All three method sources are available without peer response metadata:

| Exact63f site | Required argument source | Boundary retained |
| --- | --- | --- |
| `annex-control.ts:517`, response `accept` | `pending.path`, **`pending.method`** captured by `request()` | Current pending owner/direction/request feature, finite route cap **and** caller cap; no incoming retention or credit before approval. |
| `annex-control.ts:529`, owned `rejectStart` | Same original **pending** method/path | Preserve grouped #3714 guards; isolate only known-current parsed response size refusal, determinate GET error, cancel/tombstone ownership. No broad malformed-start tolerance. |
| `annex-control.ts:860`, dispatch context | Original parsed **`request.method` / `request.path`** | Negotiated-bulk target envelope uses the same rule; no-bulk remains existing frame budget. |

Do not derive method/path from response headers/status/body, normalize one side differently, or omit the method at one site. The target dispatch path is especially important: the current mock handler does not exercise `ReverseResponse` clipping, so a green receive-only fixture would not prove that larger real responses are materialized completely under the new dispatch limit.

## Authority and failure boundary

Source read confirmed existing authorization before dispatch/after awaited work, per-chunk/final currentness checks, token reservation/history, metadata/count/same-ID ownership and digest/sequence/credit guards. None may move behind this allowance or be relaxed. GET remains read-only and does not enter the non-read replay path. Non-GET loses no indeterminate outcome semantics. Unknown, expired, cancelled or malformed/replayed transfers keep their existing fatal/refusal behavior; known oversize replies still refuse before credit using #3714's grouped route-or-caller predicate.

Existing routing and server/Git work are unchanged: actual client `requestGitOperation('diff')` constructs GET with encoded project and URLSearchParams; reverse dispatch selects the existing raw-path route; handler looks up the project and requires file query before existing Git/file validation. This review adds no claim about the total safety or allocation cost of those unchanged readers. No second route, replay, phone permission, grant, network probe or no-bulk frame increase is authorized.

## Actual evidence and next source gate

The admitted exact9eff run is **2 FAIL/5 PASS/190 selector skips**, rc1, darwin/Node24.22.1. Actual raw/JUnit retain `response_too_large`, indeterminate=false for plain/query GET bodies8,454,145 bytes;8,454,144 passes. Same-socket sibling request/subscription liveness is reached **before** each intentional failing outcome assertion. Later complete-body/JSON assertions are unexecuted and receive no credit. Caller-cap/no-bulk/non-GET/suffix controls pass within the fixture. This is one-module paired in-memory sockets with production control/authorizer/bulk and a response handler, not actual server/Git/native/TLS/client-adapter proof.

Before implementation acceptance require:

- Exact32MiB acceptance and+1 rejection before credit, original RED→GREEN exact bytes and sibling/subscription liveness; preserve caller cap even when stricter, zero/equality boundaries and non-GET/absent-method/raw-path/query negatives. Include legacy-special-case-looking query text to establish intended precedence.
- All three original-method arguments and real target dispatch-envelope selection proved, plus actual `requestGitOperation('diff')` adapter method/path and full encoded JSON receipt. Attribute any fixture server/Git ports honestly; do not substitute mock-handler success for real target clipping proof.
- Held-body cancel/revoke/replacement: no later owned credit/body publication; cleanup releases chunk/transfer/timer/request ownership. Independent eligible work remains live where existing authority permits; revoked links need not remain open. Preserve unknown-token/replay/digest/sequence fatal controls and no-bulk/direct-priority/no-fallback behavior.
- Exact candidate tests at normal gate min4/maxWorkers2, production and actual changed-fixture types min6, scoped lint min4, portable raw/hash receipts and independent exact-source review. No unchanged broad3714/3772/3773/3774 matrix or new E2E is requested.

D1 is mandatory wording qualification, not a request for a new memory subsystem or separate approval handshake. Implement the bounded constant/matcher/three arguments within this approved design and freeze the coherent source/proof for review. An increased limit, changed route family, new normalization, relaxed authority/cancellation or extra response clipping implementation would be a different delta requiring explicit review.

Details protected hunks, private Q5 and original evidence remain preserved. Companion verification contains the exact selected input/artifact identities, baseline receipt/XML counts and three method sites. No production or original-owner workspace edits occurred.
