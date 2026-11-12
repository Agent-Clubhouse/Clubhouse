import { describe, expect, it, vi } from 'vitest';
import type { McpToolHandler } from '../types';

const mocks = vi.hoisted(() => ({ handler: undefined as McpToolHandler | undefined, read: vi.fn(), grant: undefined as unknown }));
vi.mock('../tool-registry', () => ({ registerGlobalTool: (_name: string, _definition: unknown, handler: McpToolHandler, options: unknown) => { mocks.handler = handler; mocks.grant = options; } }));
vi.mock('../../annex-agent-calls', () => ({ getDelivery: mocks.read }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
import { registerAnnexDeliveryTools } from './annex-delivery-tools';

describe('get_delivery', () => {
  it('scopes every lookup to its authenticated caller and rejects unbounded/unknown input', async () => {
    registerAnnexDeliveryTools();
    mocks.read.mockReturnValue({ callId: 'id', state: 'indeterminate' });
    expect((await mocks.handler!('caller', { delivery_id: 'id' })).isError).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledWith('caller', 'id');
    mocks.read.mockReturnValue(undefined);
    expect((await mocks.handler!('other', { delivery_id: 'id' })).isError).toBe(true);
    mocks.read.mockClear();
    expect((await mocks.handler!('caller', { delivery_id: 'x'.repeat(201) })).isError).toBe(true);
    expect((await mocks.handler!('caller', { delivery_id: 'id', callerId: 'other' })).isError).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
