import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import { BULK_CHUNK_BYTES, BULK_IDLE_MS, BULK_MAX_TRANSFERS, ControlBulkLane, type BulkHooks } from './annex-control-bulk';
import type { ControlMessage } from '../../shared/annex-control-protocol';
type Frame = Extract<ControlMessage, { type: 'bulk' }>;
const lanes: ControlBulkLane[] = [];
afterEach(() => { for (const lane of lanes) lane.close(); lanes.length = 0; vi.useRealTimers(); });
function fixture() {
  const hooks = { allowed: vi.fn(() => true), accept: vi.fn(() => true), complete: vi.fn(), send: vi.fn(() => true), binary: vi.fn(() => true), fail: vi.fn() } satisfies BulkHooks;
  const lane = new ControlBulkLane(hooks); lanes.push(lane);
  const start: Frame = { v: 1, type: 'bulk', op: 'start', transfer: randomUUID(), id: 'request-1', kind: 'request', size: 1, meta: {} };
  const binary = (seq = 0, data = Buffer.from('a'), token = start.transfer) => {
    const bytes = Buffer.alloc(40 + data.length); bytes.write(token, 0, 36); bytes.writeUInt32BE(seq, 36); data.copy(bytes, 40); return bytes;
  };
  const finish: Frame = { ...start, op: 'finish', digest: createHash('sha256').update('a').digest('hex') };
  return { hooks, lane, start, binary, finish };
}
describe('bulk lane guards', () => {
  it('checks admission before retaining any body, not just at delivery', () => {
    const f = fixture(); f.hooks.accept.mockReturnValue(false); f.lane.receive(f.start);
    expect(f.hooks.send).not.toHaveBeenCalled(); expect(f.hooks.fail).toHaveBeenCalledOnce();
  });
  it('bounds transfer count before admitting another body', () => {
    const f = fixture();
    for (let i = 0; i <= BULK_MAX_TRANSFERS; i++) f.lane.receive({ ...f.start, transfer: randomUUID(), id: `r${i}` });
    expect(f.hooks.accept).toHaveBeenCalledTimes(BULK_MAX_TRANSFERS); expect(f.hooks.fail).toHaveBeenCalledOnce();
  });
  it('bounds metadata before retaining it', () => {
    const f = fixture(); f.lane.receive({ ...f.start, meta: { huge: 'a'.repeat(17000) } });
    expect(f.hooks.accept).not.toHaveBeenCalled(); expect(f.hooks.fail).toHaveBeenCalledOnce();
  });
  it.each(['sequence', 'size', 'token', 'oversize'])('rejects an invalid binary %s before retention', (guard) => {
    const f = fixture(); f.lane.receive(f.start);
    const bytes = guard === 'sequence' ? f.binary(1) : guard === 'size' ? f.binary(0, Buffer.from('ab')) : guard === 'token' ? f.binary(0, Buffer.from('a'), randomUUID()) : f.binary(0, Buffer.alloc(BULK_CHUNK_BYTES + 1));
    f.lane.binary(bytes); expect(f.hooks.fail).toHaveBeenCalledOnce(); expect(f.hooks.complete).not.toHaveBeenCalled();
  });
  it.each(['digest', 'length', 'owner', 'authority'])('never delivers on a final %s failure', (guard) => {
    const f = fixture(); f.lane.receive(f.start);
    if (guard !== 'length') f.lane.binary(f.binary());
    if (guard === 'owner') f.hooks.accept.mockReturnValue(false);
    if (guard === 'authority') f.hooks.allowed.mockReturnValue(false);
    f.lane.receive(guard === 'digest' ? { ...f.finish, digest: '0'.repeat(64) } : guard === 'length' ? { ...f.finish, digest: createHash('sha256').update('').digest('hex') } : f.finish);
    expect(f.hooks.complete).not.toHaveBeenCalled();
    if (guard !== 'authority') expect(f.hooks.fail).toHaveBeenCalledOnce();
  });
  it('binds credits and cancellation to both the token and operation id', async () => {
    const f = fixture(); f.lane.send('request', 'r', {}, Buffer.from('a'));
    const start = f.hooks.send.mock.calls[0][0] as Frame;
    f.lane.receive({ ...start, op: 'credit', id: 'stolen' });
    expect(f.hooks.fail).toHaveBeenCalledOnce(); expect(f.hooks.binary).not.toHaveBeenCalled();
    f.lane.receive({ ...start, op: 'cancel', id: 'stolen' });
    expect(f.hooks.fail).toHaveBeenCalledTimes(2);
  });
  it('sends nothing until credited and cannot accumulate credits', async () => {
    const f = fixture(); f.lane.send('request', 'r', {}, Buffer.from('a'));
    const start = f.hooks.send.mock.calls[0][0] as Frame;
    expect(f.hooks.binary).not.toHaveBeenCalled();
    f.lane.receive({ ...start, op: 'credit' }); f.lane.receive({ ...start, op: 'credit' });
    expect(f.hooks.fail).toHaveBeenCalledOnce();
  });
  it('reauthorizes each binary frame and frees cancelled transfers', () => {
    const f = fixture(); f.lane.receive(f.start); f.hooks.allowed.mockReturnValue(false); f.lane.binary(f.binary());
    expect(f.hooks.send).toHaveBeenCalledTimes(1);
    f.hooks.allowed.mockReturnValue(true); f.lane.cancel(f.start.id); f.lane.binary(f.binary());
    expect(f.hooks.complete).not.toHaveBeenCalled(); expect(f.hooks.fail).not.toHaveBeenCalled();
  });
  it('times out a stalled credit and cleans its slot', async () => {
    vi.useFakeTimers(); const f = fixture(); const done = vi.fn();
    f.lane.send('request', 'r', {}, Buffer.from('a'), done);
    await vi.advanceTimersByTimeAsync(BULK_IDLE_MS + 1);
    expect(done).toHaveBeenCalledOnce(); expect(f.hooks.fail).toHaveBeenCalledOnce();
  });
});

it('P6 actual pump reauthorizes after credit and waits for the previous write callback', async () => {
  const f = fixture();
  f.lane.send('request', 'r', {}, Buffer.alloc(2 * BULK_CHUNK_BYTES));
  const start = f.hooks.send.mock.calls[0][0] as Frame;
  f.lane.receive({ ...start, op: 'credit' });
  await new Promise((r) => setImmediate(r));
  expect(f.hooks.binary).toHaveBeenCalledTimes(1);
  f.lane.receive({ ...start, op: 'credit' });
  await new Promise((r) => setImmediate(r));
  expect(f.hooks.binary).toHaveBeenCalledTimes(1);
  f.lane.close();
  const next = fixture(); next.lane.send('request', 'r', {}, Buffer.from('a'));
  const other = next.hooks.send.mock.calls[0][0] as Frame;
  next.lane.receive({ ...other, op: 'credit' }); next.hooks.allowed.mockReturnValue(false);
  await new Promise((r) => setImmediate(r));
  expect(next.hooks.binary).not.toHaveBeenCalled();
});


it('waits for the written callback even if a receiver sends another credit early', async () => {
  const f = fixture();
  f.lane.send('request', 'r', {}, Buffer.alloc(2 * BULK_CHUNK_BYTES));
  const start = f.hooks.send.mock.calls[0][0] as Frame;
  f.lane.receive({ ...start, op: 'credit' });
  await new Promise((r) => setImmediate(r));
  expect(f.hooks.binary).toHaveBeenCalledTimes(1);
  f.lane.receive({ ...start, op: 'credit' });
  await new Promise((r) => setImmediate(r));
  expect(f.hooks.binary).toHaveBeenCalledTimes(1);
});
it('checks actual send authority after yielding to control traffic', async () => {
  const f = fixture(); f.lane.send('request', 'r', {}, Buffer.from('a'));
  const start = f.hooks.send.mock.calls[0][0] as Frame;
  f.lane.receive({ ...start, op: 'credit' }); f.hooks.allowed.mockReturnValue(false);
  await new Promise((r) => setImmediate(r));
  expect(f.hooks.binary).not.toHaveBeenCalled();
});
