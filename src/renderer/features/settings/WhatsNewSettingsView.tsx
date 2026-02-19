import { useEffect, useMemo } from 'react';
import { marked } from 'marked';
import { useUpdateStore } from '../../stores/updateStore';

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
    return marked.parse(markdown, { async: false }) as string;
  }, [markdown]);

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="whats-new-settings">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">What&apos;s New</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          Release notes for recent versions of Clubhouse.
        </p>

        {loading && (
          <div className="text-sm text-ctp-subtext0" data-testid="whats-new-loading">
            Loading version history...
          </div>
        )}

        {error && (
          <div className="text-sm text-red-400" data-testid="whats-new-error">
            Failed to load version history: {error}
          </div>
        )}

        {!loading && !error && !html && (
          <div className="text-sm text-ctp-subtext0" data-testid="whats-new-empty">
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
    </div>
  );
}
