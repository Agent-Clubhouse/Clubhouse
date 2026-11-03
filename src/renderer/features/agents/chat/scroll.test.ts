import { describe, expect, it, vi } from 'vitest';
import { scrollLogLimiter, scrollWithin, unexplainedMoveCause } from './scroll';

function box(top: number, height: number) {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function setup(targetTop: number, targetHeight = 40) {
  const container = document.createElement('div');
  const target = document.createElement('div');
  container.appendChild(target);
  Object.defineProperty(container, 'clientHeight', { value: 400 });
  Object.defineProperty(container, 'scrollHeight', { value: 2000 });
  container.scrollTop = 500;
  container.getBoundingClientRect = () => box(100, 400);
  target.getBoundingClientRect = () => box(targetTop, targetHeight);
  const scrollTo = vi.fn();
  container.scrollTo = scrollTo as unknown as typeof container.scrollTo;
  const intoView = vi.fn();
  target.scrollIntoView = intoView;
  return { container, target, scrollTo, intoView };
}

describe('scrollWithin', () => {
  it('centres the target by scrolling only the container', () => {
    const { container, target, scrollTo, intoView } = setup(900);
    scrollWithin(container, target, 'center', 'smooth');
    // offset = 900 - 100 + 500 = 1300; centred = 1300 - (400 - 40) / 2 = 1120
    expect(scrollTo).toHaveBeenCalledWith({ top: 1120, behavior: 'smooth' });
    expect(intoView).not.toHaveBeenCalled();
  });

  it('clamps to the scrollable range', () => {
    const { container, target, scrollTo } = setup(-600);
    scrollWithin(container, target, 'center');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('nearest leaves an already-visible target alone', () => {
    const { container, target, scrollTo } = setup(200);
    scrollWithin(container, target, 'nearest');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('nearest aligns the top when above and the bottom when below', () => {
    const above = setup(50);
    scrollWithin(above.container, above.target, 'nearest');
    expect(above.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'auto' });
    const below = setup(480);
    scrollWithin(below.container, below.target, 'nearest');
    // offset = 880; bottom-aligned = 880 + 40 - 400 = 520
    expect(below.scrollTo).toHaveBeenCalledWith({ top: 520, behavior: 'auto' });
  });
});

describe('unexplainedMoveCause', () => {
  const at = (scrollTop: number, scrollHeight: number, start = 0, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight, start });

  it('blames the window when it changed under the view', () => {
    expect(unexplainedMoveCause(at(2000, 2400, 10), at(100, 2400, 40))).toBe('window-move');
  });

  it('calls it a clamp when the range shrank and the view sits at its new end', () => {
    expect(unexplainedMoveCause(at(2000, 2400), at(600, 1000))).toBe('clamp');
  });

  it('does not call it a clamp when the view stopped short of the end', () => {
    expect(unexplainedMoveCause(at(2000, 2400), at(100, 1000))).toBe('unknown');
    expect(unexplainedMoveCause(at(2000, 2400), at(100, 2400))).toBe('unknown');
  });

  it('counts a taller viewport as a smaller range', () => {
    expect(unexplainedMoveCause(at(2000, 2400), at(1800, 2400, 0, 600))).toBe('clamp');
  });
});

describe('scrollLogLimiter', () => {
  it('allows the limit a minute, then says how many it held back', () => {
    const allow = scrollLogLimiter(2);
    expect(allow(100_000)).toBe(0);
    expect(allow(100_001)).toBe(0);
    expect(allow(100_002)).toBeNull();
    expect(allow(100_003)).toBeNull();
    expect(allow(160_000)).toBe(2);
    expect(allow(160_001)).toBe(0);
  });
});
