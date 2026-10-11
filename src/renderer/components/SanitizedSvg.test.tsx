import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SanitizedSvg } from './SanitizedSvg';

const ICON = '<svg viewBox="0 0 24 24"><line x1="0" y1="0" x2="24" y2="24"/></svg>';

describe('SanitizedSvg', () => {
  it('strips disallowed markup', () => {
    const { container } = render(<SanitizedSvg svg={'<svg><script>alert(1)</script><path d="M0 0"/></svg>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('path')).not.toBeNull();
  });

  it('keeps the same SVG node across re-renders with an unchanged source', () => {
    // A rebuilt node between pointerdown and pointerup cancels the click on
    // the enclosing button, so identity must survive parent re-renders.
    const { container, rerender } = render(<SanitizedSvg svg={ICON} className="a" />);
    const before = container.querySelector('svg');
    rerender(<SanitizedSvg svg={ICON} className="b" />);
    expect(container.querySelector('svg')).toBe(before);
  });

  it('replaces the SVG when the source changes', () => {
    const { container, rerender } = render(<SanitizedSvg svg={ICON} />);
    const before = container.querySelector('svg');
    rerender(<SanitizedSvg svg={ICON.replace('y2="24"', 'y2="12"')} />);
    expect(container.querySelector('svg')).not.toBe(before);
  });
});
