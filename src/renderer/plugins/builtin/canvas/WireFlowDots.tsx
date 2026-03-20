/**
 * WireFlowDots — animated glowing dots that travel along wire paths.
 *
 * Renders SVG circles with `<animateMotion>` + `<mpath>` referencing
 * a `<path>` defined in `<defs>` by the parent `<svg>`. Forward dots
 * travel source→target; bidirectional wires add reverse dots too.
 */

import React from 'react';

const DOT_COUNT = 3;
const DOT_DURATION = 3; // seconds per full traversal
const DOT_RADIUS = 2.5;
const DOT_STAGGER = 1; // seconds between each dot

interface WireFlowDotsProps {
  wireKey: string;
  bidir: boolean;
}

export const WireFlowDots = React.memo(function WireFlowDots({
  wireKey,
  bidir,
}: WireFlowDotsProps) {
  const pathId = `wire-path-${wireKey}`;

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
      {Array.from({ length: DOT_COUNT }, (_, i) => (
        <circle
          key={`fwd-${i}`}
          r={DOT_RADIUS}
          fill="rgb(var(--ctp-accent, 137 180 250))"
          filter={`url(#wire-dot-glow-${wireKey})`}
          data-testid={`wire-dot-fwd-${wireKey}-${i}`}
        >
          <animateMotion
            dur={`${DOT_DURATION}s`}
            repeatCount="indefinite"
            begin={`${-i * DOT_STAGGER}s`}
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
          <animate
            attributeName="opacity"
            values="0;0.8;0.8;0"
            keyTimes="0;0.1;0.9;1"
            dur={`${DOT_DURATION}s`}
            repeatCount="indefinite"
            begin={`${-i * DOT_STAGGER}s`}
          />
        </circle>
      ))}

      {/* Reverse dots (target → source) — only for bidirectional wires */}
      {bidir && Array.from({ length: DOT_COUNT }, (_, i) => (
        <circle
          key={`rev-${i}`}
          r={DOT_RADIUS}
          fill="rgb(var(--ctp-accent, 137 180 250))"
          filter={`url(#wire-dot-glow-${wireKey})`}
          data-testid={`wire-dot-rev-${wireKey}-${i}`}
        >
          <animateMotion
            dur={`${DOT_DURATION}s`}
            repeatCount="indefinite"
            begin={`${-i * DOT_STAGGER}s`}
            keyPoints="1;0"
            keyTimes="0;1"
            calcMode="linear"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
          <animate
            attributeName="opacity"
            values="0;0.8;0.8;0"
            keyTimes="0;0.1;0.9;1"
            dur={`${DOT_DURATION}s`}
            repeatCount="indefinite"
            begin={`${-i * DOT_STAGGER}s`}
          />
        </circle>
      ))}
    </>
  );
});
