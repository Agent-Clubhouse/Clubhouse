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
const AMBIENT_DOT_RADIUS = 2.5;
const AMBIENT_GLOW_STD_DEV = 2;

const ACTIVE_DOT_COUNT = 5;
const ACTIVE_DOT_DURATION = 1.4; // fast burst traversal
const ACTIVE_DOT_STAGGER = 0.3;
const ACTIVE_OPACITY = '0;1;1;0';
const ACTIVE_DOT_RADIUS = 3.5;
const ACTIVE_GLOW_STD_DEV = 3.5;

interface WireFlowDotsProps {
  wireKey: string;
  activity: WireActivityState;
  bidir?: boolean;
}

/**
 * Shared SVG filter definitions for dot glow — rendered once in <defs>,
 * referenced by all WireFlowDots via url(#wire-dot-glow-ambient/active).
 * This avoids creating a separate <feGaussianBlur> per wire (24+ filters).
 */
export function WireFlowDotFilters(): React.ReactElement {
  return (
    <>
      <filter id="wire-dot-glow-ambient">
        <feGaussianBlur stdDeviation={AMBIENT_GLOW_STD_DEV} result="blur" />
        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
      <filter id="wire-dot-glow-active">
        <feGaussianBlur stdDeviation={ACTIVE_GLOW_STD_DEV} result="blur" />
        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </>
  );
}

export const WireFlowDots = React.memo(function WireFlowDots({
  wireKey,
  activity,
  bidir,
}: WireFlowDotsProps) {
  if (activity === 'idle') return null;

  const pathId = `wire-path-${wireKey}`;

  const isActive = activity.startsWith('active');
  const dotCount = isActive ? ACTIVE_DOT_COUNT : AMBIENT_DOT_COUNT;
  const duration = isActive ? ACTIVE_DOT_DURATION : AMBIENT_DOT_DURATION;
  const stagger = isActive ? ACTIVE_DOT_STAGGER : AMBIENT_DOT_STAGGER;
  const opacityValues = isActive ? ACTIVE_OPACITY : AMBIENT_OPACITY;
  const dotRadius = isActive ? ACTIVE_DOT_RADIUS : AMBIENT_DOT_RADIUS;
  const filterId = isActive ? 'wire-dot-glow-active' : 'wire-dot-glow-ambient';
  const dotColor = bidir ? 'rgb(var(--ctp-success, 166 227 161))' : 'rgb(var(--ctp-accent, 137 180 250))';

  const showForward = activity === 'ambient' || activity === 'active-forward' || activity === 'active-both';
  const showReverse = activity === 'active-reverse' || activity === 'active-both';

  return (
    <>
      {/* Forward dots (source → target) */}
      {showForward && Array.from({ length: dotCount }, (_, i) => (
        <circle
          key={`fwd-${i}`}
          r={dotRadius}
          fill={dotColor}
          filter={`url(#${filterId})`}
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
          r={dotRadius}
          fill={dotColor}
          filter={`url(#${filterId})`}
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
