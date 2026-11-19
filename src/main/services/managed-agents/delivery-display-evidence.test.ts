import { afterEach, expect, it } from 'vitest';
import { delivered, failedDeliveries, mcpProblems, forgetDelivery } from './delivery-records';
import { readSelectedDeliveryForDisplay } from './delivery-display-evidence';
import type { DeliveryRecord } from './delivery';

const record = (): DeliveryRecord => ({ fingerprint: 'synthetic', deliveredAt: '2026-11-19T00:00:00Z',
  parts: { chosen: { name: 'Chosen', revision: 1 } }, order: ['chosen'], deliveredSkillIds: ['chosen'],
  launch: { model: 'selected-model', effort: null, access: null, freeAgentMode: null } });
afterEach(() => { forgetDelivery('selected'); forgetDelivery('unrelated'); });

it('returns detached selected allowlisted fields without retaining delivery snapshots or unknown private fields', () => {
  const source = { ...record(), snapshot: { instructions: 'PRIVATE_SNAPSHOT' }, unknown: 'PRIVATE_UNKNOWN' };
  delivered.set('selected', source as unknown as DeliveryRecord);
  mcpProblems.set('selected', [{ server: 'Chosen MCP', missingEnv: ['KEY_NAME'] }]);
  const result = readSelectedDeliveryForDisplay('selected', true, () => true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|snapshot|unknown/);
  result.record!.parts.chosen.name = 'Caller changed'; result.record!.order.push('caller'); result.record!.deliveredSkillIds!.push('caller'); result.record!.launch!.model = 'caller';
  result.problems![0].missingEnv.push('CALLER');
  expect(delivered.get('selected')).toEqual(source); expect(source.parts.chosen.name).toBe('Chosen'); expect(source.order).toEqual(['chosen']); expect(source.deliveredSkillIds).toEqual(['chosen']); expect(source.launch!.model).toBe('selected-model');
  expect(mcpProblems.get('selected')).toEqual([{ server: 'Chosen MCP', missingEnv: ['KEY_NAME'] }]); expect(result.receipt.current()).toBe(true);
});
it('invalidates selected replacement, in-place metadata edits, and stop while ignoring unrelated records', () => {
  delivered.set('selected', record()); let running = true;
  const first = readSelectedDeliveryForDisplay('selected', true, () => running); expect(first.receipt.current()).toBe(true);
  delivered.set('unrelated', record()); expect(first.receipt.current()).toBe(true);
  delivered.set('selected', record()); expect(first.receipt.current()).toBe(false);
  const second = readSelectedDeliveryForDisplay('selected', true, () => running);
  delivered.get('selected')!.parts.chosen.revision = 2; expect(second.receipt.current()).toBe(false);
  const third = readSelectedDeliveryForDisplay('selected', true, () => running); running = false; expect(third.receipt.current()).toBe(false);
});
it('keeps stopped evidence independent of retained prior-run caches', () => {
  delivered.set('selected', record()); failedDeliveries.set('selected', 'OLD_FAILURE'); mcpProblems.set('selected', [{ server: 'Old MCP', missingEnv: ['OLD_KEY'] }]);
  const result = readSelectedDeliveryForDisplay('selected', false, () => false);
  expect(result.record).toBeUndefined(); expect(result.failed).toBeUndefined(); expect(result.problems).toBeUndefined(); expect(result.receipt.current()).toBe(true);
});
it.each(['record', 'failed', 'problems'] as const)('refuses present invalid %s evidence instead of reporting absence', (kind) => {
  if (kind === 'record') delivered.set('selected', null as unknown as DeliveryRecord);
  if (kind === 'failed') failedDeliveries.set('selected', undefined as unknown as string);
  if (kind === 'problems') mcpProblems.set('selected', null as unknown as []);
  expect(() => readSelectedDeliveryForDisplay('selected', true, () => true)).toThrow('unreadable');
});
it.each(['parts', 'order', 'skills', 'failure', 'problems', 'env'] as const)('bounds selected %s evidence before projection', (kind) => {
  const source = record(); delivered.set('selected', source);
  if (kind === 'parts') source.parts = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`part-${i}`, { name: 'Chosen', revision: 1 }]));
  if (kind === 'order') source.order = Array(103).fill('chosen');
  if (kind === 'skills') source.deliveredSkillIds = Array(101).fill('chosen');
  if (kind === 'failure') failedDeliveries.set('selected', 'x'.repeat(8193));
  if (kind === 'problems') mcpProblems.set('selected', Array.from({ length: 101 }, () => ({ server: 'Chosen', missingEnv: [] })));
  if (kind === 'env') mcpProblems.set('selected', [{ server: 'Chosen', missingEnv: Array(101).fill('KEY_NAME') }]);
  expect(() => readSelectedDeliveryForDisplay('selected', true, () => true)).toThrow('read limit');
});
