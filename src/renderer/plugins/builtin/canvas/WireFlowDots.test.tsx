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
  it('renders nothing when idle', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="idle" />,
    );
    const dots = container.querySelectorAll('circle');
    expect(dots.length).toBe(0);
  });

  it('renders 2 slow forward dots in ambient mode', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="ambient" />,
    );
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    expect(fwdDots.length).toBe(2);
    const revDots = container.querySelectorAll('[data-testid^="wire-dot-rev-test-wire-"]');
    expect(revDots.length).toBe(0);

    // Ambient uses slow 6s duration
    const motion = fwdDots[0].querySelector('animateMotion');
    expect(motion?.getAttribute('dur')).toBe('6s');
  });

  it('renders 5 fast forward dots in active-forward mode', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-forward" />,
    );
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    expect(fwdDots.length).toBe(5);
    const revDots = container.querySelectorAll('[data-testid^="wire-dot-rev-test-wire-"]');
    expect(revDots.length).toBe(0);

    // Active uses fast 1.4s duration
    const motion = fwdDots[0].querySelector('animateMotion');
    expect(motion?.getAttribute('dur')).toBe('1.4s');
  });

  it('renders 5 reverse dots in active-reverse mode', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-reverse" />,
    );
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    expect(fwdDots.length).toBe(0);
    const revDots = container.querySelectorAll('[data-testid^="wire-dot-rev-test-wire-"]');
    expect(revDots.length).toBe(5);
  });

  it('renders both forward and reverse dots in active-both mode', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-both" />,
    );
    const fwdDots = container.querySelectorAll('[data-testid^="wire-dot-fwd-test-wire-"]');
    expect(fwdDots.length).toBe(5);
    const revDots = container.querySelectorAll('[data-testid^="wire-dot-rev-test-wire-"]');
    expect(revDots.length).toBe(5);
  });

  it('reverse dots use keyPoints="1;0" for backward motion', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-reverse" />,
    );
    const revDot = container.querySelector('[data-testid="wire-dot-rev-test-wire-0"]');
    const motion = revDot?.querySelector('animateMotion');
    expect(motion?.getAttribute('keyPoints')).toBe('1;0');
    expect(motion?.getAttribute('keyTimes')).toBe('0;1');
  });

  it('ambient dots have dim opacity values', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="ambient" />,
    );
    const dot = container.querySelector('[data-testid="wire-dot-fwd-test-wire-0"]');
    const anim = dot?.querySelector('animate[attributeName="opacity"]');
    expect(anim?.getAttribute('values')).toBe('0;0.3;0.3;0');
  });

  it('active dots have bright opacity values', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-forward" />,
    );
    const dot = container.querySelector('[data-testid="wire-dot-fwd-test-wire-0"]');
    const anim = dot?.querySelector('animate[attributeName="opacity"]');
    expect(anim?.getAttribute('values')).toBe('0;1;1;0');
  });

  it('renders a glow filter for the wire', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="ambient" />,
    );
    expect(container.querySelector('#wire-dot-glow-test-wire')).toBeTruthy();
  });

  it('uses small radius for ambient dots', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="ambient" />,
    );
    const dot = container.querySelector('[data-testid="wire-dot-fwd-test-wire-0"]');
    expect(dot?.getAttribute('r')).toBe('2.5');
  });

  it('uses larger radius for active dots', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-forward" />,
    );
    const dot = container.querySelector('[data-testid="wire-dot-fwd-test-wire-0"]');
    expect(dot?.getAttribute('r')).toBe('3.5');
  });

  it('uses stronger glow filter for active dots', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="active-forward" />,
    );
    const blur = container.querySelector('#wire-dot-glow-test-wire feGaussianBlur');
    expect(blur?.getAttribute('stdDeviation')).toBe('3.5');
  });

  it('uses subtle glow filter for ambient dots', () => {
    const { container } = renderWithSvg(
      <WireFlowDots wireKey="test-wire" activity="ambient" />,
    );
    const blur = container.querySelector('#wire-dot-glow-test-wire feGaussianBlur');
    expect(blur?.getAttribute('stdDeviation')).toBe('2');
  });
});
