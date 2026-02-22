import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Structural regression test: ensures QuickAgentDialog is rendered in every
 * JSX return path of App.tsx.  Issue #142 was caused by the component being
 * present in Home/Help/AppPlugin views but missing from the main project view.
 */
describe('App.tsx – QuickAgentDialog presence', () => {
  // Normalize line endings so the test works on Windows (CRLF) and Unix (LF)
  const source = readFileSync(join(__dirname, 'App.tsx'), 'utf-8').replace(/\r\n/g, '\n');

  it('should include <QuickAgentDialog /> in every JSX return block', () => {
    // Match only JSX return statements (indented `return (` followed by `<div`)
    const jsxReturnPattern = /^[ ]{2,}return \(\n\s+<div/gm;
    const matches = [...source.matchAll(jsxReturnPattern)];

    expect(matches.length).toBeGreaterThanOrEqual(4); // Home, AppPlugin, Help, main

    for (const match of matches) {
      // Extract the JSX block from the match position to the next closing `);`
      const startIdx = match.index!;
      // Find the balanced closing `);\n` for this return block
      const block = source.slice(startIdx, source.indexOf('\n  );', startIdx) + 5);

      expect(
        block,
        `A JSX return block starting at offset ${startIdx} is missing <QuickAgentDialog />`
      ).toContain('<QuickAgentDialog');
    }
  });
});
