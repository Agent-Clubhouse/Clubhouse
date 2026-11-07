# NewAgent composition creation contract

Source design from c890044a; implementation and validation are pending. Root owns this continuation. Existing-agent skill delivery does not complete NewAgent, MCP/native, helper presets or selective import.

## Observed boundaries

NewAgentPage currently sends legacy persona and MCP IDs to asynchronous creation. agent-creation.startDurableCreation returns an ID while agent-config owns the complete creation promise. agent-config reserves the folder/branch and creates an owned active-creation record before starting work. The optional inject callback is intentionally best effort: its error is logged and creation can still reach ready. It must not be used for mandatory composition persistence.

The catalog saveComposition transaction validates the complete draft, source revisions and planner fingerprint under its serial lock before index rename. Agent configuration and catalog index are separate durable files. An abort or process crash between their commits therefore needs explicit reconciliation; calling two writes a transaction is insufficient. Existing registeredSkillBundleContext deliberately refuses creating agents. Do not weaken that general resolver or accept a renderer-supplied agent ID as creation authority.

## Proposed first implementation boundary

Add a local-user NewAgent draft service that uses the existing catalog planner and composer. Main owns an opaque draft token, registered project identity/path/generation, reserved durable ID, exact composition input, source revision map and preview fingerprint. Renderer edits request a new preview; confirmation consumes the current token once. Project/target changes invalidate the token. Legacy creation requests without a token retain their current persona behavior. A managed composition request must not silently also inject legacy persona text; UI makes the choice explicit.

The ID reservation must be issued by the existing creation owner before planning agent-owned assets. Extend that owner with a typed internal reservation capability; never add a general allowCreating switch to Builder IPC. Main validates UI origin, project mapping and live ownership at entry and immediately before catalog rename. Other start/write paths remain refused while creation is incomplete. A source/head/generation change requires a new preview, not an automatic replan-and-save.

Introduce a required composition phase separate from best-effort inject. Its rejection flows through existing failed creation handling and never emits ready. The phase uses the exact confirmed planner fingerprint and expected source revisions. Saved composition is desired state only; it does not adopt, start, authenticate or claim provider loading.

## Cancellation and persistence decisions to implement and test

Before catalog commit, cancellation releases the draft/reservation and follows existing owned-worktree cleanup. Library/project assets explicitly saved separately remain unassigned; no shared asset is deleted. Agent-owned copy creation must be deferred to the confirmed creation transaction or recorded in its owned journal; do not leave anonymous copies when a draft closes.

Between catalog commit and ready, retain a persisted creation marker containing the exact committed composition revision and draft identity. A cancellation or failure must reconcile only that owned revision; a broad deleteComposition operation is not acceptable. If rollback cannot be established, retain a failed visible record with its saved-only composition and refuse starts. Do not remove the agent record and claim cleanup while silently leaving ambiguous catalog ownership.

On restart, interrupted creation reconciliation must inspect this marker before ordinary record/worktree cleanup. It must neither report ready without the reviewed composition nor delete a later independently modified composition. The exact compare-and-remove or failed-record retention operation needs catalog serial-lock coverage before the UI is wired. This is the next implementation milestone, not an existing guarantee.

## Deterministic regression order

1. Exact preview and confirmation reuse one planner; wrong project, stale source/fingerprint, consumed token and foreign reservation refuse before mutation.
2. Required composition failure yields failed, never ready; legacy inject failure retains its existing behavior.
3. Gate cancellation before commit, after commit before ready, and while readiness persistence fails. Assert exact catalog/config state, owned worktree cleanup disposition and no start/adoption calls.
4. Replay persisted interrupted markers with matching and changed revisions; preserve newer edits and expose incomplete cleanup.
5. NewAgent UI retains the draft after refusal, ignores late target replies, shows saved-only state and allows explicit cancel without implicit assignment or provider launch.

Tests must immediately observe owned promises, race gate entry against terminal outcomes, release all gates in finally and drain before deleting fixtures. No sleeps, widened deadlines, real provider probes or blanket cleanup. Source review precedes the allocated affected validation batch.

## Remaining core sequence

Root owns NewAgent reservation/commit/recovery first. Managed MCP configured/auth-required/delivered/verified state and native manifest delivery remain separate required implementation milestones; their current unsupported status is not completion. Selective import resumes from its preserved inventory/confinement work, preserving originals and requiring explicit assignment. Helper presets reuse the eventual composition snapshot without changing Auto routing or granting Dispatcher settings authority.
