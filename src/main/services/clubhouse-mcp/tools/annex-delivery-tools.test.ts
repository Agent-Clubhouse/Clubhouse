import { describe, expect, it, vi } from 'vitest';
import type { McpToolHandler } from '../types';
import { tel } from '../../../telemetry/facade';

const mocks = vi.hoisted(() => ({ handler: undefined as McpToolHandler | undefined, read: vi.fn(), grant: undefined as unknown }));
vi.mock('../tool-registry', () => ({ registerGlobalTool: (_name: string, _definition: unknown, handler: McpToolHandler, options: unknown) => { mocks.handler = handler; mocks.grant = options; } }));
vi.mock('../../annex-agent-calls', () => ({ getDelivery: mocks.read }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
import { registerAnnexDeliveryTools } from './annex-delivery-tools';

describe('get_delivery', () => {
  it('reports a fixed failure without exporting the caught error or caller input', async () => {
    registerAnnexDeliveryTools();
    const report = vi.spyOn(tel, 'exception').mockImplementation(() => {});
    mocks.read.mockImplementationOnce(() => { throw new Error('SECRET token/path/callId'); });
    expect((await mocks.handler!('SECRET_AGENT', { delivery_id: 'SECRET_DELIVERY' })).isError).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ message: 'annex_delivery_status_read_failed', stack: undefined });
    expect(Object.getOwnPropertyNames(report.mock.calls[0][0])).toEqual(['stack', 'message']);
    expect(report.mock.calls[0][1]).toEqual({ origin: 'main', handled: true });
    report.mockRestore();
  });

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
