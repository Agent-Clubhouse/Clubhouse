# Annex V2 Adversarial Assessment

## 1. Threat Model

Annex V2 enables desktop-to-desktop remote control over LAN. The primary threat vectors are:

| Threat | Description | Severity |
|--------|-------------|----------|
| **LAN attacker** | Attacker on the same network can discover Annex via mDNS and attempt to pair or connect | High |
| **Compromised controller** | A paired controller with valid credentials acts maliciously (e.g., destructive shell commands) | Medium |
| **Denial of service** | Flooding the server with connections/requests to degrade or crash the satellite | Medium |
| **Token theft** | Bearer token intercepted on network or leaked from memory/disk | High |
| **Brute-force pairing** | Automated PIN guessing to pair without authorization | Medium |

## 2. Fixed in This PR

### 2a. `buildSnapshot()` unhandled rejection (Bug 1a)
**Before:** If `projectStore.list()` threw during WS connect, the client received no response and hung indefinitely. The unhandled promise rejection could crash the process.
**After:** Wrapped in try/catch. On failure, sends `{ type: 'error', payload: { message: 'snapshot_failed' } }` and logs the error.
**Test:** `annex-server.test.ts` — "sends error frame and logs when buildSnapshot rejects"

### 2b. `broadcastWs()` send can throw (Bug 1b)
**Before:** If one client disconnected between the readyState check and `send()`, the thrown error aborted the entire broadcast loop. Remaining clients missed the message.
**After:** Individual `client.send(data)` wrapped in try/catch. Failed sends are logged; broadcast continues to remaining clients.
**Test:** `annex-server.test.ts` — "multiple WS clients connect and server stays responsive"

### 2c. `sendToSatellite()` silent failures (Bug 1c)
**Before:** Returned `boolean` with no error context. `ws.send()` could throw on a race between readyState check and actual send.
**After:** Returns `{ sent: boolean; error?: string }`. Descriptive errors: `'not_connected'`, `'send_failed: <message>'`. Backward-compatible (truthy check still works).
**Test:** `annex-client.test.ts` — "sendToSatellite error reporting" describe block (3 tests)

### 2d. Silent JSON parse errors (Bug 1d)
**Before:** Both server and client silently ignored malformed WebSocket messages via empty `catch {}` blocks.
**After:** Added `appLog` warnings with first 200 characters of the malformed data in both locations.
**Test:** `annex-server.test.ts` — "malformed JSON handling"; `annex-client.test.ts` — "malformed JSON from satellite"

### 2e. Heartbeat ping failure doesn't update state (Bug 1e)
**Before:** When `ws.ping()` threw, heartbeat stopped but satellite stayed in `'connected'` state. UI showed connected but no heartbeat was running — connection was silently dead.
**After:** After `stopHeartbeat(sat)`, calls `setState(sat, 'disconnected', 'Heartbeat ping failed')` and `scheduleReconnect(sat)`.
**Test:** `annex-client.test.ts` — "transitions to disconnected and schedules reconnect on ping throw"

## 3. Known Weaknesses

### 3a. Bearer token never expires
Tokens issued during pairing persist until the server restarts or PIN is regenerated. A leaked token grants indefinite access.

### 3b. No snapshot versioning/sequencing
Snapshots have no sequence number or version. A stale snapshot can overwrite newer state if network delivers them out of order.

### 3c. `rejectUnauthorized: false` for TLS
The client disables certificate validation and relies on manual peer fingerprint checking. This is fragile and could be bypassed if the fingerprint check has a bug.

### 3d. In-memory brute-force state
The brute-force lockout counter (`checkBruteForce`) is stored in memory. A server restart resets it, allowing fresh attempts.

### 3e. Quick agent state is in-memory only
`trackedQuickAgents` is lost on server crash. Running quick agents become invisible to remote controllers.

### 3f. PTY input size limit is silent
Inputs exceeding `MAX_PTY_INPUT_SIZE` (64KB) are silently dropped. No error is reported to the sender.

### 3g. No PTY flow control / backpressure
PTY data is broadcast to all WS clients without backpressure. A slow client can miss data or cause memory buildup.

## 4. Deferred to Issues

| Issue | Title | Label |
|-------|-------|-------|
| [#933](https://github.com/Agent-Clubhouse/Clubhouse/issues/933) | Quick agent persistence to disk | enhancement |
| [#934](https://github.com/Agent-Clubhouse/Clubhouse/issues/934) | Snapshot versioning/sequencing | enhancement |
| [#935](https://github.com/Agent-Clubhouse/Clubhouse/issues/935) | Bearer token expiration/rotation | enhancement |
| [#936](https://github.com/Agent-Clubhouse/Clubhouse/issues/936) | PTY write size error reporting | bug |
| [#937](https://github.com/Agent-Clubhouse/Clubhouse/issues/937) | PTY flow control / backpressure | enhancement |
| [#938](https://github.com/Agent-Clubhouse/Clubhouse/issues/938) | TLS validation model overhaul | enhancement |
| [#939](https://github.com/Agent-Clubhouse/Clubhouse/issues/939) | Plugin version negotiation enforcement | enhancement |

## 5. Recommendations (Prioritized)

1. **Bearer token rotation** — Implement token expiration (e.g., 24h) with refresh mechanism. Highest impact on token theft vector.
2. **Quick agent persistence** — Write `trackedQuickAgents` to disk so server crash recovery doesn't lose agent visibility.
3. **Snapshot versioning** — Add monotonically increasing `seq` to snapshots. Clients discard snapshots with seq <= their current.
4. **TLS validation** — Replace `rejectUnauthorized: false` with a custom CA that signs peer certificates during pairing.
5. **PTY backpressure** — Implement WebSocket-level flow control. Pause PTY reads when WS send buffer exceeds threshold.
6. **Persistent brute-force state** — Write lockout state to disk so restarts don't reset the counter.
7. **PTY input error reporting** — Return `{ type: 'error', payload: { message: 'input_too_large' } }` when input exceeds limit.
