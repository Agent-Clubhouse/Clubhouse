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
