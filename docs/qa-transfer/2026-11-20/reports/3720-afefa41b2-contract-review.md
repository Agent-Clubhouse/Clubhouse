# Independent QA: #3720 negotiated durable member names contract

Reviewer: qa-details-local-composition. November 21, 2026.
- **Target:** `afefa41b2c8e1998979d44d383467a21c454e51e` (`origin/annex-wake-readiness/3720-rename-ordering`, remote verified), docs only on `d8c7247a4`.
- **Files:** `docs/implementation-notes/3720-negotiated-member-names/{contract.md, fixtures.json, SHA256SUMS.txt}`. Both SHA256 entries match. Product code, scripts and the lockfile are unchanged.

Method: I read the contract and fixtures. **I independently recomputed the canonical hash encoding offline**; this was not product execution. No product code ran. The fixtures are an inventory, not executed proof.

## Verdict

**APPROVE the contract design, with 3 required clarifications (R-a to R-c) to settle before product code.** The proposed hunks in §7 still need separate writer clearance; this approval does not grant it.

## Sound

- **Negotiation:**
  - A bilateral pinned `/network` request and response header (`X-Clubhouse-Member-Names: 1`). Raw occurrences are read case-insensitively, and only exactly one occurrence of `1` surrounded by SP/HTAB counts.
  - Duplicates (including differently cased or identical values), comma lists, empty or unknown values and values over 16 bytes all decline to legacy without disconnecting.
  - Old servers never manufacture the header, and subprotocols are correctly avoided.
  - Ordering: client-first `member-names-ready` only after the unchanged v1 hello **and** active confirmed membership. The server acks only once active. Duplicate ready or ack is idempotent.
  - State is per socket and renegotiated on every reconnect.
  - Extension frames on unselected sockets, before completion, or as the first frame are refused (4400). An unsupported version on a selected socket gets 4426.
  - The legacy codec, its keys and its five types are unchanged, so **no extension frame ever reaches an old socket**.
- **Authority:** capability grants nothing. Existing pin, hello and member-role checks plus reciprocal confirmation still apply. `by` is a tie-break and provenance claim, not authentication, and logs keep the real sender. One-to-one, pending and network-off peers don't participate. No record introduces members or changes pin, pairing, route, note or grants.
- **Records and epochs:** a record targets `(fingerprint, joinedAt, pairingId?)`. A missing ID never matches a known ID, superseded or removed epochs are ignored, and removal is processed before names.
- **Ordering:** by `(at, by, id)` using numeric and ordinal comparison.
- **Canonical hash:** an ASCII domain followed by six length-prefixed UTF-8 fields, with no JSON, locale or newline conversion.
  - **Verified independently:** all 5 `hashVectors` (canonical bytes and SHA256, including the non-ASCII `'Studio ☕ 🚀'`) and all 8 embedded records match my recomputation.
- **Durable monotonic clock:** a local stamp is `max(now, maxPersisted+1)`, persisted atomically with the winner before any acknowledgement, broadcast or projection. A→B→C→A works with no name veto. Records more than 24 h in the future are skipped individually. Identical replay is a no-op and can't freshen ordering. `renamedAt` becomes a legacy floor only, with no invented operations.
- **Revocation:** merges are serialized. Sender pin, pairing and target epoch are captured and rechecked at the durable commit, and delayed work after revocation, repin or departure neither commits nor publishes.
- **No remote Settings write:**
  - A remote rename of this machine changes only membership metadata and projection, never the Alias preference or any Settings surface.
  - A local Alias change goes through a durable pending intent before the Alias write, then activation. Crash recovery activates only if the stored Alias matches, and never retimestamps.
  - `USE_LOCAL_ALIAS` takes no settings object.
- **Legacy convergence:** honest.
  - Modern edits also emit the v1 `member-renamed` event.
  - A legacy event becomes a record with its original `at` and the actual sender as `by`.
  - An unstamped legacy hello or member list can't overwrite an ordered name. This fixes the original stale self-hello overwrite even against old peers.
  - An old owner's Alias-only change can't supersede an ordered name; this is stated as a limit. Convergence is promised for negotiated participants only.

## Required clarifications before code

- **R-a: whitespace and trim rule.**
  - "Nonempty after local trim", combined with "hash the exact provided UTF-8 bytes", leaves open whether a record may carry leading or trailing whitespace. Legacy `renameMember` trims.
  - Specify: writers **must** create records with trimmed names, and receivers either refuse untrimmed names or accept them as-is. Pick one and add a vector.
  - Otherwise cross-language implementations (Go) may disagree on validity and display.
- **R-b: legacy names that are malformed or over the limit.**
  - The legacy writer does `name.trim().slice(0, 200)` on UTF-16, which can split a surrogate pair and leave a lone surrogate. The contract requires well-formed Unicode.
  - Specify what happens to an authenticated legacy `member-renamed` whose name is ill-formed: skip it visibly, or keep it as an unstamped fallback only. Never silently drop it while claiming the event was applied.
  - Add a fixture.
- **R-c: trust for local-only IPC.**
  - `USE_LOCAL_ALIAS`, and the now-awaitable Rename and SAVE_SETTINGS intent path, publish network-visible name operations.
  - Apply the same sender validation as Q5: registered main-window WebContents, `senderFrame === mainFrame`, the app-entry URL, and refusal of plugin webviews, popouts and subframes.
  - "Local-only" must be enforced, not just intended.

## Implementation controls and observations

1. **Fixtures:** add a hash vector with **no `pairingId`**, which encodes the empty field as `0:`. All current vectors carry one. Also add vectors for a name of exactly 200 code units, a supplementary-plane character at the boundary, and (after R-a) whitespace.
2. **Clock ratchet with skew:** accepting a remote record up to 24 h ahead raises `maxPersisted`. This node's later local stamps then sit near that future time. A peer whose clock is a few hours slow may then see them as more than 24 h ahead and **skip them**, so the two diverge until wall time catches up.
   - This follows from the design, and there's no safe cap without breaking monotonicity. Document it with the O05 case, and test a ratcheted node renaming toward a slow peer.
   - It's the same skew trade-off D209 already accepts.
3. **Epoch cap:** define what is visible at the 256-target-epoch cap: refuse new name records for further epochs visibly, with no silent drop or eviction of ordered names.
4. **Store loss:** a missing or corrupt store fails new name writes and degrades without a clock reset. Specify how first-run absence is told apart from loss after initialization, for example with a marker like Q5's. Otherwise a deleted store silently re-initializes. That is low impact here because the clock is wall-time based, but say so.
5. **Details fences:** the reserved `annex-client.ts toPublicConnection` projection must change only the label. It must not touch `snapshotReceipt` or `connectionGeneration` gating (#3733 O1 and the receipt rules). Include a regression assertion.
6. **Header hook timing:** the server's `WebSocketServer` headers hook may run before pinned authentication completes. That's harmless, because capability isn't authority, but the ack and all name data must follow the existing authentication and membership checks, as specified. Test an unauthenticated or invalid-pin upgrade that sees no extension behaviour.

## Not authorized here

No product code, hunk clearance, release, install, activation, link or grant change, live probe or mobile adoption. Implementation needs a deterministic baseline, green on the exact source with a manifest, independent exact-source review, and hosted CI.

## Addendum: integration concerns against current main `be29c82a5` (source inspection; the draft is unchanged)

**I-1: SAVE_SETTINGS transaction ordering (P7w).**
- Current main serializes Annex settings saves through `settingsWrites` (`src/main/ipc/annex-handlers.ts:181-193`). The contract's pending local Alias intent must run **inside that existing queued clone and apply transaction**: reserve the intent, persist settings, emit settingsChanged, apply the network settings and retire the read lease, then activate the intent.
- It must not run in a second queue or outside the chain. Otherwise a concurrent P7w save could interleave between the intent and the Alias write, or apply network settings before the intent exists.
- §5 and the §7 reservation for `annex-handlers.ts` need restating against `be29`, with P7w owner confirmation.

**I-2: a getter-only overlay misses existing display seams.**
- §6 and §7 project names through `getPeer`/`listPeers`. But `annex-peers.ts` also exposes `peekPeerAlias` (:100) and `capturePeerPairingForDisplay` (:200), which read cached peer data directly for display and Details receipts.
- If they keep reading the raw stored alias, Details and other labels would show stale names, and any name-version or receipt currentness would diverge from the projection.
- **Required:** an explicit, no-IO, loaded-cache projection seam that **every** display reader uses, including these peeks, with a currentness or version token that Details receipts can include.
- Settle the exact seam with the Details owner before code (the parent has asked). Add a control: a remote rename updates every display path, including Details pairing display and peeks, without reconnecting and without changing pins, pairings or receipts.

**Hash vectors:** the parent reports that the five cross-language vectors matched in Node and Python. My independent offline Python recomputation also matched all 5, plus the 8 embedded records. This is a documentation and encoding consistency check, **not runtime or compatibility proof**.

**Updated verdict:** approval of the contract design stands, now with **5 required items before code**: R-a, R-b and R-c, plus I-1 and I-2.

**I-2 wording clarification (requested by the parent):**
- A remote rename **should** advance the **name display-currentness token**, the name version that display readers and Details include, so labels refresh.
- It must **not** change pairing authority (pin, pairing ID, roles, routes, notes or pairing display receipts as authority), and it must not change the #3733 `snapshotReceipt` or `connectionGeneration` semantics.
- My earlier phrase "without changing pins or receipts" means those authority and #3733 receipts, not the name-currentness token.
