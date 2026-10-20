import type { Terminal } from '@xterm/xterm';
import { InlineFrameGuard, type InlineFrameGuardTerminal } from '../../../shared/inline-frame-guard';

const guards = new WeakMap<Terminal, InlineFrameGuard>();

/**
 * Watch `term` for an inline TUI's redraws so narrowing it doesn't leave a
 * stale frame copy (#2359).  Returns the guard, or null for terminals without
 * a parser API (test doubles).
 */
export function attachInlineFrameGuard(term: Terminal): InlineFrameGuard | null {
  if (!(term as Partial<Terminal>).parser?.registerCsiHandler || !(term as Partial<Terminal>).onLineFeed) return null;
  const guard = new InlineFrameGuard(term as unknown as InlineFrameGuardTerminal);
  guards.set(term, guard);
  return guard;
}

export function detachInlineFrameGuard(term: Terminal): void {
  guards.get(term)?.dispose();
  guards.delete(term);
}

/**
 * Resize `term` to the PTY's size.  When narrowing over an inline TUI frame,
 * the frame region is erased first (after any queued output is parsed), so
 * the TUI's redraw for the new size covers it.  A bottom-pinned viewport
 * stays pinned.
 */
export function resizeTerminal(term: Terminal, cols: number, rows: number): void {
  const apply = () => {
    if (term.cols === cols && term.rows === rows) return;
    const buffer = term.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    term.resize(cols, rows);
    if (wasAtBottom && term.buffer.active.viewportY < term.buffer.active.baseY) term.scrollToBottom();
  };
  const erase = guards.get(term)?.eraseBeforeNarrow(cols);
  if (erase) term.write(erase, apply);
  else apply();
}

/** The `beforeResize` hook for `writePtySnapshot`, so replay erases as live did. */
export function inlineFramePrelude(term: Terminal): (cols: number) => string | null {
  return (cols) => guards.get(term)?.eraseBeforeNarrow(cols) ?? null;
}
