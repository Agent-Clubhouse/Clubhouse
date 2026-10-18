export type RunPhase = 'start' | 'run' | 'done' | 'fail';

/** An axis-aligned block in viewBox units. */
export interface Box { x: number; y: number; w: number; h: number }

/**
 * The treehouse's structure as data (#2103), so a test can check that every
 * part meets what holds it up. The viewBox is 96 units square (`0 -6 96 96`),
 * drawn on a 3-unit grid: every straight edge is a multiple of 3, which lands
 * on whole pixels at 64px (2px) and 96px (3px) and keeps edges crisp at both.
 * Nothing is thinner than 3 units.
 */
export const TREEHOUSE_GEOMETRY = {
  viewBox: { x: 0, y: -6, size: 96 },
  ground: { x: 6, y: 87, w: 84, h: 3 },
  /** The tree's crown, behind the cabin and roof, so it reads as a tree. */
  canopy: [{ cx: 15, cy: 33, r: 15 }, { cx: 81, cy: 30, r: 15 }, { cx: 15, cy: 15, r: 9 }, { cx: 84, cy: 12, r: 9 }],
  trunk: { x: 39, y: 60, w: 18, h: 27 },
  /** Where the trunk flares into roots on the ground. */
  roots: [[33, 87], [39, 78], [57, 78], [63, 87]] as ReadonlyArray<readonly [number, number]>,
  /** Branches from the trunk's sides out to the platform's ends, underneath it. */
  braces: [
    [[39, 66], [39, 75], [15, 60], [24, 60]],
    [[57, 66], [57, 75], [81, 60], [72, 60]],
  ] as ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  ladder: {
    rails: [{ x: 66, y: 60, w: 3, h: 27 }, { x: 75, y: 60, w: 3, h: 27 }],
    rungs: [{ x: 66, y: 69, w: 12, h: 3 }, { x: 66, y: 78, w: 12, h: 3 }],
  },
  platform: { x: 9, y: 54, w: 78, h: 6 },
  railing: {
    posts: [{ x: 9, y: 45, w: 3, h: 9 }, { x: 84, y: 45, w: 3, h: 9 }],
    rails: [{ x: 9, y: 45, w: 12, h: 3 }, { x: 75, y: 45, w: 12, h: 3 }],
  },
  cabin: { x: 21, y: 30, w: 54, h: 24 },
  /** Left eave, peak, right eave. */
  roof: [[15, 30], [48, 6], [81, 30]] as ReadonlyArray<readonly [number, number]>,
  eave: { x: 15, y: 30, w: 66, h: 3 },
  chimney: { x: 63, y: 9, w: 6, h: 15 },
  dish: { mast: { x: 27, y: 15, w: 3, h: 9 }, cx: 28.5, cy: 12, r: 6 },
  windows: [{ x: 27, y: 36, w: 12, h: 9 }, { x: 57, y: 36, w: 12, h: 9 }],
  door: { x: 42, y: 36, w: 12, h: 18 },
  knob: { x: 48, y: 45, w: 3, h: 3 },
  pole: { x: 45, y: -6, w: 3, h: 15 },
  /** The flag at the top of the pole; it drops by `failDrop` on failure. */
  flag: [[48, -6], [63, -3], [48, 0]] as ReadonlyArray<readonly [number, number]>,
  failDrop: 6,
} as const;

const G = TREEHOUSE_GEOMETRY;

const Rect = ({ b, className, opacity, testId }: { b: Box; className: string; opacity?: number; testId?: string }) => (
  <rect x={b.x} y={b.y} width={b.w} height={b.h} className={className} opacity={opacity} data-testid={testId} />
);
const points = (pts: ReadonlyArray<readonly [number, number]>, dy = 0) => pts.map(([x, y]) => `${x},${y + dy}`).join(' ');

/**
 * The headless run's treehouse (#2019, redrawn for #2103), in theme tokens
 * only. Lit windows, chimney smoke and the dish signal mean work is
 * happening; the flag carries the outcome (blue while running, green done,
 * red and lowered on failure). Flat fills, no glows.
 */
export function Treehouse({ phase, size = 96 }: { phase: RunPhase; size?: number }) {
  const lit = phase === 'run' || phase === 'start';
  const windowClass = (i: number) => (phase === 'fail' ? 'fill-ctp-crust' : phase === 'start' && i === 1 ? 'fill-surface-0' : 'fill-ctp-warning');
  const windowOpacity = phase === 'done' ? 0.45 : 0.85;
  const flagClass = phase === 'done' ? 'fill-ctp-success' : phase === 'fail' ? 'fill-ctp-error' : 'fill-ctp-info';
  const { x: vx, y: vy, size: vs } = G.viewBox;
  return (
    <svg
      viewBox={`${vx} ${vy} ${vs} ${vs}`}
      width={size}
      height={size}
      className="block flex-shrink-0"
      shapeRendering="crispEdges"
      aria-hidden="true"
      data-testid="treehouse"
      data-phase={phase}
    >
      <g className="fill-ctp-success" opacity={0.45} shapeRendering="auto">
        {G.canopy.map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />)}
      </g>
      <Rect b={G.ground} className="fill-surface-0" />

      {/* Under the platform: the trunk and its branches, and the ladder, all from the ground to the platform. */}
      <Rect b={G.trunk} className="fill-surface-2" testId="treehouse-trunk" />
      <polygon points={points(G.roots)} className="fill-surface-2" shapeRendering="auto" />
      {G.braces.map((b, i) => <polygon key={i} points={points(b)} className="fill-surface-2" shapeRendering="auto" />)}
      <g className="fill-ctp-overlay0">
        {G.ladder.rails.map((r, i) => <Rect key={`r${i}`} b={r} className="" />)}
        {G.ladder.rungs.map((r, i) => <Rect key={`g${i}`} b={r} className="" />)}
      </g>

      <Rect b={G.platform} className="fill-surface-2" />
      <g className="fill-surface-2">
        {G.railing.posts.map((p, i) => <Rect key={`p${i}`} b={p} className="" />)}
        {G.railing.rails.map((r, i) => <Rect key={`r${i}`} b={r} className="" />)}
      </g>

      {/* The chimney goes before the roof, so the roof covers its base. */}
      <Rect b={G.chimney} className="fill-surface-2" />
      {lit && (
        <g className="fill-ctp-overlay0" data-testid="treehouse-smoke" shapeRendering="auto">
          <circle cx={67.5} cy={3} r={3} opacity={0.5} />
          <circle cx={72} cy={-1.5} r={2.25} opacity={0.35} />
        </g>
      )}

      <Rect b={G.cabin} className="fill-surface-1" />
      {G.windows.map((w, i) => <Rect key={i} b={w} className={windowClass(i)} opacity={windowOpacity} />)}
      {lit && <Rect b={{ x: 30, y: 39, w: 3, h: 6 }} className="fill-surface-1" opacity={0.75} />}
      <Rect b={G.door} className="fill-surface-2" />
      <Rect b={G.knob} className="fill-ctp-warning" />

      <polygon points={points(G.roof)} className="fill-surface-2" shapeRendering="auto" />
      <Rect b={G.eave} className="fill-ctp-overlay0" />

      {/* Dish on the roof; its signal shows while the run is working. */}
      <Rect b={G.dish.mast} className="fill-ctp-overlay1" />
      <path
        d={`M${G.dish.cx - G.dish.r} ${G.dish.cy}a${G.dish.r} ${G.dish.r} 0 0 0 ${G.dish.r * 2} 0z`}
        className="fill-ctp-overlay1"
        shapeRendering="auto"
      />
      {phase === 'run' && (
        <path
          d={`M${G.dish.cx - 9} ${G.dish.cy - 6}a9 9 0 0 1 18 0`}
          className="stroke-ctp-info motion-safe:animate-pulse"
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
          opacity={0.6}
          shapeRendering="auto"
          data-testid="treehouse-signal"
        />
      )}

      <Rect b={G.pole} className="fill-ctp-overlay1" />
      <polygon
        points={points(G.flag, phase === 'fail' ? G.failDrop : 0)}
        className={flagClass}
        shapeRendering="auto"
        data-testid="treehouse-flag"
      />
    </svg>
  );
}
