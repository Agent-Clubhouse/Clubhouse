/** Credit-controlled binary lane on a single authenticated /control connection.
 * One chunk per credit; each credit is consumed, never accumulated. Ownership
 * is the containing connection plus a random transfer token and operation id.
 * Body buffers are the existing HTTP consumers' buffers; the lane has no
 * whole-body encoding or preallocation from a peer's declared size.
 */
import { createHash, randomUUID, type Hash } from 'crypto';
import type { ControlMessage } from '../../shared/annex-control-protocol';

export const BULK_CHUNK_BYTES = 64 * 1024;
export const BULK_MAX_TRANSFERS = 4;
export const BULK_IDLE_MS = 30_000;
const HEADER_BYTES = 40; // UUID (36 ASCII bytes), sequence (uint32 BE).
type Frame = Extract<ControlMessage, { type: 'bulk' }>;
export type BulkKind = 'request' | 'response' | 'client';
interface Transfer {
  token: string; id: string; kind: BulkKind; meta: Record<string, unknown>;
  size: number; offset: number; seq: number; hash: Hash;
  timer: ReturnType<typeof setTimeout>;
}
interface Receiving extends Transfer { chunks: Buffer[]; credit: boolean }
interface Sending extends Transfer { body: Buffer; credit: boolean; pumping: boolean; writing: boolean; done(): void }
export interface BulkHooks {
  allowed(): boolean;
  /** Checks the operation, live subscription/request owner and per-type size before retaining bytes. */
  accept(kind: BulkKind, id: string, meta: Record<string, unknown>, size: number): boolean;
  rejectStart?(kind: BulkKind, id: string, meta: Record<string, unknown>, size: number): boolean;
  complete(kind: BulkKind, id: string, meta: Record<string, unknown>, body: Buffer): void;
  send(frame: Frame, written?: () => void): boolean;
  binary(bytes: Buffer, written: () => void, stillOwned: () => boolean): boolean;
  progress?(id: string): void;
  fail(): void;
}

export class ControlBulkLane {
  private readonly incoming = new Map<string, Receiving>();
  private readonly outgoing = new Map<string, Sending>();
  private readonly cancelled = new Set<string>();
  constructor(private readonly hooks: BulkHooks) {}
  private frame(t: Transfer, op: Frame['op']): Frame { return { v: 1, type: 'bulk', op, transfer: t.token, id: t.id }; }
  private timer(token: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.cancelToken(token); this.hooks.fail(); }, BULK_IDLE_MS);
    timer.unref?.(); return timer;
  }
  private touch(t: Transfer): void { clearTimeout(t.timer); t.timer = this.timer(t.token); }
  private cancelToken(token: string): void {
    this.cancelled.add(token);
    if (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.values().next().value!);
    const incoming = this.incoming.get(token);
    if (incoming) { clearTimeout(incoming.timer); this.incoming.delete(token); }
    const outgoing = this.outgoing.get(token);
    if (outgoing) { clearTimeout(outgoing.timer); this.outgoing.delete(token); outgoing.done(); }
  }
  close(): void { for (const token of [...this.incoming.keys(), ...this.outgoing.keys()]) this.cancelToken(token); }
  cancel(id: string): void {
    for (const t of [...this.incoming.values(), ...this.outgoing.values()]) if (t.id === id) {
      this.hooks.send(this.frame(t, 'cancel')); this.cancelToken(t.token);
    }
  }
  send(kind: BulkKind, id: string, meta: Record<string, unknown>, body: Buffer, done: () => void = () => {}): boolean {
    if (this.outgoing.size >= BULK_MAX_TRANSFERS || !this.hooks.allowed()) return false;
    const token = randomUUID();
    const t: Sending = { token, id, kind, meta, body, size: body.length, offset: 0, seq: 0, hash: createHash('sha256'), timer: this.timer(token), credit: false, pumping: false, writing: false, done };
    this.outgoing.set(token, t);
    if (!this.hooks.send({ ...this.frame(t, 'start'), kind, meta, size: t.size })) { this.cancelToken(token); return false; }
    return true;
  }
  receive(frame: Frame): void {
    if (!this.hooks.allowed()) return;
    if (frame.op === 'start') {
      if (Buffer.byteLength(JSON.stringify(frame.meta)) > 16 * 1024) { this.hooks.fail(); return; }
      if (this.incoming.has(frame.transfer) || this.incoming.size >= BULK_MAX_TRANSFERS
        || frame.kind !== 'client' && [...this.incoming.values()].some((t) => t.id === frame.id)) { this.hooks.fail(); return; }
      if (!this.hooks.accept(frame.kind!, frame.id, frame.meta!, frame.size!)) {
        if (!this.hooks.rejectStart?.(frame.kind!, frame.id, frame.meta!, frame.size!)) this.hooks.fail();
        else { this.hooks.send({ ...frame, op: 'cancel' }); this.cancelToken(frame.transfer); }
        return;
      }
      const t: Receiving = { token: frame.transfer, id: frame.id, kind: frame.kind!, meta: frame.meta!, size: frame.size!, offset: 0, seq: 0, hash: createHash('sha256'), timer: this.timer(frame.transfer), chunks: [], credit: true };
      this.incoming.set(t.token, t);
      this.hooks.progress?.(t.id);
      this.hooks.send(this.frame(t, 'credit')); return;
    }
    const t = frame.op === 'credit' ? this.outgoing.get(frame.transfer) : this.incoming.get(frame.transfer);
    // A cancel may refer to either direction. Unknown tokens can race cancellation.
    if (frame.op === 'cancel') {
      const owned = this.incoming.get(frame.transfer) ?? this.outgoing.get(frame.transfer);
      if (owned && owned.id !== frame.id) { this.hooks.fail(); return; }
      this.cancelToken(frame.transfer); return;
    }
    if (!t) return;
    if (t.id !== frame.id) { this.hooks.fail(); return; }
    this.touch(t);
    this.hooks.progress?.(t.id);
    if (frame.op === 'credit') {
      const sending = t as Sending;
      if (sending.credit) { this.hooks.fail(); return; }
      sending.credit = true;
      this.pump(sending); return;
    }
    const receiving = t as Receiving;
    if (receiving.offset !== receiving.size || receiving.hash.digest('hex') !== frame.digest) { this.hooks.fail(); return; }
    // The operation must still belong to the current subscription/request at delivery.
    if (!this.hooks.accept(receiving.kind, receiving.id, receiving.meta, receiving.size)) { this.hooks.fail(); return; }
    clearTimeout(receiving.timer); this.incoming.delete(receiving.token);
    if (!this.hooks.allowed()) return;
    this.hooks.complete(receiving.kind, receiving.id, receiving.meta, Buffer.concat(receiving.chunks, receiving.size));
  }
  binary(bytes: Buffer): void {
    if (!this.hooks.allowed()) return;
    if (bytes.length < HEADER_BYTES || bytes.length > HEADER_BYTES + BULK_CHUNK_BYTES) { this.hooks.fail(); return; }
    const token = bytes.toString('ascii', 0, 36);
    const t = this.incoming.get(token);
    if (!t) { if (!this.cancelled.has(token)) this.hooks.fail(); return; }
    const body = bytes.subarray(HEADER_BYTES);
    if (!t.credit || !body.length || bytes.readUInt32BE(36) !== t.seq || body.length !== Math.min(BULK_CHUNK_BYTES, t.size - t.offset)
      || !this.hooks.accept(t.kind, t.id, t.meta, t.size)) { this.hooks.fail(); return; }
    t.credit = false; t.seq++; t.offset += body.length; t.hash.update(body); t.chunks.push(body);
    this.touch(t);
    this.hooks.progress?.(t.id);
    t.credit = true;
    this.hooks.send(this.frame(t, 'credit'));
  }
  private pump(t: Sending): void {
    if (t.pumping || t.writing || !t.credit) return;
    t.pumping = true;
    // Yield after each chunk so request/approval/event traffic gets the socket first.
    setImmediate(() => {
      t.pumping = false;
      if (this.outgoing.get(t.token) !== t || !this.hooks.allowed() || !t.credit) return;
      t.credit = false;
      if (t.offset === t.size) {
        this.outgoing.delete(t.token); clearTimeout(t.timer);
        this.hooks.send({ ...this.frame(t, 'finish'), digest: t.hash.digest('hex') }, t.done); return;
      }
      const body = t.body.subarray(t.offset, t.offset + BULK_CHUNK_BYTES);
      const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
      frame.write(t.token, 0, 36, 'ascii'); frame.writeUInt32BE(t.seq++, 36); body.copy(frame, HEADER_BYTES);
      t.hash.update(body); t.offset += body.length; this.touch(t);
      t.writing = true;
      if (!this.hooks.binary(frame, () => { t.writing = false; this.pump(t); }, () => this.outgoing.get(t.token) === t)) this.cancelToken(t.token);
    });
  }
}
