# Reverse binary transport (3613 P6, partial)

`/control` negotiates `bulk` independently on each connection. No new frame
reaches `/ws`, phones, `/network` or a peer that omitted the capability.
P2's route selection and P7 remain separate; this slice exposes the existing
request/subscription interfaces over the connection already opened by the target.

Existing attachment uploads, clipboard images, handoff chunks and manifests,
content previews, icons, full events and file reads use the bulk lane. The
handlers, peer identity, attachment ownership, handoff acceptance and content
validation remain the direct path's. No upload UI or new file operation is added.

A start frame binds a random transfer UUID to an operation id, type, size and
small metadata. Binary frames contain that UUID, a uint32 sequence and at most
64 KiB. One receiver credit permits one chunk. A final SHA-256 covers the exact
body bytes. No handler sees an unverified body. At most four transfers run in
each direction per connection; metadata is limited to 16 KiB. A stalled lane
closes after 30 seconds without progress. Valid body progress refreshes the
requester's response timeout, matching HTTPS idle timeouts on long transfers;
explicit AbortSignals and service deadlines still apply. Bulk writes yield after each chunk
and wait below a 128 KiB socket watermark, letting control/event frames go first.
The existing 16 MiB socket backlog policy still applies to control traffic.

Every start, chunk, credit, finish and actual deferred socket write rechecks the
pinned connection's authority. Clipboard transfers additionally require the
same live subscription at delivery. Cancellation, unsubscription, revocation and
disconnection discard incomplete transfers. A single per-connection ledger
reserves every transfer UUID in both directions, retaining its operation id for
the connection's lifetime after completion, cancellation or failure. Late bytes
cannot bind to a replacement operation. The ledger never evicts: at 262,144
UUIDs it closes the connection before admitting another transfer. This bounds
history while accommodating a maximum 16 GiB handoff's request/response pairs;
a fresh authenticated connection starts with independent history. No frame supplies a caller identity. Services
also fence their actual filesystem writes/reads after their own awaits, and
roll back attachment files if staging loses its caller before publication.
The attachment fence also retains the exact runtime and durable/quick-agent
registration across body/staging awaits. Handoff acts check the current record,
immutable agreement, acceptance, descriptor ownership and request lifetime,
plus a request-scoped saved-grant revision and policy generation lease.
Connection, binding and orchestration changes invalidate that lease; secret
policy revisions are checked at every actual open/read too. Async authorization
runs after descriptor/path stats, followed by the synchronous act fence.
Tool-list notifications also announce ordinary handoff acceptance/progress.
Each notification re-reads the captured authority values; unchanged values
preserve the lease. Real orchestration/cross-project/control or effective-grant
changes invalidate it, including a change restored before the await resumes.

Limits remain the existing ones: clipboard 10 MiB **base64** (7.5 MiB decoded),
attachment images 3.75 MiB raw, full events 32 MiB, content's existing 8 MiB
raw bytes (about 10.67 MiB after base64 encoding), icons 72 KiB, and handoff responses 3 MiB (256 KiB artifact reads).
The clipboard error sent over `/ws` remains exactly
`clipboard:image data exceeds 10MB limit`. The same guard now protects its
shared service entry point before decoding. Phone fixtures are unchanged.
Route handlers enforce their field limits; the content response's transport
budget includes room for its JSON metadata.

File reads retain **no reverse-only total cap**. The host still reads the whole
text file before responding, exactly as on the direct path. The current HTTPS
requester also buffers chunks and concatenates the complete response
(`satelliteHttpsRequest`/`satelliteJson` in annex-client.ts); the control requester
keeps that same consumer buffering. The wire lane adds only bounded in-flight
chunks and no whole-response base64/JSON encoding, disk spool or additional
whole-file transport buffer. This does not make the existing file consumers
streaming APIs or remove their existing memory cost.

The public tools and built-in agent instructions keep their existing behavior:
no arguments, permissions, limits or user steps change. Handoff resume still
uses the existing file offsets and per-chunk hashes; an interrupted ordinary
read restarts through its existing caller. Nothing automatically retries a
non-idempotent request with a lost reply.
