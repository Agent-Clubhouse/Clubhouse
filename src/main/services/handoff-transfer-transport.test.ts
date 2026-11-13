import { afterEach, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/handoffs';
import { HANDOFF_TRANSFER_TIMEOUT_MS, HANDOFF_TRANSFER_ROUTE, HANDOFF_TRANSFER_BODY_BYTES } from '../../shared/handoff-transfer';
const state = vi.hoisted(() => ({ machine: Array(16).fill('ab').join(':'), remote: Array(16).fill('cd').join(':'), post: vi.fn(), local: vi.fn() }));
vi.mock('./annex-identity', () => ({ getOrCreateIdentity: () => ({ fingerprint: state.machine }) }));
vi.mock('./annex-client', () => ({ postToMachine: state.post }));
vi.mock('./handoff-host', () => ({ receiveHandoffTransfer: state.local }));
import { requestHandoffTransfer } from './handoff-transfer-transport';
import { HandoffTransferInterrupted, HandoffTransferRefused } from './handoff-transfer-receiver';
const request = { op: 'manifest' as const, id: '11111111-1111-4111-8111-111111111111' };
const record = (machine = state.remote) => ({ from: { machine }, to: { machine: state.machine } }) as Handoff;
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it('uses the same local authorization boundary without network traffic', async () => {
  state.local.mockResolvedValue({ manifest: 'local' });
  expect(await requestHandoffTransfer(record(state.machine), request)).toEqual({ manifest: 'local' });
  expect(state.local).toHaveBeenCalledWith(state.machine, request); expect(state.post).not.toHaveBeenCalled();
});
it('uses only the pinned machine route and bounded response option', async () => {
  state.post.mockResolvedValue({ status: 200, body: { manifest: 'remote' } });
  expect(await requestHandoffTransfer(record(), request)).toEqual({ manifest: 'remote' });
  expect(state.post).toHaveBeenCalledWith(state.remote, HANDOFF_TRANSFER_ROUTE, request, { signal: expect.any(AbortSignal), maxResponseBytes: HANDOFF_TRANSFER_BODY_BYTES });
});
it.each([400, 403, 404])('classifies permanent HTTP %s refusal without retrying the data', async (status) => {
  state.post.mockResolvedValue({ status }); await expect(requestHandoffTransfer(record(), request)).rejects.toBeInstanceOf(HandoffTransferRefused);
});
it.each([429, 500, 503])('retains resumable data on transient HTTP %s', async (status) => {
  state.post.mockResolvedValue({ status }); await expect(requestHandoffTransfer(record(), request)).rejects.toBeInstanceOf(HandoffTransferInterrupted);
});
it('aborts a never-settling remote response at its total deadline', async () => {
  vi.useFakeTimers(); state.post.mockImplementation(() => new Promise(() => {}));
  const pending = expect(requestHandoffTransfer(record(), request)).rejects.toBeInstanceOf(HandoffTransferInterrupted);
  await vi.advanceTimersByTimeAsync(HANDOFF_TRANSFER_TIMEOUT_MS + 1); await pending;
  expect(state.post.mock.calls[0][3].signal.aborted).toBe(true);
});
it('makes local admission or verification refusal terminal too', async () => {
  state.local.mockRejectedValue(new Error('private verification detail'));
  await expect(requestHandoffTransfer(record(state.machine), request)).rejects.toBeInstanceOf(HandoffTransferRefused);
});
it('bounds a never-settling local sample too', async () => {
  vi.useFakeTimers(); state.local.mockImplementation(() => new Promise(() => {}));
  const pending = expect(requestHandoffTransfer(record(state.machine), request)).rejects.toBeInstanceOf(HandoffTransferInterrupted);
  await vi.advanceTimersByTimeAsync(HANDOFF_TRANSFER_TIMEOUT_MS + 1); await pending;
  expect(state.post).not.toHaveBeenCalled();
});
