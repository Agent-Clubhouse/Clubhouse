# Independent #3714 route-budget design/security review

**APPROVE the narrowly specified design boundary for implementation.** This is not production-source, PR-ready, runtime-liveness or security-closure approval. Production remains base-identical. No new blocking vulnerability finding was identified within the proposed delta; this is not a general federation/security audit.

Exact design [`1dcfae229ff0a2eb07b6d3a2e42f31f118f3dc32`](https://github.com/Agent-Clubhouse/Clubhouse/blob/1dcfae229ff0a2eb07b6d3a2e42f31f118f3dc32/docs/evidence/3714-route-budget/design.md), tree `7030dd231c8f21a0723da69468188402cd0a2e19`; design SHA256 `58e6bfccc3161b793f243b5c9caece703248ef63ce2a7853e5e83c14881fa4ec`.
[Manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/1dcfae229ff0a2eb07b6d3a2e42f31f118f3dc32/docs/evidence/3714-route-budget/manifest.json) SHA256 `3df2265b0df1073c084cde915d49eed5add1220c0e6875f14030853ab2309ef0`.
Base `e68536e2d292ed0b824230e158e54ff79b2f027d`; admitted baseline `a7033fa7d7081cf78fc50ef0de6c4e62fa691b76`, tree `3489b8c0a2b2c77a5e8546151f01f5901585a8cb`; frozen source `b4fdbe97a49d87ecce289b91445cec984c2bdae7`, tree `1a406a90d90635c2ecf06500ccc6e4ef92c2dd42`.

Reviewer `auto-reset-policy-design` independently inspected design, relevant control/bulk/parser/authority code, focused test delta and immutable receipts through the existing authenticated `gh` route only. No production edits, test/compiler/lint runs, access/login changes, installs, live probes or broader federation review were performed. Q5 private work remains clean and unchanged at `079a257acf38b168b529fb7745dae97f686b72b8`.

## Approved boundary

Change only the existing response refusal condition in [makeBulkLane.rejectStart](https://github.com/Agent-Clubhouse/Clubhouse/blob/b4fdbe97a49d87ecce289b91445cec984c2bdae7/src/main/services/annex-control.ts#L525). After every existing outer response-kind, parsed-response, incoming-direction, negotiated-request and current-pending-owner condition succeeds, the size predicate may become:

```ts
(size > responseBodyLimit(pending.path)
  || (pending.maxResponseBytes !== undefined && size > pending.maxResponseBytes))
```

**The OR must remain explicitly grouped under all existing outer checks.** An ungrouped textual replacement that lets the optional-limit arm bypass ownership/type/direction/capability is outside this approval. Use the captured pending request path, not a path supplied by response metadata. Do not change `accept`, `ControlBulkLane`, budgets, frame caps, the separate attachment-request refusal branch or any later transfer checks.

This treats either exceeded receive bound as sufficient. Equality remains acceptable; an absent optional local bound leaves the route bound; a larger optional bound cannot raise that route bound; a zero local bound must not be lost to a truthiness check. Existing file-read `Infinity` route policy is unchanged, with any configured caller bound still effective. This approves no new unlimited body family.

Delete only this link's matched pending entry, call its existing cleanup, reject with the existing `response_too_large` error and preserve `!isReadOnlyMethod(pending.method)` indeterminacy. A POST/PATCH/DELETE may already have acted; local refusal neither refunds effects nor proves nonexecution. No retry, alternate route, new request ID, success-shaped result, new wire error or grant follows from refusal. The guarantee is at the control-request API, not a new claim about how every pre-existing UI adapter displays errors.

## Guard ordering and cancellation review

The actual receive path supports the proposal's security ordering:

1. [onFrame](https://github.com/Agent-Clubhouse/Clubhouse/blob/b4fdbe97a49d87ecce289b91445cec984c2bdae7/src/main/services/annex-control.ts#L682) checks current pinned inbound authority, existing raw/control frame bounds, parsing and negotiated bulk before calling the lane. The protocol parser requires a nonnegative safe-integer start size, valid operation ID/token shape and record metadata.
2. [ControlBulkLane.receive](https://github.com/Agent-Clubhouse/Clubhouse/blob/b4fdbe97a49d87ecce289b91445cec984c2bdae7/src/main/services/annex-control-bulk.ts#L72) rechecks authority, reserves the fresh token in its lifetime ledger, enforces the 16KiB metadata bound, transfer-count bound and same-operation active-transfer exclusion **before** `accept` or `rejectStart`. These checks must retain their present placement. A route-oversize start cannot bypass them.
3. `bulkMeta` parses response status/headers, and `rejectStart` requires the exact link to still own the pending operation. Unknown, expired or cancelled request owners, malformed metadata, wrong direction/capability and lost pin therefore cannot enter this exception. A response rejected solely by the two size bounds is distinguishable at this point.
4. Returning the existing true result sends matching bulk cancel before any credit. No incoming transfer, body chunks, hash state or idle timer is created for the rejected start. The reserved token remains bounded history; the receiver does not decode or deliver a response body.
5. Sender cancellation uses the existing token+ID ledger check and `cancelToken`, which clears its transfer/timer and invokes the sender's completion/release callback. Scheduled pumping checks that the exact outgoing transfer still exists; without credit, no body begins. This frees the transfer/response slot, not independent active-run accounting before route operations settle, write-history state, or remote effects. It is not an operation rollback.

Keep the existing distinctions: rejected UUID restart/history exhaustion remain fatal; a mismatched ID on an owned cancel/credit is not a local size refusal; unknown late binary tokens and accepted-transfer sequence/length/digest/credit/ownership violations retain their current failure paths. Existing tombstone-owned late body/control handling, and any existing no-owner late-control no-op paths, stay unchanged. This verdict does not generalize all unknown text control frames into a new fatal or tolerant policy. Genuine fatal cleanup still closes the subscription and invokes its served cleanup; this proposal changes no private-shell cleanup, authorization, P1/P5/P6 fence, route registration, phone/wire field or federation refusal/422 policy.

## What was actually proved

I fetched and verified all **27 selected effective input blobs** and **15 artifact blobs**, including sizes, SHA256 and Git blob identities. Compare metadata confirms production is base-identical and only the control test changes runtime-facing source. No selected effective input changes across admitted baseline a703, frozen b4fd and design head1dc; the archival successor is not relabeled as a new test execution.

All **six receipt/raw pairs** match their recorded heads/trees, minima, exits and log hashes. The four executed receipts have matching before/after selected-input lists, clean tracked status/diff and unchanged gate hash `d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3`. These are selected-input/tracked-state seals, not exhaustive transitive runtime or untracked-file seals. The companion verification JSON preserves the actual commands and scope.

- Attempt04 on a703: **2 FAIL / 7 PASS / 169 skips**, maxWorkers=2, normal min4 admission. Both known GET/POST route-cap+1 starts fail at the intended aggregate disposition assertion. Actual output shows zero credit and rejected binary, but both link ends close4400/protocol; the rejected request receives `transport_unavailable`, the unrelated GET/POST also fail, the subscription ends and served close runs once. POST errors remain indeterminate.
- The seven added fatal controls pass for unknown/expired/cancelled owner, malformed response metadata, invalid size, lost pin and missing bulk feature. They do not demonstrate the future local refusal.
- Attempt05 on the same source: **106 PASS / 90 skips / two files** for selected existing caller-limit, binary/P6, replay/token/credit/digest, authority, protocol and refusal controls. This is a targeted selector, not the whole suite or shared protocol-test file execution.
- Attempt06: complete existing fixture project typecheck **PASS**, min6. Attempt07 on b4fd: changed control-test lint **PASS, zero errors/zero warnings**, min4, with all 27 effective inputs unchanged.

The unrelated-success and subscription send/receive assertions **after** the failed aggregate were not reached. Their source presence is a future proof obligation, not measured liveness. The fixture's `finally` cleanup is likewise not evidence of successful post-refusal work.

## Preserved admission chronology and required next proof

Attempt00 failed capture preflight before the gate; its transcript is owner-copied, not an independently captured raw stream. Attempts01/02 remain **75 NOT RUN**, without an admitted Vitest child. The second retry violated the 60-second rule: receipt timestamps give about52.6 seconds after the prior finish, consistent with the retained approximately52.5-second observation. The outer shell continued despite its failed interval assertion. Nothing in this review erases or credits that attempt.

Read-only observation03 is explicitly advisory. Later04 has actual ordinary locked START/END admission after that changed observation and elapsed interval; no advisory pass is substituted for admission. The Python capture now checks refusal spacing before spawning the unchanged gate. Its original capture bytes and Node-version chronology are preserved. The Node argv self-match is a plausible predicate interaction, not an exclusively proven historical holder cause. No kill, baseline reset, process masking or gate weakening is credited or requested.

The next bounded implementation must preserve this exact placement and obtain independent exact-source review with meaningful green proof: GET and write refusal type/indeterminacy; zero credit/body delivery and one token+ID cancel; unrelated GET/POST success and same subscription bidirectional liveness on the **same** link/epoch; exact route cap versus cap+1 and unchanged uncapped-file behavior; rejected-token late payload/restart and a subsequent fresh request; and the existing fatal owner/metadata/capability/authority/count/replay/integrity controls. Existing evidence may be reused only for unchanged boundaries with an explicit source bridge; it is not implementation-green credit. No broad rerun or new CI experiment is requested by this design verdict.

All tests here use deterministic paired wire sockets and fixture dispatch/subscription handles in one module instance. Production control/bulk/P1 callbacks are exercised, but there is no real TCP/TLS, actual server content-confinement, phone, Electron/current-app, native shell/PTY or whole-duplex acceptance. Independent implementation review and normal product/hosted gates remain after code exists.
