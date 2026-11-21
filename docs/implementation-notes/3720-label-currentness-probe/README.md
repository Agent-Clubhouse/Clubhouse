# Full-list label notification counterexample

Test-only source `7d06c7882`, based on the unapplied source/design freeze
`dff3337e6a5519790a4b4d76b0cd23f163c4eab7` and main c43. No client, handler,
renderer store or other product body was changed. This is intentionally red
diagnostic evidence, not a PR candidate or a product regression attribution.

The proposed handler observer would send a current `getSatellites()` list directly
through SATELLITES_CHANGED when its name signature first changes. This test feeds
that equivalent payload into the **real existing** renderer listener and projection
stores, with the initial getSatellites promise still pending. The initial catalog
is empty. The test does not actually apply/run the proposed handler patch.

Actual root-config renderer result: **2 failed, 1 passed**. Both no-hydration
assertions fail: with an absent receipt and with an already-eligible unchanged
receipt, the full list hydrates the cached agent as running. The Alias updates and
only the one original startup GET is called. The failure occurs at the agent
assertion before the following permission assertion, so permission hydration in
these failing cases is not separately credited. The positive control proves an
alias-only clone preserves sleeping/retired run status and a settled permission
when a catalog/source baseline already exists.

Exact path: annexClientStore onSatellitesChanged → reconcileSatellites; when
missingCatalog is true and the payload is connected with a cached snapshot,
the existing normal host path calls applySnapshot. That is expected for genuine
host metadata. An additional name-only signal cannot reuse that authority path
while promising no hydration in all startup states.

Therefore **do not implement the dff handler observer unchanged** under the
label-only/no-hydration requirement. The pure getter alias projection is independent,
but notification needs a separately reviewed label discriminator/renderer seam
(or an explicitly different authority contract), including late initial/manual
read ordering. Do not silently invent an event/schema, replay snapshots, alter
receipts/generations, or weaken ordinary host hydration.

The previous proposal already labeled this initial/unknown-signature behavior
unaccepted and required this discriminator. This actual negative result replaces
that uncertainty; it is not erased by static patch applicability. No whole Q5
prerequisite, store approval, negotiated naming, live app or full-duplex conclusion.

The raw receipt binds actual HEAD, source before/after hashes, command, root config,
runtime setup, one-worker/no-parallel/no-cache flags, matched 1,176 dependency
versions, local CPU/load and full output. The source fixture was committed; the
recorder was committed with it. The test file uses mocked IPC transport but real
renderer state stores; it does not prove main/preload/Electron delivery ordering.
