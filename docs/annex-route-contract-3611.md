# Desktop / Clubhouse Go route contract for #3611

Source snapshot: historical reviewed desktop head `fd8c826596422ed45919909c4deb6b759ba5b850`. Source line references below refer to that head, not moving main. This document separates the existing wire contract from local desktop storage. #3611 adds no phone wire fields, protocol version, control frame, or route endpoint. The Go receiver change is receiver-only. No repair, reset, re-pair, credential replacement or grant change is part of migration.

## Pairing exchange (existing contract)

`POST /pair` is TLS with the client's Ed25519 identity-bound client certificate, PIN validation and certificate pinning. Request: `pin: string`, `publicKey: string` (base64 Ed25519 DER/SPKI) required; `alias?: string`, `icon?: string`, `color?: string`; `pairingMode?: "session" | "persistent"` (absent means persistent); `network?: 1` requests network membership; `selfPairing?: { id: string; joinedAt: string }` offers the phone's existing network pairing. A session pairing cannot join. Both sides must enable Annex Network for `network: 1` to take effect. Invalid optional selfPairing is ignored by readPairing; it is not authority to override a removal. Sources: `src/main/services/annex-server.ts:2565`, `:2574`, `:2631`; `src/main/services/annex-network-membership.ts:285`, `:310`.

Successful response fields: `token: string` (legacy, ignored for authentication), `tlsCertificateFingerprint: string`, `mobileProtocolVersion: 1`, `pairingMode: "session" | "persistent"`, `publicKey: string`, `alias: string`, `icon: string`, `color: string`, `fingerprint: string`. Only on a network join: `network: 1`, `pairing: { id: string; joinedAt: string }` (the PHONE's own pairing), `serverPairing: { id: string; joinedAt: string }` (the answering DESKTOP's pairing). Authentication subsequently uses the pinned client certificate, not token. Source: `src/main/services/annex-server.ts:2671`.

Actual fixture, unchanged (`test/fixtures/annex-mobile/network-pairing.json`):

```json
{
  "request": {
    "body": {
      "alias": "Mason’s iPhone",
      "color": "emerald",
      "icon": "iphone",
      "network": 1,
      "pairingMode": "persistent",
      "pin": "123456",
      "publicKey": "<base64 Ed25519 SPKI DER>"
    },
    "method": "POST",
    "path": "/pair"
  },
  "response": {
    "body": {
      "alias": "Studio Mac",
      "color": "indigo",
      "fingerprint": "AA:BB:CC:DD",
      "icon": "computer",
      "mobileProtocolVersion": 1,
      "network": 1,
      "pairing": {
        "id": "00000000-0000-4000-8000-000000000035",
        "joinedAt": "2026-11-08T10:00:00.000Z"
      },
      "pairingMode": "persistent",
      "publicKey": "fixture-public-key",
      "serverPairing": {
        "id": "00000000-0000-4000-8000-000000000031",
        "joinedAt": "2026-11-01T09:00:00.000Z"
      },
      "tlsCertificateFingerprint": "AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB:AB",
      "token": "<ignored>"
    },
    "status": 200
  }
}
```

Preserve the identity key, certificate/private key, pinned server certificate, existing per-desktop credentials/Keychain pairing, and each network pairing's id and join time across migration and restart. Preserve the phone's local/manual route separately from addresses learned from desktops; receiving no shareable route does not revoke it. This is a receiver requirement, not an assertion about pre-fix Go behavior. A deliberate valid revocation must still erase secrets; do not retain erased credentials in a second persistence store.

## Phone network wire shapes

Desktop sends `GET /api/v1/mobile/network` response `{ version: 1, joined: boolean, members: PhoneNetworkMember[], removals: NetworkRemoval[] }`. Same payload is sent on `/ws` as `{ type: "network:changed", payload: <response> }`. Nonmember/one-to-one phones see only the answering desktop, `joined: false`, no removals. Sources: `src/main/services/annex-server.ts:3535`, `:3568`, `:3808`, `:3824`.

| Member field | Type / optionality |
| --- | --- |
| fingerprint | required string; identity public-key hash, case-insensitive identity comparison |
| publicKey | required string; base64 Ed25519 DER/SPKI |
| certFingerprint | required string; 32-byte colon-separated certificate SHA-256 |
| certPem | optional string; certificate PEM; emitted for desktops when known |
| name, icon, color | required strings |
| kind | required `"desktop" | "phone"` |
| hosts | required string array, MAY BE EMPTY; phone members always `[]` |
| port | optional integer 1–65535; only desktop members can emit it |
| joinedAt | required date string; pairing join time (not freshness of a route) |
| pairingId | optional string; stable network pairing id, absent until learned / on legacy records |
| online | required boolean; live connection to REPORTING desktop, not global reachability |
| self | optional literal `true`; answering desktop |

Removal: `{ fingerprint: string, removedAt: string, pairingId?: string, joinedAt?: string }`. A missing route or offline presence is not a removal. Absence from one desktop's view is not a removal. `joined: false` does not itself issue network-wide revocations.

Phone accepts/shares this same member data with another desktop via `POST /api/v1/mobile/network/members` request `{ members: NetworkMember[] }`. Desktop strips `online` and `self`, then strictly parses the remaining keys (extra `command`, `reach`, or saved-route keys are rejected). Response `{ added: string[], skipped: { fingerprint: string, reason: "self" | "one-to-one" | "member" | "invalid" }[] }`. This endpoint does NOT accept removals, route-local fields, credentials or grants. Existing members are skipped, not updated by a phone vouch. A new introduction is cryptographically checked. A kept unrevoked input pairing stamp is retained; otherwise the endpoint makes a new pairing for this intentional introduction. Source: `src/main/services/annex-server.ts:3599`; `src/shared/annex-network-protocol.ts:112`; `src/main/services/annex-network-membership.ts:671`.

Inbound parser limits: at most 64 members, 8 hosts/member, host length 1–255, publicKey 1–512, name 1–200, icon/color 1–64, optional certPem 1–6000 beginning with PEM marker; parseable joinedAt of length <=40; pairingId matches `[A-Za-z0-9-]{8,64}`; identity fingerprint 16–32 colon-separated bytes; port may be absent even when hosts are present. Total body cap 512 KiB. Syntactic acceptance is not cryptographic proof; membership checks hash/key/certificate binding separately. Sources: `src/shared/annex-network-protocol.ts:18`, `:93`, `:121`; `src/main/services/annex-network-membership.ts:443`.

Actual unchanged excerpt from `network-list.json` (the phone member demonstrates empty hosts / absent port):

```json
{
  "version": 1,
  "joined": true,
  "members": [
    {
      "certFingerprint": "CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD:CD",
      "certPem": "-----BEGIN CERTIFICATE-----\n<base64 DER>\n-----END CERTIFICATE-----\n",
      "color": "indigo",
      "fingerprint": "11:11:11:11:11:11:11:11:11:11:11:11:11:11:11:11",
      "hosts": [
        "192.168.1.9",
        "studio.tail1234.ts.net"
      ],
      "icon": "computer",
      "joinedAt": "2026-11-08T10:00:00.000Z",
      "kind": "desktop",
      "name": "Travel laptop",
      "online": false,
      "pairingId": "00000000-0000-4000-8000-000000000032",
      "port": 7432,
      "publicKey": "<base64 Ed25519 SPKI DER>"
    },
    {
      "certFingerprint": "EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF:EF",
      "color": "indigo",
      "fingerprint": "ef:ef:ef:ef:ef:ef:ef:ef:ef:ef:ef:ef:ef:ef:ef:ef",
      "hosts": [],
      "icon": "iphone",
      "joinedAt": "2026-11-08T10:00:00.000Z",
      "kind": "phone",
      "name": "Mason’s iPhone",
      "online": false,
      "pairingId": "00000000-0000-4000-8000-000000000033",
      "publicKey": "<base64 Ed25519 SPKI DER>"
    }
  ],
  "removals": [
    {
      "fingerprint": "55:55:55:55:55:55:55:55:55:55:55:55:55:55:55:55",
      "joinedAt": "2026-11-05T09:00:00.000Z",
      "pairingId": "00000000-0000-4000-8000-000000000034",
      "removedAt": "2026-11-08T12:00:00.000Z"
    }
  ]
}
```

A DESKTOP member can legitimately have the same `hosts: []` / absent `port` shape while retaining its desktop kind, identity, certificate and pairing fields. For example, the reporting desktop knows only its own private forward and has not received the peer's announcement. #3611 filters typed, pairing override/no-link, and loopback endpoints and the ports only those endpoints use. `hosts: []` means no shareable direct route is known to this reporter. It does not mean removed, invalid pairing, erased credentials, or authorization for the phone to invent a route. It also is not a wire declaration of reverse-control capability; later desktop-only reverse control remains separately authenticated/negotiated and excludes phones. Sources: `src/main/services/annex-network-membership.ts:130`; `src/main/services/annex-reach.ts:182`; test `src/main/services/annex-network-membership.test.ts:209`.

## Pairing stamp ordering and multiple sources

A device is keyed by its identity `fingerprint`; its network epoch is `pairingId` (wire) / `PairingRecord.id` (pair exchange); its epoch time is `joinedAt` (wire) / `AnnexPeer.pairedAt` (desktop persistence). There is no numeric stamp, counter, source priority or route freshness sequence. Never sort UUID strings. Pairing ids are not ordered.

Exact desktop rules at `src/main/services/annex-network-membership.ts:230`:

- `laterPairing(a,b)`: if a has the same nonempty pairingId as b, FALSE regardless of timestamps. Otherwise `Date.parse(a.joinedAt) > Date.parse(b.joinedAt)`. Equal dates with different ids are not later in either direction. No tie-breaking/conflict-resolution protocol exists; preserve the known stamp rather than inventing a winner.
- Existing member adopts input stamp only when input has pairingId AND (known id absent OR input is later). An input without id never moves the existing pairing time/id; same id with a conflicting joinedAt does not update it. Source `:420`.
- `endsPairing(removal,pairing)`: if removal names an id and known pairing has no id, TRUE; if ids match, TRUE; if ids differ, TRUE only if removal has joinedAt AND pairing.joinedAt <= removal.joinedAt. If removal has no id, compare removal.removedAt >= pairing.joinedAt. Therefore a P1 removal must leave known later P2 alone, including P2 with no route. Same id is one epoch, not P1/P2; P1 and P2 here mean different pairing epochs of the SAME DEVICE. Source `:246`.
- `covers(knownRemoval,incomingRemoval)`: when both have different ids and both join times, known covers incoming only when known.joinedAt > incoming.joinedAt. Otherwise known.removedAt >= incoming.removedAt. Source `:254`.
- A valid later member drops the locally held stale removal (`:387`); an incoming stale removal is ignored before ending the peer (`:473`). Self-pairing removal additionally checks its saved epoch (`:480`). No individual currentView emits a newer member beside its older removal (deterministic invariant tests at `src/main/services/annex-network-membership.test.ts:116`).

Across sources B and C, an isolated C can still advertise P1 removal while B advertises P2. Do not union removals as unconditional fingerprint deletion. Merge identity/stamp observations independently of route usability, then evaluate removals against the newest legitimately known epoch. Retain endpoint-less P2's stamp even if no endpoint is dialable; do not overwrite phone-local saved route, credentials or pairing just because B's route list is empty. A removal arriving BEFORE any knowledge of P2 still revokes known P1; no hidden-secret retention or resurrection is authorized by a possible future epoch. If a valid P2 arrives later, it does not recreate erased atomic Keychain secrets. These are receiver requirements using desktop epoch semantics, not claims that desktop implements Go Keychain storage.

Route hints from different sources are not interchangeable private forwards. Preserve provenance and pin; do not combine a host from one record with an unrelated port from another. The wire has ONE port per member, not arbitrary endpoint maps. Desktop's own view is already normalized; source liveness does not grant removal authority.

## Desktop-local saved routes and per-direction reach (NOT phone wire)

`src/shared/types.ts:1166` defines AnnexPeer persistence in `annex-peers.json`. Existing route fields: `knownHosts?: string[]`, `hostPorts?: Record<string,number>` (lowercase host -> port), `mainPort?: number` (legacy fallback), `announcedReach?: { hosts: string[]; port?: number }`, `typedHost?: string` (host or host:port). #3611 adds `typedHostCert?: string`, `privateHosts?: string[]`, `sharedEndpoints?: Record<string,number>`, `heldRoutes?: { certFingerprint?: string; heldAt: string; typedHost?: string; knownHosts?: string[]; hostPorts?: Record<string,number> }`. All are local only. No phone receiver needs to echo these fields, and the phone member endpoint rejects them. New phone round-trip means existing wire member identity/stamp/host/port/certificate metadata round-trips; it does NOT mean transmitting these saved routes.

`privateHosts` conservatively marks typed addresses and pairing override/no-link endpoints private. `sharedEndpoints` remembers the exact host AND port given by the peer's pairing link or discovery; a private port at the same host cannot be exported as the shared port. Load migrates an old typedHost to private provenance and fills missing per-host ports from legacy mainPort without creating identity/pairing/certificates (`src/main/services/annex-peers.ts:76`). Same identity and certificate continuity carries saved routes; a replacement without continuity holds previous routes unused for a future independently authorized verification (`:242`). Neither migration nor offline/restart invokes pairing.

Settings-only `reach?: { outbound: { state, lastUp?: string }, inbound: { state, lastUp?: string }, notice?: { message: string; action: string } }`. `state` is `"up" | "down" | "unknown" | "off" | "not-used"`; lastUp is ISO string for this session. No phone wire field, durable pairing stamp or new grant. Source `src/shared/types.ts:1301`, `:1323`. Settings also has `heldTypedHost?: string`, local only.

## Mixed versions and old receiver risk

New Go + old desktop: decode the same protocol v1 shapes and optional fields; retain legacy no-id removal semantics, accept empty hosts/missing port, retain local routes and credentials unless actually revoked. Older desktop may leak a local override endpoint that #3611 now keeps private. Go must not require new desktop-local fields.

Old Go + new desktop: no new field/frame/version is sent, and desktop migration retains existing pairings/routes. However source audit does NOT prove loss-free pre-fix Go reception. Go owner reports that old `AnnexTransportRegistry.applyNetwork` filters on `trustedHost()` before retaining P2 stamp; then a unioned P1 removal can erase the atomic Keychain pairing. #3611 does increase this trigger in the no-link/non-loopback case below. Receiver fix and rollout ordering are needed for the requested no-repair guarantee; a desktop re-pair is not an acceptable mitigation.

Concrete triggers:

1. Already on main: F joins B server-side with epoch P2, before F's first hello B has no known address/port for F. C, isolated from B, retains P1 removal. Phone polls B (valid P2 with empty hosts / absent port), then C. Old receiver ignores B's P2 and erases on C's P1. Covered by `src/main/services/annex-network-membership.multi.sim.test.ts:387`. Main also filters loopback-only known routes to empty hosts (though may still export mainPort).
2. Added by #3611: B pairs with F without a link (or through an override with no shareable link endpoints) at non-loopback `10.20.0.5:7443`; no F announcement yet. Main exported that known host + mainPort and old Go could persist P2. #3611 marks endpoint private and emits P2 with `hosts: []`, no `port`; isolated C still reports P1 removal. Same old-receiver loss follows. Source: main toMember versus this head `src/main/services/annex-network-membership.ts:130`, tests `:209`, and pairing provenance in annex-client.ts. This is more situations, not an estimated measured frequency.
3. Reduced by #3611: continuity re-pair now retains old announced/shared reach, where main discarded it; thus fewer route-less windows after that operation. It does not cancel trigger 2.

Desktop-only alternatives, not implemented / requiring maintainer decision:

| Option | Consequence |
| --- | --- |
| Hide endpoint-less member from old/all phones | Old receiver still never learns P2; C's P1 removal still erases. New receiver loses protective stamp too. No solution. |
| Suppress old removal at B when B knows P2 | Already done by main/#3611; isolated C does not know P2. Cannot fix cross-source loss. |
| Delay/suppress removals on C until it knows global newest epoch | C cannot know an unseen P2 or prove synchronization while offline; delays real P1 revocation, possibly indefinitely. Fails revocation boundary. |
| Keep emitting private endpoint to make old trustedHost pass | Violates route privacy; host/port may only reach B's private forward. No safe synthetic host/port or access expansion. |
| Require all desktops online before removals / phone response | Makes offline revocation and ordinary network reads unavailable; expands scope and still cannot prove all sources current. |
| Ship Go receiver preservation fix before #3611 rollout | Preserves wire/privacy/revocation; recommended. Merging code alone does not protect old installed phones; maintainer decides merge/release sequencing. |

Rollout decision (Clubhouse-Orchestrator, 2026-11-17): **#3611 merges only after the Go receiver preservation fix is released to phones.** Prepare and validate the rebased desktop branch now; the merge dependency remains until that release. #3611 worsens main for trigger 2, so cannot justify rollout as equal risk. No wire change or repair has been made.

Rebase audit: rebased onto `12823e6ce624e41b162cd482cee509a9792d2ed5` (P1/P3/P4/P5/P6 and #3686). No pairing/member/removal schema, related phone fixture or epoch-ordering delta relative to the historical head above. Every mobile fixture is byte-identical to current main. Four unrelated helper/command fixtures changed upstream since the historical head: `commands/_fields.json`, `commands/helperRouting.update.json`, `helper-routing-quota.json`, `helper-routing.json`, from `a36fac58e` (#3620: provider available/enabled fields) and `dd8ec6766` (#3665: grant.answer reviewedDigest). They are inherited unchanged, not regenerated by #3611. Exact upstream diff: `git diff fd8c82659 12823e6ce -- test/fixtures/annex-mobile` (the pairing/network fixtures have no diff). Source references remain pinned to that historical snapshot so line shifts do not change their meaning.

## Fixtures to replay and evidence

Canonical byte-identical fixtures in `test/fixtures/annex-mobile/`: `pairing.json` (one-to-one), `network-pairing.json` (network pair, both stamps), `network-list.json` (joined / one-to-one, offline members and removal), `network-changed.json` (same view as WS event), `network-members.json` (vouch accepted, extra-field invalid, nonmember denied), `pairing-revoke.json` (persistent deletion refused). `capabilities.json` identifies network endpoints; `index.json` catalogs fixtures. Fixtures intentionally contain placeholder public keys/certificates; replay wire decoding without real credentials. For cryptographic validation use generated test-only identities, not placeholder proof.

Additional deterministic desktop evidence: `src/main/services/annex-network-membership.test.ts` (older/legacy input, stale/current removal, route-less P2, private export negatives); `annex-network-membership.multi.sim.test.ts` (lagging multisource/offline); `annex-peers.test.ts` (legacy migration/restart, host+port provenance, downgrade unknown fields, holding routes); `annex-mobile-contract.test.ts` (generates canonical fixtures); `annex-server.test.ts` (real mobile network endpoint with empty hosts/no port, auth/revocation). Go should replay canonical bytes unmodified, then add receiver-local derived cases for route-less desktop P2 + P1 removal in both source/arrival orders, repeated/same-id/conflicting/equal-time stamps, legacy no-id removal, current P2 revocation, offline/restart, malformed fields and explicit forget. Do not claim those new Go fixtures are desktop canonical fixtures.

Run canonical check with `node scripts/annex-mobile-fixtures.mjs --check` under the prescribed desktop test gate (internally targeted vitest with maxWorkers=2). Any later rebase contract delta must be reported to the Go owner; local source-line shifts alone are not wire deltas.
