import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression test for GitHub Issue #85 — scrollbar auto-hide.
 *
 * Scrollbar thumbs must be transparent by default and only appear when the
 * user hovers over the scrollable container.  These tests read the raw CSS
 * source to verify the key selectors are present so a future refactor does
 * not accidentally revert the behavior.
 */
describe('scrollbar auto-hide CSS', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, 'index.css'),
    'utf-8',
  );

  it('default scrollbar-thumb background is transparent', () => {
    // Match the base ::-webkit-scrollbar-thumb rule (not nested inside :hover)
    // The rule should set background: transparent
    const thumbRule = css.match(
      /(?<!:hover\s*)::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/,
    );
    expect(thumbRule).not.toBeNull();
  });

  it('scrollbar-thumb becomes visible on container hover', () => {
    expect(css).toContain(':hover::-webkit-scrollbar-thumb');
    // The hover rule should set a non-transparent background
    const hoverThumbRule = css.match(
      /:hover::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*rgb\(/,
    );
    expect(hoverThumbRule).not.toBeNull();
  });
});
