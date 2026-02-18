import { useEffect, useMemo, useCallback } from 'react';
import { marked } from 'marked';
import { useUpdateStore } from '../../stores/updateStore';

export function WhatsNewDialog() {
  const whatsNew = useUpdateStore((s) => s.whatsNew);
  const showWhatsNew = useUpdateStore((s) => s.showWhatsNew);
  const dismissWhatsNew = useUpdateStore((s) => s.dismissWhatsNew);

  const html = useMemo(() => {
    if (!whatsNew?.releaseNotes) return null;
    return marked.parse(whatsNew.releaseNotes, { async: false }) as string;
  }, [whatsNew?.releaseNotes]);

  const handleDismiss = useCallback(() => {
    dismissWhatsNew();
  }, [dismissWhatsNew]);

  // Escape key support
  useEffect(() => {
    if (!showWhatsNew) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showWhatsNew, handleDismiss]);

  if (!showWhatsNew || !whatsNew || !html) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      data-testid="whats-new-backdrop"
      onClick={handleDismiss}
    >
      <div
        className="bg-ctp-mantle rounded-xl w-[520px] max-h-[70vh] flex flex-col shadow-xl"
        data-testid="whats-new-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-ctp-surface0">
          <h2 className="text-lg font-semibold text-ctp-text">
            What&apos;s New in v{whatsNew.version}
          </h2>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          <div
            className="help-content"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-ctp-surface0 flex justify-end">
          <button
            onClick={handleDismiss}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
            data-testid="whats-new-got-it"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
