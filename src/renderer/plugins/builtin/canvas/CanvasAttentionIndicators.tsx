import React from 'react';
import type { OffScreenIndicator, OffScreenDirection } from './canvas-attention';

interface CanvasAttentionIndicatorsProps {
  indicators: OffScreenIndicator[];
  onNavigate: (viewId: string) => void;
}

/** Arrow rotation for each off-screen direction (degrees, 0 = pointing up). */
const ARROW_ROTATION: Record<OffScreenDirection, number> = {
  'top': 0,
  'top-right': 45,
  'right': 90,
  'bottom-right': 135,
  'bottom': 180,
  'bottom-left': 225,
  'left': 270,
  'top-left': 315,
};

export function CanvasAttentionIndicators({ indicators, onNavigate }: CanvasAttentionIndicatorsProps) {
  if (indicators.length === 0) return null;

  return (
    <>
      {indicators.map((ind) => {
        const isError = ind.attention.level === 'error';
        const rotation = ARROW_ROTATION[ind.direction];

        return (
          <button
            key={ind.viewId}
            className="absolute z-[9998] flex items-center justify-center group"
            style={{
              left: ind.screenX,
              top: ind.screenY,
              transform: 'translate(-50%, -50%)',
            }}
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(ind.viewId);
            }}
            title={ind.attention.message}
            data-testid={`canvas-offscreen-${ind.viewId}`}
          >
            {/* Bubble */}
            <div
              className={`
                w-8 h-8 rounded-full flex items-center justify-center
                shadow-lg cursor-pointer transition-transform
                group-hover:scale-110
                ${isError
                  ? 'bg-red-500/90 hover:bg-red-500'
                  : 'bg-yellow-500/90 hover:bg-yellow-500'
                }
              `}
            >
              {/* Arrow pointing toward the off-screen card */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-ctp-crust"
                style={{ transform: `rotate(${rotation}deg)` }}
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </div>
          </button>
        );
      })}
    </>
  );
}
