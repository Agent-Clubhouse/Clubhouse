# M2: the Helpers card reports a refused page

Branch `details-local-composition/3733-m2-helpers-refusal` from `main` `d8c7247a4dccc1ebff01f0f28f8e61279bdf5437`. Source commit `5640526d70dae737b76b1bf0ee1ab98ee8363be7`. Renderer only: `RemoteHelpersCard.tsx`, `RemoteAgentDetailsView.tsx` and their tests. Sanitized copies of output.

## Change

`RemoteHelpersCard` takes `onRefused` and calls it when its helper page read returns `forbidden`, the same pattern the Actions and Canvas pages use. Both call sites in `RemoteAgentDetailsView` pass `() => setRetry((n) => n + 1)`: the Details column and the sleeping inline view.

## Proof

- `red.txt` (main, new tests, source unchanged): the forbidden card case and the view re-read fail. The error, offline and ok card cases pass.
- `green.txt`: 6 files, 145 passed, with a fresh `TMPDIR`. Pre- and post-status clean.
- Mutations, each with a byte-identical restore and post-restore status:
  - `mut-card-callback.txt`: dropping the forbidden callback fails the forbidden card case.
  - `mut-view-wiring-precise.txt`: removing `onRefused` from the Details-column call site only fails the view test.
  - `mut-view-wiring-BROADER-also-canvas.txt` (no credit): a first attempt whose replace-all also removed the Canvases card's identical `onRefused`. It is kept as recorded; the precise run supersedes it.
- `tsc.txt` exit 0. `lint.txt` exit 0. `store-*.txt`: shared store unchanged.

Gaps:
- The sleeping inline call site's wiring has no dedicated discriminating test. It is the same prop on the same component.
- No full suite was run.
