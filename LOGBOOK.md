# Annex V2 — mega-camel Logbook

## Phase 0: Dual-Instance Test Infrastructure

### 2026-03-17 — Branch setup
- Created `mega-camel/annex-v2` staging branch from `origin/main`
- Created `mega-camel/annex-v2-phase0` working branch

### 2026-03-17 — 0A: userData isolation
- Modified `src/main/index.ts`: added `CLUBHOUSE_USER_DATA` env var support before `app.name` assignment
- This allows running multiple isolated Clubhouse instances on the same machine

### 2026-03-17 — 0B: Dual-launch harness
- Created `e2e/annex-v2/dual-launch.ts`: launches 2 Electron instances with isolated temp userData dirs
- Created `e2e/annex-v2/helpers.ts`: protocol-level helpers (enableAnnex, getAnnexStatus, pairViaHttp, connectWs, waitForMessage)
- Created `e2e/annex-v2/protocol-client.ts`: standalone HTTP/WS client for vitest integration tests
- Created `test/annex-v2/protocol-client.test.ts`: integration tests validating pairing, auth, WS snapshot

### 2026-03-17 — 0C: Dev workflow scripts
- Created `scripts/annex-dev-satellite.sh`: launches Instance A with isolated userData
- Created `scripts/annex-dev-controller.sh`: launches Instance B with isolated userData

### 2026-03-17 — Note
- Node.js runtime not available in this environment; tests written but not yet executed
- Code correctness verified by manual review against existing patterns

## Phase 1: Security Foundation

### 2026-03-17 — #859: Identity System
- Created `src/main/services/annex-identity.ts`: Ed25519 keypair gen, persist, fingerprint
- Created `src/main/services/annex-identity.test.ts`: unit tests for keygen, idempotency, permissions, fingerprints
- Modified `src/shared/types.ts`: extended AnnexSettings (alias, icon, color), AnnexStatus (fingerprint, alias, icon, color), added AnnexPeer type
- Modified `src/main/services/annex-settings.ts`: added defaults for alias, icon, color
- Modified `src/main/services/annex-server.ts`: added GET /api/v1/identity endpoint, identity init on start, enriched getStatus()
- Modified `src/preload/index.ts`: updated annex API types for new fields
- Modified `src/renderer/stores/annexStore.ts`: updated defaults for new fields
- Modified `src/renderer/features/settings/AnnexSettingsView.tsx`: added data-testid for toggle

### 2026-03-17 — #860: Durable Pairing & Key Exchange
- Created `src/main/services/annex-peers.ts`: peer CRUD, brute-force protection state machine
- Created `src/main/services/annex-peers.test.ts`: unit tests for CRUD, brute-force, lockout
- Modified `src/shared/ipc-channels.ts`: added LIST_PEERS, REMOVE_PEER, REMOVE_ALL_PEERS, UNLOCK_PAIRING, PAIRING_LOCKED, PEERS_CHANGED
- Modified `src/main/ipc/annex-handlers.ts`: registered peer management handlers
- Modified `src/preload/index.ts`: exposed listPeers, removePeer, removeAllPeers, unlockPairing, onPeersChanged, onPairingLocked
- Modified `src/main/services/annex-server.ts`: extended POST /pair with key exchange (publicKey, alias, icon, color), brute-force middleware

### 2026-03-17 — #861: mTLS Transport
- Created `src/main/services/annex-tls.ts`: self-signed X.509 cert generation (ECDSA P-256), CN=fingerprint, mTLS server/client options
  - Uses raw ASN.1/DER construction (no external deps needed)
  - Ed25519 kept for identity, ECDSA P-256 for TLS (broader Node.js TLS support)
- Created `src/main/services/annex-tls.test.ts`: cert generation, PEM validation, X.509 parsing, CN verification
- Modified `src/main/services/annex-server.ts`: MAJOR refactor — dual-port architecture
  - Pairing port (plain HTTP): POST /pair, GET /api/v1/identity, OPTIONS
  - Main port (TLS with mTLS): all authenticated endpoints + WSS
  - WS connections tagged with authType (mtls|bearer) via WeakMap
  - Bonjour publishes v:2 + pairingPort in TXT record
  - Graceful fallback to plain HTTP if TLS fails

### 2026-03-17 — #862: Annex Client & Service Discovery
- Created `src/main/services/annex-client.ts`: Bonjour browser, satellite state machine, mTLS WS client, snapshot storage
- Created `src/main/ipc/annex-client-handlers.ts`: IPC handlers for getSatellites, connect, disconnect, retry, scan, proxy PTY/agent commands
- Created `src/renderer/stores/annexClientStore.ts`: Zustand store for satellite connections + snapshots
- Modified `src/shared/ipc-channels.ts`: added ANNEX_CLIENT section (12 channels)
- Modified `src/shared/types.ts`: added SatelliteConnection, SatelliteSnapshot types
- Modified `src/preload/index.ts`: added annexClient.* API
- Modified `src/main/ipc/index.ts`: registered annex client handlers

### 2026-03-17 — #863: Protocol V2 Bidirectional Control
- Modified `src/main/services/annex-server.ts`:
  - Added WS control message handlers: pty:input, pty:resize, agent:spawn, agent:wake, agent:kill
  - Security gate: control messages require mTLS auth (rejected for bearer-only connections)
  - 64KB limit on pty:input data
  - Extended snapshot with protocolVersion: 2, agentsMeta
  - Added handleSpawnQuickAgentWs and handleWakeAgentWs for WS-based agent control

### 2026-03-17 — #865: Reconnection & State Sync
- Modified `src/main/services/annex-client.ts`:
  - Added 30s ping/pong heartbeat with 10s pong timeout
  - startHeartbeat/stopHeartbeat lifecycle management
  - resumeAllConnections() for power resume
  - scheduleReconnect checks autoReconnect setting
- Modified `src/main/index.ts`: added powerMonitor.on('resume') listener
- Modified `src/shared/types.ts`: added autoReconnect to AnnexSettings
- Modified `src/main/services/annex-settings.ts`: autoReconnect default true
- Modified `src/renderer/stores/annexStore.ts`: updated default settings

### 2026-03-17 — #864: Settings UI
- Created `src/renderer/features/settings/AnnexControlSettingsView.tsx`: new settings page for satellite management
- Created `src/renderer/features/settings/AnnexIdentitySection.tsx`: reusable alias/color/fingerprint section
- Created `src/renderer/features/settings/PairedSatelliteList.tsx`: satellite list with status indicators, retry/disconnect
- Modified `src/renderer/features/settings/AnnexSettingsView.tsx`: renamed to "Annex Server", added identity section
- Modified `src/shared/types.ts`: added 'annex-control' to SettingsSubPage
- Modified `src/renderer/panels/AccessoryPanel.tsx`: added "Annex Control" nav item, renamed "Annex" to "Annex Server"
- Modified `src/renderer/panels/MainContentView.tsx`: added routing for annex-control page

### 2026-03-17 — #866: Remote Project Model & Proxy Store
- Created `src/renderer/stores/remoteProjectStore.ts`: Zustand store for satellite projects/agents, namespaced agent IDs
- Created `src/renderer/services/project-proxy.ts`: routing layer (remote: prefix → annex client, else → local IPC)

### 2026-03-17 — #867: Satellite Locking
- Created `src/renderer/features/annex/SatelliteLockOverlay.tsx`: full-screen lock overlay with controller identity, disconnect/pause/disable actions
- Created `src/renderer/stores/lockStore.ts`: Zustand store for lock state (locked, paused, controller info)
- Modified `src/shared/ipc-channels.ts`: added LOCK_STATE_CHANGED, DISCONNECT_CONTROLLER, DISABLE_AND_DISCONNECT channels

### 2026-03-17 — #868: Plugin Matching
- Created `src/renderer/services/plugin-matcher.ts`: matchPlugins() — compares satellite vs local plugins (matched/missing/version_mismatch)
- Created `src/renderer/services/plugin-matcher.test.ts`: unit tests for all match states

## Phase 4: UI Integration

### 2026-03-17 — #869: Project Rail Satellite Sections
- Created `src/renderer/panels/SatelliteSection.tsx`: collapsible satellite section with divider, status dot, color bar, project list
- Modified `src/renderer/panels/ProjectRail.tsx`: added SatelliteSections component, wired to annexClientStore + remoteProjectStore

### 2026-03-17 — #870: Remote Agent Views
- Created `src/renderer/hooks/useRemoteAgents.ts`: unified hook for remote agent data, isRemoteProjectId helper
- Provides interface for reading remote agents from remoteProjectStore when active project is remote

### 2026-03-17 — #871: Help Docs
- Created `src/renderer/features/help/content/settings-annex-v2.md`: comprehensive help for Annex V2
  - Covers: overview, setup, pairing, usage, locking, security model, troubleshooting
- Modified `src/renderer/features/help/help-content.ts`: registered new help topic
- Modified `src/renderer/features/help/help-content.test.ts`: added topic ID assertion

## Post-Implementation: Test Fixes & Validation Attempts

### 2026-03-18 00:00 — Test fix pass #1 (`965fab7`)
- Updated existing tests for dual-port architecture and new IPC channels
- Tests were written but **never executed** during implementation (no Node.js runtime available in agent environment)

### 2026-03-18 00:10 — Test fix pass #2 (`6e9db7f`)
- Additional test updates for Phase 1 annex-v2 changes

### 2026-03-18 00:47 — TypeScript error fixes (`c5b31bd`)
- Resolved TypeScript compilation errors in annex-client modules
- Indicates the code was written without a running `tsc` — errors discovered after the fact

### 2026-03-18 00:57 — UI integration wire-up (`e44dce3`)
- Wired satellite events, lock overlay, and server lock state into the UI
- Final committed change on this branch

### 2026-03-18 ~01:03 — E2E validation attempt (FAILED, uncommitted)
- Created `e2e/annex-v2/full-demo.spec.ts`: 22-step Playwright test covering the full Phase 4 validation gate
- Created `e2e/annex-v2/minimal-test.spec.ts`: minimal single-instance launch test
- Ran both tests against built Electron app
- **Result: Total failure.** All four screenshots (`00-satellite-initial.png`, `00b-satellite-still-blank.png`, `01-satellite-before-project-ERROR.png`, `minimal-test.png`) show a **completely blank dark window** — the renderer never painted any UI
- The app launched (Electron window appeared) but React never mounted or rendered
- The full-demo spec failed at Step 1 (satellite initial load) and never reached any Annex-specific testing
- Root cause was never diagnosed. Likely causes: build artifact issues, webpack config problems, or missing renderer entry point in the test harness
- No further debugging was attempted — session ended here

## Validation & Fix Pass (2026-03-18)

### Phase 1: TypeScript Compilation — PASS
- `npx tsc --noEmit` — 0 errors
- No changes needed

### Phase 2: Unit Tests — PASS (after fix)
- **Before:** 2 files failed, 16 tests failed (289 files, 7167 tests)
- **Root cause:** `app-event-bridge.test.ts` — missing mocks for `window.clubhouse.annex.onStatusChanged`, `onLockStateChanged`, and `window.clubhouse.annexClient.onSatellitesChanged`, `onSatelliteEvent`
- **Fix:** Added 4 mock methods to `mockRemovers` and `window.clubhouse` stub (`214e307`)
- **After:** 289 files passed, 7167 tests passed

### Phase 3: Build — PASS
- `npm run make` exits 0
- Artifacts in `out/make/` (zip + dmg for darwin/arm64)
- `bonjour-service` and `ws` bundled correctly by webpack

### Phase 4: Blank Screen Fix — PASS (after fix)
- **Before:** `#root` had 0 children — React error #185 (Maximum update depth exceeded)
- **Root cause:** `App.tsx` useLockStore selectors created new objects on every render → Zustand reference-inequality → infinite re-render loop
  ```tsx
  // BROKEN: creates new object every render → infinite loop
  const lockState = useLockStore((s) => ({ locked: s.locked, ... }));
  // FIXED: individual selectors return stable primitives
  const lockLocked = useLockStore((s) => s.locked);
  ```
- **Fix:** Replaced 2 object selectors with 8 individual field selectors (`cdeb13b`)
- **After:** App renders, all 17 smoke-blank-screen tests pass, all 250 e2e tests pass

### Phase 5: Annex V2 Functional Validation — PASS

**Phase 1 Gate (Security) — 7 tests, all pass:**
1. App renders UI (not blank screen)
2. Annex preload API available (all methods present)
3. Annex server enable → status (port, pin, advertising=true)
4. Identity endpoint: `GET /api/v1/identity` → fingerprint
5. PIN pairing: `POST /pair` → bearer token
6. Brute-force lockout after 5 wrong PINs → 429, unlock works
7. Settings UI shows "Annex Server" section

**Phase 2 Gate (Client) — dual-instance test, all steps pass:**
1. Dual Electron instances launch with isolated userData
2. Satellite enables Annex server (dual-port: main + pairing)
3. Identity endpoint returns fingerprint + alias
4. Controller pairs with satellite via HTTP PIN
5. WSS connection with bearer token → receives snapshot
6. Annex settings and Annex Control UI pages navigable
7. Peer management APIs functional

**E2E fixes applied:**
- Replaced broken `require()` calls in `electronApp.evaluate()` with preload APIs
- Fixed WebSocket connection: `wss://` with `rejectUnauthorized: false` for self-signed TLS certs
- Added `ws://` fallback for HTTP-mode servers
- Structural test selector limit updated: 5 → 12 (routing + lock state)

### Phase 6: Full Validation Pipeline — PASS
- `npx tsc --noEmit` → 0 errors
- `npm test` → 289 files, 7167 tests, all pass
- `npm run make` → exits 0, artifacts in `out/make/`
- `npx playwright test` → 250 e2e tests, all pass (including 7 Annex V2 minimal + 1 full-demo)

### Commits
| Hash | Description |
|------|-------------|
| `214e307` | fix: add missing annex/annexClient mocks to app-event-bridge tests |
| `cdeb13b` | fix: resolve infinite re-render loop caused by Zustand selector objects |
| `03dc6df` | fix: rewrite Annex V2 e2e tests — use preload API, fix WS TLS |
| `3d80a12` | fix: update structural test selector limit for Annex V2 lock state |

## Summary of Remaining Gaps (as of 2026-03-18)

1. **Branch strategy was not followed.** All work landed on `mega-camel/annex-v2-862` instead of per-issue branches
2. **No PRs were opened.** The plan called for per-issue PRs into `mega-camel/annex-v2`
3. **Phase 3/4 validation gates (data model, full demo) are partially tested.** Remote project model, lock overlay, and bidirectional PTY require a running agent orchestrator to fully validate
4. **mTLS peer persistence not tested.** PIN-only pairing (without publicKey) returns a bearer token but doesn't persist a peer entry — key exchange pairing untested in e2e
