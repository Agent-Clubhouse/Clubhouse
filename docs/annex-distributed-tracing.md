# Annex distributed tracing v1

This additive contract pairs with Clubhouse-Go PR #109. It does not configure a
collector, transfer exporter credentials, or turn on remote export. The fixture
in `docs/fixtures/annex-tracing-v1.json` is the cross-client source of examples.

## Recording and destinations

Desktop defaults to enabled local recording at Standard, independently of export.
Request spans now run at Standard. Existing rolling file/session budgets still
apply. Disabled recording disables new trace production and propagation. Each
export destination remains independently enabled and filtered; the remote peer
cannot enable collection or change the local sampling rate.

`service.name=clubhouse` and `service.instance.id` is a random UUID v4 created once
per process. The same ID appears in the local session header, handshake and
exporter resource. Phone uses `service.name=clubhouse-go` with its own process
UUID. Neither side copies the peer identity into its own resource.

Desktop generic OTLP uses HTTP/JSON `/v1/traces`. Framebriar wraps that exporter
with a separately authenticated feedback session; that session is not a trace or
process identity. Azure Monitor uses its native exporter, not an OTLP ingestion
endpoint. A phone OTLP exporter therefore needs an appropriately configured
collector/backend adapter; pointing it at Annex or copying a desktop connection
string is not an integration. The existing mock-ingestion test now checks Azure
serialization of the process instance and distributed trace IDs. It cannot prove
a live backend's retention, access, or cross-service queries. No live export was
performed for this change.

## Authenticated capability handshake

After mTLS WebSocket authentication, send:

```json
{"type":"telemetry:hello","payload":{"version":1,"serviceName":"clubhouse-go","serviceInstanceId":"11111111-1111-4111-8111-111111111111","connectionAttemptId":"22222222-2222-4222-8222-222222222222","traceContext":"w3c-v00"},"tc":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"}
```

Host returns `telemetry:hello:ack` with payload fields:

- `version: 1`, `serviceName: "clubhouse"`, `serviceInstanceId`: host process UUID.
- `peerServiceInstanceId`: the validated phone process UUID.
- `connectionAttemptId`: echoed phone attempt UUID; `connectionId`: fresh host socket UUID.
- `traceContext: "w3c-v00"`, `recording: "off"|"errors"|"standard"|"detailed"`, `sampling: "local"`.

All UUIDs must be lowercase UUID v4. Additional input fields are discarded, not
reflected. A repeat hello can repeat the same identities, but cannot change them
on an existing socket. An unsupported/malformed hello or bearer hello is ignored.
The hello span may carry validated ephemeral peer/connection/attempt UUIDs; these
are span attributes, never metric dimensions, authentication, hardware IDs or
stable installation identifiers.

Process restart changes the instance UUID. Reconnect keeps the process UUID but
creates a new attempt UUID and socket UUID. Multiple phones/hosts have separate
process/socket identities. No handshake is required for old clients; new fields
are additive and existing authentication and command semantics are unchanged.

## Per-operation context and response semantics

HTTP: `traceparent` request header, and `traceparent` response header containing
the host request span. Only mTLS-authenticated controller context is consumed
(including pinned mobile); bearer and unauthenticated contexts are ignored.
WS: optional top-level `tc` is the same header value. Supported authenticated
spawn/wake/kill commands have a bounded host span; replies and directly caused
events carry its context. The handshake's `tc` belongs only to the handshake.

The current receiver policy accepts version 00, lowercase nonzero trace/span IDs,
a fixed 55-byte encoding and sampled bit set. Other flag bits are normalized.
Malformed, duplicate, future-version and unsampled input starts independent local
work; it cannot suppress or force recording. No `baggage` or `tracestate` is
accepted. This deliberately bounded interoperability policy is narrower than
full W3C forwarding. See https://www.w3.org/TR/trace-context/.

REST lifetime includes callback body handling and response completion/close.
Nested agent roots continue the request only while that bounded scope remains
active; retained process callbacks cannot attach later roots to it. Each command
retry gets its own request span. Existing command deduplication does not execute
agent work twice; its original work/events keep the original context.

Chat prompt dispatch carries an explicit, expiring context to driver turn events,
including the app-managed queue. Context is memory-only, never transcript or chat
payload content; only the outer Annex event envelope has `tc`. The aggregate
agent-turn span retains its originating request parent even after HTTP completes.
Later unrelated turns cannot inherit a previous turn. Context expires after one
hour and is dropped on queue removal/session replacement; no per-token spans.

Replay stores each event's original `tc` alongside its existing bounded sequence
record. Reconnection does not rewrite it. Phone should make an explicitly marked
receive/replay span or link to that context, never reparent the original agent
work or count replay as new model latency.

## Evidence and remaining end-to-end limits

Hosted tests cover parser/privacy boundaries, local-only continuation, nested
roots and expired request scopes, asynchronous queued chat events, replay context,
handshake fixture identity and Azure mock serialization. No local tests, builds,
app launches, pairing or live exports are part of this work.

A raw PTY stream has no reliable per-turn boundary and is not assigned a guessed
chat trace. Native provider-managed queue dispatch currently lacks an exact
message-to-turn correlation signal. Steering contributes to an existing turn;
it does not replace that turn's original parent. Native queue/steering causal
links need provider acknowledgement support before complete coverage can be
claimed. Phone-host physical-device integration and a common approved ingestion
adapter/query remain unverified. A green draft is not evidence those gaps closed.
