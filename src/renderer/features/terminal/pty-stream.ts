/**
 * Helpers for stitching a PTY buffer snapshot to the live PTY.DATA stream and
 * for forwarding xterm's binary (onBinary) input.
 */

export { unseenPtySuffix } from '../../../shared/pty-seq';

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
