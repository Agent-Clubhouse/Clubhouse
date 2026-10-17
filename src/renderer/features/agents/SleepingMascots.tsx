/**
 * Provider mascots for the agent-state views (#2019), redrawn from each
 * product's public look on a 96×96 viewBox and drawn at 44 to 96px.
 *
 * - Claude Code: the terminal pixel creature on a 6px grid, napping by a cursor block.
 * - Codex: a one-color blossom creature whose body is the rounded hexagon of six
 *   lobes; it keeps a terminal prompt as its mouth.
 * - Copilot: a rounded pilot with the goggles pushed up while it naps.
 *
 * Brand tints come from the named `brand-*` tokens in index.css (themes can
 * tune them); everything else in each drawing uses theme tokens.
 */

import type { OrchestratorId } from '../../../shared/types';

export interface MascotProps {
  /** Rendered width and height in px. */
  size?: number;
  /** Awake pose: eyes open, no z's. */
  awake?: boolean;
  /** Failed launch: dimmed, no z's. */
  error?: boolean;
}

/** Three monospace z's drifting up and to the right. */
function Zzz({ x, y }: { x: number; y: number }) {
  return (
    <g className="fill-ctp-overlay0 font-mono" fontWeight={700} aria-hidden="true">
      <text x={x} y={y} fontSize={13} className="motion-safe:animate-pulse">z</text>
      <text x={x + 8} y={y - 9} fontSize={10} opacity={0.7} className="motion-safe:animate-pulse" style={{ animationDelay: '0.3s' }}>z</text>
      <text x={x + 14} y={y - 16} fontSize={8} opacity={0.45} className="motion-safe:animate-pulse" style={{ animationDelay: '0.6s' }}>z</text>
    </g>
  );
}

/* ── Claude Code ─────────────────────────────────────────────────── */

const CC_U = 6;
const CC_OX = 6;
const CC_OY = 26;

function Px({ c, r, w = 1, h = 1, className = 'fill-brand-claude', opacity }: { c: number; r: number; w?: number; h?: number; className?: string; opacity?: number }) {
  return <rect x={CC_OX + c * CC_U} y={CC_OY + r * CC_U} width={w * CC_U} height={h * CC_U} className={className} opacity={opacity} />;
}

/** A pixel "Z": top bar, a three-step diagonal, bottom bar. */
function PixelZ({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <g className="fill-ctp-overlay0" aria-hidden="true">
      <rect x={x} y={y} width={5 * s} height={s} />
      <rect x={x + 3 * s} y={y + s} width={s} height={s} />
      <rect x={x + 2 * s} y={y + 2 * s} width={s} height={s} />
      <rect x={x + s} y={y + 3 * s} width={s} height={s} />
      <rect x={x} y={y + 4 * s} width={5 * s} height={s} />
    </g>
  );
}

export function ClaudeMascot({ size = 88, awake, error }: MascotProps) {
  const ink = 'fill-brand-claude-ink';
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} shapeRendering="crispEdges" className="block" aria-hidden="true" data-mascot="claude-code">
      <rect x={12} y={CC_OY + 7 * CC_U + 6} width={72} height={2} className="fill-surface-1" />
      <Px c={2} r={0} w={10} h={5} />
      <Px c={2} r={0} w={10} h={1} className="fill-ctp-text" opacity={0.1} />
      <Px c={0} r={2} w={2} h={1} />
      <Px c={12} r={2} w={2} h={1} />
      <Px c={3} r={5} h={2} />
      <Px c={5} r={5} h={2} />
      <Px c={8} r={5} h={2} />
      <Px c={10} r={5} h={2} />
      {awake ? (
        <>
          <Px c={4} r={1} className={ink} />
          <Px c={9} r={1} className={ink} />
        </>
      ) : (
        <>
          <rect x={CC_OX + 3.5 * CC_U} y={CC_OY + 1.6 * CC_U} width={2 * CC_U} height={3} className={ink} />
          <rect x={CC_OX + 8.5 * CC_U} y={CC_OY + 1.6 * CC_U} width={2 * CC_U} height={3} className={ink} />
        </>
      )}
      {!awake && <rect x={CC_OX + 13.5 * CC_U} y={CC_OY + 5 * CC_U} width={CC_U} height={2 * CC_U} className="fill-ctp-overlay0" opacity={0.55} />}
      {!awake && !error && (
        <>
          <PixelZ x={68} y={4} s={2.4} />
          <PixelZ x={84} y={-2} s={1.6} />
        </>
      )}
    </svg>
  );
}

/* ── Codex ───────────────────────────────────────────────────────── */

const CX_D = 15;
const CX_R = 22;
const CX_CX = 48;
const CX_CY = 46;
const CX_LOBES: Array<[number, number]> = [-90, -30, 30, 90, 150, 210].map((a) => [
  CX_CX + CX_D * Math.cos((a * Math.PI) / 180),
  CX_CY + CX_D * Math.sin((a * Math.PI) / 180),
]);

/** Six short arcs where neighboring lobes meet, a pinwheel that suggests the blossom's strokes. */
const CX_SEAMS = (() => {
  const f = (n: number) => n.toFixed(1);
  return CX_LOBES.map(([x, y], k) => {
    const [nx, ny] = CX_LOBES[(k + 1) % 6];
    const mx = (x + nx) / 2;
    const my = (y + ny) / 2;
    const h = Math.sqrt(CX_R * CX_R - (CX_D * CX_D) / 4);
    const len = Math.hypot(mx - CX_CX, my - CX_CY);
    const ux = (mx - CX_CX) / len;
    const uy = (my - CX_CY) / len;
    const a0 = Math.atan2(my + uy * h - y, mx + ux * h - x);
    const a1 = Math.atan2(my - uy * h - y, mx - ux * h - x);
    let d = a1 - a0;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    const a2 = a0 + d * 0.32;
    return `M${f(x + CX_R * Math.cos(a0))} ${f(y + CX_R * Math.sin(a0))}A${CX_R} ${CX_R} 0 0 ${d > 0 ? 1 : 0} ${f(x + CX_R * Math.cos(a2))} ${f(y + CX_R * Math.sin(a2))}`;
  }).join('');
})();

export function CodexMascot({ size = 88, awake, error }: MascotProps) {
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} className="block" aria-hidden="true" data-mascot="codex-cli">
      <ellipse cx={48} cy={85} rx={awake ? 26 : 31} ry={2.5} className="fill-surface-1" />
      <g transform={awake ? undefined : 'translate(0 4) rotate(-7 48 82)'}>
        <g className="fill-brand-codex">
          {CX_LOBES.map(([x, y], i) => <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={CX_R} />)}
        </g>
        {/* Below 40px the seams drop out so the silhouette and face stay clean. */}
        {size >= 40 && <path d={CX_SEAMS} fill="none" className="stroke-ctp-base" strokeWidth={2.6} strokeLinecap="round" opacity={0.36} />}
        {awake ? (
          <>
            <rect x={35} y={34} width={7} height={11} rx={3.5} className="fill-ctp-base" />
            <rect x={54} y={34} width={7} height={11} rx={3.5} className="fill-ctp-base" />
            <path d="M40.5 51.5l4.5 4-4.5 4" className="stroke-ctp-base" strokeWidth={3.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <rect x={48.5} y={58} width={8} height={3.2} rx={1.6} className="fill-ctp-base" />
          </>
        ) : (
          <>
            <path d="M34 41q4.5 4 9 0M53 41q4.5 4 9 0" className="stroke-ctp-base" strokeWidth={3.4} fill="none" strokeLinecap="round" />
            <rect x={44} y={54} width={8} height={3.2} rx={1.6} className="fill-ctp-base" opacity={0.5} />
          </>
        )}
      </g>
      {!awake && !error && <Zzz x={74} y={14} />}
    </svg>
  );
}

/* ── Copilot ─────────────────────────────────────────────────────── */

export function CopilotMascot({ size = 88, awake, error }: MascotProps) {
  const gy = awake ? 40 : 18;
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} className="block" aria-hidden="true" data-mascot="copilot-cli">
      <ellipse cx={48} cy={88} rx={26} ry={2.5} className="fill-surface-1" />
      <rect x={10} y={44} width={11} height={20} rx={5.5} className="fill-ctp-text" opacity={0.85} />
      <rect x={75} y={44} width={11} height={20} rx={5.5} className="fill-ctp-text" opacity={0.85} />
      <rect x={17} y={30} width={62} height={52} rx={24} className="fill-ctp-text" />
      <rect x={25} y={44} width={46} height={28} rx={12} className="fill-ctp-base" />
      {!awake && <path d="M34 57q5 4 10 0M52 57q5 4 10 0" className="stroke-ctp-text" strokeWidth={3} fill="none" strokeLinecap="round" />}
      <g className="fill-brand-copilot">
        <rect x={21} y={gy} width={25} height={19} rx={8} />
        <rect x={50} y={gy} width={25} height={19} rx={8} />
        <rect x={44} y={gy + 6} width={8} height={6} rx={3} />
      </g>
      <rect x={25} y={gy + 4} width={17} height={11} rx={5} className="fill-ctp-crust" opacity={0.85} />
      <rect x={54} y={gy + 4} width={17} height={11} rx={5} className="fill-ctp-crust" opacity={0.85} />
      <rect x={27} y={gy + 5} width={6} height={3} rx={1.5} className="fill-ctp-text" opacity={0.25} />
      <rect x={56} y={gy + 5} width={6} height={3} rx={1.5} className="fill-ctp-text" opacity={0.25} />
      {!awake && !error && <Zzz x={76} y={18} />}
    </svg>
  );
}

/* ── Any other provider ──────────────────────────────────────────── */

/** A plain robot in theme colors for providers without a mascot of their own. */
export function GenericMascot({ size = 88, awake, error }: MascotProps) {
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} className="block" aria-hidden="true" data-mascot="generic">
      <ellipse cx={48} cy={86} rx={26} ry={2.5} className="fill-surface-1" />
      <path d="M48 22v-8" className="stroke-ctp-overlay1" strokeWidth={2} strokeLinecap="round" />
      <circle cx={48} cy={12} r={3} className="fill-ctp-overlay1" />
      <rect x={22} y={22} width={52} height={36} rx={14} className="fill-ctp-subtext0" />
      <rect x={28} y={30} width={40} height={20} rx={7} className="fill-ctp-base" />
      {awake ? (
        <>
          <rect x={36} y={36} width={6} height={8} rx={3} className="fill-ctp-subtext0" />
          <rect x={54} y={36} width={6} height={8} rx={3} className="fill-ctp-subtext0" />
        </>
      ) : (
        <path d="M35 41q4 3 8 0M53 41q4 3 8 0" className="stroke-ctp-subtext0" strokeWidth={2.6} fill="none" strokeLinecap="round" />
      )}
      <rect x={28} y={62} width={40} height={22} rx={7} className="fill-ctp-overlay1" />
      {!awake && !error && <Zzz x={74} y={18} />}
    </svg>
  );
}

/** The mascot for an agent's provider, sleeping unless `awake`. */
export function SleepingMascot({ orchestrator, size = 88, awake, error }: MascotProps & { orchestrator?: OrchestratorId }) {
  const props = { size, awake, error };
  const art = orchestrator === 'claude-code' ? <ClaudeMascot {...props} />
    : orchestrator === 'codex-cli' ? <CodexMascot {...props} />
      : orchestrator === 'copilot-cli' ? <CopilotMascot {...props} />
        : <GenericMascot {...props} />;
  return <span className={`inline-block ${error ? 'opacity-50' : ''}`} data-testid="agent-mascot">{art}</span>;
}
