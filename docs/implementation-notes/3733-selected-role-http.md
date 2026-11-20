# #3733 selected-role metadata HTTP adapter

Base: independently accepted staged selector `72dc7005c16672c31c8895e8dbae7e6f366120e4`.
Isolated branch: `DetailsSessionDisplay/role-read-http`.
Scope: one new metadata GET handler/registration plus its actual HTTP matrix; no client/UI/preload/IPC/snapshot-bus wiring, unrelated routes or permission changes.

## Contract and final checks

`GET /api/v1/dispatcher/details` uses `ctx.requireMtls()` and the **unchanged** existing `desktopDetailsAuthorized(ctx)` predicate. It accepts no caller-selected id/address/machine/path/role/page query. Non-GET methods and a mobile alias have no route. Every handler response is no-store; successful output is only the selected role wrapper's `body`, containing already-authorized corresponding ordinary Details.

The handler delegates to the accepted passive canonical selector, including while the Dispatcher is off. Unbound canonical role remains unavailable, not never-created/sleeping; no fallback role/Agent object, initialization, creation, wake or scope substitution occurs.

The accepted selector already checked the role/primary witness around its ordinary async read. This increment retains that **same private receipt** on its internal result so the handler can check the exact admitted role/primary revision again after awaiting the selector, before serializing. It never re-resolves a later role as if it authorized the earlier result. A missing, false or unreadable final receipt withholds metadata. Principal authorization is also rechecked after the await. The private callback/target witnesses are not serialized, stored, returned on snapshots or put on a discovery/grant bus.

Direct eligible paired desktop controllers and desktop members retain the ordinary Details gate; network membership is not added as a new direct requirement. Reverse requests retain the shared transport's stricter active-desktop-member eligibility, pin/principal rechecks and link nondelivery behavior. Existing controller-conversation agent.read and mobile-off policies are unchanged and remain independently refused when applicable.

## Actual handler proof

Tests use the existing isolated loopback TLS HTTP fixture with mocked certificate identity extraction, the **real** new handler, real staged selector, real canonical role helper and real temporary primary inventory/witness. The ordinary safe Details projection is mocked. They do not act on the running app, network peers, agents or grants. The session-only case populates only the isolated server fixture's temporary pairing map; no live pairing/grant is made.

New matrix: **32 HTTP cases** plus **15 selector unit cases**, **47 passed** together. Coverage:
- Pinned direct desktop controller and member positive reads, including an admitted existing role while off; exact canonical strict primary id, no-store header, body-only output and unchanged primary.
- Anonymous, removed, wrong-pin, obsolete/unpaired pin, opposite direction, phone, unclassified/unknown kind, pending member and session-only refusal before role/config/Details lookup.
- No mutation methods/mobile alias or caller-selected query; unbound role remains unavailable without another lookup.
- Role/primary changes inside ordinary Details AND after selector completion; late peer removal, pin, kind, pending and direction changes; HTTP adapter late principal check independently exercised with a valid role receipt.
- Missing/unreadable final receipt does not leak metadata or raw errors.
- Actual mocked reverse transport: member positive, direct-only controller/phone/pending refused; closing the link during the read delivers no metadata response.
- Mobile off remains 404; controller conversation remains 403 for the direct-only desktop; public snapshot contains no selected-role Details provider marker/new private envelope.
- Every new case forbids Dispatcher init/enable/wake, agent spawn and PTY writes. Primary changes are limited to explicit isolated generation fixtures.

A bounded combined HTTP regression selection (new matrix, existing Settings/Details gates, controller conversation and reverse refusal matrix): **67 passed / 564 skipped**. Initial snapshot-isolation fixture required explicit empty mocked group/plugin inventories; that fixture setup was corrected without production changes.

Failure discriminators (all temporary mutations restored):
- Replace the desktop predicate with plain paired-principal reauthorization: **4 failed / 627 skipped** (phone, unclassified, unknown kind, session-only).
- Skip final role receipt verification: **4 failed / 627 skipped** (post-selector role/primary changes, missing/unreadable receipt).
- Omit final principal recheck while a reader returns valid role metadata after revocation: **1 failed / 630 skipped** (would return 200 metadata instead of 403).

## Freeze/handoff status

First push is a reviewable WIP checkpoint before the requested 05:00 wrap; the lane was released to Actions once the above tests finished. Final committed-head rerun, typecheck and scoped lint are pending at that checkpoint. The final handoff records the exact delivered SHA and completed/deferred checks. No principal coverage was reduced and no blind confidence reruns were scheduled.

```
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project main src/main/services/annex-server.test.ts -t 'selected-role desktop Details HTTP authority|remote full Details authority|remote Settings details|desktop controller conversation|refusal matrix: the same authorizer, as a reverse principal' --maxWorkers=1 --no-file-parallelism
NODE_OPTIONS=--no-experimental-webstorage node_modules/.bin/vitest run --project main src/main/services/selected-dispatcher-details.test.ts --maxWorkers=1 --no-file-parallelism
node_modules/.bin/tsc --noEmit
```

Verified November19 dependencies only; no installs. Independent HTTP-adapter review and any subsequent client/UI binding remain required. Existing selected-machine snapshot receipt adds no role permission and is not used as this endpoint's authority. Remaining #3733 no-chat consumer/full parity and live acceptance stay deferred. No PR/merge/release or production/live actions.
