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
  const bodyColor = '#d4896b';
  const legColor = '#be7a5e';

  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      {/* Ground shadow */}
      <ellipse cx="50" cy="90" rx="30" ry="3" fill="#181825" opacity="0.3" />

      {/* Ears / top bumps */}
      <rect x="20" y="20" width="12" height="10" rx="2" fill={bodyColor} />
      <rect x="68" y="20" width="12" height="10" rx="2" fill={bodyColor} />

      {/* Main body — wide blocky rectangle */}
      <rect x="20" y="27" width="60" height="38" rx="3" fill={bodyColor} />

      {/* Arms — stubs on sides */}
      <rect x="10" y="36" width="10" height="14" rx="3" fill={bodyColor} />
      <rect x="80" y="36" width="10" height="14" rx="3" fill={bodyColor} />

      {/* Sleeping eyes — peaceful closed arcs */}
      <path
        d="M 34 42 Q 38 37 42 42"
        stroke="#2a1f1a"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 58 42 Q 62 37 66 42"
        stroke="#2a1f1a"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />

      {/* Subtle blush */}
      <circle cx="30" cy="48" r="4" fill="#e88" opacity="0.15" />
      <circle cx="70" cy="48" r="4" fill="#e88" opacity="0.15" />

      {/* Legs — 4 legs in 2 pairs */}
      <rect x="24" y="65" width="9" height="14" rx="2" fill={legColor} />
      <rect x="35" y="65" width="9" height="14" rx="2" fill={legColor} />
      <rect x="56" y="65" width="9" height="14" rx="2" fill={legColor} />
      <rect x="67" y="65" width="9" height="14" rx="2" fill={legColor} />

      <SleepingZzz x={80} y={16} />
    </svg>
  );
}

/* ── GitHub Copilot mascot ────────────────────────────────────────── */

export function CopilotSleeping() {
  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      <defs>
        <linearGradient id="copilotHelmetGrad" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#26D9C4" />
          <stop offset="50%" stopColor="#1ABFAE" />
          <stop offset="100%" stopColor="#0FA898" />
        </linearGradient>
        <linearGradient id="copilotVisorGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#B8C8D8" />
          <stop offset="100%" stopColor="#98A8B8" />
        </linearGradient>
      </defs>

      {/* Ground shadow */}
      <ellipse cx="50" cy="88" rx="28" ry="3" fill="#181825" opacity="0.3" />

      {/* Helmet dome — teal rounded spaceman helmet */}
      <ellipse cx="50" cy="38" rx="36" ry="30" fill="url(#copilotHelmetGrad)" />

      {/* Helmet highlight — specular reflection */}
      <ellipse cx="40" cy="20" rx="18" ry="8" fill="#4EEEDE" opacity="0.25" />

      {/* Ear covers — communication headset style */}
      <rect x="6" y="34" width="12" height="18" rx="5" fill="#1ABFAE" stroke="#16A89A" strokeWidth="1" />
      <rect x="82" y="34" width="12" height="18" rx="5" fill="#1ABFAE" stroke="#16A89A" strokeWidth="1" />
      {/* Ear cover inner detail — speaker grille */}
      <rect x="9" y="38" width="6" height="10" rx="3" fill="#128F82" />
      <rect x="85" y="38" width="6" height="10" rx="3" fill="#128F82" />
      {/* Ear cover accent lines */}
      <line x1="11" y1="40" x2="13" y2="40" stroke="#0E7A6E" strokeWidth="0.8" />
      <line x1="11" y1="43" x2="13" y2="43" stroke="#0E7A6E" strokeWidth="0.8" />
      <line x1="11" y1="46" x2="13" y2="46" stroke="#0E7A6E" strokeWidth="0.8" />
      <line x1="87" y1="40" x2="89" y2="40" stroke="#0E7A6E" strokeWidth="0.8" />
      <line x1="87" y1="43" x2="89" y2="43" stroke="#0E7A6E" strokeWidth="0.8" />
      <line x1="87" y1="46" x2="89" y2="46" stroke="#0E7A6E" strokeWidth="0.8" />


      {/* Goggles on forehead — pushed up */}
      <rect x="22" y="16" width="22" height="16" rx="7" fill="#5AB8E8" stroke="#4AA8D8" strokeWidth="1.5" />
      <rect x="56" y="16" width="22" height="16" rx="7" fill="#5AB8E8" stroke="#4AA8D8" strokeWidth="1.5" />
      {/* Goggle bridge */}
      <rect x="44" y="21" width="12" height="6" rx="3" fill="#5AB8E8" />

      {/* Goggle lenses — reflective blue */}
      <rect x="25" y="19" width="16" height="10" rx="5" fill="#2060A0" />
      <rect x="59" y="19" width="16" height="10" rx="5" fill="#2060A0" />
      {/* Goggle lens reflection */}
      <rect x="27" y="20" width="6" height="4" rx="2" fill="#4090D0" opacity="0.4" />
      <rect x="61" y="20" width="6" height="4" rx="2" fill="#4090D0" opacity="0.4" />

      {/* Open face visor — lighter panel where eyes are visible */}
      <rect x="22" y="38" width="56" height="30" rx="10" fill="url(#copilotVisorGrad)" />

      {/* Visor inner shadow */}
      <rect x="24" y="40" width="52" height="26" rx="8" fill="#8898A8" opacity="0.3" />

      {/* Visor top edge highlight */}
      <rect x="28" y="38" width="44" height="1.5" rx="0.75" fill="#D0DDE8" opacity="0.5" />

      {/* Closed eyes — simple dark slits */}
      <line x1="31" y1="52" x2="45" y2="52" stroke="#0a1830" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="55" y1="52" x2="69" y2="52" stroke="#0a1830" strokeWidth="2.5" strokeLinecap="round" />


      <SleepingZzz x={78} y={8} />
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

/* ── Codex CLI mascot ────────────────────────────────────────────── */

export function CodexCliSleeping() {
  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      {/* Ground shadow */}
      <ellipse cx="50" cy="90" rx="18" ry="2.5" fill="#181825" opacity="0.3" />

      {/* Arms — smooth leaf/paddle shapes, behind body */}
      <ellipse cx="20" cy="60" rx="7" ry="18" transform="rotate(-12, 20, 60)" fill="#D0D0D8" />
      <ellipse cx="80" cy="60" rx="7" ry="18" transform="rotate(12, 80, 60)" fill="#D0D0D8" />

      {/* Body — tapered cup shape (wide top, narrow bottom) */}
      <path
        d="M 30 46 Q 30 44 32 44 L 68 44 Q 70 44 70 46 L 63 82 Q 61 88 50 88 Q 39 88 37 82 Z"
        fill="#E0E0E8"
      />

      {/* Body highlight */}
      <path
        d="M 33 46 L 67 46 L 65 52 L 35 52 Z"
        fill="#EAEAF0"
        opacity="0.4"
      />

      {/* Head — smooth oval */}
      <ellipse cx="50" cy="28" rx="24" ry="20" fill="#E8E8EC" />

      {/* Head highlight */}
      <ellipse cx="44" cy="18" rx="14" ry="8" fill="#F0F0F6" opacity="0.35" />

      {/* Visor / face panel */}
      <ellipse cx="50" cy="32" rx="18" ry="12" fill="#0a0a14" />

      {/* Sleeping eyes — dim blue crescents */}
      <ellipse cx="40" cy="34" rx="5" ry="3" fill="#3a6a9a" opacity="0.4" />
      <ellipse cx="60" cy="34" rx="5" ry="3" fill="#3a6a9a" opacity="0.4" />
      {/* Eyelid overlay — visor covers top of eye */}
      <ellipse cx="40" cy="32" rx="5.5" ry="3" fill="#0a0a14" />
      <ellipse cx="60" cy="32" rx="5.5" ry="3" fill="#0a0a14" />

      {/* Codex indigo accent at neck */}
      <rect x="36" y="43" width="28" height="1.5" rx="0.75" fill="#6B6BDE" opacity="0.25" />

      {/* Codex terminal prompt on chest >_ */}
      <path d="M 44 60 L 48 63 L 44 66" stroke="#9898B0" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" />
      <line x1="50" y1="66" x2="56" y2="66" stroke="#9898B0" strokeWidth="1.2" strokeLinecap="round" opacity="0.35" />

      <SleepingZzz x={68} y={8} />
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
    case 'codex-cli':
      return <CodexCliSleeping />;
    default:
      return <GenericRobotSleeping />;
  }
}
