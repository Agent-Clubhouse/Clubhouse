export type RunPhase = 'start' | 'run' | 'done' | 'fail';

/**
 * The headless run's treehouse (#2019), in theme tokens only. Lit windows,
 * chimney smoke and the dish signal mean work is happening; the flag carries
 * the outcome (blue while running, green done, red and lowered on failure).
 */
export function Treehouse({ phase, size = 96 }: { phase: RunPhase; size?: number }) {
  const lit = phase === 'run' || phase === 'start';
  const windowClass = (i: number) => (phase === 'fail' ? 'fill-ctp-crust' : phase === 'start' && i === 1 ? 'fill-surface-0' : 'fill-ctp-warning');
  const windowOpacity = (i: number) => (phase === 'done' ? 0.45 : i === 0 ? 0.8 : 0.7);
  const flagClass = phase === 'done' ? 'fill-ctp-success' : phase === 'fail' ? 'fill-ctp-error' : 'fill-ctp-info';
  const fy = phase === 'fail' ? 6 : 0;
  return (
    <svg viewBox="0 -8 120 128" width={size} height={size} className="block flex-shrink-0" aria-hidden="true" data-testid="treehouse" data-phase={phase}>
      <ellipse cx={60} cy={112} rx={50} ry={4.5} className="fill-surface-0" />
      <g className="fill-ctp-success" opacity={0.35}>
        <circle cx={28} cy={110} r={4} /><circle cx={42} cy={111} r={5} /><circle cx={78} cy={111} r={4.5} /><circle cx={92} cy={110} r={3.5} />
      </g>
      <g className="fill-surface-2">
        <rect x={30} y={60} width={4} height={52} /><rect x={86} y={60} width={4} height={52} /><rect x={58} y={72} width={4} height={40} />
      </g>
      <path d="M32 76l26 14M88 76l-26 14" className="stroke-surface-1" strokeWidth={2} />
      <path d="M40 112l-10-47M48 112l-10-47M39 104h8M37 94h8M35 84h8M33 74h8" className="stroke-surface-2" strokeWidth={1.6} />
      <rect x={22} y={58} width={76} height={5} rx={1.5} className="fill-surface-2" />
      <path d="M24 58v-6M42 58v-6M78 58v-6M96 58v-6M24 53h18M78 53h18" className="stroke-surface-2" strokeWidth={1.4} />
      <rect x={26} y={28} width={68} height={31} rx={2} className="fill-surface-1" />
      <path d="M26 36h68M26 44h68M26 52h68" className="stroke-surface-2" strokeWidth={0.7} opacity={0.7} />
      <polygon points="16,30 60,5 104,30" className="fill-surface-2" />
      <path d="M16 30h88" className="stroke-ctp-overlay0" strokeWidth={1.4} />
      <rect x={80} y={9} width={8} height={15} rx={1} className="fill-surface-2" />
      {lit && (
        <g className="fill-ctp-overlay0" data-testid="treehouse-smoke">
          <circle cx={84} cy={3} r={2.6} opacity={0.5} /><circle cx={87} cy={-2} r={2} opacity={0.35} /><circle cx={85} cy={-6} r={1.4} opacity={0.2} />
        </g>
      )}
      <rect x={34} y={36} width={14} height={12} rx={1.5} className={windowClass(0)} opacity={windowOpacity(0)} />
      <rect x={72} y={36} width={14} height={12} rx={1.5} className={windowClass(1)} opacity={windowOpacity(1)} />
      <path d="M41 36v12M34 42h14M79 36v12M72 42h14" className="stroke-surface-1" strokeWidth={1} />
      {lit && <ellipse cx={39} cy={43} rx={2.4} ry={3.8} className="fill-surface-1" opacity={0.7} />}
      <rect x={53} y={40} width={14} height={19} rx={2} className="fill-surface-2" />
      <circle cx={63} cy={50} r={1.1} className="fill-ctp-warning" />
      <path d="M30 14q6-4 12 0M36 14v6" className="stroke-ctp-overlay1" strokeWidth={1.4} fill="none" />
      {phase === 'run' && (
        <path d="M27 8q9-7 18 0M23 3q13-10 26 0" className="stroke-ctp-info motion-safe:animate-pulse" strokeWidth={1.2} fill="none" opacity={0.55} />
      )}
      <path d="M60 5v-10" className="stroke-ctp-overlay1" strokeWidth={1} />
      <polygon points={`60,${-5 + fy} 72,${-4 + fy} 60,${1 + fy}`} className={flagClass} data-testid="treehouse-flag" />
    </svg>
  );
}
