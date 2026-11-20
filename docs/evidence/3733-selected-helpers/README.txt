#3733 finite matrix sections2/3: selected helper rows and work continuation
Base: cf60564f16444420fe924b7c11e69214eb0c2446
Branch: Nov20AutoCI/3733-selected-helpers
Scope: one paired host's existing strict selected-parent helper inventory,
structured read-only Orchestration display, selected page8 work checks and
qualified existing UI navigation. No Wires/Dispatcher/Changes card logic edits.

Observed source gap
Remote Details previously flattened selected helpers into generic rows,
classified nonrunning/no-creation helpers as Sleeping regardless of unavailable
failure attribution, used path.basename for cross-project labels, and checked
work only for the first8 entries with no helper-work continuation.
Actual local HelpersCard has pending/live/disposed groups, work/state/project
labels and host-aware selected navigation. Existing helper-index readOnly mode
uses strict project and primary inventories and parent project identity,
retaining primary inventory receipts. It is reused, not replaced by a broad
mutable census, recovering loader or unrelated-agent fallback.

Contract
The existing paired/pinned desktop Details GET accepts an additive query:
card=orchestrate&source=helpers&offset=0 (then8,16,...<=4096); projectOffset must
be absent/0. Existing card=connections source=helpers retains its existing
project-qualified relationship paging and offset semantics.
helperPages:1 advertises support; helperPage is a version1 selected-direct-helpers
DTO. Stable opaque row keys, names, qualified display labels, safe branch/date,
status provenance, generic failure classification, bounded work words and optional
strictly qualified agent+project navigation identity only. No project path,
raw CLI/Git error, helper command/args, configuration, credentials or grants.
Pending rows reuse the existing conservative selected request display text and
hash their request IDs; no raw request object or approval action is exposed.

Counts/page semantics
Live/disposed/pending counts are independent. Unreadable helper inventory yields
null live/disposed/total, not zero; readable pending data survives that failure.
Pending unavailable is null, never an empty-queue claim. Stable host inventory
ordering; row pages contain at most8, with bounded arithmetic, explicit next,
and no beyond-end/partial/duplicate identity masquerading as a complete page.
101 rows reach row101 at offset96, with5 work checks on that page; first page
checks at most8. No disposed/creating work check. Work errors never become clean.
The two-second budget limits admission to work reads, not completion time or a
hard I/O deadline. Refresh can retry that selected page. The strict helper-index
registry/inventory traversal and strict identity resolution costs are unchanged;
this slice does NOT claim bounded total inventory I/O, a global scan reduction,
or an atomic cross-page snapshot. Oversized selected inventories stay unavailable.

Current status and identity
Live helper resolution must equal the exact selected inventory snapshot and
parent/project association; unrelated/native-ID collisions cannot provide a
project label, work read or Open target. Project displayName/name is used after
strict association, never basename fallback. Disposed labels join only a unique
strict registered project; current runtime/Open are not inferred for them.
Current-run lifecycle/Needs-you requires a loaded registration whose project/cwd
exactly match admitted helper paths, and runtime kind association. No arbitrary
registration path is probed. Registration/runtime identity, safe lifecycle and
chat status are receipted. A retained native-ID-only failure cannot establish a
current helper runtime: failure remains unknown and no Sleeping/success claim
is made. Generic creation/runtime failures are distinguished without raw errors.
PTY Needs-you without a project-bound passive source remains unknown; chat
waiting_permission/waiting_input is available from the bound current runtime.

Receipts and envelope
Parent/strict project/inventory, selected helper identity and runtime receipts
stay through all awaited work and final whole-Details serialization, with
existing parent/run/role/settings/auth checks. Revocation remains403; changed
inventory/runtime yields409 rather than stale private data. Queries capture
arguments before transport awaits; helper responses echo exact offset and must
be helperPageOnly. That envelope clears other card rows/notices/omission counts
and connectionPage metadata, Settings/provider/Wires payloads. Default reads
refuse helper-only replies; older hosts ignoring/rejecting this query remain
unavailable. Connections page-only responses remove helperPage. No new endpoint,
access switch, grant, permission or mutation API was added.

Renderer/navigation
RemoteHelpersCard replaces only the remote Orchestration slot. Pending, live and
collapsed Disposed rows are separate; counts/limitations stay readable. Next,
Previous, First and Refresh request bounded selected host pages. A delayed old
parent/page/read generation, denial, disconnect or mismatched page is withheld.
Older hosts keep legacy authorized card summaries. Open is disabled unless the
strict host target, current same-host snapshot parent+project+helper relationship,
and loaded namespaced navigation inventory agree. Click rechecks and uses only
existing host/UI navigation with namespaced agent+project IDs. No raw ID alone,
local fallback, lifecycle call, direct hydrate/save or new target discovery.
A snapshot that omits a target/relationship cannot authorize Open; explicit
reason is displayed. Membership/Details is not a management or transport grant.

Proof (development; exact final SHA/results reported separately)
- Red1: exact base remote-details-query.ts with new contract-test overlay rejects
  the newly allowed helper query:1fail,6skip. Candidate query restored.
- Red2: exact base remote-agent-details.ts producer with new test overlay lacks
  structured helper-page and independent unknown-count evidence:2fail,183skip.
  Candidate producer restored. These are base-file test overlays, not a claimed
  full-base exact-head suite.
- Initial full tsc --noEmit: exit0.
- New producer/shared/UI/navigation suites:30PASS (1.52s; followed by30PASS after
  hardening). Real temporary primary files support identity/receipt controls;
  work result and runtime ports are modeled. Existing read-only-helper-work
  tests separately exercise actual Git bytes/filters/transforms/no-write behavior.
- Affected development full integration:7suites1136PASS (102.72s): complete
  Details, full Annex client/server, Quick, source-page envelope, remote Details
  view and Connections card. Subsequent page/envelope hardening gets exact-head
  focused proof, not an unqualified reuse of these earlier results.
- New scoped source lint exits0. Existing presentation regex/catch diagnostics
  outside this slice remain baseline limitations if reported by broader lint.

Reproduce new targets
node node_modules/vitest/vitest.mjs run --project main --project shared --project renderer \
 src/main/services/selected-helper-page.test.ts src/shared/remote-helper-page.test.ts \
 src/renderer/features/agents/details/RemoteHelpersCard.test.tsx \
 src/renderer/features/agents/details/remote-helper-navigation.test.ts \
 --maxWorkers=1 --no-file-parallelism
node node_modules/typescript/bin/tsc --noEmit
Logs: /tmp/nov20autoci-helpers-{red-query,red-producer,dev,integration}.log.
Final exact-head target/transport/route/source proof and commit SHA are sent to
orchestrator after checks. Heavy lane is serialized through it, process/resource
checks precede heavy commands. Preinstalled dependencies only; no installation.

Acceptance/deferred
Independent review required. This is a selected helper-list increment, not full
#3733 role/provider/state/live matrix acceptance. No inline helper surface when
Details itself is hidden, no new PTY status source or disposed navigation, no
incarnation generation beyond currently qualified selected host/project identity,
no new aggregate inventory budget. No cross-host probes, management writes,
permission changes, restarts, PR updates or merge. Future generic/Canvas
continuation stays separate; membership must never imply board-content access.

QA follow-up / successor controls
Initial023d exact-head run:295PASS/1FAIL in8suites. Failure log preserved at
/tmp/nov20autoci-helpers-exact.log. The older disposed/handoff test fixture
omitted parentAgentId on both entries, contradicting strict helper-index output.
The parent fence is preserved; those fixtures are corrected to the real source
shape. Separately, valid disposed dates and handoff words outside the selected
8-row typed page must remain in legacy flat summaries. Production fallback now
retains those saved fields; a new valid beyond-page regression keeps that API
contract. Missing/invalid parent source entries do not gain typed identity,
runtime/work or navigation through this fallback.

QA also identified AgentRegistry.setNonce/setRuntime mutating one object.
Pointer comparison alone missed nonce/provider/session-run changes. Bounded red
using the actual registry singleton and actual setter methods:3FAIL (nonce,
provider,run),3PASS (runtime,project,cwd),9SKIP; log preserved at
/tmp/nov20autoci-helpers-registration-red.log. Successor captures immutable
registration scalar values (nonce,project,cwd,provider,runtime) and chat
session/native/display-run identifiers into the receipt signature while also
checking original object identity. No auth nonce or runtime object is serialized.
These are actual registry mutation semantics, with unrelated dependency ports
stubbed for the test; no live host lifecycle is claimed. Final successor SHA
and exact-head results are reported independently from023d and development passes.
