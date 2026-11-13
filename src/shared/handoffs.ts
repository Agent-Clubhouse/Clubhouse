import { isMachineFingerprint, type AgentAddress } from './agent-address';

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_LIMITS = {
  title: 256, brief: 16_000, reason: 512, history: 256, records: 1000,
  encodedBytes: 384 * 1024, terminalReserveBytes: 64 * 1024,
} as const;
export const HANDOFF_STATES = [
  'offered', 'accepted', 'transferring', 'verifying', 'applying', 'applied', 'declined', 'cancelled', 'failed',
] as const;
export type HandoffState = typeof HANDOFF_STATES[number];
export type HandoffAgent = AgentAddress & { machine: string };
export type HandoffTarget = HandoffAgent | { machine: string; via: 'dispatcher' };
export type HandoffActor = { kind: 'agent'; address: HandoffAgent } | { kind: 'machine'; machine: string };
export type HandoffMode = 'branch' | 'worktree';

export interface HandoffManifestSummary {
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

export interface HandoffResult {
  agent: HandoffAgent;
  worktree: string;
  branch: string;
  commit: string;
}

export interface HandoffApplyCheckpoint {
  projectId: string;
  worktree: string;
  branch: string;
  stagingId: string;
}

export interface HandoffFailure {
  step: 'authorization' | 'transfer' | 'verification' | 'apply' | 'wake' | 'recovery';
  code: 'authorization_changed' | 'transfer_failed' | 'verification_failed' | 'apply_failed' | 'wake_failed' | 'indeterminate_apply';
}

interface TransitionBase {
  operationId: string;
  at: number;
  by: HandoffActor;
  reason?: string;
}

export type HandoffTransition = TransitionBase & (
  | { state: 'offered' | 'declined' | 'cancelled' | 'verifying' }
  | { state: 'accepted'; target: HandoffAgent }
  | { state: 'transferring'; bytesDone: number }
  | { state: 'applying'; checkpoint: HandoffApplyCheckpoint }
  | { state: 'applied'; result: HandoffResult }
  | { state: 'failed'; failure: HandoffFailure }
);

export interface Handoff {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  from: HandoffAgent;
  to: HandoffTarget;
  /** Display name captured by the sending host; authority remains the agent id and machine. */
  senderName?: string;
  task: { title: string; brief: string };
  mode: HandoffMode;
  manifest?: HandoffManifestSummary;
  state: HandoffState;
  history: HandoffTransition[];
  acceptance?: { by: HandoffAgent; target: HandoffAgent };
  progress?: { bytesDone: number; totalBytes: number };
  checkpoint?: HandoffApplyCheckpoint;
  result?: HandoffResult;
  failure?: HandoffFailure;
}

export interface HandoffOffer {
  to: HandoffTarget;
  senderName?: string;
  task: Handoff['task'];
  mode: HandoffMode;
  manifest?: HandoffManifestSummary;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid handoff record.');
}

export function sameHandoffAgent(a: HandoffAgent, b: HandoffAgent): boolean {
  return a.agentId === b.agentId && a.machine === b.machine;
}

export function isHandoffAgent(value: unknown): value is HandoffAgent {
  return object(value) && keys(value, ['agentId', 'machine'])
    && bounded(value.agentId, 128) && !value.agentId.includes('@')
    && typeof value.machine === 'string' && value.machine === value.machine.toLowerCase() && isMachineFingerprint(value.machine);
}

function isTarget(value: unknown): value is HandoffTarget {
  return isHandoffAgent(value) || (object(value) && keys(value, ['machine', 'via']) && value.via === 'dispatcher'
    && typeof value.machine === 'string' && value.machine === value.machine.toLowerCase() && isMachineFingerprint(value.machine));
}

function isActor(value: unknown): value is HandoffActor {
  return object(value) && (value.kind === 'agent'
    ? keys(value, ['kind', 'address']) && isHandoffAgent(value.address)
    : value.kind === 'machine' && keys(value, ['kind', 'machine'])
      && typeof value.machine === 'string' && value.machine === value.machine.toLowerCase() && isMachineFingerprint(value.machine));
}

function isSummary(value: unknown): value is HandoffManifestSummary {
  return object(value) && keys(value, ['fileCount', 'totalBytes', 'sha256']) && integer(value.fileCount)
    && integer(value.totalBytes) && typeof value.sha256 === 'string' && SHA256.test(value.sha256);
}

function isResult(value: unknown): value is HandoffResult {
  return object(value) && keys(value, ['agent', 'worktree', 'branch', 'commit']) && isHandoffAgent(value.agent)
    && bounded(value.worktree, 4096) && bounded(value.branch, 256) && typeof value.commit === 'string' && COMMIT.test(value.commit);
}

function isCheckpoint(value: unknown): value is HandoffApplyCheckpoint {
  return object(value) && keys(value, ['projectId', 'worktree', 'branch', 'stagingId'])
    && bounded(value.projectId, 128) && bounded(value.worktree, 4096) && bounded(value.branch, 256)
    && typeof value.stagingId === 'string' && UUID.test(value.stagingId);
}

function isFailure(value: unknown): value is HandoffFailure {
  if (!object(value) || !keys(value, ['step', 'code'])) return false;
  const codes: Record<HandoffFailure['step'], HandoffFailure['code']> = {
    authorization: 'authorization_changed', transfer: 'transfer_failed', verification: 'verification_failed',
    apply: 'apply_failed', wake: 'wake_failed', recovery: 'indeterminate_apply',
  };
  return typeof value.step === 'string' && Object.prototype.hasOwnProperty.call(codes, value.step)
    && codes[value.step as HandoffFailure['step']] === value.code;
}

function isTransition(value: unknown): value is HandoffTransition {
  if (!object(value) || typeof value.operationId !== 'string' || !UUID.test(value.operationId)
    || !integer(value.at) || !isActor(value.by)
    || (value.reason !== undefined && !bounded(value.reason, HANDOFF_LIMITS.reason))) return false;
  const base = ['operationId', 'at', 'by', 'reason', 'state'];
  switch (value.state) {
    case 'offered': case 'declined': case 'cancelled': case 'verifying': return keys(value, base);
    case 'accepted': return keys(value, [...base, 'target']) && isHandoffAgent(value.target);
    case 'transferring': return keys(value, [...base, 'bytesDone']) && integer(value.bytesDone);
    case 'applying': return keys(value, [...base, 'checkpoint']) && isCheckpoint(value.checkpoint);
    case 'applied': return keys(value, [...base, 'result']) && isResult(value.result);
    case 'failed': return keys(value, [...base, 'failure']) && isFailure(value.failure);
    default: return false;
  }
}

const NEXT: Record<HandoffState, readonly HandoffState[]> = {
  offered: ['accepted', 'declined', 'cancelled', 'failed'],
  accepted: ['transferring', 'cancelled', 'failed'],
  transferring: ['transferring', 'verifying', 'cancelled', 'failed'],
  verifying: ['applying', 'cancelled', 'failed'],
  applying: ['applied', 'failed'],
  applied: [], declined: [], cancelled: [], failed: [],
};

export function isTerminalHandoff(state: HandoffState): boolean {
  return NEXT[state].length === 0;
}

function eventMachine(event: HandoffTransition): string {
  return event.by.kind === 'agent' ? event.by.address.machine : event.by.machine;
}

function validateNext(record: Handoff, event: HandoffTransition): void {
  requireValid(NEXT[record.state].includes(event.state) && event.at >= record.updatedAt);
  if (event.state === 'cancelled') {
    requireValid(event.by.kind === 'agent' && sameHandoffAgent(event.by.address, record.from));
  } else {
    requireValid(eventMachine(event) === record.to.machine);
    if (event.state === 'accepted' || event.state === 'declined') {
      requireValid(event.by.kind === 'agent');
      if ('agentId' in record.to) requireValid(sameHandoffAgent(event.by.address, record.to));
    } else {
      requireValid(event.by.kind === 'machine');
    }
  }
  if (event.state === 'accepted') {
    requireValid(event.target.machine === record.to.machine);
    if ('agentId' in record.to) requireValid(sameHandoffAgent(event.target, record.to));
  }
  if (event.state === 'transferring') {
    requireValid(record.manifest && event.bytesDone <= record.manifest.totalBytes
      && event.bytesDone >= (record.progress?.bytesDone ?? 0));
    if (record.state === 'transferring') requireValid(record.progress && event.bytesDone > record.progress.bytesDone);
  }
  if (event.state === 'verifying') requireValid(record.progress && record.progress.bytesDone === record.progress.totalBytes);
  if (event.state === 'applied') {
    requireValid(record.acceptance && sameHandoffAgent(event.result.agent, record.acceptance.target)
      && record.checkpoint && event.result.worktree === record.checkpoint.worktree && event.result.branch === record.checkpoint.branch);
  }
  if (event.state === 'failed' && event.failure.step === 'recovery') requireValid(record.state === 'applying');
}

function append(record: Handoff, event: HandoffTransition): Handoff {
  const next: Handoff = {
    ...record, version: record.version + 1, updatedAt: event.at, state: event.state, history: [...record.history, event],
  };
  if (event.state === 'accepted' && event.by.kind === 'agent') next.acceptance = { by: event.by.address, target: event.target };
  if (event.state === 'transferring') next.progress = { bytesDone: event.bytesDone, totalBytes: record.manifest!.totalBytes };
  if (event.state === 'applying') next.checkpoint = event.checkpoint;
  if (event.state === 'applied') next.result = event.result;
  if (event.state === 'failed') next.failure = event.failure;
  return next;
}

/** Reject rather than repair malformed or newer records, including rewritten history. */
export function parseHandoff(value: unknown): Handoff {
  requireValid(object(value) && keys(value, [
    'schemaVersion', 'id', 'createdAt', 'updatedAt', 'version', 'from', 'to', 'senderName', 'task', 'mode', 'manifest',
    'state', 'history', 'acceptance', 'progress', 'checkpoint', 'result', 'failure',
  ]));
  requireValid(value.schemaVersion === HANDOFF_SCHEMA_VERSION && typeof value.id === 'string' && UUID.test(value.id)
    && integer(value.createdAt) && integer(value.updatedAt) && integer(value.version)
    && isHandoffAgent(value.from) && isTarget(value.to) && !('agentId' in value.to && sameHandoffAgent(value.from, value.to))
    && (value.senderName === undefined || bounded(value.senderName, 128))
    && object(value.task) && keys(value.task, ['title', 'brief'])
    && bounded(value.task.title, HANDOFF_LIMITS.title) && bounded(value.task.brief, HANDOFF_LIMITS.brief)
    && (value.mode === 'branch' || value.mode === 'worktree') && (value.manifest === undefined || isSummary(value.manifest))
    && Array.isArray(value.history) && value.history.length > 0 && value.history.length <= HANDOFF_LIMITS.history);
  const history: HandoffTransition[] = [];
  for (const event of value.history) {
    requireValid(isTransition(event) && !history.some((prior) => prior.operationId === event.operationId));
    history.push(event);
  }
  const first = history[0];
  requireValid(first.state === 'offered' && first.at === value.createdAt && first.by.kind === 'agent'
    && sameHandoffAgent(first.by.address, value.from));
  let manifest: HandoffManifestSummary | undefined;
  if (value.manifest !== undefined) {
    requireValid(isSummary(value.manifest));
    manifest = value.manifest;
  }
  let replay: Handoff = {
    schemaVersion: 1, id: value.id, createdAt: value.createdAt, updatedAt: value.createdAt, version: 1,
    from: value.from, to: value.to, ...(value.senderName !== undefined && { senderName: value.senderName as string }), task: { title: value.task.title, brief: value.task.brief }, mode: value.mode,
    ...(manifest !== undefined && { manifest }), state: 'offered', history: [first],
  };
  for (const event of history.slice(1)) {
    validateNext(replay, event);
    replay = append(replay, event);
  }
  requireValid(value.version === replay.version && value.state === replay.state && value.updatedAt === replay.updatedAt);
  for (const field of ['acceptance', 'progress', 'checkpoint', 'result', 'failure'] as const) {
    // Both are compared in schema order, independently of JSON property order.
    const raw = value[field];
    const expected = replay[field];
    if (expected === undefined) requireValid(raw === undefined);
    else {
      requireValid(object(raw) && keys(raw, Object.keys(expected)));
      if (field === 'acceptance') {
        requireValid(isHandoffAgent(raw.by) && isHandoffAgent(raw.target) && replay.acceptance
          && sameHandoffAgent(raw.by, replay.acceptance.by) && sameHandoffAgent(raw.target, replay.acceptance.target));
      } else if (field === 'progress') {
        requireValid(replay.progress && raw.bytesDone === replay.progress.bytesDone && raw.totalBytes === replay.progress.totalBytes);
      } else if (field === 'checkpoint') {
        requireValid(isCheckpoint(raw) && replay.checkpoint && raw.projectId === replay.checkpoint.projectId
          && raw.worktree === replay.checkpoint.worktree && raw.branch === replay.checkpoint.branch && raw.stagingId === replay.checkpoint.stagingId);
      } else if (field === 'result') {
        requireValid(isResult(raw) && replay.result && sameHandoffAgent(raw.agent, replay.result.agent)
          && raw.worktree === replay.result.worktree && raw.branch === replay.result.branch && raw.commit === replay.result.commit);
      } else {
        requireValid(isFailure(raw) && replay.failure && raw.step === replay.failure.step && raw.code === replay.failure.code);
      }
      requireValid(replay.history.length < HANDOFF_LIMITS.history || isTerminalHandoff(replay.state));
    }
  }
  // Leave envelope headroom and room for a terminal event's JSON-escaped result plus its derived copy.
  const byteLimit = HANDOFF_LIMITS.encodedBytes - (isTerminalHandoff(replay.state) ? 0 : HANDOFF_LIMITS.terminalReserveBytes);
  requireValid(new TextEncoder().encode(JSON.stringify(replay)).byteLength <= byteLimit);
  return structuredClone(replay);
}

export function transitionHandoff(record: Handoff, event: HandoffTransition, expectedVersion: number): Handoff {
  const current = parseHandoff(record);
  requireValid(isTransition(event));
  const priorIndex = current.history.findIndex((prior) => prior.operationId === event.operationId);
  if (priorIndex !== -1) {
    const intent = (value: HandoffTransition) => {
      const by = value.by.kind === 'agent' ? ['agent', value.by.address.machine, value.by.address.agentId] : ['machine', value.by.machine];
      let detail: unknown;
      if (value.state === 'accepted') detail = [value.target.machine, value.target.agentId];
      if (value.state === 'transferring') detail = value.bytesDone;
      if (value.state === 'applying') detail = [value.checkpoint.projectId, value.checkpoint.worktree, value.checkpoint.branch, value.checkpoint.stagingId];
      if (value.state === 'applied') detail = [value.result.agent.machine, value.result.agent.agentId, value.result.worktree, value.result.branch, value.result.commit];
      if (value.state === 'failed') detail = [value.failure.step, value.failure.code];
      return JSON.stringify([value.state, by, value.reason, detail]);
    };
    if (expectedVersion < 1 || priorIndex !== expectedVersion || intent(current.history[priorIndex]) !== intent(event)) {
      throw new Error('Conflicting handoff operation.');
    }
    return current;
  }
  if (current.version !== expectedVersion) throw new Error('Handoff version conflict.');
  validateNext(current, event);
  return parseHandoff(append(current, event));
}
