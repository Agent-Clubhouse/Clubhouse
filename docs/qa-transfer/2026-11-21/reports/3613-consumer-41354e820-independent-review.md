# Independent review: reverse consumer candidate 41354e820

**Verdict: BLOCK — R1 must be resolved before this consumer increment is accepted.**

Reviewer: `auto-reset-policy-design`, independently reassigned by Clubhouse-Orchestrator. I did not author this host change. I inspected source and immutable artifacts with the existing authenticated `gh` route; I did not change account/settings, run tests, install dependencies, or change product code. Private Q5 work remains preserved at `079a257acf38b168b529fb7745dae97f686b72b8`, tree `89e942aabd42c8ec93fe47794f2eef95b0b61980`, on its original pushed branch.

## Exact objects and scope

- Base: `c43ffb37d20650c542e449a8a04a9fd84e65b655`.
- Production: [`41354e82025320809b4a8bc954b7053a4f05c33e`](https://github.com/Agent-Clubhouse/Clubhouse/commit/41354e82025320809b4a8bc954b7053a4f05c33e), tree `8f47585f68ccf9356be0d984a3780de2b9bc3d26`.
- Executed combined five-suite source: `6039da94c3385f5c8f2371d7b2ffa180113113aa`, tree `a5b2f61ba8c0a0cfa2281d2bf19900a4c29a9868`.
- Final executed fixture: [`6d7aec19dbc11489633a0a3d52629e41341c6548`](https://github.com/Agent-Clubhouse/Clubhouse/commit/6d7aec19dbc11489633a0a3d52629e41341c6548), tree `3196f2477ddfe3224d324e69b1cff85c70a52ad1`.
- Immutable [evidence README](https://github.com/Agent-Clubhouse/Clubhouse/blob/740aa5050fb870c971fef95a7dcb06ad785d1bae/docs/evidence/3613-duplex-consumer-candidate/README.md) and [paired manifest](https://github.com/Agent-Clubhouse/Clubhouse/blob/740aa5050fb870c971fef95a7dcb06ad785d1bae/docs/evidence/3613-duplex-consumer-candidate/paired-manifest.json).

Scope is one usable snapshot/icon/text consumer read and an owned reverse stream increment. It excludes full duplex, real handoff acceptance, Electron/native PTY, phone adoption, Details sensitive-read admission, naming label changes and Q5 integration. This is source/evidence review against the specified base, not a freshness or landing guard against future main.

## R1 — retired icon workers can start direct requests after stop or revocation

Blocking source-derived correctness finding; **no observed live incident or executed reproduction is claimed**.

At [annex-client.ts:575–593](https://github.com/Agent-Clubhouse/Clubhouse/blob/41354e82025320809b4a8bc954b7053a4f05c33e/src/main/services/annex-client.ts#L575), `fetchSatelliteIcon` chooses reverse only while reverse readiness is true. Otherwise it unconditionally falls through to the legacy direct `https.get`; it does not require a live direct connection or the original stream. At [615–623](https://github.com/Agent-Clubhouse/Clubhouse/blob/41354e82025320809b4a8bc954b7053a4f05c33e/src/main/services/annex-client.ts#L615), the caller captures the stream for snapshot/publication checks, but the per-icon fetch callback has no captured-stream check.

The unchanged [remote-icon-fetch.ts:118–140](https://github.com/Agent-Clubhouse/Clubhouse/blob/c43ffb37d20650c542e449a8a04a9fd84e65b655/src/main/services/remote-icon-fetch.ts#L118) starts up to four workers. Each worker continues through the already captured missing-icon list after its await, without consulting `getSnapshot` again before each fetch.

Concrete sequence: an accepted reverse snapshot names five or more missing icons; four reverse reads are pending. `stopClient`, disconnect or authority retirement aborts those requests and retires the stream. Their catches return `failed`; a worker then requests a remaining icon. Reverse readiness is now false, so it enters the direct HTTPS branch on the retained satellite record. A peer with a saved direct address can therefore receive a new direct attempt **after the stop/retirement sweep**. That direct request is not in `satelliteRequests`, has no owning abort signal, and is not prevented by the later publication guard. Stop retains the paired peer, so obtaining its pinned TLS options does not itself prevent this path. A replacement stream can similarly receive work scheduled by an old batch.

This violates the increment's owned cleanup and route-currentness promise. Existing direct icon behavior also lacks this scheduling guard, but extending its callback into a reverse batch does not make that reverse-to-direct continuation acceptable. The passing real fixture has exactly one icon and cannot expose the fifth-icon path.

Required bounded correction: recheck the captured stream immediately before **every** icon fetch and refuse retired work without a direct attempt. Preserve direct behavior for its valid current owner; do not introduce automatic route fallback after a chosen request fails. Ensure running requests remain owned/cancellable and old workers cannot attach work to a replacement stream. Add a five-or-more-icon controlled test: hold the first four reverse requests, retire/stop, release/abort them, and assert zero subsequent reverse or direct sends, no late IPC, and normal fresh-stream liveness. A guard-removal mutant should fail that discriminator. Submit an exact successor source/fixture/evidence bridge for narrow independent re-review; broad unchanged runs are unnecessary.

## Source properties that passed inspection

The common request helper selects one direct or accepted reverse route before sending, carries one request ID, propagates the original control error and has no alternate-route retry. Its reverse lease captures trust plus accepted-link epoch, combines caller/owner abort signals, rejects stale completion, and removes the request from its owner set in `finally`.

Reverse readiness is gated by running/client/network state, manual pause/halt, current paired desktop member identity, pin and accepted authorized control link. Existing `annex-control` reauthorizes requests, subscription frames and client frames; accepting a link is not a grant bypass. Reverse subscription creation is limited to negotiated subscribe capability, one owned stream per peer, with trust/epoch identity and refusal deduplication until a new epoch or explicit retry. Retired callbacks are dropped; replacement streams start their own snapshot sequence. Canvas and icon publication callbacks check the captured stream. R1 concerns **new dispatch scheduling**, which those publication checks do not cover.

Direct connection observation/listeners remain direct-only. Reverse snapshots may support consumer display state but do not mint the positive `snapshotReceipt` required by sensitive Details/new-card admission. `annex-devices` uses the explicit direct observer rather than mistaking renderer consumer state for a direct outbound socket. The sensitive reader/receipt branches and naming label expressions are unchanged by the production delta. This does not independently approve their wider feature contracts.

## Evidence review and exact credit

I fetched committed blobs via `gh`, recomputed all 32 paired archive hashes, and matched all 32 original receipt/raw pairs across attempts 01–32. Receipt before/after source observations agree, gate hashes agree, admission is recorded, and each raw output SHA matches. I independently fetched all 15 fixed-list input blobs at final 6d7 plus the fixture and matched their SHA256/Git blob identities. The companion verification JSON records exact commands, heads, trees, exits and checked source hashes.

GitHub compare metadata confirms no production delta from 41354 to final 6d7; the non-evidence changes are the fixture and its tsconfig inclusion. The 6039→6d7 commit changes only the fixture (+8/-9): capture validated listener references on the success path and report teardown through a closure, removing the explicit unsafe throw from `finally`. Final evidence 740 is docs-only.

- Exact 6039 attempt 25: five files, main + integration projects, maxWorkers=2, **610 passed**, exit 0. Attempts 26/27 production and complete fixture typechecks ran at min6 and passed. Attempt 28 measured policy lint at min4: **0 errors, 160 current versus 161 baseline warnings, 0 introduced diagnostics**.
- Attempt 29 at 6039 genuinely failed strict fixture lint with `no-unsafe-finally`. Final 6d7 attempts 30/31/32 ran the paired fixture (1 passed), complete fixture typecheck (min6), and strict fixture lint (min4, 0 errors/0 warnings), all exit 0. **610 tests were not executed at 6d7.** The inspected fixture-only bridge permits credit for unchanged production, not relabeling the earlier test run.
- Final pair output records 81,937 decoded all-byte-values bytes with SHA256 `f7da8be077ec14d7c37a9e717948bedebdc1b9e4ec14cde538646611e18b643b`, a 68-byte PNG through the icon adapter, and an exact UTF-8 text adapter read. It records one `/control` upgrade, zero ordinary HTTP requests, one common POST, an actually closed reverse direct-port hint, and direct-connected=false.
- Before forced fixture teardown: pending tree read aborted, target inflight=0, subscriptions=0, owned headless disposed, late IPC=0, and independent accepted control link retained. Fixture teardown separately records zero forward/server sockets and both listeners stopped. The fixture source performs these assertions before its cleanup destroys remaining sockets.
- Three recorded negative executions fail at the intended behavior: replacement sequence stays 50 instead of 1 (17), owned subscription leaks at 1 instead of 0 (23), and same-epoch refusal subscribes twice instead of once (24). Their changed hashes/diff digests are retained; I do not claim to have reconstructed unpublished mutant patches or rerun them.

The original fixed SHA input list omits the newly tracked paired fixture. Its original execution binding is the recorded clean immutable HEAD/tree, **not** a separate fixture digest in that list. The paired manifest and this inspection provide a supplemental committed-blob bridge; neither retro-seals or augments those execution receipts.

Original failures remain failures: the c43-production negative baseline had 16 failures/1 pass; intermediate regression had 10 failures/599 passes; the missing Azure declaration/module typecheck failed; the empty-array contextual typing check failed; the zero-warning lint command failed; intermediate paired fixture typing had five diagnostics; strict 6039 fixture lint failed. Later successes do not erase those outcomes. The original worktree dependency restoration and unchanged package/lock receipt are historical owner evidence, not an install performed by this reviewer.

## Guarantee limits and disposition

The two isolated desktop module contexts use real generated identities, pinned TLS/control and one byte-transparent forward in one Node worker. Target handlers/subscription stores are fixtures. The large response is a handoff-shaped bulk envelope, not full handoff/grant/manifest integration. There is no Electron/native PTY/process-tree/firewall proof, real app route-confinement acceptance, phone feature acceptance, or whole-duplex acceptance. Preserved phone fixture bytes and 68 check-mode passes are a compatibility observation only.

The existing evidence is useful and honestly scoped, but R1 leaves an uncovered post-retirement dispatch path. **BLOCK this exact candidate until that scheduling/currentness defect and a focused discriminator are reviewed.** No source changes, additional reruns, PR or activation were performed by this review.
