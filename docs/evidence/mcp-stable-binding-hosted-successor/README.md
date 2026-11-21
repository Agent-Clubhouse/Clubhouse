# #3738 final hosted evidence

PR [#3751](https://github.com/Agent-Clubhouse/Clubhouse/pull/3751) was merged by the parent on 2026-11-21T07:33:46Z as `daa7dab5e3db78280ba845602bbcfd7e5f73cf0c`. The reviewed source is `c0a278d6e96484394cda8b595a90e32da2af9a12`; final independent QA is `4f2175d637b69728c7038e56c8eeb27b33e04d61`. This evidence branch changes documentation only.

[Hosted run 44879425441](https://github.com/Agent-Clubhouse/Clubhouse/actions/runs/44879425441) completed successfully: 33 successful jobs, zero failed or pending, four policy skips. Skips are dependency preflight (ordinary PR), Linux package smoke (ordinary PR), and the two paused macOS jobs; they are not counted as passes. All four Linux/Windows unit shards and all enabled E2E shards passed.

Actual Plan checkout was `596ad681aa4385185b3dc30e5fb82249f280b49c`, parents `6130b29669f58c8a7bad112aa745d4ca43775971` and reviewed source `c0a278d6e96484394cda8b595a90e32da2af9a12`, tree `cf169e860c3786939aee75fcef1d7e2e7ba28349`. Plan raw log and Git object metadata are retained. The PR API's cached base field is not used as checkout proof. The final squash parent `53524110b90d053053d6ed49fd480816b8fcaee6` contains a disjoint intervening P2 change. `merge-composition.json` records its file set and SHA256 for all 19 fix files, which are byte identical between approved source and squash. No automatic broad retest was performed for that disjoint composition.

The four directly affected Chat/Annex Linux/Windows jobs passed on their first attempt, with no retry/flaky records in the retained raw logs. Exact GitHub ZIP bytes and JUnit are preserved, and their download SHA256 matches the API digest. Chat target case timings: Ubuntu 3.837s, Windows 6.285s; Annex durable replay case: Ubuntu 10.907s, Windows 14.44s. The Annex passing source asserts old callable refusal without forwarding, current exact-target rediscovery, identical first arguments/idempotency, strict receipt SHA/equality and single delivery. Both archived delivery boundaries carry resultHash `3153f48fdb8b158484313fe653ae5628d8d0645f61ed343caab3e9e59e36ae27`. Archived request JSONL records first call twice, next call once, file call once, four requests total. `hosted-44879425441-artifact-manifest.json` records their exact entries, hashes and values.

The inline `durable-replay-witness` body is not retained by the existing archive/JUnit configuration. The passing assertions, boundary JSON and request JSONL are retained; this bundle does not claim archived old/new opaque callable values.

The previously timed-out Windows unit case (`restart.test.ts`, built-in skill status #3517) passed explicitly, unskipped, in 0.4173173s. Its original timeout remains historical and unresolved: this is no root-cause-fixed claim. Original RED logs, traces, exact tests and existing main comparison remain separate in the earlier evidence below.

Immutable prior evidence:

- Original baseline, discriminator, mutations and gate refusals: `7e362e2cc1f0ea153a5569dad86ec5cfedc00a0d`, `docs/evidence/mcp-stable-binding-name`.
- Preview successor, exact local checks and original hosted RED: `e8a55d50b7b1b1fc1651f712595b5e30be162e03`, `docs/evidence/mcp-stable-binding-preview-successor`.
- Final consumer exact-head helper/type/lint proof, retained ES2020 baseline typing limit and ES2022 Node22 test-only qualification: `e86254490b5860c431ed41936352d254b6ac543e`, `docs/evidence/mcp-stable-binding-e2e-consumers`.

No local E2E, full P8 acceptance, federation review, release, live access/settings change, install or restart is claimed. This closes only the approved #3738 contract.

Verify downloaded bundle bytes from this directory with `shasum -a 256 -c SHA256SUMS`. Logs are lossless deterministic gzip; `manifest.json` records the uncompressed SHA256. Reconstruct exact raw logs with `gzip -dc FILE.log.gz > FILE.log`. No test rerun is needed to inspect this evidence.
