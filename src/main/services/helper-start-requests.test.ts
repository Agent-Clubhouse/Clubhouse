import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dropStartRequestsFor,
  listStartRequests,
  MAX_PENDING_STARTS_PER_ORCHESTRATOR,
  onStartRequestsChanged,
  recordStartRequest,
  START_REQUEST_TTL_MS,
  takeStartRequest,
  _resetStartRequestsForTesting,
  type StartRequestChange,
} from './helper-start-requests';

const PROJECT = path.join(path.sep, 'tmp', 'project');
const OTHER = path.join(path.sep, 'tmp', 'other');
const args = (name: string) => ({ name, task: `Do ${name}` });

describe('helper start requests (#2234)', () => {
  let changes: StartRequestChange[];

  beforeEach(() => {
    _resetStartRequestsForTesting();
    changes = [];
    onStartRequestsChanged((c) => changes.push(c));
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetStartRequestsForTesting();
  });

  it('records a request with its arguments and times, and reports it', () => {
    const now = Date.parse('2026-10-18T10:00:00.000Z');
    const result = recordStartRequest(PROJECT, 'orch', 'Orch', { ...args('a'), access: 'auto' }, now);
    expect(result).toMatchObject({ ok: true, reused: false });
    if (!result.ok) return;
    expect(result.request).toMatchObject({
      projectPath: PROJECT, orchestratorId: 'orch', orchestratorName: 'Orch',
      args: { name: 'a', task: 'Do a', access: 'auto' },
      createdAt: '2026-10-18T10:00:00.000Z',
      expiresAt: new Date(now + START_REQUEST_TTL_MS).toISOString(),
    });
    expect(changes).toEqual([{ kind: 'added', request: result.request }]);
  });

  it('reuses an identical request and treats any changed argument as new', () => {
    const first = recordStartRequest(PROJECT, 'orch', 'Orch', args('a'));
    const same = recordStartRequest(PROJECT, 'orch', 'Orch', args('a'));
    const differs = recordStartRequest(PROJECT, 'orch', 'Orch', { ...args('a'), model: 'm' });
    expect(same).toMatchObject({ ok: true, reused: true });
    if (!first.ok || !same.ok || !differs.ok) throw new Error('unexpected refusal');
    expect(same.request.requestId).toBe(first.request.requestId);
    expect(differs.request.requestId).not.toBe(first.request.requestId);
    expect(listStartRequests()).toHaveLength(2);
  });

  it('caps the requests waiting per orchestrator, not across orchestrators', () => {
    for (let i = 0; i < MAX_PENDING_STARTS_PER_ORCHESTRATOR; i++) recordStartRequest(PROJECT, 'orch', 'Orch', args(`h${i}`));
    expect(recordStartRequest(PROJECT, 'orch', 'Orch', args('more'))).toEqual({ ok: false, reason: 'too_many', waiting: MAX_PENDING_STARTS_PER_ORCHESTRATOR });
    expect(recordStartRequest(PROJECT, 'orch2', 'Orch 2', args('more')).ok).toBe(true);
  });

  it('gives a request out once, and only in its own project', () => {
    const recorded = recordStartRequest(PROJECT, 'orch', 'Orch', args('a'));
    if (!recorded.ok) throw new Error('unexpected refusal');
    const id = recorded.request.requestId;
    expect(takeStartRequest(OTHER, id)).toBeNull();
    expect(takeStartRequest(PROJECT, id)?.requestId).toBe(id);
    expect(takeStartRequest(PROJECT, id)).toBeNull();
    expect(takeStartRequest(PROJECT, 'hstart_unknown')).toBeNull();
    expect(changes.at(-1)).toEqual({ kind: 'closed', requestIds: [id] });
  });

  it('expires a request after the time to live and reports it closed', () => {
    vi.useFakeTimers();
    const recorded = recordStartRequest(PROJECT, 'orch', 'Orch', args('a'));
    if (!recorded.ok) throw new Error('unexpected refusal');
    vi.advanceTimersByTime(START_REQUEST_TTL_MS - 1000);
    expect(listStartRequests()).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(listStartRequests()).toEqual([]);
    expect(takeStartRequest(PROJECT, recorded.request.requestId)).toBeNull();
    expect(changes.at(-1)).toEqual({ kind: 'closed', requestIds: [recorded.request.requestId] });
  });

  it('drops one orchestrator\'s requests', () => {
    recordStartRequest(PROJECT, 'orch', 'Orch', args('a'));
    recordStartRequest(PROJECT, 'orch', 'Orch', args('b'));
    recordStartRequest(PROJECT, 'orch2', 'Orch 2', args('c'));
    expect(dropStartRequestsFor('orch', PROJECT)).toHaveLength(2);
    expect(listStartRequests().map((r) => r.orchestratorId)).toEqual(['orch2']);
    expect(dropStartRequestsFor('orch')).toEqual([]);
  });
});
