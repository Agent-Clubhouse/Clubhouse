import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WireFlowDots } from './WireFlowDots';

function renderWithSvg(element: React.ReactElement) {
  return render(
    <svg>
      <defs>
        <path id="wire-path-test-wire" d="M 0 0 C 80 0, 220 0, 300 0" />
      </defs>
      {element}
    </svg>,
  );
}

describe('WireFlowDots', () => {
  it('renders 3 forward dots for a unidirectional wire', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" bidir={false} />,
    );
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    expect(fwdDots.length).toBe(3);
    const revDots = container.querySelectorAll('[data-testid^="wire-dot-rev-test-wire-"]');
    expect(revDots.length).toBe(0);
  });

  it('renders 3 forward and 3 reverse dots for a bidirectional wire', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" bidir={true} />,
    );
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    expect(fwdDots.length).toBe(3);
    const revDots = container.querySelectorAll('[data-testid^="wire-dot-rev-test-wire-"]');
    expect(revDots.length).toBe(3);
  });

  it('staggers dot animations by 1s intervals', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" bidir={false} />,
    );
    const dots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    const begins = Array.from(dots).map(
      (dot) => dot.querySelector('animateMotion')?.getAttribute('begin'),
    );
    expect(begins).toEqual(['0s', '-1s', '-2s']);
  });

  it('reverse dots use keyPoints="1;0" for backward motion', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" bidir={true} />,
    );
    const revDot = container.querySelector('[data-testid="wire-dot-rev-test-wire-0"]');
    const motion = revDot?.querySelector('animateMotion');
    expect(motion?.getAttribute('keyPoints')).toBe('1;0');
    expect(motion?.getAttribute('keyTimes')).toBe('0;1');
  });

  it('renders a glow filter for the wire', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" bidir={false} />,
    );
    expect(container.querySelector('#wire-dot-glow-test-wire')).toBeTruthy();
  });
});
