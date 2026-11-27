import { useEffect, useMemo } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { renderMarkdownSafe } from '../../utils/safe-markdown';
import { SettingsPage, settingsHelp } from './SettingsLayout';
import { Button } from '../../components/Button';
import { openWelcomeTour } from '../welcome-tour/welcomeTourStore';

export function WhatsNewSettingsView() {
  const markdown = useUpdateStore((s) => s.versionHistoryMarkdown);
  const loading = useUpdateStore((s) => s.versionHistoryLoading);
  const error = useUpdateStore((s) => s.versionHistoryError);
  const loadVersionHistory = useUpdateStore((s) => s.loadVersionHistory);

  useEffect(() => {
    loadVersionHistory();
  }, [loadVersionHistory]);

  const html = useMemo(() => {
    if (!markdown) return null;
    return renderMarkdownSafe(markdown);
  }, [markdown]);

  return (
    <SettingsPage
      title="What's new"
      description="Release notes for recent versions of Clubhouse."
      testId="whats-new-settings"
    >
      <div className="mt-[22px] flex items-center gap-3">
        <Button data-testid="whats-new-welcome-tour" onClick={() => void openWelcomeTour()}>Show the welcome tour</Button>
        <span className={settingsHelp}>A short tour of what&apos;s new in 1.0. It changes nothing.</span>
      </div>
      <div className="mt-[22px] pt-3 border-t border-surface-0">
        {loading && (
          <div className={settingsHelp} data-testid="whats-new-loading">
            Loading version history…
          </div>
        )}

        {error && (
          <div className="text-xs text-ctp-error" data-testid="whats-new-error">
            Couldn&apos;t load version history. {error}
          </div>
        )}

        {!loading && !error && !html && (
          <div className={settingsHelp} data-testid="whats-new-empty">
            No version history available.
          </div>
        )}

        {!loading && html && (
          <div
            className="help-content"
            data-testid="whats-new-content"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </SettingsPage>
  );
}
