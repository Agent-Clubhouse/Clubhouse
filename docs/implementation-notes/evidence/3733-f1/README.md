# F1 evidence: Connections omission expectations

Source: commit `7daca0e3e` on `details-local-composition/3733-f1-parity`. The change is test-only (`src/main/services/remote-connection-endpoint-fields.test.ts`). These are copies of raw output with path prefixes replaced; `SHA256SUMS` lists the raw files and these copies.

Before the fix, on `5e3e21cfe`, the file failed 2 of 17: `bounded-page` omitted 142 against an expected 112, and `bounded-identity-page` 21 against 20. See `../3733-local-successor/focused.txt`.

Arithmetic:

- `9f2354d0d` emits one more row per manual pair (`manual source eligibility`) and counts manual fields as 3 instead of 2 (`remote-connection-card.ts:262`).
- `bounded-page`: 2 host rows plus 30 directions of 8 fields is 242. With 100 shown, 142 are omitted. The eligibility row appears among the shown rows.
- `bounded-identity-page`: 34 terminal bindings and one manual pair total 121 fields. With 100 shown, 21 are omitted. The manual pair falls past the row cap, so its eligibility row is absent and counted as omitted.

| File | Command | Result |
| --- | --- | --- |
| `f1-tests.txt` | The test files run | The `remote-connection-card` importer suite plus the endpoint-fields file |
| `f1-pass.txt` | `vitest run --no-cache --maxWorkers=3 --reporter=verbose <f1-tests>` on `7daca0e3e` | 71 passed, exit 0 |
| `f1-mutation.txt` | The same file with `(pair.manual ? 3 : 0)` changed to `2` in `remote-connection-card.ts`, then restored; the diff is included | 2 failed (125 vs 142, 20 vs 21), exit 1 |
| `validated-head.txt` | `git rev-parse HEAD` | `7daca0e3e` |
