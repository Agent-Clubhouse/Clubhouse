import { describe, expect, it } from 'vitest';
import { hasAsciiControl, hasC0Control, replaceAsciiControl } from './ascii-control';

// Reference classes are built at runtime so the comparison uses the exact original patterns.
const c = (code: number) => String.fromCharCode(code);
const asciiClass = `[${c(0)}-${c(0x1f)}${c(0x7f)}]`, c0Class = `[${c(0)}-${c(0x1f)}]`;

describe('ascii-control', () => {
  it('matches the original classes for every UTF-16 code unit', () => {
    const ascii = new RegExp(asciiClass), c0 = new RegExp(c0Class);
    for (let code = 0; code <= 0xffff; code++) {
      const unit = c(code);
      if (hasAsciiControl(unit) !== ascii.test(unit) || hasC0Control(unit) !== c0.test(unit)) throw new Error(`mismatch at ${code}`);
      if (replaceAsciiControl(unit, ' ') !== unit.replace(new RegExp(asciiClass, 'g'), ' ')) throw new Error(`replace mismatch at ${code}`);
    }
  });

  it('keeps C1, line separators, astral and lone surrogate units as the non-u regex does', () => {
    for (const value of ['\u0085', '\u009f', ' ', '\u{1F600}', '\ud800', 'plain']) {
      expect(hasAsciiControl(value)).toBe(false); expect(replaceAsciiControl(value)).toBe(value);
    }
  });

  it('replaces each control unit in mixed strings and honours the replacement', () => {
    const value = `a${c(0)}b${c(0x1f)}${c(0x7f)}\u{1F600}\tc`;
    expect(replaceAsciiControl(value)).toBe(value.replace(new RegExp(asciiClass, 'g'), ' '));
    expect(replaceAsciiControl(value, '')).toBe('ab\u{1F600}c');
    expect(hasAsciiControl(`x${c(0x7f)}`)).toBe(true); expect(hasC0Control(`x${c(0x7f)}`)).toBe(false);
    // Global replacement is per unit: consecutive controls are not collapsed, and the first match does not stop it.
    const run = `${c(0)}${c(0)}${c(0x7f)}path${c(0x0a)}${c(0x0d)}end${c(0x1b)}`;
    expect(replaceAsciiControl(run)).toBe('   path  end ');
    expect(replaceAsciiControl(run)).toBe(run.replace(new RegExp(asciiClass, 'g'), ' '));
    expect(replaceAsciiControl(run)).not.toBe(run.replace(new RegExp(asciiClass), ' '));
  });
});
