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
