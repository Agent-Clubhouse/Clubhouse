import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as path from 'path';
import { _resetStartRequestsForTesting, dropStartRequestsFor, listStartRequests, onStartRequestsChanged, readStartRequestsForDisplay, recordStartRequest, START_REQUEST_TTL_MS, takeStartRequest, type StartRequestChange } from './helper-start-requests';
const home = path.resolve('/selected-project'), other = path.resolve('/unrelated-project');
const add = (task = 'Review visible changes', name = 'Selected helper') => recordStartRequest(home, 'selected', 'Selected owner', { name, task });
beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-19T12:00:00Z') }); _resetStartRequestsForTesting(); });
afterEach(() => { _resetStartRequestsForTesting(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('returns bounded selected metadata and safe task text, never args/config/other owners or projects', () => {
  const first = recordStartRequest(home, 'selected', 'PRIVATE_OWNER', { name: 'Selected helper', task: 'Review visible changes', model: 'PRIVATE_MODEL', env: { PRIVATE_KEY: 'PRIVATE_VALUE' }, config: 'PRIVATE_CONFIG' } as never);
  const unrelated = recordStartRequest(other, 'unrelated', 'PRIVATE_OTHER', { name: 'PRIVATE_OTHER', task: 'PRIVATE_OTHER_TASK' });
  recordStartRequest(home, 'other-owner', 'PRIVATE_OWNER_2', { name: 'PRIVATE_OTHER_2', task: 'PRIVATE_OTHER_TASK_2' });
  expect(first.ok && unrelated.ok).toBe(true); const result = readStartRequestsForDisplay(home, 'selected');
  expect(result).toMatchObject({ state: 'ok', value: [{ status: 'awaiting-approval', name: { state: 'ok', text: 'Selected helper' }, task: { state: 'ok', text: 'Review visible changes', truncated: false } }] });
  if (result.state === 'ok') expect(result.value).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|args|config|provider|env|projectPath/);
  expect(readStartRequestsForDisplay(other, 'selected')).toMatchObject({ state: 'ok', value: [] });
});
it('does not inspect unrelated request fields or materialize a global inventory for display', () => {
  add(); const unrelated = recordStartRequest(other, 'unrelated', 'Other', { name: 'Other', task: 'Other work' }); if (!unrelated.ok) throw new Error('fixture refused');
  Object.defineProperty(unrelated.request, 'orchestratorId', { get: () => { throw new Error('unrelated request inspected'); } });
  expect(readStartRequestsForDisplay(home, 'selected')).toMatchObject({ state: 'ok', value: [{ name: { text: 'Selected helper' } }] });
});
it('reads expiry without sweeping requests, clearing timers or emitting changes', () => {
  add(); recordStartRequest(other, 'unrelated', 'Other', { name: 'Other', task: 'Other work' });
  const changes: StartRequestChange[] = []; onStartRequestsChanged((change) => changes.push(change)); const timers = vi.getTimerCount();
  vi.setSystemTime(Date.now() + START_REQUEST_TTL_MS + 1);
  expect(readStartRequestsForDisplay(home, 'selected')).toMatchObject({ state: 'ok', value: [] });
  expect.soft(changes).toEqual([]); expect.soft(vi.getTimerCount()).toBe(timers);
  // The ordinary explicit getter still performs its existing sweep. This
  // confirms the passive read did not remove the two expired records first.
  expect(listStartRequests()).toEqual([]); expect(changes).toEqual([{ kind: 'closed', requestIds: expect.any(Array) }]);
  expect(changes[0]).toMatchObject({ requestIds: expect.arrayContaining([expect.any(String), expect.any(String)]) }); expect(vi.getTimerCount()).toBe(0);
});
it.each(['cancel', 'expire', 'task-change', 'new-selected'] as const)('carries private selected currentness through later %s without read-triggered mutation', (change) => {
  const initial = add(); if (!initial.ok) throw new Error('fixture refused'); const receipts: Array<{ current(): boolean }> = [];
  expect(readStartRequestsForDisplay(home, 'selected', { receipts })).toMatchObject({ state: 'ok', value: [{ requestId: initial.request.requestId }] }); expect(receipts[0].current()).toBe(true);
  recordStartRequest(other, 'unrelated', 'Other', { name: 'Other', task: 'PRIVATE_UNRELATED' }); expect(receipts[0].current()).toBe(true);
  if (change === 'cancel') takeStartRequest(home, initial.request.requestId);
  if (change === 'expire') vi.setSystemTime(Date.now() + START_REQUEST_TTL_MS + 1);
  if (change === 'task-change') initial.request.args.task = 'Changed selected work';
  if (change === 'new-selected') add('Different selected work', 'Second helper');
  const changes: StartRequestChange[] = []; onStartRequestsChanged((event) => changes.push(event)); const timers = vi.getTimerCount();
  expect.soft(receipts[0].current()).toBe(false); expect.soft(changes).toEqual([]); expect.soft(vi.getTimerCount()).toBe(timers);
});
it.each([
  'const apiKey = ("PRIVATE_PAREN");',
  'config["apiKey"] = "PRIVATE_INDEXED";',
  'credentials = "PUBLIC_USER", "PRIVATE_TUPLE"',
  'const apiKey = "prefix" /* comment */ + "PRIVATE_TAIL";',
  '{"api\\u004bey":"PRIVATE_ESCAPED"}',
])('reuses conservative reviewed withholding for unsafe task text: %s', (task) => {
  add(task); const result = readStartRequestsForDisplay(home, 'selected');
  expect.soft(result).toMatchObject({ state: 'ok', value: [{ name: { state: 'ok', text: 'Selected helper' }, task: { state: 'withheld', reason: 'safety' }, status: 'awaiting-approval', createdAt: expect.any(String), expiresAt: expect.any(String) }] });
  expect.soft(JSON.stringify(result)).not.toMatch(/PRIVATE_|PUBLIC_USER|prefix|config\[/);
});
it('redacts a classified complete value before trimming, without retaining raw warning text', () => {
  const initial = recordStartRequest(home, 'selected', 'Owner', { name: 'Selected helper', task: 'Use apiKey="PRIVATE_TASK_VALUE";' }, Date.now(), { message: 'apiKey="PRIVATE_WARNING_VALUE";' } as never); expect(initial.ok).toBe(true);
  const result = readStartRequestsForDisplay(home, 'selected'); expect(result.state).toBe('ok');
  if (result.state === 'ok') { expect(result.value[0].task).toMatchObject({ state: 'ok', text: expect.stringContaining('<redacted>') }); expect(result.value[0].warning).toMatchObject({ state: 'ok', text: expect.stringContaining('<redacted>') }); }
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|args|warning.*provider/);
});
it('marks truncated and over-budget task content explicitly while retaining independent metadata', () => {
  add('Review ' + 'x'.repeat(3000)); add('x'.repeat(64 * 1024 + 1), 'Large task helper');
  const result = readStartRequestsForDisplay(home, 'selected'); expect(result.state).toBe('ok');
  if (result.state === 'ok') { expect(result.value[0].task).toMatchObject({ state: 'ok', truncated: true, text: expect.stringContaining('[text truncated]') }); if (result.value[0].task.state === 'ok') expect(result.value[0].task.text.length).toBeLessThanOrEqual(2048); expect(result.value[1]).toMatchObject({ name: { text: 'Large task helper' }, task: { state: 'withheld', reason: 'read-limit' } }); }
});
it('classifies the complete bounded task before display truncation and fences changes hidden by redaction', () => {
  const first = add('Review ' + 'x'.repeat(3000) + '\nconfig["apiKey"]="PRIVATE_AFTER_TRUNCATION";');
  expect(first.ok).toBe(true);
  expect(readStartRequestsForDisplay(home, 'selected')).toMatchObject({ value: [{ task: { state: 'withheld', reason: 'safety' } }] });
  dropStartRequestsFor('selected', home);
  const next = add('apiKey="PRIVATE_INITIAL";'); if (!next.ok) throw new Error('fixture refused');
  const receipts: Array<{ current(): boolean }> = [];
  const before = readStartRequestsForDisplay(home, 'selected', { receipts }); expect(receipts[0].current()).toBe(true);
  next.request.args.task = 'apiKey="PRIVATE_REPLACED";';
  const after = readStartRequestsForDisplay(home, 'selected');
  expect(after).toEqual(before); // visible redacted values are deliberately identical
  expect(receipts[0].current()).toBe(false);
});
it('detaches the selected projection and keeps index cleanup aligned with ordinary cancellation/reset', () => {
  add(); const value = readStartRequestsForDisplay(home, 'selected'); if (value.state !== 'ok' || value.value[0].task.state !== 'ok') throw new Error('fixture missing');
  value.value[0].task.text = 'Caller mutation'; expect(readStartRequestsForDisplay(home, 'selected')).toMatchObject({ value: [{ task: { text: 'Review visible changes' } }] });
  dropStartRequestsFor('selected', home); expect(readStartRequestsForDisplay(home, 'selected')).toMatchObject({ state: 'ok', value: [] });
  add(); _resetStartRequestsForTesting(); expect(readStartRequestsForDisplay(home, 'selected')).toMatchObject({ state: 'ok', value: [] });
});
