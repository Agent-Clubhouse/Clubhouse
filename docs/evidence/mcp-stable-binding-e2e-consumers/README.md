# #3738 E2E callable consumers

Frozen source: `c0a278d6e96484394cda8b595a90e32da2af9a12`, branch `fix/3738-e2e-callable-consumers`, parent `0723c341045212306c3966f6b8951b626d95e10f`. This is a five-file, **test-only** consumer/helper delta. Its `src` tree is identical to the parent. The preview successor's 633/14-file importer proof and production type/lint receipts remain bound in evidence `e8a55d50b7b1b1fc1651f712595b5e30be162e03`. Original identity source `807360c543a28848e9359564b7917d0bac425e91`, its evidence `7e362e2cc1f0ea153a5569dad86ec5cfedc00a0d` and original RED proofs remain unchanged.

## Consumer correction

The Dispatcher test previously selected tool names containing the display fragment `conductor`. Opaque bounded keys do not promise that fragment. It now reads current definitions and requires exactly one agent-prefix tool with the exact full `Target.id` and action suffix. Zero or multiple required matches throw; absence assertions explicitly require an empty match set. There is no name-fragment or guessed-key fallback.

The shared selector reads one structured server Target JSON block before the user-guidance delimiter. It rejects missing, duplicate, malformed or invalid metadata, ignores forged Target lines inside user instructions, preserves address case/identity, and rejects the wrong target kind. Twelve pure unit controls cover these distinctions without launching an app.

The Annex crash test actually kills and relaunches its owned sender application. That is a new callable namespace, distinct from in-place hydration. The test now verifies the retired callable returns an error containing `No binding found`, with the actual receiver request log, receiver MCP user-input events and retained receipt unchanged. It then rediscovers exactly one current callable for the **same complete endpoint and suffix**, requires a new name, and submits the **same `firstArgs` object and idempotency key**. The original strict receipt SHA equality, file replay equality, exact file bytes, actual request IDs/counts, final three runtime inputs and retained receipt equality remain intact. `retained-contract.json` records the assertions retained verbatim and identical source trees. No P8 draft or threshold was changed.

## Exact source checks

| Receipt | Result |
| --- | --- |
| `helper-exact.*` | **12/12 PASS**, one pure-helper file, exit 0. No Electron/runtime E2E. |
| `e2e-types-exact.*` | Full scoped type graph of all five changed files, imported E2E dependencies and all repository ambient declarations, exit 0. |
| `lint-exact.*` | Five changed files, exit 0, zero errors / six retained Annex `any` warnings. |

Every exact receipt records source HEAD and source hashes before/after. All checks used the existing measured desktop gate (4 GB helper/lint, 6 GB type), with unchanged matched dependencies. Admission refusals are separate and are not passes. No local E2E, app restart, install or live probe was performed.

The first scoped type attempt inherited the production ES2020 library declarations and found four existing uses of `AggregateError` / `Error.cause` in E2E code. `e2e-types-initial.*` retains that exit 2. Restoring the three E2E consumers from parent `0723c3410` reproduces the same four diagnostics (`e2e-types-es2020-baseline.*`, exit 2; line offsets only). The corrected **test-only** config adds `ES2022` and `DOM` library declarations for the actual Node 22 test runtime; target, `noImplicitAny`, source checking and production config are unchanged. No diagnostic was suppressed or source API rewritten. Both original configs are retained. `tsconfig.e2e.portable.json` is a path-normalized counterpart of the executed final config; its resolved source paths/options were checked for equality, without another compiler run.

Portable commands, through the existing approved admission script and matched dependencies:

```sh
desktop-test-gate.sh mcp-stable-binding-name 4 -- node node_modules/vitest/vitest.mjs run test/mcp-target-tools.test.ts --maxWorkers=1
desktop-test-gate.sh mcp-stable-binding-name 6 -- node node_modules/typescript/bin/tsc --noEmit -p docs/evidence/mcp-stable-binding-e2e-consumers/tsconfig.e2e.portable.json
desktop-test-gate.sh mcp-stable-binding-name 4 -- node node_modules/eslint/bin/eslint.js e2e/annex-v2/agents-across-machines.spec.ts e2e/dispatcher.spec.ts e2e/mcp-agent.ts test/mcp-target-tools.test.ts test/mcp-target-tools.ts
```

## Historical hosted failures are retained

Original run `44876043424` completed **FAILURE**, not cancelled or waived. `original-hosted-final.json` pins its source and every job's final outcome. The preview bundle retains the exact Ubuntu2/Windows1 JUnit ZIPs, three Playwright/JUnit trace ZIPs, lossless original logs, artifact digests and the existing main `c0cf2f1974b98a9418f1682284c6535d1a1e396b` run `44875569706` comparison. Main's corresponding unit/Chat/Annex jobs passed, and the E2E specs were identical before this correction. Existing artifacts were inspected before any new execution; no main rerun was requested.

Both Chat3 platforms fail at the old `conductor` selector. Both Annex1 platforms fail when the old pre-crash name is used. The original Annex trace only records `duplicate.isError === true`; it does **not** attach the response text. The namespace explanation is source-derived, and the corrected hosted flow must explicitly observe the refusal text and current endpoint behavior. No old-name acceptance was added.

This bundle additionally preserves the exact Windows Annex1 trace ZIP (artifact `14696516899`) and Windows unit2 JUnit ZIP (artifact `14696766675`), plus losslessly compressed raw logs. Download SHA-256 equals each GitHub artifact digest; archive-entry JUnit byte counts and SHA-256 are in `manifest.json`. Gzip decompression restores the exact original log bytes.

Windows unit2 also timed out in `src/main/services/managed-agents/restart.test.ts:91`, case `exposes current applicability and only a successful current running delivery`, at the existing 5,000 ms limit in an 1,122.68-second shard. The body begins with dynamic imports; the timeout stack identifies the test definition, **not the exact pending await**. File identity and existing-main success are not root-cause proof. This historical exception is unresolved, has not been classified as infrastructure/flakiness, and neither its timeout nor unrelated managed-agent code was changed. It must be investigated if it recurs in the ordinary corrected-head run.

## Remaining acceptance

Independent exact-delta QA is required before the single existing PR #3751 is updated. Ordinary hosted validation of that reviewed head supplies the runtime E2E gate; green hosted results are not a prerequisite to making that permitted reviewed PR update. The actual changed E2E flows have **not** been run locally. Historical RED, strict receipt semantics, namespace invalidation, permissions and release/refusal boundaries remain intact. There is no blind retry, waiver, extra PR, old-namespace alias or merge action; the parent owns the final guarded merge after green.
