/**
 * Keeps an inline TUI's frame from leaving a stale copy when the terminal
 * narrows (#2359).
 *
 * Inline TUIs (Copilot CLI, Claude Code) draw on the main screen and redraw
 * by moving the cursor up over their previous frame ("cursor up N, erase
 * line").  When the terminal narrows, xterm reflows the frame's full-width
 * rows into more rows than that cursor-up covers, so a copy of the old frame
 * stays above the redraw, even in a live terminal.
 *
 * The guard watches cursor-up runs that are followed by drawing to learn how
 * tall the program's frame is, and where its bottom is relative to a caret
 * parked inside it.  Just before a narrowing resize it erases exactly that
 * region (blank rows don't reflow), so the program's redraw after SIGWINCH
 * covers it.  It does nothing on the alt screen (no reflow there) or when the
 * program hasn't redrawn with cursor-up since its last output scrolled on.
 */

interface Disposable {
  dispose(): void;
}

/** The parts of an xterm (or @xterm/headless) Terminal the guard uses. */
export interface InlineFrameGuardTerminal {
  readonly cols: number;
  readonly buffer: { readonly active: { readonly type: string; readonly cursorY: number } };
  readonly parser: {
    registerCsiHandler(id: { final: string }, callback: (params: (number | number[])[]) => boolean): Disposable;
  };
  onLineFeed(listener: () => void): Disposable;
}

/**
 * Line feeds allowed after a redraw before its region is considered stale:
 * the redrawn frame's own rows plus a little output above it.  Beyond that
 * the program (or a shell after it) has moved on and nothing is erased.
 */
const SLACK_LINES = 2;

export class InlineFrameGuard {
  /** Height (rows above its bottom) of the last frame redrawn with cursor-up. */
  private frameRows = 0;
  private lineFeedsSinceFrame = 0;
  /** The cursor run in progress: cursor-ups/downs with no line feed between. */
  private inRun = false;
  private runBottomY = 0;
  private runTopY = 0;
  /** Net rows moved up since the last line feed (a caret parked in the frame). */
  private upSinceLineFeed = 0;
  private readonly disposables: Disposable[];

  constructor(private readonly term: InlineFrameGuardTerminal) {
    this.disposables = [
      term.parser.registerCsiHandler({ final: 'A' }, (params) => {
        this.onVerticalMove(-count(params));
        return false; // let xterm move the cursor
      }),
      term.parser.registerCsiHandler({ final: 'B' }, (params) => {
        this.onVerticalMove(count(params));
        return false;
      }),
      term.onLineFeed(() => this.onLineFeed()),
    ];
  }

  private onVerticalMove(delta: number): void {
    const { cursorY } = this.term.buffer.active;
    const target = Math.max(0, cursorY + delta);
    if (!this.inRun) {
      this.inRun = true;
      this.runBottomY = cursorY;
      this.runTopY = cursorY;
    }
    this.runBottomY = Math.max(this.runBottomY, target);
    this.runTopY = Math.min(this.runTopY, target);
    this.upSinceLineFeed += cursorY - target;
  }

  private onLineFeed(): void {
    if (this.inRun) {
      // The run is followed by drawing: it was a redraw over a frame this tall.
      this.inRun = false;
      if (this.runBottomY > this.runTopY) {
        this.frameRows = this.runBottomY - this.runTopY;
        this.lineFeedsSinceFrame = 0;
      }
    }
    this.upSinceLineFeed = 0;
    this.lineFeedsSinceFrame++;
  }

  /**
   * Escape sequence to write (and let parse) before resizing to `cols`, or
   * null when nothing needs erasing.  It clears from the frame's top row to
   * the end of the screen and restores the cursor.
   */
  eraseBeforeNarrow(cols: number): string | null {
    if (cols >= this.term.cols) return null;
    const buffer = this.term.buffer.active;
    if (buffer.type !== 'normal') return null;
    if (this.frameRows <= 0) return null;
    // The frame's own rows, plus a little output above it; beyond that the
    // program (or a shell after it) has moved on.
    if (this.lineFeedsSinceFrame > this.frameRows + SLACK_LINES) return null;
    const bottom = buffer.cursorY + Math.max(0, this.upSinceLineFeed);
    const top = Math.max(0, bottom - this.frameRows);
    return `\x1b7\x1b[${top + 1};1H\x1b[J\x1b8`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** A CSI cursor-move count (default and 0 mean 1). */
function count(params: (number | number[])[]): number {
  const first = params[0];
  return typeof first === 'number' && first > 0 ? first : 1;
}
