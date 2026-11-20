#3733 selected Actions relationship pages — UNFINISHED ISOLATED WIP
Base: b7b40600b462ba533f6cb61ff375d12da5f35ece
Branch: Nov20AutoCI/3733-selected-actions
No whole-feature acceptance, default-branch push, PR or merge.

Ownership and integration boundary
Actions-only producer, typed source DTO/validator, pure row presentation and
fixtures. Central inventory parser/query/client/envelope/host admission wiring
belongs to Nov20SettingsCI. Those central files are not edited here. No actual
Details view replacement is claimed. The common owner must import the source
validator, retain all selected/role/project/host/pairing/auth receipts, reject
wrong source/offset/selection and remove unrelated bodies. This WIP does not
establish those end-to-end guarantees by itself.

Source/API
shared/remote-action-page.ts exports RemoteActionRelationshipPage,
RemoteActionRelationshipRow, isRemoteActionRelationshipPage, fixed page size25
and selected-action-relationships source constant. Recorded common fields:
version1,source,state,offset,next,selection64hex,observedAt,notes; source extras
rows,totalRelationships,uniqueActions. Unavailable carries reason
invalid/unreadable/limit/changed/unsupported and no rows/counts/selection/next.
The relationship selection hashes selected agent/project/role and ordered
Action ID/group identity. Nonzero offsets require the same ordered selection.
No raw Action IDs are exported; stable group-qualified row keys are hashes.

main/actions/index.ts exports readSelectedActionDetailsPageForAgent(agentId,
projectId,dispatcher,options), where options are offset,optional selection,
authorized,target receipt,receipt list,and names():ActionNames. The wrapper
uses only the existing engine pointer and never initializes it. The new
selected-details-page reader takes the explicit engine, selected subject and
same options plus sourceCurrent(); receipt callbacks stay private.
The names callback must create a fresh passive name resolver per observation;
this preserves currentness for existing short descriptions/reference labels
without new probes. Established describeAction+display sanitization is reused.

Bounded read behavior
Visible selected relationships use existing agentActionGroups: owned,targeting,
triggered-by (or only Dispatcher-owned for an admitted Dispatcher). An Action
can occur in multiple groups; unique Action and relationship-row counts remain
separate. Group order is fixed; within each group, saved createdAt then ID uses
stable lexical ordering. At most25 rows and25 unique last-run display metadata
reads per page. Source scan/selected relationship ceiling4096 is explicit;
oversized/unreadable sources remain unavailable, not empty. The engine's initial
list() copying/sorting cost is unchanged; no hard I/O deadline is claimed.
Receipts recompute selected ordering and page label/enabled/short description/
recorded outcome/time, plus fresh passive reference names and engine/target/
authorization identity. Off-page relevant relationship changes invalidate
continuation. Irrelevant raw prompt/unrelated label changes do not become a
private-data-dependent display field. No execution, mutable history API,
delivery receipt refresh, stores recovery or lifecycle call occurs.

Safe display contract
Rows expose name,group,enabled,existing short description,and optional recorded
last-run outcome/time only. Message/wake/quick text, steps, arguments, prompts,
chain, raw history/run IDs/reasons/receipts and underlying Action objects are
not returned. The existing description formatter says e.g. Message Selected,
without prompt contents; the existing redactor runs before text bounding.
This preserves established list information, not a new guarantee that arbitrary
unstructured labels contain no secrets. Unknown/invalid run times are withheld;
absence of lastRun does not claim no past execution. Recorded outcomes are not
current delivery or execution authority.

Pure renderer seam
SelectedActionsPage requires selectionKey,expected offset,result with its own
selectionKey,read status,agentName and onPage(offset,selection?). It displays
nothing from a late parent/host/epoch/page result or after denial/offline status.
It validates the source DTO and reuses ActionGroupFrame/ActionLineContent,
including short descriptions and recorded outcome/time. First page clears the
stale selection token; later pages pass it. No management/action callbacks or
transport are owned by this component. Actual host/epoch/result wiring remains
with the common owner and needs independent integration proof.

Prepared proof, not yet executed at this WIP checkpoint
-101 selected Actions/303 relationship rows; row101 at offset100 and final rows.
-One Action in3groups; stable keys, unique/relationship counts and bounded
 recorded-history display reads.
-Selected label/enable/outcome/time/reference/membership/order/engine/target/auth
 receipt changes, unrelated/private prompt changes, malformed page arguments.
-Real ActionsEngine started during test setup; read path must not call mutable
 history(), refresh delivery receipts, write history/storage or execute steps.
-Cold wrapper remains unavailable without initialization, revoked source unread.
-Renderer delayed selection/reconnect/offline/denial/wrong-offset withholding,
 multi-group presentation, token-preserving continuation and fresh first page.
-Strict source validator rejects underlying definitions and malformed counts.

Validation state
UNVALIDATED WIP pending coordinated heavy lane after role HTTP proof. No test,
typecheck, lint or exact-head acceptance is claimed at this checkpoint. Final
observed results and limitations will be appended only after execution and sent
to the orchestrator. Source scope and exported interfaces have been relayed for
shared integration; independent review remains required.

Deferred
Central inventory/source capability plumbing and final serialization gates;
actual remote Actions card integration; live/hosted role/provider matrix; any
extra Action drilldown/history/management. Sleeping remote hidden-Details helper
read-only surface remains a separate next increment. No grants/permissions,
raw workflow exports, probes, installs/restarts or management APIs.

Lightweight source-lint follow-up
The six new producer/DTO/presentation source+fixture files pass ESLint with zero
errors/warnings after correcting test regex escaping and documenting private
fail-closed receipts. This0.24s static check does not replace the still-pending
coordinated tests/typecheck or central integration proof.
