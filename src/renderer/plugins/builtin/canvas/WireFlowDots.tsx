/**
 * WireFlowDots — animated glowing dots that travel along wire paths.
 *
 * Renders SVG circles with `<animateMotion>` + `<mpath>` referencing
 * a `<path>` defined in `<defs>` by the parent `<svg>`.
 *
 * Supports three visual modes:
 * - **ambient**: slow, dim dots (both endpoints alive, no traffic)
 * - **active**: fast, bright dots in the direction of actual communication
 * - **idle**: no dots (one or both endpoints dead)
 */

import React from 'react';
import type { WireActivityState } from './useWireActivity';

// ── Animation parameters per mode ───────────────────────────────────

const AMBIENT_DOT_COUNT = 2;
const AMBIENT_DOT_DURATION = 6; // slow traversal
const AMBIENT_DOT_STAGGER = 3;
const AMBIENT_OPACITY = '0;0.3;0.3;0';

const ACTIVE_DOT_COUNT = 3;
const ACTIVE_DOT_DURATION = 2; // fast traversal
const ACTIVE_DOT_STAGGER = 0.7;
const ACTIVE_OPACITY = '0;0.9;0.9;0';

const DOT_RADIUS = 2.5;

interface WireFlowDotsProps {
  wireKey: string;
  activity: WireActivityState;
}

export const WireFlowDots = React.memo(function WireFlowDots({
  wireKey,
  activity,
}: WireFlowDotsProps) {
  if (activity === 'idle') return null;

  const pathId = `wire-path-${wireKey}`;

  const isActive = activity.startsWith('active');
  const dotCount = isActive ? ACTIVE_DOT_COUNT : AMBIENT_DOT_COUNT;
  const duration = isActive ? ACTIVE_DOT_DURATION : AMBIENT_DOT_DURATION;
  const stagger = isActive ? ACTIVE_DOT_STAGGER : AMBIENT_DOT_STAGGER;
  const opacityValues = isActive ? ACTIVE_OPACITY : AMBIENT_OPACITY;

  const showForward = activity === 'ambient' || activity === 'active-forward' || activity === 'active-both';
  const showReverse = activity === 'active-reverse' || activity === 'active-both';

  return (
    <>
      {/* Glow filter for dots */}
      <filter id={`wire-dot-glow-${wireKey}`}>
        <feGaussianBlur stdDeviation="2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>

      {/* Forward dots (source → target) */}
      {showForward && Array.from({ length: dotCount }, (_, i) => (
        <circle
          key={`fwd-${i}`}
          r={DOT_RADIUS}
          fill="rgb(var(--ctp-accent, 137 180 250))"
          filter={`url(#wire-dot-glow-${wireKey})`}
          data-testid={`wire-dot-fwd-${wireKey}-${i}`}
        >
          <animateMotion
            dur={`${duration}s`}
            repeatCount="indefinite"
            begin={`${-i * stagger}s`}
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
          <animate
            attributeName="opacity"
            values={opacityValues}
            keyTimes="0;0.1;0.9;1"
            dur={`${duration}s`}
            repeatCount="indefinite"
            begin={`${-i * stagger}s`}
          />
        </circle>
      ))}

      {/* Reverse dots (target → source) */}
      {showReverse && Array.from({ length: dotCount }, (_, i) => (
        <circle
          key={`rev-${i}`}
          r={DOT_RADIUS}
          fill="rgb(var(--ctp-accent, 137 180 250))"
          filter={`url(#wire-dot-glow-${wireKey})`}
          data-testid={`wire-dot-rev-${wireKey}-${i}`}
        >
          <animateMotion
            dur={`${duration}s`}
            repeatCount="indefinite"
            begin={`${-i * stagger}s`}
            keyPoints="1;0"
            keyTimes="0;1"
            calcMode="linear"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
          <animate
            attributeName="opacity"
            values={opacityValues}
            keyTimes="0;0.1;0.9;1"
            dur={`${duration}s`}
            repeatCount="indefinite"
            begin={`${-i * stagger}s`}
          />
        </circle>
      ))}
    </>
  );
});
