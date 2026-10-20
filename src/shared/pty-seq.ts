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
