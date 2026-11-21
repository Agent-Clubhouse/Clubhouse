# Independent QA: Q5 R1 confirmation

Reviewer: qa-details-local-composition. November 21, 2026.
Target: `d0316e4769c22f1cc67fd808ef7a019e47d0b246`, tree `31eea077…ee36f` (`origin/auto-reset-policy-design/q5-durable-delivery-ledger`, remote verified).
- One docs commit adding 35 lines on top of the approved revision 2 `ebb062602`.
- `docs/design/q5-durable-notice-ledger.md` SHA256 `13548a82…fa758d` matches.

Method: I read the diff only and ran nothing. There is no product proof.

## Verdict

**R1 CONFIRMED.** The post-ID baseline and adoption contract may proceed to implementation. The revision 2 approval and all of its controls carry forward unchanged.

## Checks

- **Pages first:** baseline index pages (≤256 KiB each) and, for large page lists, bounded immutable index nodes are written first. Every page and node is file-synced, followed by a directory sync before activation.
- **Inert until activation:** the pages are inert orphans, neither coverage nor proof of a consumed nonce.
- **Bounded root reference:** a reference with digest and aggregate count, with no embedded IDs and no unbounded page list in the delta.
- **One small activation record (≤64 KiB)** carries the root reference and digest, the expected old revision and generation, fresh-generation creation and, for adoption, nonce consumption. Only its verified committed revision exposes the new generation.
- **Before the record:** a failure or crash leaves the prior generation and the prepared nonce unchanged, with no partial baseline and no send from orphans.
- **After the record:** the whole referenced baseline and the consumed nonce recover once, with no replay and no second adoption.
- **Missing or corrupt referenced page after activation:** that shard is refused, with no fallback to an empty baseline.
- **Orphan cleanup:** separate, bounded, and only after non-reference is proven. It is never a reset.
- **Required control:** an actual baseline of more than 64 KiB, cut during page writes, after page syncs before activation, and after the record sync. Assert:
  - no partial generation;
  - no early nonce consumption;
  - inert orphans;
  - complete recovery after the record;
  - no replay;
  - a double-submit returns the same consumed result.
- **Privacy:** post IDs that carry timestamps stay local in userData and are never exported to logs, telemetry or Go fixtures. The status shows the retained byte size and the unbounded post-ID storage consideration.
- **Sequenced path:** initialization uses a scalar baseline and is unaffected.

## Note (implementation control, not a contract gap)

Also cut **during the activation-record append**, a partial tail. The revision 2 rule already covers this: an incomplete last record is ignored and authorizes nothing, so the prior generation and nonce stay intact. Include it explicitly in the crash matrix with the other three cuts.
