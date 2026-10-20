/**
 * Helpers for stitching a PTY buffer snapshot to the live PTY.DATA stream and
 * for forwarding xterm's binary (onBinary) input.
 */

/**
 * Return the part of a live PTY chunk that is not already covered by
 * `appliedSeq`.
 *
 * `seq` is the main process's output sequence at the END of `data` (a running
 * count of UTF-16 code units), so the chunk spans `[seq - data.length, seq)`.
 * Main-process broadcast batching can merge output from before and after a
 * snapshot into one chunk, so a chunk may overlap the snapshot only partially.
 * Chunks without a seq (older/remote transports) pass through unchanged.
 */
export function unseenPtySuffix(data: string, seq: number | undefined, appliedSeq: number): string {
  if (seq === undefined) return data;
  if (seq <= appliedSeq) return '';
  const start = seq - data.length;
  return start >= appliedSeq ? data : data.slice(appliedSeq - start);
}

/**
 * Whether an xterm binary string (one char per byte) survives a text-only
 * transport unchanged.  Text transports UTF-8 encode their payload, which is
 * only byte-exact for code points below 0x80.
 */
export function isAsciiBinary(data: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(data);
}

/** `term.write` that resolves once xterm has parsed `data`. */
export function writeAsync(term: { write(data: string, callback?: () => void): void }, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}
