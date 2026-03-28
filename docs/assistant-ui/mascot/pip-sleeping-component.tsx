/**
 * Pip sleeping mascot — ready to add to SleepingMascots.tsx
 *
 * DESIGN SPEC — NOT PRODUCTION CODE
 * This is a reference implementation for coding agents to integrate.
 * Follows exact patterns from existing SleepingMascots.tsx:
 * - 200×200 SVG, 100×100 viewBox
 * - Uses shared SleepingZzz component
 * - drop-shadow-lg class
 * - Ground shadow ellipse
 *
 * Integration: Add to SleepingMascot selector for orchestrator === 'assistant'
 * or as default when the assistant agent type is detected.
 */

export function AssistantSleeping() {
  return (
    <svg width="200" height="200" viewBox="0 0 100 100" className="drop-shadow-lg">
      <defs>
        <linearGradient id="pipSleepBodyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9aa5c4" />
          <stop offset="100%" stopColor="#6c7086" />
        </linearGradient>
        <radialGradient id="pipSleepCoreGrad" cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#a6adc8" />
          <stop offset="100%" stopColor="#6c7086" stopOpacity="0.4" />
        </radialGradient>
      </defs>

      {/* Ground shadow */}
      <ellipse cx="50" cy="92" rx="18" ry="3.5" fill="#181825" opacity="0.4" />

      {/* Legs — relaxed */}
      <rect x="39" y="80" width="7" height="8" rx="3" fill="#585b70" />
      <rect x="54" y="80" width="7" height="8" rx="3" fill="#585b70" />

      {/* Body */}
      <rect x="33" y="55" width="34" height="28" rx="12" fill="url(#pipSleepBodyGrad)" />
      {/* Body highlight */}
      <rect x="37" y="57" width="10" height="3" rx="1.5" fill="#a6adc8" opacity="0.3" />

      {/* Core — dim */}
      <circle cx="50" cy="68" r="6" fill="url(#pipSleepCoreGrad)" />
      <circle cx="50" cy="68" r="3" fill="#bac2de" opacity="0.3" />

      {/* Arms — drooped down */}
      <ellipse cx="27" cy="67" rx="5" ry="3.5" fill="#6c7086" />
      <ellipse cx="73" cy="67" rx="5" ry="3.5" fill="#6c7086" />
      {/* Hands */}
      <circle cx="23" cy="67" r="3" fill="#7f849c" />
      <circle cx="77" cy="67" r="3" fill="#7f849c" />

      {/* Head — slightly tilted */}
      <g transform="rotate(-3 50 36)">
        {/* Head dome */}
        <ellipse cx="50" cy="36" rx="22" ry="22" fill="url(#pipSleepBodyGrad)" />
        {/* Head highlight */}
        <ellipse cx="43" cy="22" rx="10" ry="5" fill="#a6adc8" opacity="0.2" />

        {/* Antenna — dim */}
        <rect x="49" y="12" width="2" height="5" rx="1" fill="#585b70" />
        <circle cx="50" cy="10" r="2.5" fill="#6c7086" />
        <circle cx="50" cy="10" r="1.2" fill="#7f849c" opacity="0.4" />

        {/* Eyes — closed arcs (matching existing mascot pattern) */}
        <path
          d="M 36 36 Q 41 39 46 36"
          stroke="#313244"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M 54 36 Q 59 39 64 36"
          stroke="#313244"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
        />

        {/* Mouth — peaceful line */}
        <path
          d="M 46 44 Q 50 46 54 44"
          stroke="#313244"
          strokeWidth="1"
          fill="none"
          strokeLinecap="round"
        />

        {/* Blush — faint */}
        <circle cx="34" cy="41" r="3.5" fill="#f472b6" opacity="0.08" />
        <circle cx="66" cy="41" r="3.5" fill="#f472b6" opacity="0.08" />
      </g>

      <SleepingZzz x={68} y={22} />
    </svg>
  );
}
