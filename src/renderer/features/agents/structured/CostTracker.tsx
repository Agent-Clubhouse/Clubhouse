import { useState } from 'react';
import type { UsageEvent } from '../../../../shared/structured-events';

interface Props {
  usage: UsageEvent;
}

/**
 * Compact token usage and cost display.
 * Shows "up inputTokens down outputTokens • $cost" with tooltip breakdown.
 */
export function CostTracker({ usage }: Props) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      className="relative inline-flex items-center gap-1.5 text-[10px] text-ctp-subtext0 tabular-nums"
      data-testid="cost-tracker"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span title="Input tokens">&#8593; {formatTokens(usage.inputTokens)}</span>
      <span title="Output tokens">&#8595; {formatTokens(usage.outputTokens)}</span>
      {usage.costUsd != null && (
        <>
          <span className="text-ctp-subtext0/40">|</span>
          <span>${usage.costUsd.toFixed(4)}</span>
        </>
      )}

      {/* Tooltip breakdown */}
      {showTooltip && (
        <div className="absolute bottom-full left-0 mb-1 bg-ctp-crust border border-surface-0 rounded px-2 py-1.5 text-[10px] text-ctp-subtext1 shadow-lg whitespace-nowrap z-10">
          <div>Input: {usage.inputTokens.toLocaleString()}</div>
          <div>Output: {usage.outputTokens.toLocaleString()}</div>
          {usage.cacheReadTokens != null && (
            <div>Cache Read: {usage.cacheReadTokens.toLocaleString()}</div>
          )}
          {usage.cacheWriteTokens != null && (
            <div>Cache Write: {usage.cacheWriteTokens.toLocaleString()}</div>
          )}
          {usage.costUsd != null && (
            <div className="border-t border-surface-0 mt-1 pt-1">
              Cost: ${usage.costUsd.toFixed(4)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
