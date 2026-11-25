import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  value: { state: 'ok', inputs: [], value: { recorded: false, scope: 'none', reason: null, appliesToEpoch: () => false } },
  read: vi.fn(), reconcile: vi.fn(() => Promise.resolve()), effect: vi.fn(() => { throw new Error('unexpected runtime side effect'); }), stop: vi.fn(),
}));
vi.mock('./dispatcher-federation-context', () => ({ federationTurnInputs: m.effect, startFederationTurnTracking: m.effect, withFederationInput: m.effect }));
vi.mock('../telemetry/facade', () => ({ tel: { exception: m.effect } }));
vi.mock('../telemetry/dispatcher-telemetry', () => ({ recordFederatedRequest: m.effect, recordFederationLimit: m.effect }));
vi.mock('./dispatcher-federation-telemetry', () => ({ watchFederationTelemetry: () => m.stop }));
vi.mock('./annex-agent-calls', () => ({ captureControllerPublication: m.effect, forwardPreparedAgentCall: m.effect, flushOutbox: m.effect, getDelivery: m.effect, isNetworkComputer: m.effect }));
vi.mock('./annex-identity', () => ({ getIdentity: m.effect }));
vi.mock('./annex-network-membership', () => ({ ownPairing: m.effect }));
vi.mock('./annex-peers', () => ({ listPeers: m.effect }));
vi.mock('./dispatcher-federation', () => ({ controllerDirection: m.effect, remoteFederationController: m.effect }));
vi.mock('./dispatcher-federation-requests', () => ({ createFederationRequestStore: () => ({}), createFederatedRequests: () => ({ readPauseForDisplay: m.read, reconcile: m.reconcile }), FederationInputNotReady: class extends Error {} }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => null, dispatcherDisplayName: m.effect, isDispatcherEnabled: m.effect, onDispatcherChanged: () => m.stop }));
vi.mock('./dispatcher/dispatcher-requests', () => ({ beginRemoteRequest: m.effect, getRequest: m.effect, noteHandedOff: m.effect, settleFederatedRequest: m.effect, workTurnMark: m.effect }));
vi.mock('./clubhouse-mcp/tools/dispatcher-delivery', () => ({ deliverToDispatcher: m.effect }));
vi.mock('./dispatcher/dispatcher-channel', () => ({ deliverToChat: m.effect }));
vi.mock('./dispatcher/dispatcher-memory-timeline', () => ({ appendTimeline: m.effect }));
vi.mock('./dispatcher-federation-handoffs', () => ({ recordFederationHandoff: m.effect }));
vi.mock('./dispatcher-presence', () => ({ remoteDispatcherLabelFor: m.effect }));
vi.mock('./log-service', () => ({ appLog: m.effect }));
import { startFederatedRequests, federatedRequests } from './dispatcher-federation-runtime';
import { federationRequestRouter, readRegisteredFederationPauseForDisplay } from './dispatcher-federation-policy';
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); m.read.mockReset().mockReturnValue(m.value); m.reconcile.mockClear(); m.effect.mockClear(); m.stop.mockClear(); });
afterEach(() => { stop?.(); stop = undefined; vi.clearAllTimers(); vi.useRealTimers(); });
it('forwards the actual production installed optional callback only while its runtime service is active', () => {
  stop = startFederatedRequests(); const router = federationRequestRouter()!; const receipts: Array<{ current(): boolean }> = [];
  const value = readRegisteredFederationPauseForDisplay('selected-machine', { receipts }); expect(value).toBe(m.value); expect(m.read).toHaveBeenCalledExactlyOnceWith('selected-machine', { receipts }); expect(receipts[0].current()).toBe(true); expect(m.effect).not.toHaveBeenCalled(); expect(m.reconcile).toHaveBeenCalledOnce();
  stop(); stop = undefined; expect(federatedRequests()).toBeUndefined(); expect(federationRequestRouter()).toBeUndefined(); expect(receipts[0].current()).toBe(false);
  const retired = router.readPauseForDisplay!('selected-machine', { receipts: [] }); expect.soft(retired.state).toBe('unavailable'); expect.soft(m.read).toHaveBeenCalledTimes(1); expect(m.effect).not.toHaveBeenCalled();
});
it('a replacement production registration invalidates the prior installation receipt even for the same modeled adapter', () => {
  const firstStop = startFederatedRequests(); const receipts: Array<{ current(): boolean }> = []; readRegisteredFederationPauseForDisplay('selected-machine', { receipts }); expect(receipts[0].current()).toBe(true);
  stop = startFederatedRequests(); expect(receipts[0].current()).toBe(false); firstStop(); expect(federationRequestRouter()).toBeDefined(); expect(readRegisteredFederationPauseForDisplay('selected-machine', { receipts: [] })).toBe(m.value); expect(m.effect).not.toHaveBeenCalled();
});
