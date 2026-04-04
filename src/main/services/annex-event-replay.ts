/**
 * Event replay buffer for Annex WebSocket clients.
 *
 * Stores a time-bounded ring buffer of all broadcast events so that
 * reconnecting clients can catch up on events they missed while disconnected.
 *
 * Buffer limits:
 *   - Max age: 1 hour
 *   - Max events: 10,000
 *
 * Each event gets a monotonically increasing sequence number. Clients
 * send { type: "replay", since: <seq> } after reconnecting and the
 * server replays buffered events since that sequence.
 *
 * Internally uses a ring buffer with head/tail indices for O(1) push
 * and front-eviction, avoiding the O(n) cost of Array.shift().
 */

export interface BufferedEvent {
  seq: number;
  type: string;
  payload: unknown;
  timestamp: number;
}

const MAX_EVENTS = 10_000;
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fixed-capacity ring buffer with O(1) push and front-eviction.
 * Uses head/tail indices with modulo arithmetic.
 */
class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _size = 0;

  constructor(private capacity: number) {
    this.buf = new Array(capacity);
  }

  get size(): number {
    return this._size;
  }

  push(item: T): void {
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this._size === this.capacity) {
      // Overwrite oldest — advance head
      this.head = (this.head + 1) % this.capacity;
    } else {
      this._size++;
    }
  }

  /** Get item at logical index (0 = oldest). */
  at(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.buf[(this.head + index) % this.capacity];
  }

  /** Drop n items from the front (oldest). O(n) for GC cleanup. */
  dropFront(n: number): void {
    const toDrop = Math.min(n, this._size);
    for (let i = 0; i < toDrop; i++) {
      this.buf[(this.head + i) % this.capacity] = undefined;
    }
    this.head = (this.head + toDrop) % this.capacity;
    this._size -= toDrop;
  }

  /** Return items from logical index `start` to end as an array. */
  slice(start: number): T[] {
    if (start >= this._size) return [];
    const result: T[] = [];
    for (let i = start; i < this._size; i++) {
      result.push(this.buf[(this.head + i) % this.capacity]!);
    }
    return result;
  }

  /** Keep only items matching the predicate, maintaining order. */
  filterInPlace(predicate: (item: T) => boolean): void {
    const kept: T[] = [];
    for (let i = 0; i < this._size; i++) {
      const item = this.buf[(this.head + i) % this.capacity]!;
      if (predicate(item)) kept.push(item);
    }
    this.clear();
    for (const item of kept) {
      this.push(item);
    }
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }
}

let globalSeq = 0;
const buffer = new RingBuffer<BufferedEvent>(MAX_EVENTS);

/** Push an event into the replay buffer and return its sequence number. */
export function pushEvent(type: string, payload: unknown): number {
  globalSeq += 1;
  buffer.push({
    seq: globalSeq,
    type,
    payload,
    timestamp: Date.now(),
  });
  return globalSeq;
}

/** Evict events older than MAX_AGE_MS. Called periodically. */
export function evictStale(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  let count = 0;
  while (count < buffer.size) {
    const event = buffer.at(count);
    if (!event || event.timestamp >= cutoff) break;
    count++;
  }
  if (count > 0) buffer.dropFront(count);
}

/**
 * Get events with sequence numbers greater than `sinceSeq`.
 * Returns null if the requested seq is older than the buffer (gap).
 */
export function getEventsSince(sinceSeq: number): BufferedEvent[] | null {
  if (buffer.size === 0) return [];

  const oldest = buffer.at(0)!;

  // If the client's last seq is older than our buffer, there's a gap
  if (sinceSeq < oldest.seq - 1) {
    return null;
  }

  // Find the starting index (events are ordered by seq)
  let startIdx = -1;
  for (let i = 0; i < buffer.size; i++) {
    if (buffer.at(i)!.seq > sinceSeq) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return [];

  return buffer.slice(startIdx);
}

/** Get the oldest available sequence number, or 0 if buffer is empty. */
export function getOldestSeq(): number {
  return buffer.size > 0 ? buffer.at(0)!.seq : 0;
}

/** Get the current (latest) sequence number. */
export function getLastSeq(): number {
  return globalSeq;
}

/** Clear all buffered events for a specific agent ID. */
export function clearForAgent(agentId: string): void {
  buffer.filterInPlace((e) => {
    const payload = e.payload as Record<string, unknown> | null;
    return !(payload && payload.agentId === agentId);
  });
}

/** Reset the entire buffer. Used during shutdown. */
export function reset(): void {
  buffer.clear();
  globalSeq = 0;
}

/** Get the number of buffered events (for testing/diagnostics). */
export function size(): number {
  return buffer.size;
}
