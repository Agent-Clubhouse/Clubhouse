import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Treehouse, TREEHOUSE_GEOMETRY as G, type Box, type RunPhase } from './Treehouse';

const bottom = (b: Box) => b.y + b.h;
const right = (b: Box) => b.x + b.w;
const platformBottom = bottom(G.platform);
const groundTop = G.ground.y;

/** The roof's top edge at `x`: the eave-to-peak line on that side. */
function roofYAt(x: number): number {
  const [[lx, ly], [px, py], [rx, ry]] = G.roof;
  return x <= px ? ly + ((py - ly) * (x - lx)) / (px - lx) : py + ((ry - py) * (x - px)) / (rx - px);
}

describe('Treehouse geometry (#2103)', () => {
  it('stands every support from the ground top to the platform bottom: trunk and ladder rails', () => {
    for (const b of [G.trunk, ...G.ladder.rails]) {
      expect(b.y).toBe(platformBottom);
      expect(bottom(b)).toBe(groundTop);
    }
  });

  it('roots the trunk on the ground and keeps its ladder rungs between the rails', () => {
    const rootYs = G.roots.map(([, y]) => y);
    expect(Math.max(...rootYs)).toBe(groundTop);
    const [left, rightRail] = G.ladder.rails;
    for (const rung of G.ladder.rungs) {
      expect(rung.x).toBe(left.x);
      expect(right(rung)).toBe(right(rightRail));
      expect(rung.y).toBeGreaterThan(platformBottom);
      expect(bottom(rung)).toBeLessThan(groundTop);
    }
  });

  it('runs each branch from the side of the trunk to the underside of the platform', () => {
    for (const brace of G.braces) {
      const onTrunk = brace.filter(([x, y]) => (x === G.trunk.x || x === right(G.trunk)) && y > G.trunk.y && y < bottom(G.trunk));
      const onPlatform = brace.filter(([x, y]) => y === platformBottom && x >= G.platform.x && x <= right(G.platform));
      expect(onTrunk).toHaveLength(2);
      expect(onPlatform).toHaveLength(2);
    }
  });

  it('sits the cabin and railing on the platform, and the railing against the cabin walls', () => {
    expect(bottom(G.cabin)).toBe(G.platform.y);
    for (const p of G.railing.posts) expect(bottom(p)).toBe(G.platform.y);
    const [l, r] = G.railing.rails;
    expect(l.x).toBe(G.platform.x);
    expect(right(l)).toBe(G.cabin.x);
    expect(r.x).toBe(right(G.cabin));
    expect(right(r)).toBe(right(G.platform));
  });

  it('puts the roof on the cabin and the flagpole, chimney base and dish mast inside the roof', () => {
    const [[, eaveY]] = G.roof;
    expect(eaveY).toBe(G.cabin.y);
    expect(G.eave.y).toBe(eaveY);
    // The pole's foot is below the roof line at both of its edges, so it meets the peak.
    expect(bottom(G.pole)).toBeGreaterThanOrEqual(roofYAt(G.pole.x));
    expect(bottom(G.pole)).toBeGreaterThanOrEqual(roofYAt(right(G.pole)));
    expect(right(G.pole)).toBe(G.roof[1][0]);
    for (const b of [G.chimney, G.dish.mast]) {
      expect(bottom(b)).toBeGreaterThanOrEqual(roofYAt(b.x));
      expect(bottom(b)).toBeGreaterThanOrEqual(roofYAt(right(b)));
      expect(bottom(b)).toBeLessThanOrEqual(G.cabin.y);
    }
    // The dish bowl rests on its mast.
    expect(G.dish.cy + G.dish.r).toBeGreaterThan(G.dish.mast.y);
  });

  it('hangs the flag on the pole, and still on the pole when lowered', () => {
    const flagXs = G.flag.map(([x]) => x);
    expect(Math.min(...flagXs)).toBe(right(G.pole));
    const lowestFlagY = Math.max(...G.flag.map(([, y]) => y)) + G.failDrop;
    expect(lowestFlagY).toBeLessThanOrEqual(bottom(G.pole));
  });

  it('draws every straight edge on the 3-unit grid and nothing thinner than 3 units', () => {
    const boxes: Box[] = [
      G.ground, G.trunk, ...G.ladder.rails, ...G.ladder.rungs, G.platform, ...G.railing.posts,
      ...G.railing.rails, G.cabin, G.eave, G.chimney, G.dish.mast, ...G.windows, G.door, G.knob, G.pole,
    ];
    for (const b of boxes) {
      for (const v of [b.x, b.y, b.w, b.h]) expect(Math.abs(v % 3)).toBe(0);
      expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(3);
    }
    for (const [x, y] of [...G.roof, ...G.roots, ...G.flag, ...G.braces.flat()]) {
      expect(Math.abs(x % 3)).toBe(0);
      expect(Math.abs(y % 3)).toBe(0);
    }
  });

  it('fits the drawing in the viewBox', () => {
    const { x, y, size } = G.viewBox;
    const all: Box[] = [G.ground, G.pole, ...G.canopy.map((c) => ({ x: c.cx - c.r, y: c.cy - c.r, w: c.r * 2, h: c.r * 2 }))];
    for (const b of all) {
      expect(b.x).toBeGreaterThanOrEqual(x);
      expect(b.y).toBeGreaterThanOrEqual(y);
      expect(right(b)).toBeLessThanOrEqual(x + size);
      expect(bottom(b)).toBeLessThanOrEqual(y + size);
    }
  });
});

describe('Treehouse phases', () => {
  const renderPhase = (phase: RunPhase, size?: number) => render(<Treehouse phase={phase} size={size} />);
  const flagClass = () => screen.getByTestId('treehouse-flag').getAttribute('class');

  it.each(['start', 'run', 'done', 'fail'] as RunPhase[])('keeps the test id and phase for %s, in theme tokens only', (phase) => {
    const { container } = renderPhase(phase);
    expect(screen.getByTestId('treehouse')).toHaveAttribute('data-phase', phase);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.innerHTML).not.toMatch(/filter|blur|drop-shadow/);
  });

  it('shows smoke while starting or running, and the dish signal only while running', () => {
    renderPhase('start');
    expect(screen.getByTestId('treehouse-smoke')).toBeTruthy();
    expect(screen.queryByTestId('treehouse-signal')).toBeNull();
  });

  it('signals from the dish with a blue flag while running', () => {
    renderPhase('run');
    expect(screen.getByTestId('treehouse-signal')).toBeTruthy();
    expect(flagClass()).toBe('fill-ctp-info');
  });

  it('flies a green flag with no smoke when done', () => {
    renderPhase('done');
    expect(screen.queryByTestId('treehouse-smoke')).toBeNull();
    expect(flagClass()).toBe('fill-ctp-success');
  });

  it('lowers a red flag on failure', () => {
    renderPhase('fail');
    expect(flagClass()).toBe('fill-ctp-error');
    const ys = screen.getByTestId('treehouse-flag').getAttribute('points')!.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.min(...ys)).toBe(Math.min(...G.flag.map(([, y]) => y)) + G.failDrop);
  });

  it('renders at the requested size', () => {
    renderPhase('run', 64);
    expect(screen.getByTestId('treehouse')).toHaveAttribute('width', '64');
  });
});
