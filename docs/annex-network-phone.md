# Annex Network: the phone as a member

Epic #3056, stage 5 (#3062). This is the contract between Clubhouse desktops and the iOS app (Clubhouse Go) for Annex Network. The desktop side ships first; the app adopts it when ready. Everything here is additive: a phone that ignores it keeps working one-to-one, exactly as before.

Fixtures: `test/fixtures/annex-mobile/network-*.json`, written by `src/main/services/annex-mobile-contract.test.ts` (see `docs/mobile-control-v1.md#contract-fixtures`).

## What the phone gets

- It sees every machine in the network, from any desktop it's connected to.
- It connects to a new machine by itself when one joins.
- Pairing a new computer to the phone joins that computer to the network.

## Is it supported here?

`GET /api/v1/mobile/capabilities` includes, while Annex Network is on for that desktop:

```json
"network": {
  "version": 1,
  "path": "/api/v1/mobile/network",
  "membersPath": "/api/v1/mobile/network/members",
  "event": "network:changed",
  "pairField": "network"
}
```

No `network` key: this desktop doesn't offer it (older build, or Annex Network off). Pair and connect one-to-one as today.

## Joining when pairing

Add `"network": 1` to the `POST /pair` body, with `"pairingMode": "persistent"` (required: it's how the desktop knows a phone is joining; `"session"` never joins):

```json
{ "pin": "123456", "publicKey": "…", "alias": "Mason’s iPhone", "icon": "iphone", "color": "emerald", "pairingMode": "persistent", "network": 1 }
```

If the desktop agrees, the answer carries `"network": 1` beside the usual fields, and the phone is now a member of that desktop's network. Without it, the pairing is one-to-one, as before. The desktop tells its other members, and each of them accepts this phone's pinned certificate from then on: the phone can connect to any of them with no more pairing.

A member phone still shows "Controlled by" on a desktop it connects to, like any phone.

## Listing machines

`GET /api/v1/mobile/network` (pinned mTLS, like every mobile route):

```json
{
  "version": 1,
  "joined": true,
  "members": [
    {
      "fingerprint": "aa:…", "publicKey": "MCowBQYDK2VwAyEA…", "name": "Studio", "icon": "computer", "color": "indigo", "kind": "desktop",
      "hosts": ["192.168.1.9", "studio.tail1234.ts.net"], "port": 7432,
      "certFingerprint": "AB:CD:…", "certPem": "-----BEGIN CERTIFICATE-----…",
      "online": true, "self": true, "joinedAt": "2026-11-08T10:00:00.000Z"
    },
    { "fingerprint": "bb:…", "name": "Mason’s iPhone", "kind": "phone", "hosts": [], "certFingerprint": "…", "online": true, "joinedAt": "…" }
  ],
  "removals": [{ "fingerprint": "cc:…", "removedAt": "2026-11-08T12:00:00.000Z" }]
}
```

- `self` marks the desktop answering. `online` is whether that desktop is connected to the member now; offline machines stay listed (show them dimmed).
- `hosts` and `port` say where a desktop can be reached, best first: LAN addresses, then its tailnet name if it has one. Phones have none.
- `certFingerprint` is the SHA-256 of the member's TLS certificate. Pin it exactly as at pairing: never connect to an address that shows another certificate.
- `certPem` is there so the phone can vouch for that desktop to another one (below). Desktops only.
- `joined: false`: this phone isn't a member here (paired one-to-one, or Annex Network off). `members` then lists only this desktop.
- `removals`: devices removed from the network. Forget any listed here.

## Connecting to a new machine by itself

Over the `/ws` connection, a member phone receives:

```json
{ "type": "network:changed", "payload": { "version": 1, "joined": true, "members": [ … ], "removals": [ … ] } }
```

The payload is the same as `GET /api/v1/mobile/network`. On each one:

1. Connect to every desktop in `members` that the phone isn't connected to yet, at `hosts`/`port`, pinned to `certFingerprint`, with the phone's own pinned client certificate. No pairing: the desktop already accepts this phone.
2. Disconnect from, and forget, every device in `removals`.
3. If this phone is in `removals`, it was removed: forget the whole network.

When this phone is removed, each desktop it's connected to sends it a last `network:changed` with its own fingerprint in `removals`, then closes the connection (WebSocket close code 4401, reason `peer_not_paired`). A desktop that refuses with 401 `peer_not_paired` later no longer has this phone (it was removed while the phone was off, for example): if every desktop does, the phone was removed from the network.

`network:changed` is also sent when a desktop connects or disconnects (`online` changes). After the phone reconnects, read `GET /api/v1/mobile/network` again rather than relying on an earlier event.

## Joining a new computer through the phone

The person scans a new computer's pairing code (or picks it from nearby and confirms its certificate code), as today. Finishing a pairing always needs a person on the new device; no agent can do it.

1. Pair with the new computer, `D`, with `"network": 1`. If its answer has `"network": 1`, the phone is now a member on `D` (`D` was in no network, or its own).
2. `GET /api/v1/mobile/network` from a desktop already in the phone's network, `A`. Send its `members` (as they came, including `certPem`) to `D`:
   `POST /api/v1/mobile/network/members` on `D`, body `{ "members": [ … ] }`.
3. `GET /api/v1/mobile/network` from `D`, take the entry with `self: true`, and send it to `A`:
   `POST /api/v1/mobile/network/members` on `A`, body `{ "members": [ { …D… } ] }`.

Each answers which records were added, and why any weren't:

```json
{ "added": ["dd:…"], "skipped": [{ "fingerprint": "aa:…", "reason": "member" }] }
```

`reason` is `member` (already a member there), `one-to-one` (paired with that desktop one-to-one; pair it again with `network: 1` to join it), `self` (the desktop itself) or `invalid` (the record doesn't hold together). Joining through the phone counts as a fresh join, so an earlier removal of those devices doesn't stop it. From there the desktops do the rest: `A` tells its other members about `D`, and each connects to `D`; `D` connects to the members it was given. The phone gets `network:changed` from each desktop as that happens.

Each record must hold together, or it's ignored: its public key hashes to its fingerprint, and its `certPem` to its `certFingerprint`. Send members exactly as `GET /api/v1/mobile/network` lists them; `online` and `self` are ignored. The record is `fingerprint`, `publicKey`, `certFingerprint`, `certPem`, `name`, `icon`, `color`, `kind`, `hosts`, `port` and `joinedAt`; anything else is refused. Sending a member that's already known changes nothing.

Refusals:

| Status | `error` | Meaning |
|---|---|---|
| 403 | `client_certificate_required` | No pinned client certificate. |
| 403 | `not_a_member` | This phone isn't a member of this desktop's network. Pair again with `network: 1`. |
| 400 | `invalid_json` | The body isn't JSON. |
| 400 | `invalid_members` | A record isn't well formed, or there are more than 64. Nothing was added. |
| 413 | `too_large` | Over 512 KB (`maxBytes` says the limit). |

## Agent addresses (stage 6, #3063)

Every snapshot says which machine it's from:

```json
"machine": { "fingerprint": "aa:…", "name": "Studio Mac" }
```

An agent's address across the network is `<agentId>@<machine fingerprint>`. Capabilities say so:

```json
"agentAddress": { "version": 1, "format": "{agentId}@{machine}", "snapshotField": "machine", "wrongMachineCode": "wrong_machine" }
```

A command's `agentId` may be an address. The bare id still means the desktop the command is sent to. An address for that desktop works the same as the bare id. An address for another machine is refused, naming the machine to send it to:

```json
{ "status": "rejected", "error": { "code": "wrong_machine", "message": "…" }, "machine": "bb:…" }
```

Only a command's `agentId` takes an address; routes with an agent id in the path (`/api/v1/mobile/agents/{agentId}/…`) take the bare id. Keep the form a command was first sent with when retrying its `commandId`: the receipt is tied to the command as sent, so the other form gets `command_conflict`.

Fixture: `agent-address.json`.

## Order of work for the app

1. Read `capabilities.network`; send `network: 1` when pairing a desktop that offers it.
2. List machines from `GET /api/v1/mobile/network`; keep offline ones, dimmed.
3. Handle `network:changed`: connect to new members, forget removed ones.
4. Joining through the phone (the three steps above).
5. Keep agents keyed by address (`agentId@machine`) when showing more than one machine's agents together.
