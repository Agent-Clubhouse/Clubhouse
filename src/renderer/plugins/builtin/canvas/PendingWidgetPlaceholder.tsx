import React, { useCallback, useEffect, useState } from 'react';
import { Spinner } from '../../../components/Spinner';
import { usePluginStore } from '../../plugin-store';
import { retryPluginActivation } from '../../plugin-loader';

/**
 * How long a plugin widget may sit on the loading placeholder before we treat
 * it as stuck. Activation normally completes in well under a second; anything
 * past this is a hung IPC call or a failed activation, and silently spinning
 * forever gives the user nothing to act on.
 */
export const PENDING_WIDGET_TIMEOUT_MS = 15_000;

interface PendingWidgetPlaceholderProps {
  /** Plugin that owns the widget — used to re-dispatch activation. */
  pluginId: string;
  /** Human-readable widget label, when known. */
  label?: string;
  /** Override the stuck threshold (tests). */
  timeoutMs?: number;
}

/**
 * Loading placeholder for a plugin canvas widget whose plugin has not finished
 * activating. Falls back to an error state with a retry affordance once the
 * plugin has clearly failed to come up.
 */
export function PendingWidgetPlaceholder({
  pluginId,
  label,
  timeoutMs = PENDING_WIDGET_TIMEOUT_MS,
}: PendingWidgetPlaceholderProps): React.ReactElement {
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryUnavailable, setRetryUnavailable] = useState(false);

  const pluginStatus = usePluginStore((s) => s.plugins[pluginId]?.status);
  const pluginError = usePluginStore((s) => s.plugins[pluginId]?.error);

  // Restart the clock on each retry so the spinner gets another full window.
  useEffect(() => {
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [pluginId, timeoutMs, attempt]);

  const handleRetry = useCallback(() => {
    const dispatched = retryPluginActivation(pluginId);
    setRetryUnavailable(!dispatched);
    if (dispatched) setAttempt((n) => n + 1);
  }, [pluginId]);

  // An errored plugin is terminal for this render — surface it immediately
  // rather than waiting out the timeout.
  const isStuck = timedOut || pluginStatus === 'errored';

  if (!isStuck) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-2 text-ctp-overlay0 text-xs p-4 text-center"
        data-testid="widget-loading"
      >
        {label && <span className="font-medium text-ctp-subtext0">{label}</span>}
        <Spinner size="sm" />
        <span>Loading&hellip;</span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-2 text-ctp-overlay0 text-xs p-4 text-center"
      data-testid="widget-load-failed"
    >
      {label && <span className="font-medium text-ctp-subtext0">{label}</span>}
      <span>{label || 'This widget'} failed to load.</span>
      {pluginError && (
        <span className="text-ctp-overlay0/80 line-clamp-2" title={pluginError}>
          {pluginError.split('\n')[0]}
        </span>
      )}
      <button
        type="button"
        onClick={handleRetry}
        className="px-2 py-1 rounded border border-ctp-surface2 text-ctp-subtext0 hover:bg-ctp-surface0 transition-colors"
        data-testid="widget-load-retry"
      >
        Retry
      </button>
      {retryUnavailable && (
        <span data-testid="widget-retry-unavailable">
          Could not restart the plugin — try re-enabling it in settings.
        </span>
      )}
    </div>
  );
}
