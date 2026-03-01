import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSafeMarkdownLinks } from './safe-markdown-links';

const mockOpenExternalUrl = vi.fn().mockResolvedValue(undefined);

Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      app: {
        openExternalUrl: mockOpenExternalUrl,
      },
    },
  },
  writable: true,
});

function makeClickEvent(anchorAttrs?: { href?: string } | null) {
  const anchor = anchorAttrs
    ? Object.assign(document.createElement('a'), anchorAttrs)
    : null;

  const target = anchor || document.createElement('span');
  // If anchor, wrap in a div so closest('a') still works via DOM
  const container = document.createElement('div');
  container.appendChild(target);

  const preventDefault = vi.fn();
  return {
    target,
    preventDefault,
    // Minimal React.MouseEvent shape
  } as unknown as React.MouseEvent<HTMLDivElement>;
}

describe('useSafeMarkdownLinks', () => {
  beforeEach(() => {
    mockOpenExternalUrl.mockClear();
  });

  it('returns a stable callback', () => {
    const { result, rerender } = renderHook(() => useSafeMarkdownLinks());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('does nothing when clicking a non-anchor element', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const event = makeClickEvent(null);
    result.current(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('prevents default and opens external URL for https links', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://example.com');
    const preventDefault = vi.fn();
    const event = {
      target: anchor,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('prevents default and opens external URL for http links', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'http://example.com');
    const preventDefault = vi.fn();
    const event = {
      target: anchor,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).toHaveBeenCalledWith('http://example.com');
  });

  it('prevents default and opens external URL for mailto links', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'mailto:test@example.com');
    const preventDefault = vi.fn();
    const event = {
      target: anchor,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).toHaveBeenCalledWith('mailto:test@example.com');
  });

  it('prevents default but does NOT open external URL for relative links', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    anchor.setAttribute('href', './other-file.md');
    const preventDefault = vi.fn();
    const event = {
      target: anchor,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('prevents default but does NOT open external URL for anchor links', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#section');
    const preventDefault = vi.fn();
    const event = {
      target: anchor,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('prevents default but does nothing when anchor has no href', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    // No href attribute
    const preventDefault = vi.fn();
    const event = {
      target: anchor,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('finds anchor via closest() when clicking child of anchor', () => {
    const { result } = renderHook(() => useSafeMarkdownLinks());
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://example.com/nested');
    const span = document.createElement('span');
    span.textContent = 'click me';
    anchor.appendChild(span);
    // Attach to document so closest() works
    document.body.appendChild(anchor);

    const preventDefault = vi.fn();
    const event = {
      target: span,
      preventDefault,
    } as unknown as React.MouseEvent<HTMLDivElement>;

    result.current(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://example.com/nested');

    document.body.removeChild(anchor);
  });
});
