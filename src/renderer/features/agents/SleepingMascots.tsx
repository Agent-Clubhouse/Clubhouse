/**
 * Orchestrator-specific sleeping mascots for the SleepingAgent view.
 * Each renders a 200×200 SVG (100×100 viewBox) with animated Zzz.
 */

import type { OrchestratorId } from '../../../shared/types';

/* ── Shared Zzz animation ─────────────────────────────────────────── */

function SleepingZzz({ x, y }: { x: number; y: number }) {
  return (
    <>
      <text x={x} y={y} fill="#6c7086" fontSize="11" fontWeight="bold" fontFamily="monospace">
        <tspan className="animate-pulse">z</tspan>
      </text>
      <text
        x={x + 6}
        y={y - 8}
        fill="#585b70"
        fontSize="9"
        fontWeight="bold"
        fontFamily="monospace"
      >
        <tspan className="animate-pulse" style={{ animationDelay: '0.3s' }}>
          z
        </tspan>
      </text>
      <text
        x={x + 11}
        y={y - 15}
        fill="#45475a"
        fontSize="7"
        fontWeight="bold"
        fontFamily="monospace"
      >
        <tspan className="animate-pulse" style={{ animationDelay: '0.6s' }}>
          z
        </tspan>
      </text>
    </>
  );
}

/* ── Claude Code mascot ───────────────────────────────────────────── */

export function ClaudeCodeSleeping() {
  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      {/* Ground shadow */}
      <ellipse cx="50" cy="90" rx="28" ry="3.5" fill="#181825" opacity="0.3" />

      {/* Nightcap — droops to upper-left */}
      <path d="M 56 27 L 36 27 Q 24 10 20 16" fill="#6366f1" />
      <path d="M 38 25 Q 30 16 26 20" stroke="#818cf8" strokeWidth="1.5" fill="none" opacity="0.4" />
      <circle cx="20" cy="15" r="3.5" fill="#a5b4fc" />
      <rect x="30" y="26" width="32" height="3" rx="1.5" fill="#4f46e5" opacity="0.35" />

      {/* Body */}
      <rect x="18" y="27" width="64" height="48" rx="10" fill="#d4896b" />

      {/* Horizontal shading bands (like original pixel art) */}
      <rect x="18" y="27" width="64" height="8" rx="10" fill="#e0a88d" opacity="0.3" />
      <rect x="18" y="50" width="64" height="6" fill="#c4795b" opacity="0.15" />
      <path
        d="M 18 63 L 82 63 L 82 65 Q 82 75 72 75 L 28 75 Q 18 75 18 65 Z"
        fill="#c4795b"
        opacity="0.2"
      />

      {/* Closed eyes — peaceful arcs */}
      <path
        d="M 33 45 Q 37 40 41 45"
        stroke="#2a1f1a"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 59 45 Q 63 40 67 45"
        stroke="#2a1f1a"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />

      {/* Eyelashes */}
      <line x1="32" y1="45" x2="31" y2="42.5" stroke="#2a1f1a" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="42" y1="45" x2="43" y2="42.5" stroke="#2a1f1a" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="58" y1="45" x2="57" y2="42.5" stroke="#2a1f1a" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="68" y1="45" x2="69" y2="42.5" stroke="#2a1f1a" strokeWidth="0.8" strokeLinecap="round" />

      {/* Blush */}
      <circle cx="29" cy="51" r="4.5" fill="#e88" opacity="0.2" />
      <circle cx="71" cy="51" r="4.5" fill="#e88" opacity="0.2" />

      {/* Content smile */}
      <path
        d="M 44 56 Q 50 60 56 56"
        stroke="#2a1f1a"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />

      {/* Legs */}
      <rect x="28" y="75" width="9" height="11" rx="3" fill="#a86a4e" />
      <rect x="45.5" y="75" width="9" height="11" rx="3" fill="#a86a4e" />
      <rect x="63" y="75" width="9" height="11" rx="3" fill="#a86a4e" />
      {/* Feet / shoes */}
      <rect x="26.5" y="83" width="12" height="3.5" rx="1.75" fill="#8a5a3e" />
      <rect x="44" y="83" width="12" height="3.5" rx="1.75" fill="#8a5a3e" />
      <rect x="61.5" y="83" width="12" height="3.5" rx="1.75" fill="#8a5a3e" />

      <SleepingZzz x={74} y={22} />
    </svg>
  );
}

/* ── GitHub Copilot mascot ────────────────────────────────────────── */

export function CopilotSleeping() {
  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      {/* Ground shadow */}
      <ellipse cx="50" cy="91" rx="26" ry="3" fill="#181825" opacity="0.3" />

      {/* Legs */}
      <rect x="30" y="76" width="12" height="10" rx="4" fill="#14141e" />
      <rect x="58" y="76" width="12" height="10" rx="4" fill="#14141e" />
      {/* Feet */}
      <rect x="28" y="83" width="16" height="4" rx="2" fill="#0e0e18" />
      <rect x="56" y="83" width="16" height="4" rx="2" fill="#0e0e18" />

      {/* Main face / body */}
      <rect x="15" y="18" width="70" height="58" rx="10" fill="#1e1e2e" stroke="#2d2d3d" strokeWidth="0.5" />

      {/* Top magenta stripe */}
      <rect x="15" y="18" width="70" height="4" rx="10" fill="#d946ef" opacity="0.8" />

      {/* Eye socket backgrounds (dim teal) */}
      <rect x="23" y="34" width="22" height="18" rx="5" fill="#0d2e2e" />
      <rect x="55" y="34" width="22" height="18" rx="5" fill="#0d2e2e" />

      {/* Eye "eyelid" overlay — covers top portion for half-closed look */}
      <rect x="23" y="34" width="22" height="11" rx="5" fill="#1e1e2e" />
      <rect x="55" y="34" width="22" height="11" rx="5" fill="#1e1e2e" />

      {/* Dim eye glow — bottom sliver visible */}
      <rect x="23" y="45" width="22" height="7" rx="0 0 5 5" fill="#0a4a4a" opacity="0.6" />
      <rect x="55" y="45" width="22" height="7" rx="0 0 5 5" fill="#0a4a4a" opacity="0.6" />

      {/* Subtle eyelid line */}
      <line x1="24" y1="45" x2="44" y2="45" stroke="#2a6a6a" strokeWidth="0.5" opacity="0.4" />
      <line x1="56" y1="45" x2="76" y2="45" stroke="#2a6a6a" strokeWidth="0.5" opacity="0.4" />

      {/* Green LED indicators (dimmed) */}
      <rect x="39" y="60" width="5" height="3" rx="1" fill="#1a3a1a" />
      <rect x="48" y="60" width="5" height="3" rx="1" fill="#1a3a1a" />

      {/* Magenta side panels (dimmed) */}
      <rect x="20" y="59" width="8" height="5" rx="2" fill="#4a1a4a" />
      <rect x="64" y="59" width="8" height="5" rx="2" fill="#4a1a4a" />

      {/* Mouth — small horizontal bar */}
      <rect x="42" y="67" width="8" height="2" rx="1" fill="#2d2d3d" />

      <SleepingZzz x={76} y={14} />
    </svg>
  );
}

/* ── Generic robot mascot ─────────────────────────────────────────── */

export function GenericRobotSleeping() {
  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      {/* Ground shadow */}
      <ellipse cx="50" cy="93" rx="24" ry="3" fill="#181825" opacity="0.3" />

      {/* Antenna */}
      <line x1="50" y1="14" x2="50" y2="6" stroke="#5a5a6e" strokeWidth="2" strokeLinecap="round" />
      <circle cx="50" cy="5" r="3" fill="#3a3a4c" />
      {/* Dim antenna glow */}
      <circle cx="50" cy="5" r="1.5" fill="#5a5a6e" opacity="0.3" />

      {/* Head — dome shape */}
      <rect x="28" y="14" width="44" height="28" rx="12" fill="#6a6a7e" />
      {/* Head highlight */}
      <rect x="32" y="16" width="36" height="4" rx="2" fill="#7a7a8e" opacity="0.35" />

      {/* Visor / face area */}
      <rect x="32" y="22" width="36" height="14" rx="5" fill="#3a3a4c" />

      {/* Closed eyes — horizontal lines */}
      <line x1="38" y1="29" x2="44" y2="29" stroke="#8a8a9e" strokeWidth="2" strokeLinecap="round" />
      <line x1="56" y1="29" x2="62" y2="29" stroke="#8a8a9e" strokeWidth="2" strokeLinecap="round" />

      {/* Small eyelash accents */}
      <line x1="37" y1="29" x2="36" y2="27" stroke="#8a8a9e" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="45" y1="29" x2="46" y2="27" stroke="#8a8a9e" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="55" y1="29" x2="54" y2="27" stroke="#8a8a9e" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="63" y1="29" x2="64" y2="27" stroke="#8a8a9e" strokeWidth="0.7" strokeLinecap="round" />

      {/* Neck */}
      <rect x="42" y="42" width="16" height="8" rx="3" fill="#5a5a6e" />

      {/* Body */}
      <rect x="26" y="48" width="48" height="30" rx="6" fill="#5a5a6e" />
      {/* Body highlight */}
      <rect x="30" y="50" width="40" height="4" rx="2" fill="#6a6a7e" opacity="0.3" />

      {/* Chest panel */}
      <rect x="36" y="55" width="28" height="16" rx="3" fill="#4a4a5c" stroke="#6a6a7e" strokeWidth="0.5" />

      {/* Power LED (dim / off) */}
      <circle cx="50" cy="63" r="2.5" fill="#2a1515" />
      <circle cx="50" cy="63" r="1.2" fill="#4a2020" opacity="0.4" />

      {/* Panel details — small screws / rivets */}
      <circle cx="39" cy="58" r="1" fill="#5a5a6e" />
      <circle cx="61" cy="58" r="1" fill="#5a5a6e" />
      <circle cx="39" cy="68" r="1" fill="#5a5a6e" />
      <circle cx="61" cy="68" r="1" fill="#5a5a6e" />

      {/* Arms (hanging down, relaxed) */}
      <rect x="17" y="50" width="9" height="22" rx="4" fill="#5a5a6e" />
      <rect x="74" y="50" width="9" height="22" rx="4" fill="#5a5a6e" />
      {/* Hands */}
      <circle cx="21.5" cy="73" r="4.5" fill="#4a4a5c" />
      <circle cx="78.5" cy="73" r="4.5" fill="#4a4a5c" />

      {/* Legs */}
      <rect x="33" y="78" width="10" height="12" rx="3" fill="#4a4a5c" />
      <rect x="57" y="78" width="10" height="12" rx="3" fill="#4a4a5c" />
      {/* Feet */}
      <rect x="31" y="87" width="14" height="4" rx="2" fill="#3a3a4c" />
      <rect x="55" y="87" width="14" height="4" rx="2" fill="#3a3a4c" />

      <SleepingZzz x={74} y={10} />
    </svg>
  );
}

/* ── Mascot selector ──────────────────────────────────────────────── */

export function SleepingMascot({ orchestrator }: { orchestrator?: OrchestratorId }) {
  switch (orchestrator) {
    case 'claude-code':
      return <ClaudeCodeSleeping />;
    case 'copilot-cli':
      return <CopilotSleeping />;
    default:
      return <GenericRobotSleeping />;
  }
}
