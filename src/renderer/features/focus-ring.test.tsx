/**
 * Regression tests for VQ-FI-01: Focus Ring Migration
 *
 * Each test renders a migrated interactive element and asserts that it carries
 * the canonical focus-ring* utility class instead of the ad-hoc patterns
 * (focus:outline-none, outline-none focus:border-ctp-accent, etc.).
 *
 * We check class presence because JSDOM does not compute CSS — asserting the
 * class is present is equivalent to asserting that the canonical focus style
 * will be applied at runtime.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HelpSearchInput } from './help/HelpSearchInput';
import { CommandPaletteInput } from './command-palette/CommandPaletteInput';

// ── CommandPaletteStore mock ───────────────────────────────────────────────
vi.mock('../stores/commandPaletteStore', () => {
  const hook: any = (selector: (s: any) => any) => selector({
    query: '',
    mode: 'all',
    setQuery: vi.fn(),
  });
  hook.getState = () => ({ query: '', mode: 'all', setQuery: vi.fn() });
  hook.subscribe = () => () => {};
  return { useCommandPaletteStore: hook };
});

// ── Helper: check no old ad-hoc patterns remain on element ────────────────
function assertNoAdHocFocusPattern(el: HTMLElement): void {
  const cls = el.className;
  expect(cls, 'should not contain focus:outline-none').not.toContain('focus:outline-none');
  expect(cls, 'should not contain focus:border-ctp-accent').not.toContain('focus:border-ctp-accent');
  expect(cls, 'should not contain "outline-none focus:border"').not.toMatch(/outline-none.*focus:border/);
}

// ─────────────────────────────────────────────────────────────────────────
// HelpSearchInput
// ─────────────────────────────────────────────────────────────────────────

describe('HelpSearchInput — focus ring (VQ-FI-01)', () => {
  it('search input carries focus-ring class (was: bare outline-none)', () => {
    render(<HelpSearchInput query="" onQueryChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search help...');
    expect(input.className).toContain('focus-ring');
    assertNoAdHocFocusPattern(input);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CommandPaletteInput  (WCAG zero-indicator fix)
// ─────────────────────────────────────────────────────────────────────────

describe('CommandPaletteInput — focus ring (VQ-FI-01)', () => {
  it('command palette input carries focus-ring class (was: bare outline-none, WCAG failure)', () => {
    render(<CommandPaletteInput listboxId="results" />);
    const input = screen.getByRole('combobox');
    expect(input.className).toContain('focus-ring');
    assertNoAdHocFocusPattern(input);
  });
});
