# Reset-aware Auto implementation evidence

Source base: approved design/replay `f386b143fda60d969c705dcb397c9458b6ae0035`. Implementation branch: `auto-reset-policy-design/implement-reset-aware-auto`. Behavior and deferred measurement are documented in [the implementation guide](../../helper-auto-reset-implementation.md). No live setting activation, installation, provider start, PR/merge or release is implied by owner checks.

Development checks observed before the final frozen-head receipts:

- Pure production policy, existing legacy policy, real settings persistence and schema:72 tests /4 files passed.
- Initial integration batch:811 passed /10 failed. Four assertions still expected policy version3, four new persistence cases accidentally used the old unknown-quota mock, and two UI assertions read the pre-save view after a mocked response had replaced it. Corrected fixtures/expectations; no production-policy bypass was used to make them pass.
- Corrected production routing, real queued-write/start races and UI:204 tests /3 files passed.
- Initial root ES2020 compiler run was refused by the existing Go compile hold; a later run found two implementation typing errors, both corrected. Full root `tsc --noEmit --project tsconfig.json` then passed with the existing byte-matched dependency cache. This is a full root project pass, unlike the historical design's scoped ES2022 receipt. Root config excludes test files as before.
- Targeted routing contract producer run:4 passed /64 intentionally unselected. Routing-only regeneration/check writes only eight named routing fixtures and preserves other fixtures. Routing sample command ids and relative saved revisions are normalized independently from unrelated producer cases; global UUID bookkeeping for unrelated fixtures is retained.
- Scoped changed-source ESLint passed with0 errors and existing warnings in large legacy test files.

Historical design evidence remains under `../helper-reset-policy/` with its original scope and failures, never relabeled as implementation proof. Development raw output remains in the owner's external evidence directory and is not retroactively sealed.

Final review receipts use `sealed-validation.py` **inside** the existing desktop gate. It requires a clean committed worktree, captures exact HEAD/tree and source SHA256 before/after each command, records exact argv/exit/raw output, and rejects source/head/tree/environment drift. Receipts write outside this worktree; their immutable source target is the implementation commit. Before/after sealing is not continuous monitoring or independent approval. Final raw output and transfer notes may be preserved on a separate normal evidence branch so they can bind the frozen implementation head without changing it.

Dependency validation uses the existing lock cache whose directory/lock hash matches the unchanged repository `package-lock.json` byte-for-byte. Only package links are created under this worktree's ignored `node_modules`; shared `.vite`, `.vite-temp`, `.cache` directories are excluded so test cache writes remain local. The prior worktree directory is retained and restored after validation. No installation, lockfile update, shared dependency write or cache transfer to another host is performed.

Gates: tests/lint min4GiB, compiler min6GiB, Vitest maxWorkers2 total; gate75 retries no sooner than60s. Ordinary feature checks are scoped to routing, persistence, UI, quota/pressure, schemas, local receipts and protocol fields. The routing protocol check is:

```sh
ANNEX_MOBILE_ROUTING_FIXTURES=check /Users/masonallen/.clubhouse/orch/desktop-test-gate.sh auto-reset-implementation 4 -- python3 docs/evidence/helper-reset-implementation/sealed-validation.py --output-stem /absolute/external/evidence/protocol -- node node_modules/vitest/vitest.mjs run --project main src/main/services/annex-mobile-contract.test.ts --maxWorkers=2 -t 'capabilities|helper presets|every command type has an accepted request and receipt|fixtures on disk match'
```

No task-quality, live quota savings, rate-prediction accuracy or physical reserve guarantee is measured. Burn pace/deficit estimation remains deferred and is labeled absent. Epoch-invalidation tests cover expired observations and old group evidence; actual task completion across resets is not measured. Independent exact-head review is required before PR creation. CI, landing, release and live opt-in remain separate gates; no ownership transfer occurs merely because source/notes were delivered to another host.
