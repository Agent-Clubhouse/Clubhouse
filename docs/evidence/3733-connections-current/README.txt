#3733 selected Connections/Wires bounded host slice
Base: 4fcae1c956719300b5e052540a37bb9a391bb405
Branch: Nov20AutoCI/3733-connections-current

Scope/source comparison
Read docs/implementation-notes/3733-finite-local-delta-checklist.txt, actual
ConnectionsCard.tsx and details/McpCard.tsx, host remote-connection-card.ts,
dispatcher-connections.ts, binding-manager.ts, and complete Details assembly.
Local Wires reads selected outgoing binding records, separately from MCP
handshake. Local Connections may call mutable source inspection/Dispatcher
listing. Host full eligibility/statusOf requires a census plus mutable store
loading. This slice does not invoke those readers, authorize new reads, collect
sources, probe hosts or change bindings/enforcement.

Typed projection
RemoteAgentDetails.outgoingWires is additive. Source is explicitly
selected-outgoing-binding-records; state recorded contains name/kind rows,
total/omitted. The direct selected outgoing display bucket validates row
ownership/kind and produces a receipt. Names use already recorded safe fields,
group projectName first then targetName/label, with redaction before bounding.
Unattested/invalid/over-limit names stay null; raw target IDs are not fallback
names. No target IDs, source stores, instructions, credentials, tools, effective
grants, handshake or health claims leave this projection. Null means no usable
bounded name was attested in this binding record; it does not imply an empty
name, missing target, failed runtime, or absent permission.

Recorded empty is an observed empty selected bucket; unavailable has an
explicit invalid/limit/changed/unreadable reason and no rows. Missing field is
older/unsupported/not-requested, not empty. Only normal durable Details emits
this version; Dispatcher/Quick paths do not gain synthetic support. Source-only
pages omit it. The first 50 of at most 4096 validated selected binding records
are bounded; omissions are explicit. No new continuation or management API.
All record kinds are included: no broad mutable Dispatcher identity/target
lookup or unqualified native-ID join was added for Wires filtering.

Currentness
Selected config witness admission precedes the read, the binding receipt joins
connectionReceipts, and existing final selected/role/run/settings/provider/auth
and connection checks remain. A real selected binding change during the
Settings await BEFORE Connections recaptures its own page now refuses stale
typed Wires (409); late changes also refuse, revocation is 403. Unrelated owner
binding changes do not invalidate this selected outgoing bucket. Read receipts
cannot be retargeted by editing returned name/kind rows.

Manual-source display
A selected project-qualified manual pair now has explicit restriction evidence
from already-qualified independent observations: Dispatcher off, selected
Connect to Dispatcher off, earlier store write blocked, saved removal, or
process-known queued removal. Pending removal remains recorded, no current
host-memory record, or unknown independently of saved persistence. Unknown
active/suspended/current endpoint eligibility is explicit, with the reason that
no qualified current endpoint census is available. These observations do not
establish effective permission, source enforcement, target reachability, or a
binding held by another source. Row omission accounting includes the new field.

Validation/evidence
Red: restored exact base remote-agent-details.ts producer with new test overlay;
focused actual selected Connections boundary cases: 3 failed, 4 passed,
163 skipped. Missing typed Wires assertions fail; the new early selected-binding
schedule illustrates why a receipt for the separately returned typed snapshot
must be retained. This is a base-producer test overlay, not a claimed whole-base
exact-head test. Candidate producer restored after red. Temporary logs:
/tmp/nov20autoci-3733-red.log.
Development green: 239 passed across selected-outgoing-wires-display,
remote-agent-details, remote-connection-card, selected-connection-page-envelope
(2.55s). Full tsc --noEmit exited 0. A further denied/source-only regression was
added before final exact-head checks. Reproducible target commands:
node node_modules/vitest/vitest.mjs run --project main \
 src/main/services/selected-outgoing-wires-display.test.ts \
 src/main/services/remote-agent-details.test.ts \
 src/main/services/remote-connection-card.test.ts \
 src/main/services/selected-connection-page-envelope.test.ts \
 --maxWorkers=1 --no-file-parallelism
node node_modules/typescript/bin/tsc --noEmit
Exact committed SHA, final results, and isolated push verification are reported
to the orchestrator after those checks. Dependencies are preinstalled, with no
install. Heavy lane serialized through the orchestrator, after process checks.
Scoped ESLint found an existing no-control-regex error at unchanged
remote-details-presentation.ts:6 (the same regex exists in the exact base), plus
existing catch-must-report warnings. This slice does not alter that regex.
The new producer catch explicitly documents its safe unavailable response.

Acceptance/limits
Host source slice only. No renderer card blocks changed. The Skills/MCP owner
must consume typed Wires rather than parse Connections prose, gate presentation
on applicable MCP evidence, and independently review/test resulting UI.
No fresh cross-host/lifecycle/grant probes, settings/access changes, host/app
restarts, management APIs, PR updates or merge. No full #3733 parity acceptance.
Current operational eligibility, additional omitted rows, genuinely unavailable
source/target fields, Dispatcher/Quick Wires and full cross-platform/live
matrix remain explicitly deferred. Independent review remains required.
