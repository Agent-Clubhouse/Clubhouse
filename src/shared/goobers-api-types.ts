// Vendored from Goobers portal/src/api/types.ts
// Source commit: a1b2ae99ea8ee0874517560e42bfaeee7c9f95e6   Binary contract: portal-v0.1.0-21-ga1b2ae99
// DO NOT EDIT BY HAND. Re-vendor when the Goobers API version changes.
// Upstream is contract-tested against the Go structs; this copy is not.
//
// Only the subset consumed by the Clubhouse Goobers panel is vendored here
// (spec §5.2) — not the full 1,500+ line upstream file.

// ---------------------------------------------------------------------------
// §5.3 Enum strings (exact) — copied verbatim from upstream
// ---------------------------------------------------------------------------

export type Environment = 'dev' | 'staging' | 'prod';
export type Provider = 'github' | 'ado';
export type InstanceStatus = 'starting' | 'ready' | 'degraded';
export type DefinitionStatus = 'configured';
export type Harness = 'copilot' | 'claude-code';
export type RunPhase = 'running' | 'completed' | 'failed' | 'aborted' | 'escalated';
export type RunTriggerKind = 'manual' | 'schedule' | 'signal' | 'item';
export type AttemptClass = 'initial' | 'policy' | 'infra' | 'human';
// '' is a real wire value (in-flight/unrecorded attempt) — see spec §5.3.
export type StageAttemptStatus = 'running' | 'success' | 'failure' | 'blocked' | 'no-work' | '';
export type MaintenanceState = 'none' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type UpdateModel = 'instance' | 'run' | 'workflow';
export type ValidationWarningCode = 'VER001' | 'VER002' | 'VER003' | 'MODEL002';
export type OutcomeFilter = 'finished' | 'terminal' | 'success' | 'failure' | 'other';
export type StagePopulationFilter =
  | 'active'
  | 'completed'
  | 'all';

export type RunEventCategory =
  | 'transition'
  | 'decision'
  | 'result'
  | 'evidence'
  | 'liveness'
  | 'bookkeeping'
  | 'unknown';

// RunEventType is an OPEN union (43 known literals) — unknown types must
// render, not crash (spec §5.2/§5.3).
export type KnownRunEventType =
  | 'run.started'
  | 'run.resumed'
  | 'run.finished'
  | 'stage.started'
  | 'stage.heartbeat'
  | 'stage.finished'
  | 'stage.rerun.requested'
  | 'gate.started'
  | 'gate.paused'
  | 'gate.evaluated'
  | 'artifact.recorded'
  | 'span.recorded'
  | 'input.snapshot'
  | 'ref.touched'
  | 'error'
  | 'redaction'
  | 'repaired'
  | 'runner.annotation'
  | 'trigger.fired'
  | 'tick.skipped'
  | 'workflow.starved'
  | 'provider.quota.reset'
  | 'poll.shed'
  | 'claim.acquired'
  | 'claim.released'
  | 'claim.force_released'
  | 'claim_lock_slow'
  | 'claims_lock_timeout'
  | 'config.reloaded'
  | 'config.reload.rejected'
  | 'daemon.started'
  | 'daemon.clean_shutdown'
  | 'daemon.dirty_restart'
  | 'parallel.started'
  | 'parallel.finished'
  | 'branch.started'
  | 'branch.finished';

export type RunEventType = KnownRunEventType | (string & Record<never, never>);

export type BranchStatus = 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'no-output';

// ---------------------------------------------------------------------------
// §9.4 API compatibility check
// ---------------------------------------------------------------------------

/** Wire contract version this vendored copy was taken from. Compare against
 *  a live Health/Instance response's apiVersion/schemaVersion (§9.4) — a
 *  mismatch means the vendored types may have drifted from the daemon. */
export const API_VERSION = 'v1' as const;
export const SCHEMA_VERSION = 'v1' as const;

export interface ContractVersion {
  apiVersion: typeof API_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
}

// ---------------------------------------------------------------------------
// §5.4 Error envelope
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiErrorEnvelope {
  error: ApiError;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageInfo {
  limit: number;
  total: number;
  hasMore: boolean;
  nextCursor: string;
}

// ---------------------------------------------------------------------------
// ReadStateEnvelope (spec §5.2) — carries honest staleness. The Goobers
// system deliberately reports degradation rather than hiding it; the panel
// must surface it rather than rendering stale data as fresh.
// ---------------------------------------------------------------------------

export interface ReadState {
  epoch: string;
  appliedSeq: number;
  sourceApplied?: { runId: string; journalSeq: number };
  observedAt: string;
  lagSeconds: number;
  pendingIntake: number;
  oldestPendingSourceAge: number;
  intakeWriteFailures: number;
  lastSweepCompletedAt?: string;
  minChangeSeq: number;
  completeness: 'complete' | 'partial';
  missing?: { name: string; reason: string; expectedBy: string }[];
  degraded: string[];
}

/** Embedded in nearly every read-model response. */
export interface WithReadState {
  readState?: ReadState;
}

// ---------------------------------------------------------------------------
// Health (GET /api/v1/health)
// ---------------------------------------------------------------------------

export interface BuildMetadata {
  version: string;
  commit: string;
  date: string;
}

export interface InstanceIdentity {
  name: string;
  environment: Environment;
}

export interface Freshness {
  observedAt: string;
  definitionsLoadedAt: string;
  journalUpdatedAt: string | null;
  lastSchedulerTickAt: string | null;
  lastTickAgeMillis: number | null;
}

export interface Health extends ContractVersion {
  build?: BuildMetadata;
  readState?: ReadState;
  ready: boolean;
  healthy: boolean;
  instance: InstanceIdentity;
  freshness: Freshness;
}

// ---------------------------------------------------------------------------
// Instance (GET /api/v1/instance)
// ---------------------------------------------------------------------------

export interface Concurrency {
  activeRuns: number;
  maxConcurrentRuns: number;
}

export interface InventoryCounts {
  gaggles: number;
  goobers: number;
  workflows: number;
  activeRuns: number;
}

export interface ValidationWarning {
  code: ValidationWarningCode;
  message: string;
}

export interface MaintenanceStatus {
  kind: string;
  state: MaintenanceState;
  trigger: 'startup' | 'periodic' | 'manual';
  startedAt?: string;
  lastProgressAt?: string;
  currentPhase?: string;
  candidates: number;
  removed: number;
  failures: number;
  lastCompletedAt?: string;
  lastResult?: string;
  errorSummary?: string;
}

export interface Instance extends ContractVersion {
  name: string;
  version?: string;
  environment: Environment;
  computerName?: string;
  instanceRoot: string;
  rootIdentity?: {
    id?: string;
    identityProblem?: string;
    decommissionedAt?: string;
    decommissionReason?: string;
    lifecycleProblem?: string;
  };
  ready: boolean;
  status: InstanceStatus;
  concurrency: Concurrency;
  counts: InventoryCounts;
  warnings: ValidationWarning[];
  maintenance?: MaintenanceStatus;
  fleetEnrolled: boolean;
}

// ---------------------------------------------------------------------------
// Gaggle (GET /api/v1/gaggles)
// ---------------------------------------------------------------------------

export interface RepoRef {
  provider: Provider;
  owner: string;
  name: string;
  branch?: string;
  connectionRef?: string;
}

export interface BacklogRef {
  provider: Provider;
  project: string;
  labels?: string[];
  query?: string;
  connectionRef?: string;
}

export interface Gaggle {
  name: string;
  displayName: string;
  status: DefinitionStatus;
  project: RepoRef;
  backlog: BacklogRef;
  gooberCount: number;
  workflowCount: number;
  activeRunCount: number;
  warnings: ValidationWarning[];
}

export interface GagglePage {
  items: Gaggle[];
  page: PageInfo;
}

// ---------------------------------------------------------------------------
// Workflow (GET /api/v1/workflows)
// ---------------------------------------------------------------------------

export interface WorkflowReference {
  gaggle: string;
  name: string;
}

export interface GooberReference {
  gaggle: string;
  name: string;
}

export type WorkflowTriggerType = 'manual' | 'backlog-item' | 'schedule' | 'signal' | 'webhook';

export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  selector?: Record<string, string>;
  schedule?: string;
  signal?: string;
  events?: string[];
}

export interface ReadinessConditions {
  desiredConcurrentRuns?: number;
  maxConcurrentRuns?: number;
  maxRunsPerHour?: number;
  maxRunsPerDay?: number;
  maxChainDepth?: number;
  maxOpenPRs?: number;
}

export interface WorkflowDefinition {
  version: number;
  digest: string;
}

export interface WorkflowConcurrency {
  activeRuns: number;
  desiredRuns?: number;
  maxConcurrentRuns: number;
  admissionBlocked?: boolean;
  blockingCondition?: string;
}

export interface EngineFallback {
  gaggle: string;
  workflow: string;
  runId: string;
  at: string;
  reason: string;
  reasonClass: string;
  placementDeclared: boolean;
  selfPinnedStages?: string[];
  unpinnedGates?: string[];
}

export interface WorkflowSummary {
  engineFallback?: EngineFallback;
  identity: WorkflowReference;
  displayName: string;
  purpose: string;
  triggers: WorkflowTrigger[];
  readiness: ReadinessConditions;
  concurrency: WorkflowConcurrency;
  owners: GooberReference[];
  stageCount: number;
  definition: WorkflowDefinition;
  warnings: ValidationWarning[];
}

export interface WorkflowPage {
  items: WorkflowSummary[];
  page: PageInfo;
}

// ---------------------------------------------------------------------------
// Run list / summary / detail (GET /api/v1/runs, /api/v1/runs/{run})
// ---------------------------------------------------------------------------

export interface RunTrigger {
  kind: RunTriggerKind;
  ref?: string;
}

/** The wire shape of GET /api/v1/runs query params. Passthrough — see spec
 *  §6.3 for the identical renderer-facing `RunListQuery` (shared/goobers-types.ts). */
export interface RunListOptions {
  gaggle?: string;
  workflow?: string;
  stage?: string;
  outcome?: OutcomeFilter;
  population?: StagePopulationFilter;
  phase?: RunPhase;
  trigger?: RunTriggerKind;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  latestPerWorkflow?: boolean;
  orderByActivity?: boolean;
  showNoWork?: boolean;
}

export interface RunList {
  runs: RunSummary[];
  workflowActivity?: WorkflowRunActivity[];
  nextCursor?: string;
}

export interface WorkflowRunActivity {
  gaggle: string;
  workflow: string;
  activeRuns: number;
}

export interface RunSummary {
  activeStages?: Array<{
    name: string;
    kind: string;
    branch?: number;
    attempt?: number;
    goober?: string;
    startedAt: string;
  }>;
  engineFallback?: EngineFallback;
  id: string;
  workflow: string;
  workflowVersion: number;
  workflowDigest?: string;
  gaggle: string;
  trigger: RunTrigger;
  phase: RunPhase;
  terminal: boolean;
  currentStage?: string;
  startedAt: string;
  finishedAt?: string;
  durationMillis: number;
  lastActivityAt: string;
  /** Running run whose activity and daemon heartbeat both exceed runner.livenessTimeout. */
  stale: boolean;
  repassCount: number;
  retryCount: number;
  /** True for a completed run that touched exactly one stage and that stage's terminal status was no-work (#2188). */
  noWork: boolean;
  /** Projected cause of a non-completed terminal run (#4246). */
  terminalReason?: string;
  operator?: OperatorRunSummary;
}

/**
 * The operations payload. `potentialBlockers` and `diagnosticsLimitations`
 * are deliberately distinct fields (upstream #3346) and must be rendered
 * differently: the former is what is impeding the run, the latter is what
 * this read could not establish. Conflating them manufactures false signals.
 */
export interface OperatorRunSummary {
  issue?: { number: string; title?: string };
  currentStage?: string;
  lastHeartbeatAt?: string;
  heartbeatAgeMillis?: number;
  /** Only ever "no-heartbeat" or "terminal" in non-test code. */
  liveness: string;
  /** Derived from a substring match on the stage name upstream. Display hint only — never branch machine logic on it. */
  trajectory: string;
  pullRequest?: { provider: string; kind: string; id: string; url?: string };
  claim: {
    leaseStatus: string;
    expiresAt?: string;
    providerMarker: string;
  };
  latestError?: { code: string; message?: string };
  review?: { verdict: string; rationale?: string };
  nextTransition?: string;
  /** What is impeding the run itself. Never a read-side capability gap (#3346). */
  potentialBlockers: string[];
  /** What this read could not establish (missing credential, unreachable provider) — a limit on the reader, not the run (#3346). */
  diagnosticsLimitations?: string[];
}

export interface RunOutcome {
  gate?: string;
  verdict?: string;
  target?: string;
  causalEventSeq?: number;
}

export interface EscalationSelector {
  kind: string;
  name: string;
}

export interface EscalationCause {
  selector: EscalationSelector;
  selectedBranch?: string;
  repassCount: number;
  retryCount: number;
  terminalReason?: string;
  causalEventSeq?: number;
}

/** One executed transition in a run's workflow graph — never inferred from
 *  "both endpoints visited"; only what actually fired (upstream #1430). */
export interface RunTransition {
  branch: number;
  occurrence: number;
  seq: number;
  source: string;
  target?: string;
  verdict?: string;
  terminal?: boolean;
  status?: string;
  repass?: boolean;
}

export interface WorkflowGraphNode {
  name: string;
  kind: string;
}

export interface WorkflowGraphEdge {
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export interface RunDetail extends RunSummary {
  graph?: WorkflowGraph;
  graphStatus: 'pinned' | 'unavailable';
  escalation?: EscalationCause;
  terminalCause?: EscalationCause;
  outcome?: RunOutcome;
  /** Respect `transitionsStatus: "projected"` with an empty array — a fresh run legitimately has none. */
  transitions?: RunTransition[];
  transitionsStatus: 'projected' | 'unavailable';
}

// ---------------------------------------------------------------------------
// Run events (GET /api/v1/runs/{run}/events)
// ---------------------------------------------------------------------------

export interface EventList {
  runId: string;
  events: RunEvent[];
}

export interface ArtifactMetadata {
  name?: string;
  digest: string;
  size: number;
  mediaType: string;
  stage?: string;
  attempt?: number;
  attemptClass?: AttemptClass;
  recordedSeq?: number;
}

export interface ExternalRef {
  provider: string;
  kind: string;
  id: string;
  url?: string;
}

export interface ErrorDetail {
  code: string;
  message?: string;
}

/** One entry in a parallel's completeness record (one per declared branch). */
export interface BranchOutcome {
  branch: number;
  name: string;
  status: BranchStatus;
  artifacts: number;
}

export interface RunEvent {
  schema: string;
  seq: number;
  type: RunEventType;
  branch: number;
  time: string;
  knownSchema: boolean;
  category?: RunEventCategory;
  stage?: string;
  attempt?: number;
  attemptClass?: AttemptClass;
  gate?: string;
  verdict?: string;
  status?: RunPhase | StageAttemptStatus;
  actor?: string;
  decision?: string;
  rationale?: string;
  outputs?: Record<string, unknown>;
  artifacts?: ArtifactMetadata[];
  externalRef?: ExternalRef;
  error?: ErrorDetail;
  reason?: string;
  completeness?: BranchOutcome[];
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Stage attempts (GET /api/v1/runs/{run}/stages/{stage}/attempts)
// ---------------------------------------------------------------------------

export interface AttemptList {
  runId: string;
  stage: string;
  attempts: StageAttempt[];
}

export interface StageAttempt {
  id: string;
  visit: number;
  number: number;
  class: AttemptClass;
  status: StageAttemptStatus;
  errorCode?: string;
  errorClass?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMillis: number;
  artifacts: ArtifactMetadata[];
  error?: ErrorDetail;
  /** Requested/selected model (e.g. "auto"), when indexed. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Telemetry errors (GET /api/v1/telemetry/errors) — M25.
// Vendored from upstream portal/src/api/types.ts:1336-1350. Verified against
// a real response from a scratch instance (`/tmp` root, no repo connected):
// the two items observed — `merged_pr_cost_sweep_failed` and
// `storage_health_critical` — matched every field name and the field order
// below exactly. `nextCursor` was absent on that response (only 2 items);
// left optional rather than assumed present.
// ---------------------------------------------------------------------------

export interface TelemetryErrorsPage {
  items: TelemetryError[];
  nextCursor?: string;
}

export interface TelemetryError {
  runId: string;
  workflow: string;
  stage: string;
  attempt: number;
  code: string;
  errorClass: string;
  message: string;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Work items (GET /api/v1/work-items) — M25.
// Vendored from upstream portal/src/api/types.ts:1391-1417. The wrapper shape
// (`{items, hasMore}`) was verified against a real response — empty on both
// the scratch instance and (per the owner) the real one, since neither has a
// repo with tracked PRs/issues. `WorkItemSummary`'s field-level shape is
// NOT independently verified against a live payload for that reason — it is
// copied from upstream types.ts, which itself already matched the daemon's
// Go wire DTO (`internal/readservice/workitems.go`) field-for-field at the
// time of vendoring. Re-check against a real item the first time one exists.
// ---------------------------------------------------------------------------

export type WorkItemKind = 'pr' | 'issue';

export interface WorkItemPage {
  items: WorkItemSummary[];
  hasMore: boolean;
}

export interface WorkItemSummary {
  provider: string;
  repository?: string;
  kind: WorkItemKind;
  externalId: string;
  url?: string;
  actionCount: number;
  lastOperation: string;
  lastActionAt: string;
  lastRunId: string;
  gaggle?: string;
  workflow?: string;
  runStatus?: string;
}
