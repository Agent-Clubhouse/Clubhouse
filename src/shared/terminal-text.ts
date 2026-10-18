/**
 * Turn raw terminal output into plain text for error messages and previews
 * (#2088). Removes CSI sequences including private modes (`ESC[?25h`,
 * `ESC[?2026l`), OSC titles and links, other escapes, and control
 * characters, plus a sequence cut in half where the output was sliced.
 * Newlines and tabs are kept; a carriage return counts as a line break.
 */

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** DCS, SOS, PM and APC strings, ended by ST. */
const STRING_SEQUENCE = /\x1b[PX^_][^\x1b]*(?:\x1b\\)/g;
const CSI = /(?:\x1b\[|\x9b)[0-9:;<=>?]*[ -/]*[@-~]/g;
/** Two- and three-byte escapes: charset selects (`ESC(B`), keypad modes (`ESC=`), RIS (`ESC c`). */
const OTHER_ESCAPE = /\x1b[ -/]*[0-~]/g;
/** Control characters except tab and newline; carriage returns are already gone by then. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/**
 * The tail of a CSI sequence whose ESC was cut off by a slice (`0m`,
 * `[?25h`), recognized by another escape following right after it.
 */
const LEADING_FRAGMENT = /^\[?[0-9;?]*[0-9;?][@-~](?=\x1b)/;
/* eslint-enable no-control-regex */

export function stripTerminalEscapes(text: string): string {
  return text
    .replace(LEADING_FRAGMENT, '')
    .replace(OSC, '')
    .replace(STRING_SEQUENCE, '')
    .replace(CSI, '')
    .replace(OTHER_ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '');
}

/** The last few non-empty lines of terminal output as one plain line, for a launch error. */
export function terminalTailSummary(text: string, maxLines = 3, maxChars = 200): string {
  return stripTerminalEscapes(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .slice(-maxLines)
    .join(' | ')
    .slice(0, maxChars);
}
