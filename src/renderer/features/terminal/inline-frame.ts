import type { Terminal } from '@xterm/xterm';
import { InlineFrameGuard, type InlineFrameGuardTerminal } from '../../../shared/inline-frame-guard';

const guards = new WeakMap<Terminal, InlineFrameGuard>();

/**
 * Watch `term` for an inline TUI's redraws so narrowing it doesn't leave a
 * stale frame copy (#2359).  Returns the guard, or null for terminals without
 * a parser API (test doubles).
 */
export function attachInlineFrameGuard(term: Terminal): InlineFrameGuard | null {
  const candidate = term as Partial<Terminal>;
  if (!candidate.parser?.registerCsiHandler || !candidate.onLineFeed) return null;
  const guard = new InlineFrameGuard(term as unknown as InlineFrameGuardTerminal);
  guards.set(term, guard);
  return guard;
}

export function detachInlineFrameGuard(term: Terminal): void {
  guards.get(term)?.dispose();
  guards.delete(term);
}

/**
 * Resize `term` now, keeping a bottom-pinned viewport pinned and keyboard
 * focus on the xterm if it had it (a resize can blur the helper textarea).
 */
export function resizeTerminal(term: Terminal, cols: number, rows: number): void {
  if (term.cols === cols && term.rows === rows) return;
  const buffer = term.buffer.active;
  const wasAtBottom = buffer.viewportY >= buffer.baseY;
  const textarea = term.textarea;
  const hadFocus = !!textarea && document.activeElement === textarea;
  term.resize(cols, rows);
  if (wasAtBottom && term.buffer.active.viewportY < term.buffer.active.baseY) term.scrollToBottom();
  if (hadFocus && document.activeElement !== textarea) term.focus();
}

/**
 * Before narrowing `term` to `cols`: the inline-frame erase to write next, or
 * null.  Call once the output before the resize has been parsed, write the
 * result before any later output, then call `endErase` once it is parsed.
 */
export function beginErase(term: Terminal, cols: number): string | null {
  const guard = guards.get(term);
  const erase = guard?.eraseBeforeNarrow(cols) ?? null;
  if (erase) guard!.setSuppressed(true);
  return erase;
}

export function endErase(term: Terminal): void {
  guards.get(term)?.setSuppressed(false);
}

/** `writePtySnapshot` hooks, so replay erases before each narrowing as live did. */
export function inlineFrameReplayHooks(term: Terminal): { beforeResize: (cols: number) => string | null; afterPrelude: () => void } {
  return { beforeResize: (cols) => beginErase(term, cols), afterPrelude: () => endErase(term) };
}
