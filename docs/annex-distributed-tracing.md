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
it does not replace that turn's original parent. Overlapping prompt dispatches before a driver turn boundary are treated as
ambiguous and receive no guessed parent. Native queue/steering causal
links need provider acknowledgement support before complete coverage can be
claimed. Phone-host physical-device integration and a common approved ingestion
adapter/query remain unverified. A green draft is not evidence those gaps closed.

## Feedback links to an independent tracing backend

Feedback upload and tracing remain separate configurations. The feedback adapter
keeps its own telemetry disabled. Desktop vendors the canonical Framebriar Node
SDK at `25c05f76e8ae05e5ff4b13d2caaf71a7abcfd17e` (service #11, SDK #12), with
unchanged upstream files and SHA-256 provenance in `VENDORED.json`. No npm release
is assumed to contain these APIs.

Desktop snapshots references synchronously at feedback opening, before async
SDK startup or screenshot capture. A bounded memory-only window keeps up to 32
recent Annex span references and 32 validated phone/socket observations for at
most five minutes. Recording disable/re-enable fences old references by recording
generation. Only the last eight trace/span references and four connection UUIDs
can enter an incident. References describe the recent window, not proof that each
span was caused by a particular connection. No logs, request bodies, chat,
addresses, account identifiers or exporter credentials are stored in this window.

Incident v1 requires a real `phoneInstanceId`. When exactly one validated phone
process is known in the window, desktop includes the frozen v1 incident: its own
host process UUID, observed socket UUIDs, capture/window times, and bounded trace
references. Multiple phone processes, peer-cache overflow, no phone, or expired
context do not produce an invented phone identity: they fall back to the real
legacy trace/span pair if available. Desktop-only rich incident metadata is not
supported by the current upstream v1 schema. No configured logical backend UUID
currently exists on desktop, so `backendRef` is omitted, never derived from a URL.
Known phone context without spans uses `availability: unavailable`; no context
creates no synthetic trace. Local recording does not prove remote retention.

The review shows a summary and lets the user remove correlation independently of
the screenshot. Removal passes `incident:null` and removes the flat trace/span
pair too. The renderer can only choose inclusion; it cannot supply incident IDs
or metadata. A prepared report is reused unchanged after a failed/uncertain save,
including its report ID. Editing after preparation requires opening a new report.
The SDK persists reviewed metadata through restart and retries without replacing
it with the upload-request trace or current process/socket identities.

The SDK binds `feedbackCorrelationVersion: 1` to the current, unexpired access
response. Unsupported incident-bearing reports stay queued unchanged while
ordinary reports continue. Settings show this hold separately from permanent
rejections. Capability is not persisted across access refresh/restart, and no
metadata is stripped to force delivery. The service needs a separately approved
deployment before clients can receive the capability; source merges and consumer
pins do not deploy it. The shared service fixture and mocked-transport tests cover
immutability, old-service hold, ordinary delivery and restart/capable delivery.

Physical-device feedback and live common-backend queries remain unverified.
Separately, optional Framebriar telemetry ingestion currently strips
`service.instance.id` and prefixes `service.name` with authenticated app scope.
That gateway limitation does not block a separately configured tracing backend.
