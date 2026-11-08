import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Accent-filled controls take the theme's on-accent text color (#3086): not
 * white, crust or base, which each fail on some built-in. A translucent tint
 * (bg-ctp-accent/10) or the second accent isn't a fill, so it's not checked.
 */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('text on accent-filled controls (#3086)', () => {
  it('no class string sets text-white, text-ctp-crust or text-ctp-base beside a solid bg-ctp-accent', () => {
    const offenders: string[] = [];
    for (const file of sources(__dirname)) {
      for (const literal of fs.readFileSync(file, 'utf8').match(/["'`][^"'`]*bg-ctp-accent[^"'`]*["'`]/g) ?? []) {
        if (/bg-ctp-accent(?![\w/-])/.test(literal) && /\btext-(white|ctp-crust|ctp-base)\b/.test(literal)) offenders.push(`${path.relative(__dirname, file)}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
