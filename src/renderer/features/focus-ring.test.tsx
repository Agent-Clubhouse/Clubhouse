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
import { AssistantInput } from './assistant/AssistantInput';
import { ActionBar } from './agents/structured/ActionBar';
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

// ── CostTracker mock (child of ActionBar) ─────────────────────────────────
vi.mock('./agents/structured/CostTracker', () => ({
  CostTracker: () => null,
}));

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
    render(<CommandPaletteInput />);
    const input = screen.getByPlaceholderText('Type to search...');
    expect(input.className).toContain('focus-ring');
    assertNoAdHocFocusPattern(input);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AssistantInput
// ─────────────────────────────────────────────────────────────────────────

describe('AssistantInput — focus ring (VQ-FI-01)', () => {
  it('textarea carries focus-ring-dim class (was: outline-none focus:border-ctp-accent/50)', () => {
    render(<AssistantInput onSend={vi.fn()} status="idle" />);
    const ta = screen.getByPlaceholderText('Ask anything…') as HTMLTextAreaElement;
    expect(ta.className).toContain('focus-ring-dim');
    assertNoAdHocFocusPattern(ta);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ActionBar
// ─────────────────────────────────────────────────────────────────────────

describe('ActionBar — focus ring (VQ-FI-01)', () => {
  it('message input carries focus-ring-dim class (was: outline-none focus:border-ctp-accent/50)', () => {
    render(
      <ActionBar
        agentId="test-agent"
        elapsed={0}
        usage={null}
        isComplete={false}
        onStop={vi.fn()}
        onSendMessage={vi.fn()}
      />
    );
    const input = screen.getByPlaceholderText('Send a message...');
    expect(input.className).toContain('focus-ring-dim');
    assertNoAdHocFocusPattern(input);
  });
});
