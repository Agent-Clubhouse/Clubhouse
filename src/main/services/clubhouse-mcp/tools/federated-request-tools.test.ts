import { describe, expect, it, vi } from 'vitest';
import { FederationBackpressure, FederationRefusal } from '../../../../shared/dispatcher-federation-requests';
import type { McpToolHandler } from '../types';
const state = vi.hoisted(() => ({ handlers: new Map<string, McpToolHandler>(), report: vi.fn(), triage: vi.fn() }));
vi.mock('../mcp-adapter', () => ({ mcpAdapter: { registerMcpCommand: vi.fn() } }));
vi.mock('../tool-registry', () => ({ registerGlobalTool: (name: string, _definition: unknown, handler: McpToolHandler) => { state.handlers.set(name, handler); } }));
vi.mock('../../dispatcher-federation-runtime', () => ({ federatedRequests: () => ({ report: state.report, triage: state.triage }) }));
import { registerFederatedRequestTools } from './federated-request-tools';
describe('federated report admission errors', () => {
  it.each(['report_remote_request', 'triage_remote_request'])('preserves typed refusals through %s', async (tool) => {
    registerFederatedRequestTools();
    for (const error of [new FederationBackpressure('rate_limited', 'Rate budget full', 500), new FederationRefusal('depth_unrepresentable', 'Tracing depth is unsafe')]) {
      state.report.mockRejectedValueOnce(error); state.triage.mockRejectedValueOnce(error);
      const result = await state.handlers.get(tool)!('controller', { id: 'request', outcome: 'answered', message: 'Done', choice: 'now', reason: 'Ready' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text!)).toEqual({ error: error.details() });
      state.report.mockReset(); state.triage.mockReset();
    }
  });
});
