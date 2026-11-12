import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_LIMITS, isTerminalHandoff, parseHandoff, transitionHandoff,
  type Handoff, type HandoffAgent, type HandoffTransition,
} from './handoffs';

const sender: HandoffAgent = { agentId: 'sender', machine: Array(16).fill('aa').join(':') };
const receiver: HandoffAgent = { agentId: 'receiver', machine: Array(16).fill('bb').join(':') };
const checkpoint = { projectId: 'project', worktree: '/registered/project/handoff', branch: 'handoff/example', stagingId: randomUUID() };

function offer(): Handoff {
  return parseHandoff({
    schemaVersion: 1, id: randomUUID(), createdAt: 1, updatedAt: 1, version: 1,
    from: sender, to: receiver, task: { title: 'Example task', brief: 'Goal, done, remaining, verification.' },
    mode: 'worktree', manifest: { fileCount: 1, totalBytes: 10, sha256: 'a'.repeat(64) },
    state: 'offered', history: [{ operationId: randomUUID(), at: 1, state: 'offered', by: { kind: 'agent', address: sender } }],
  });
}

function event(record: Handoff, update: Record<string, unknown>, by: HandoffTransition['by'] = { kind: 'machine', machine: receiver.machine }): HandoffTransition {
  return { operationId: randomUUID(), at: record.updatedAt + 1, by, ...update } as HandoffTransition;
}

function accepted(): Handoff {
  const record = offer();
  return transitionHandoff(record, event(record, { state: 'accepted', target: receiver }, { kind: 'agent', address: receiver }), record.version);
}

const encodedBytes = (record: Handoff) => new TextEncoder().encode(JSON.stringify(record)).byteLength;
const recordByteLimit = 384 * 1024;
const nonterminalByteLimit = recordByteLimit - 64 * 1024;

function fillTransfer(record: Handoff, reason: string, limit = nonterminalByteLimit): { current: Handoff; overflow: Handoff } {
  record.manifest!.totalBytes = 1000;
  for (let bytesDone = 0; record.history.length < HANDOFF_LIMITS.history - 1; bytesDone++) {
    const update: HandoffTransition = {
      operationId: randomUUID(), at: record.updatedAt + 1, by: { kind: 'machine', machine: receiver.machine },
      state: 'transferring', bytesDone, reason,
    };
    const next: Handoff = {
      ...record, version: record.version + 1, updatedAt: update.at, state: 'transferring',
      history: [...record.history, update], progress: { bytesDone, totalBytes: record.manifest!.totalBytes },
    };
    if (encodedBytes(next) > limit) return { current: record, overflow: next };
    record = transitionHandoff(record, update, record.version);
  }
  throw new Error('Fixture reached the history limit before the byte limit.');
}

describe('handoff record and lifecycle', () => {
  it('replays the complete agreement, verified transfer and durable apply checkpoint', () => {
    let record = accepted();
    for (const update of [
      { state: 'transferring', bytesDone: 0 }, { state: 'transferring', bytesDone: 10 },
      { state: 'verifying' }, { state: 'applying', checkpoint },
      { state: 'applied', result: { agent: receiver, worktree: checkpoint.worktree, branch: checkpoint.branch, commit: 'a'.repeat(40) } },
    ]) record = transitionHandoff(record, event(record, update), record.version);
    expect(parseHandoff(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(record).toMatchObject({ state: 'applied', version: 7, acceptance: { by: receiver, target: receiver }, checkpoint });
    expect(isTerminalHandoff(record.state)).toBe(true);
    expect(() => transitionHandoff(record, event(record, { state: 'failed', failure: { step: 'apply', code: 'apply_failed' } }), record.version)).toThrow();
  });

  it.each([
    ['newer schema', (record: Handoff) => ({ ...record, schemaVersion: 2 })],
    ['overlong brief', (record: Handoff) => ({ ...record, task: { ...record.task, brief: 'x'.repeat(HANDOFF_LIMITS.brief + 1) } })],
    ['invalid UUID', (record: Handoff) => ({ ...record, id: '../other' })],
    ['non-finite time', (record: Handoff) => ({ ...record, createdAt: Infinity })],
    ['unqualified sender', (record: Handoff) => ({ ...record, from: { agentId: 'sender' } })],
    ['unexpected payload', (record: Handoff) => ({ ...record, content: 'must not persist' })],
    ['invalid hash', (record: Handoff) => ({ ...record, manifest: { ...record.manifest, sha256: 'no' } })],
    ['unsafe byte count', (record: Handoff) => ({ ...record, manifest: { ...record.manifest, totalBytes: Number.MAX_SAFE_INTEGER + 1 } })],
    ['forged version', (record: Handoff) => ({ ...record, version: 10 })],
    ['forged state', (record: Handoff) => ({ ...record, state: 'applied' })],
    ['forged acceptance', (record: Handoff) => ({ ...record, acceptance: { by: receiver, target: receiver } })],
  ])('rejects %s without echoing input', (_name, corrupt) => {
    expect(() => parseHandoff(corrupt(offer()))).toThrow('Invalid handoff record.');
  });

  it('requires the addressed receiver and explicit acceptance before transfer', () => {
    const record = offer();
    expect(() => transitionHandoff(record, event(record, { state: 'transferring', bytesDone: 0 }), 1)).toThrow();
    expect(() => transitionHandoff(record, event(record, { state: 'accepted', target: receiver }, { kind: 'agent', address: sender }), 1)).toThrow();
    expect(() => transitionHandoff(record, event(record, { state: 'accepted', target: sender }, { kind: 'agent', address: receiver }), 1)).toThrow();
  });

  it('enforces compare-and-swap, monotonic bounded progress and complete transfer before verification', () => {
    let record = accepted();
    expect(() => transitionHandoff(record, event(record, { state: 'transferring', bytesDone: 0 }), 1)).toThrow('version conflict');
    record = transitionHandoff(record, event(record, { state: 'transferring', bytesDone: 5 }), record.version);
    for (const update of [{ state: 'transferring', bytesDone: 4 }, { state: 'transferring', bytesDone: 11 }, { state: 'verifying' }]) {
      expect(() => transitionHandoff(record, event(record, update), record.version)).toThrow();
    }
    expect(() => parseHandoff({ ...record, progress: { bytesDone: 10, totalBytes: 10 } })).toThrow();
  });

  it('permits sender cancellation only before the durable applying boundary', () => {
    let record = accepted();
    const cancel = (value: Handoff) => event(value, { state: 'cancelled' }, { kind: 'agent', address: sender });
    expect(transitionHandoff(record, cancel(record), record.version).state).toBe('cancelled');
    expect(() => transitionHandoff(record, event(record, { state: 'cancelled' }, { kind: 'agent', address: receiver }), record.version)).toThrow();
    for (const update of [{ state: 'transferring', bytesDone: 10 }, { state: 'verifying' }, { state: 'applying', checkpoint }]) {
      record = transitionHandoff(record, event(record, update), record.version);
    }
    expect(() => transitionHandoff(record, cancel(record), record.version)).toThrow();
    expect(() => parseHandoff({ ...record, checkpoint: { ...checkpoint, worktree: '/different' } })).toThrow();
  });

  it('rejects reordered or duplicated operations and backward timestamps', () => {
    const record = accepted();
    expect(() => parseHandoff({ ...record, history: [...record.history].reverse() })).toThrow();
    expect(() => transitionHandoff(record, { ...event(record, { state: 'transferring', bytesDone: 0 }), operationId: record.history[0].operationId }, record.version)).toThrow();
    expect(() => transitionHandoff(record, { ...event(record, { state: 'transferring', bytesDone: 0 }), at: 0 }, record.version)).toThrow();
  });

  it('reserves the final bounded history slot for a terminal decision', () => {
    let record = accepted();
    record.manifest!.totalBytes = HANDOFF_LIMITS.history;
    for (let bytesDone = 0; record.history.length < HANDOFF_LIMITS.history - 1; bytesDone++) {
      record = transitionHandoff(record, event(record, { state: 'transferring', bytesDone }), record.version);
    }
    expect(() => transitionHandoff(record, event(record, { state: 'transferring', bytesDone: record.progress!.bytesDone + 1 }), record.version)).toThrow();
    const cancelled = transitionHandoff(record, event(record, { state: 'cancelled' }, { kind: 'agent', address: sender }), record.version);
    expect(cancelled.history).toHaveLength(HANDOFF_LIMITS.history);
    expect(cancelled.state).toBe('cancelled');
  });

  it('bounds actual UTF-8 bytes rather than character count and retains room for cancellation', () => {
    const initial = accepted();
    initial.task.brief = '\u0800'.repeat(HANDOFF_LIMITS.brief);
    const { current, overflow } = fillTransfer(initial, '\u0800'.repeat(HANDOFF_LIMITS.reason));
    expect(overflow.history.length).toBeLessThan(HANDOFF_LIMITS.history);
    expect(JSON.stringify(overflow).length).toBeLessThan(nonterminalByteLimit);
    expect(encodedBytes(overflow)).toBeGreaterThan(nonterminalByteLimit);
    expect(() => parseHandoff(overflow)).toThrow('Invalid handoff record.');
    expect(parseHandoff(current)).toEqual(current);
    const cancelled = transitionHandoff(current, event(current, {
      state: 'cancelled', reason: '\u0001'.repeat(HANDOFF_LIMITS.reason),
    }, { kind: 'agent', address: sender }), current.version);
    expect(cancelled.state).toBe('cancelled');
    expect(encodedBytes(cancelled)).toBeLessThanOrEqual(recordByteLimit);
  });

  it('reserves bytes for maximum escaped apply results and indeterminate restart failure', () => {
    const initial = accepted();
    initial.task.brief = '\u0001'.repeat(HANDOFF_LIMITS.brief);
    const largeCheckpoint = {
      projectId: '\u0001'.repeat(128), worktree: '\u0001'.repeat(4096),
      branch: '\u0001'.repeat(256), stagingId: randomUUID(),
    };
    const reason = '\u0001'.repeat(HANDOFF_LIMITS.reason);
    const checkpointBytes = new TextEncoder().encode(JSON.stringify(largeCheckpoint)).byteLength;
    let { current } = fillTransfer(initial, reason, nonterminalByteLimit - 2 * checkpointBytes - 8 * 1024);
    current.manifest!.totalBytes = current.progress!.bytesDone;
    current.progress!.totalBytes = current.progress!.bytesDone;
    for (const update of [{ state: 'verifying', reason }, { state: 'applying', checkpoint: largeCheckpoint, reason }]) {
      current = transitionHandoff(current, event(current, update), current.version);
    }
    expect(encodedBytes(current)).toBeGreaterThan(nonterminalByteLimit - 12 * 1024);
    const applied = transitionHandoff(current, event(current, {
      state: 'applied', reason, result: {
        agent: receiver, worktree: largeCheckpoint.worktree, branch: largeCheckpoint.branch, commit: 'a'.repeat(64),
      },
    }), current.version);
    expect(encodedBytes(applied)).toBeGreaterThan(nonterminalByteLimit);
    expect(encodedBytes(applied)).toBeLessThanOrEqual(recordByteLimit);
    expect(parseHandoff(JSON.parse(JSON.stringify(applied)))).toEqual(applied);
    const recovered = transitionHandoff(current, event(current, {
      state: 'failed', reason, failure: { step: 'recovery', code: 'indeterminate_apply' },
    }), current.version);
    expect(recovered).toMatchObject({ state: 'failed', checkpoint: largeCheckpoint, failure: { code: 'indeterminate_apply' } });
    expect(encodedBytes(recovered)).toBeLessThanOrEqual(recordByteLimit);
  });

  it('rejects oversized escaped terminal history without truncating or echoing it', () => {
    const { current } = fillTransfer(accepted(), '\u0800'.repeat(HANDOFF_LIMITS.reason));
    const terminal = transitionHandoff(current, event(current, { state: 'cancelled' }, { kind: 'agent', address: sender }), current.version);
    terminal.task.brief = '\u0001'.repeat(HANDOFF_LIMITS.brief);
    terminal.history = terminal.history.map((entry) => ({ ...entry, reason: '\u0001'.repeat(HANDOFF_LIMITS.reason) }));
    expect(encodedBytes(terminal)).toBeGreaterThan(recordByteLimit);
    expect(() => parseHandoff(terminal)).toThrow('Invalid handoff record.');
    expect(terminal.history).toHaveLength(current.history.length + 1);
  });
});
