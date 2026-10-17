import { describe, expect, it, vi } from 'vitest';
import { scrollWithin } from './scroll';

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
