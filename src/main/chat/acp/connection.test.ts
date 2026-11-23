import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '../../orchestrators/adapters/rpc-error';
import { AcpConnection, AcpDisconnectedError, AcpRequestTimeoutError, type AcpTransportHandlers, type JsonRpcMessage } from './connection';

function pair() {
  const sent: JsonRpcMessage[] = [];
  let handlers!: AcpTransportHandlers;
  const onRequest = vi.fn<(method: string, params: unknown, signal: AbortSignal) => Promise<unknown>>();
  const onNotification = vi.fn();
  const conn = new AcpConnection((h) => {
    handlers = h;
    return { send: (m) => { sent.push(m); }, close: async () => undefined };
  }, { onRequest, onNotification, requestTimeoutMs: 50 });
  return { conn, sent, onRequest, onNotification, deliver: (m: JsonRpcMessage) => handlers.onMessage(m), end: () => handlers.onEnd({ code: 1, signal: null }) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AcpConnection', () => {
  it('matches responses by id, string and number ids apart', async () => {
    const { conn, sent, deliver } = pair();
    const a = conn.request('a', {});
    deliver({ jsonrpc: '2.0', id: '1', result: 'wrong' });
    deliver({ jsonrpc: '2.0', id: 1, result: 'right' });
    await expect(a).resolves.toBe('right');
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'a', params: {} });
  });

  it('rejects with the agent error code', async () => {
    const { conn, deliver } = pair();
    const a = conn.request('a', {});
    deliver({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'nope' } });
    await expect(a).rejects.toMatchObject({ code: -32002 });
    await expect(a).rejects.toBeInstanceOf(RpcError);
  });

  it('withdraws a timed-out request with $/cancel_request and ignores the late answer', async () => {
    const { conn, sent, deliver } = pair();
    await expect(conn.request('slow', {})).rejects.toBeInstanceOf(AcpRequestTimeoutError);
    expect(sent[1]).toEqual({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 1 } });
    deliver({ jsonrpc: '2.0', id: 1, result: 'late' });
  });

  it('waits without a timeout when asked', async () => {
    const { conn, deliver } = pair();
    const turn = conn.request('session/prompt', {}, { timeoutMs: null });
    await new Promise((r) => setTimeout(r, 80));
    deliver({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('answers agent requests, including errors, and -32800 when the agent withdraws one', async () => {
    const { sent, deliver, onRequest } = pair();
    onRequest.mockResolvedValueOnce({ ok: 1 });
    deliver({ jsonrpc: '2.0', id: 'r1', method: 'x', params: {} });
    onRequest.mockRejectedValueOnce(new RpcError(-32601, 'no'));
    deliver({ jsonrpc: '2.0', id: 'r2', method: 'y', params: {} });
    let aborted = false;
    onRequest.mockImplementationOnce((_m, _p, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve('too late'); });
    }));
    deliver({ jsonrpc: '2.0', id: 'r3', method: 'z', params: {} });
    deliver({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'r3' } });
    await tick();
    expect(aborted).toBe(true);
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 'r3', error: { code: -32800, message: 'Request cancelled' } },
      { jsonrpc: '2.0', id: 'r1', result: { ok: 1 } },
      { jsonrpc: '2.0', id: 'r2', error: { code: -32601, message: 'no' } },
    ]);
  });

  it('rejects pending requests as disconnected when the transport ends, and sends nothing after', async () => {
    const { conn, sent, end, deliver, onNotification } = pair();
    const a = conn.request('a', {}, { timeoutMs: null });
    end();
    await expect(a).rejects.toBeInstanceOf(AcpDisconnectedError);
    await expect(conn.request('b', {})).rejects.toBeInstanceOf(AcpDisconnectedError);
    conn.notify('c', {});
    deliver({ jsonrpc: '2.0', method: 'late', params: {} });
    expect(sent).toHaveLength(1);
    expect(onNotification).not.toHaveBeenCalled();
  });
});
