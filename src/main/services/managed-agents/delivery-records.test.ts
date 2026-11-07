import { beforeEach, describe, expect, it } from 'vitest';
import { delivered, dropRunningSnapshot, failedDeliveries, forgetDelivery, mcpProblems } from './delivery-records';
import type { DeliveryRecord } from './delivery';

const record = (): DeliveryRecord => ({
  fingerprint: 'f1', deliveredAt: '2026-11-07T10:00:00.000Z', orchestrator: 'claude-code', parts: {}, order: [],
  snapshot: { deliveredAt: '2026-11-07T10:00:00.000Z', instructions: 'You are ada.', rawInstructions: 'You are @@AgentName.', skills: [], mcps: [], settings: [] },
});

beforeEach(() => {
  delivered.clear();
  failedDeliveries.clear();
});

describe('what a running session started with (D79)', () => {
  it('drops the text when the session ends, keeping the fingerprint and CLI a restart reads', () => {
    delivered.set('ada', record());
    dropRunningSnapshot('ada');
    expect(delivered.get('ada')).toEqual({ fingerprint: 'f1', deliveredAt: '2026-11-07T10:00:00.000Z', orchestrator: 'claude-code', parts: {}, order: [] });
    dropRunningSnapshot('nobody');
    expect(delivered.has('nobody')).toBe(false);
  });

  it('forgets everything for an agent that is gone', () => {
    delivered.set('ada', record());
    failedDeliveries.set('ada', 'disk full');
    forgetDelivery('ada');
    expect(delivered.has('ada')).toBe(false);
    expect(failedDeliveries.has('ada')).toBe(false);
  });
});

describe('a session\'s MCP start problems (D95)', () => {
  it('end with the session, and go when the agent is deleted or disposed', () => {
    mcpProblems.set('ada', [{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }]);
    dropRunningSnapshot('ada');
    expect(mcpProblems.has('ada')).toBe(false);
    mcpProblems.set('ada', [{ server: 'workiq', missingEnv: ['WORKIQ_TENANT'] }]);
    forgetDelivery('ada');
    expect(mcpProblems.has('ada')).toBe(false);
  });
});
