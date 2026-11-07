/**
 * Two input modes at a raw replay's head, accumulated through evicted output.
 * This is not a screen emulator or a repair for a cut escape sequence.
 *
 * Syntax follows the pinned xterm 6 parser/InputHandler: private CSI h/l,
 * RIS and DECSTR, C1 introducers, cancellation and control-string termination.
 * Only scalar parser state is retained, never output or a pending string.
 */
type State = 'ground' | 'escape' | 'escape-intermediate'
  | 'csi-entry' | 'csi-param' | 'csi-intermediate' | 'csi-ignore'
  | 'osc' | 'string' | 'dcs-entry' | 'dcs-param' | 'dcs-intermediate' | 'dcs-ignore' | 'dcs-string';

export class PtyInputModeTracker {
  private state: State = 'ground';
  private cursor = false;
  private paste = false;
  private collect = 0;
  private param = 0;
  private paramIndex = 1;
  private subParam = false;
  private modeBits = 0;

  get modes(): Readonly<{ applicationCursor: boolean; bracketedPaste: boolean }> {
    return { applicationCursor: this.cursor, bracketedPaste: this.paste };
  }

  /** All fields are scalars; completing a skipped prefix must not advance the stored head. */
  clone(): PtyInputModeTracker { return Object.assign(new PtyInputModeTracker(), this); }

  /** Existing replay targets start fresh, with both modes disabled. */
  replayPrefix(skipped = ''): string {
    const head = this.clone(); head.feed(skipped);
    return (head.cursor ? '\x1b[?1h' : '') + (head.paste ? '\x1b[?2004h' : '');
  }

  private clear(state: State): void {
    this.state = state; this.collect = 0; this.param = 0;
    this.paramIndex = 1; this.subParam = false; this.modeBits = 0;
  }

  private rememberParam(): void {
    // xterm stores 32 primary parameters, saturating each at 2^31-1.
    if (this.paramIndex <= 32) {
      if (this.param === 1) this.modeBits |= 1;
      if (this.param === 2004) this.modeBits |= 2;
    }
  }

  private parameter(code: number): void {
    if (code === 0x3b) {
      this.rememberParam(); this.paramIndex = Math.min(33, this.paramIndex + 1);
      this.param = 0; this.subParam = false;
    } else if (code === 0x3a) this.subParam = true;
    else if (!this.subParam && this.paramIndex <= 32) this.param = Math.min(0x7fffffff, this.param * 10 + code - 0x30);
  }

  private dispatch(code: number): void {
    if (this.collect === 0x3f && (code === 0x68 || code === 0x6c)) {
      this.rememberParam();
      if (this.modeBits & 1) this.cursor = code === 0x68;
      if (this.modeBits & 2) this.paste = code === 0x68;
    } else if (this.collect === 0x21 && code === 0x70) {
      // Pinned xterm's DECSTR calls CoreService.reset, resetting both modes.
      this.cursor = this.paste = false;
    }
    this.state = 'ground';
  }

  feed(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      // xterm's anywhere transitions also leave OSC/DCS on ESC, CAN/SUB or
      // a C1 introducer. ESC [ after string text is a real new command.
      if (code === 0x1b) { this.clear('escape'); continue; }
      if (code === 0x9b) { this.clear('csi-entry'); continue; }
      if (code === 0x90) { this.clear('dcs-entry'); continue; }
      if (code === 0x9d) { this.state = 'osc'; continue; }
      if (code === 0x98 || code === 0x9e || code === 0x9f) { this.state = 'string'; continue; }
      if (code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f)) { this.state = 'ground'; continue; }
      if (this.state === 'osc') { if (code === 0x07) this.state = 'ground'; continue; }
      if (this.state === 'string') { if (code >= 0xa0) this.state = 'ground'; continue; }
      if (this.state === 'dcs-string' || this.state === 'dcs-ignore') continue;
      // Executable C0 controls and DEL leave the relevant ESC/CSI syntax in
      // progress; their screen effects are deliberately outside this tracker.
      if (code < 0x20 || code === 0x7f) continue;

      switch (this.state) {
        case 'ground': break;
        case 'escape':
          if (code === 0x5b) this.clear('csi-entry');
          else if (code === 0x5d) this.state = 'osc';
          else if (code === 0x50) this.clear('dcs-entry');
          else if (code === 0x58 || code === 0x5e || code === 0x5f) this.state = 'string';
          else if (code >= 0x20 && code <= 0x2f) this.state = 'escape-intermediate';
          else {
            if (code === 0x63) this.cursor = this.paste = false; // RIS
            this.state = 'ground';
          }
          break;
        case 'escape-intermediate':
          if (code < 0x20 || code > 0x2f) this.state = 'ground';
          break;
        case 'csi-entry':
        case 'csi-param':
          if (code >= 0x30 && code <= 0x3b) { this.parameter(code); this.state = 'csi-param'; }
          else if (code >= 0x3c && code <= 0x3f) {
            if (this.state === 'csi-entry') { this.collect = code; this.state = 'csi-param'; }
            else this.state = 'csi-ignore';
          } else if (code >= 0x20 && code <= 0x2f) {
            this.collect = (this.collect << 8) | code; this.state = 'csi-intermediate';
          } else if (code >= 0x40 && code <= 0x7e) this.dispatch(code);
          else this.state = 'ground';
          break;
        case 'csi-intermediate':
          if (code >= 0x20 && code <= 0x2f) this.collect = (this.collect << 8) | code;
          else if (code >= 0x30 && code <= 0x3f) this.state = 'csi-ignore';
          else if (code >= 0x40 && code <= 0x7e) this.dispatch(code);
          else this.state = 'ground';
          break;
        case 'csi-ignore':
          if (code >= 0x40 && code <= 0x7e) this.state = 'ground';
          break;
        case 'dcs-entry':
        case 'dcs-param':
          if (code >= 0x30 && code <= 0x3b) this.state = 'dcs-param';
          else if (code >= 0x3c && code <= 0x3f) this.state = this.state === 'dcs-entry' ? 'dcs-param' : 'dcs-ignore';
          else if (code >= 0x20 && code <= 0x2f) this.state = 'dcs-intermediate';
          else this.state = code >= 0x40 && code <= 0x7e ? 'dcs-string' : 'ground';
          break;
        case 'dcs-intermediate':
          if (code >= 0x30 && code <= 0x3f) this.state = 'dcs-ignore';
          else if (code >= 0x40 && code <= 0x7e) this.state = 'dcs-string';
          else if (code > 0x2f) this.state = 'ground';
          break;
      }
    }
  }
}
