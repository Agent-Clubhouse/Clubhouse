# Annex test harness

Runs the real Annex server, off the host app, so a phone or test client can be pointed at it. Real identity, TLS, pairing, peers, routes and WebSockets. Only the project and agent stores are fixtures.

It can't reach the app or its data: it never loads Electron, and `HOME` and every Electron path point at a new temp folder, deleted when it stops. It binds to 127.0.0.1 on ports the OS picks, and doesn't advertise on the network.

## Run it

```
npm run harness:annex
```

It runs its self-tests, then prints one line and stays up until told to stop:

```
ANNEX_HARNESS {"host":"127.0.0.1","port":54321,"pairingPort":54322,"pin":"123456","pairingUrl":"clubhousego://pair?v=1&host=127.0.0.1&…","controlPort":54323,"dataDir":"/tmp/annex-harness-…"}
```

## Connect

1. Generate an Ed25519 key, and a self-signed RSA client certificate whose CN is the lowercase colon-separated first 16 bytes of the SHA-256 of the public key's SPKI DER.
2. `POST https://127.0.0.1:<port>/pair` presenting that certificate, with `{"pin":"…","publicKey":"<base64 SPKI DER>","alias":"…","icon":"phone","color":"indigo"}`. The PIN is one the printed line gives. The server's certificate is self-signed, so pin the `tlsCertificateFingerprint` in the response (the `cert` in `pairingUrl` is the same value).
3. `wss://127.0.0.1:<port>/ws` and `https://127.0.0.1:<port>/api/v1/…` with the same client certificate. Nothing else authenticates: a bearer token is ignored, and a request without the pinned certificate gets 401.

`phoneIdentity()` and `pair()` in `test/annex-v2/annex-harness.test.ts` do this, and so does `AnnexProtocolClient` in `e2e/annex-v2/protocol-client.ts`. Everything is from [Trust and pairing](mobile-control-v1.md#trust-and-pairing). A desktop controller pairs with `pairingUrl`, as `annex-client`'s `pairWithLink` does. A simulator on the same Mac can reach 127.0.0.1. A physical phone can't. The plain `pairingPort` only answers `GET /api/v1/identity`; `POST /pair` there is 410 `update_required`.

The self-tests pair their own phone first. The PIN still works for yours, because the harness turns on its in-process switch `annexServer._testing.setPinReusable(true)`: the printed PIN stays usable after each pairing, so any number of clients can pair with it. A real Annex server has no such switch. Its PIN pairs one identity and is replaced, and it expires after 10 minutes. The harness's own single-use PIN tests turn the switch off for their duration and back on after.

## Control

Plain HTTP on `127.0.0.1:<controlPort>`. Every answer is the current state: `{"fault","reads","readsRunning","maxReadsRunning","lastSeq","pin","pairingUrl"}`. `pin` and `pairingUrl` are the server's current ones.

| Request | Effect |
|---|---|
| `GET /state` | Nothing |
| `POST /fault {"fault":"fail"}` | Builds fail reading their projects |
| `POST /fault {"fault":"hang"}` | Builds hang until the fault changes, then their reads end |
| `POST /fault {"fault":"oversize"}` | Snapshots are over 16 MiB in a required field |
| `POST /fault {"fault":"none"}` | Back to normal. Waiting sockets recover on the host's next retry, up to a minute later, or at once after `POST /refresh` if the window is over |
| `POST /fixture {"projects":40,"agentsPerProject":10}` | Sets how many snapshots list |
| `POST /refresh` | Asks for a refresh, as a change would |
| `POST /projects-changed {"count":20}` | Fires Annex's real project list listener that many times, through its real debounce |
| `POST /theme` | Sends a frame with no seq, `theme:changed` |
| `POST /reset-seq` | Restarts the event seq from zero, as a desktop restart does |
| `POST /chat-event {"agentId":"…"}` | Sends a sequenced `chat:event` |
| `POST /stop` | Stops the harness |

`reads` counts snapshot builds that reached disk. It also counts a REST call while `fail` is set, because the fault is on the project list. `maxReadsRunning` is the most running at once, and is reset by nothing, so read it before and after.

## Our own controller

`npm run harness:annex-client` runs the real `annex-client` against a harness in its own process: real pairing over TLS (by the printed `pairingUrl`, and by discovery with the certificate read first), the satellite's pinned certificate, mTLS and WebSockets, for a first connection, events held until the snapshot, a failed build and a cold start on one, an oversized snapshot, and reconnects. It takes about a minute, so it isn't part of `npm test`. There's no renderer in it.

## One long session

`npm run harness:annex-session` connects a phone and the real `annex-client` (paired by the satellite's pairing link) to one satellite process at once, and takes both through these in order, sharing state on purpose: a snapshot over 8 MiB with canvases left out, a project change, a large terminal attach during a snapshot, a failed build and recovery, canvas edits around truncated snapshots and a reconnect, an oversized command, Annex stopped and started during a hung build, and a process restart during a failure. It takes about a minute, so it isn't part of `npm test`.

This satellite (`annex-session-satellite.test.ts`) keeps its PIN usable with the same switch as the harness, so both clients pair with the one PIN it prints. It uses the real canvas storage, `pty-manager` and terminal mirror, in its own temp folder. The output comes from a fake `node-pty`, and project and agent lists are fixtures.

## What it doesn't cover

The fixtures have no agents running, no chat history and no icons, and it doesn't set a real permission or a real process in a PTY. It tests connecting, snapshots and their failures, not everything a phone does. It also isn't a real phone, a renderer, the real project and agent stores, or two machines.
