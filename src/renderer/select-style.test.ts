import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { selectChevron } from './themes/apply-theme';

/**
 * One look for every native select (#2443): no native arrow, a chevron inset
 * from the right edge in the theme's color, and room for it in the padding.
 */
describe('the shared select style', () => {
  const css = fs.readFileSync(path.resolve(__dirname, 'index.css'), 'utf-8');
  const rule = css.match(/\nselect:not\(\[multiple\]\):not\(\[size\]\):not\(\.select-native\) \{([^}]*)\}/);

  it('replaces the native arrow with an inset chevron and leaves room for it', () => {
    expect(rule).not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/appearance:\s*none;/);
    expect(body).toMatch(/padding-right:\s*2rem;/);
    expect(body).toMatch(/background-image:\s*var\(--select-chevron\);/);
    expect(body).toMatch(/background-repeat:\s*no-repeat;/);
    expect(body).toMatch(/background-position:\s*right 0\.625rem center;/);
    expect(body).toMatch(/background-size:\s*12px;/);
  });

  it('sits outside every layer, so a padding utility such as px-2 doesn\'t put the text under the chevron', () => {
    const before = css.slice(0, rule!.index);
    let depth = 0;
    for (const ch of before) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    expect(depth).toBe(0);
  });

  it('starts with the default theme\'s chevron, the same one applyTheme draws for it', () => {
    const value = css.match(/--select-chevron:\s*(url\("[^"]+"\));/);
    expect(value?.[1]).toBe(selectChevron('#7f849c'));
  });

  it('no select keeps its own right padding for the old arrow', () => {
    for (const file of ['chrome/pages/newAgentUi.tsx', 'features/managed/TemplatesSettingsView.tsx', 'features/actions/ActionForm.tsx']) {
      const src = fs.readFileSync(path.resolve(__dirname, file), 'utf-8');
      expect(src.match(/selectClass = [^;]*/)?.[0], file).not.toMatch(/\bpr-\d/);
    }
  });
});
