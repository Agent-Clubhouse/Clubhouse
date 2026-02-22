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
 */

export interface BufferedEvent {
  seq: number;
  type: string;
  payload: unknown;
  timestamp: number;
}

const MAX_EVENTS = 10_000;
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

let globalSeq = 0;
const buffer: BufferedEvent[] = [];

/** Push an event into the replay buffer and return its sequence number. */
export function pushEvent(type: string, payload: unknown): number {
  globalSeq += 1;
  const event: BufferedEvent = {
    seq: globalSeq,
    type,
    payload,
    timestamp: Date.now(),
  };
  buffer.push(event);

  // Trim by count
  while (buffer.length > MAX_EVENTS) {
    buffer.shift();
  }

  return globalSeq;
}

/** Evict events older than MAX_AGE_MS. Called periodically. */
export function evictStale(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
    buffer.shift();
  }
}

/**
 * Get events with sequence numbers greater than `sinceSeq`.
 * Returns null if the requested seq is older than the buffer (gap).
 */
export function getEventsSince(sinceSeq: number): BufferedEvent[] | null {
  if (buffer.length === 0) return [];

  const oldestSeq = buffer[0].seq;

  // If the client's last seq is older than our buffer, there's a gap
  if (sinceSeq < oldestSeq - 1) {
    return null;
  }

  // Find the starting index
  const startIdx = buffer.findIndex((e) => e.seq > sinceSeq);
  if (startIdx === -1) return [];

  return buffer.slice(startIdx);
}

/** Get the oldest available sequence number, or 0 if buffer is empty. */
export function getOldestSeq(): number {
  return buffer.length > 0 ? buffer[0].seq : 0;
}

/** Get the current (latest) sequence number. */
export function getLastSeq(): number {
  return globalSeq;
}

/** Clear all buffered events for a specific agent ID. */
export function clearForAgent(agentId: string): void {
  // Remove events where payload.agentId matches
  for (let i = buffer.length - 1; i >= 0; i--) {
    const payload = buffer[i].payload as Record<string, unknown> | null;
    if (payload && payload.agentId === agentId) {
      buffer.splice(i, 1);
    }
  }
}

/** Reset the entire buffer. Used during shutdown. */
export function reset(): void {
  buffer.length = 0;
  globalSeq = 0;
}

/** Get the number of buffered events (for testing/diagnostics). */
export function size(): number {
  return buffer.length;
}
