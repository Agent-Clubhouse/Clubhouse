# Independent #3714 implemented disposition review

**APPROVE exact source 7207ed4cd — scoped PR-ready.** No concrete blocking source/security finding was found in this implemented disposition change. This is a new source/evidence verdict, not transfer of the earlier design-only approval. Normal current-main/composition/exact-head/pushed-state checks and hosted CI remain before landing; full security, federation and duplex closure are outside this verdict.

Source [`7207ed4cd4d0a6d5fba443450bed049c8283a02e`](https://github.com/Agent-Clubhouse/Clubhouse/commit/7207ed4cd4d0a6d5fba443450bed049c8283a02e), tree `55f4982865d75fe05ff1393651b2b39b516918e7`; base `e68536e2d292ed0b824230e158e54ff79b2f027d`.
Evidence [`e56648cb0952cb29c5045107b635d81f662dae74`](https://github.com/Agent-Clubhouse/Clubhouse/blob/e56648cb0952cb29c5045107b635d81f662dae74/docs/evidence/3714-route-budget/implementation.md), tree `3a565789d7551b92fce8c34ee14677b79efd69cc`; [implementation manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/e56648cb0952cb29c5045107b635d81f662dae74/docs/evidence/3714-route-budget/implementation-manifest.json) SHA256 `7f9cbd167df96b3346658ddc5d0164c6290d9ffed8ee331b731fbee840e7e4bc`.

Reviewer `auto-reset-policy-design` did not author the implementation. I independently inspected the delta against [93472ec design review](https://github.com/Agent-Clubhouse/Clubhouse/blob/93472ec24648696672e4138b91891a2227b0510b/docs/qa-transfer/2026-11-21/reports/3714-route-budget-1dcfae229-independent-review.md), new tests and immutable receipts with the existing authenticated `gh` route only. I ran no tests/types/lint, edited no product code, updated no PR and changed no account/settings/access. Q5 private work remains clean at `079a257acf38b168b529fb7745dae97f686b72b8`.

## Actual production boundary

The only production change is [the grouped size predicate in rejectStart](https://github.com/Agent-Clubhouse/Clubhouse/blob/7207ed4cd4d0a6d5fba443450bed049c8283a02e/src/main/services/annex-control.ts#L525):

```ts
kind === 'response' && message?.type === 'response'
  && link.direction === 'in' && link.features?.has('request') && pending
  && (size > responseBodyLimit(pending.path)
    || (pending.maxResponseBytes !== undefined && size > pending.maxResponseBytes))
```

Both alternatives are correctly grouped beneath all response/type/direction/request/current-owner checks and use the captured pending path. The surrounding `accept`, parser, current pin/authority, fresh-token ledger, metadata limit, transfer count and same-operation active-transfer exclusion are unchanged. The bulk lane, frame/binary caps, route budgets, separate attachment-request refusal branch and all later integrity/credit checks are unchanged. There is no new wire field, permission, route, retry, alternate-route fallback or federation422 disposition.

The existing local refusal path removes and cleans only that pending operation, rejects with `response_too_large` and retains the existing GET versus non-GET indeterminacy. It then uses the existing matching token+ID cancel before credit or incoming body allocation. The spent-token ledger is not removed. Sender cancel releases its outgoing transfer/response slot through the existing completion callback; independent active-route settlement and completed-write history are not refunded or erased.

This implementation therefore matches the approved narrow distinction: a well-formed, authorized, currently-owned response rejected only for an exceeded receive budget is local; malformed, unknown/stale-owner, capability/pin, token/count/metadata, accepted-transfer digest/sequence/credit and replay violations retain their existing paths. Existing no-owner text no-ops and tombstone-owned late-frame drops are preserved, not widened into generic oversized-frame tolerance. Genuine fatal failures still end the link and subscription through the unchanged cleanup.

No vulnerability finding table is included because no new finding was identified within this reviewed delta; this is not an exhaustive audit of unchanged protocol behavior.

## Newly executed behavior, not baseline assertions

I read the final test source and matched it to the exact final execution. The 21-case disposition group now executes the assertions that were unreachable in the original red baseline:

- Rejected known GET and POST cap+1 starts produce the local error (POST indeterminate), zero credit/binary delivery and one matching cancel. Simultaneously pending unrelated GET and POST complete normally. The existing subscription sends an event and receives a client frame, with no end/served-close callback and the same accepted-link epoch.
- Exact route cap succeeds and cap+1 refuses with either no caller bound or a larger caller bound. Zero caller limit accepts empty and refuses nonempty content. The existing uncapped file-read route accepts content beyond the default route envelope; an explicit caller limit still refuses before binary delivery.
- An old rejected token's binary/finish/cancel is injected while a different response is active and its write is deliberately held. It neither delivers the rejected result nor closes/ends the subscription. Releasing the fresh transfer produces its **exact expected body** on the same epoch, so this is not merely an assertion that the old rejected promise stayed rejected.
- Restarting the spent token against a fresh currently-owned operation is fatal, exercising reservation before the new size exception. The original seven malformed/unknown/expired/cancelled/invalid-size/pin/feature fatal controls continue to pass.
- A completed POST refused for response size remains indeterminate. An explicit same-ID caller retry returns `replay_unavailable`, and the target dispatch count remains one; the implementation does not add automatic retry or reexecution. A separate fresh read still succeeds.
- Seventeen sequential route refusals exceed the existing16-operation window. They send no rejected binary frames, leave active-run count zero and allow the eighteenth fresh request to complete on the same connection. This demonstrates sender transfer/response-slot release under the fixture's completed-route conditions; it does not claim premature release while independent route work remains pending.

The two old P6 cap tests were updated only where their expected `transport_unavailable` result contradicted the new selected behavior. Exact-cap acceptance, unchanged binary count for cap+1 and live connection assertions remain. No timeout, guard or content assertion was removed to make them pass.

## Exact source and artifact verification

I fetched and verified **18 new artifact blobs and all27 final selected input blobs**, plus the initial implementation's test blob. All SHA256/Git identities and artifact sizes match. The final production file with only the old predicate substituted reconstructs the **entire base control file byte-for-byte**. Both mutant receipts' changed control hashes equal that reconstruction; the archived patch hashes equal their original binary-diff seals. This independently binds the mutation to the stated old-policy semantic control.

All **eight receipt/raw pairs** match the recorded heads/trees, commands, exits, minima and raw hashes, with matching before/after tracked-state, selected-input and installed-gate observations. The two mutant runs have only `control.ts` tracked-dirty and are explicitly WIP, not clean-head runs. All other selected inputs match their initial/final committed source; final restored12–15 have clean tracked status, empty diff, all27 exact committed inputs equal and unchanged gate hash `d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3`. These are selected-input/tracked-state seals, not exhaustive transitive-runtime or untracked-input seals.

Actual credit:

| Attempt | Scope | Observed result |
|---|---|---|
| 08 | Initial a3f implementation selector | 20 pass /169 skips |
| 09 | Initial source plus exact old-predicate WIP patch | 7 fail /13 pass /169 skips |
| 10 | Restored initial source, three-file regression | **2 fail /221 pass**, original coupled old P6 expectations retained |
| 11 | Final720 plus exact old-predicate WIP patch | **8 fail /13 pass /169 skips** |
| 12 | Clean exact final720, main+shared three-file regression | **224 pass, no skips**, maxWorkers2, min4 |
| 13/14 | Clean exact final720 root and complete fixture compilers | **Pass**, each min6 |
| 15 | Clean exact final720 control source+test lint | **0 errors /1 inherited warning**, min4 |

The mutant's eight failures occur at the intended refusal boundaries; its remaining13 passes are not mislabeled failures. Restored final execution is independent new proof, not historical green credit from a different head. Initial10 remains a real failure; the typing/compiler/lint outcomes above belong only to their actually executed sources.

The one warning is the unchanged telemetry catch: base line562 equals final line563 byte-for-byte at column47. The predicate adds one preceding line. The final linter JSON embeds the exact final source and reports no other messages; the changed test has zero warnings. This is an inherited-warning **byte/position bridge**, not a newly executed baseline-lint comparison or a warning suppression.

The evidence commit has final720 as its direct parent and adds only documents/artifacts. Historical design/baseline files and75 refusal history retain their earlier meanings, including the52.5-second retry violation. The historical README is a baseline record; implementation.md and the implementation manifest describe current implemented status. No old record is retrosealed or treated as a current production-unchanged claim.

## Approval limits

This is independent source/evidence approval for the known-owned **start-time** response-budget disposition. The source is ready for a scoped PR after ordinary fresh-main/head/composition/push guards, then normal hosted checks. No new local run is requested by this verdict. No PR, merge, activation or release was performed by this reviewer.

The fixture uses deterministic socket wires in one module instance with production control/bulk/P1 callbacks and fixture target dispatch/subscription handles. It is not real TCP/TLS, actual server route/content confinement, private-shell/native PTY cleanup, Electron/current-app, phone or whole-duplex acceptance. Committed phone fixture/route paths are unchanged from the base; that is a byte/identity bridge, **not phone execution**. No naming/Details/Q5 consumer, runtime or broader security acceptance is inferred.
