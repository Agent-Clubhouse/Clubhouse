import { useMemo, useCallback } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { renderMarkdownSafe } from '../../utils/safe-markdown';
import { Modal } from '../../components/Modal';

export function WhatsNewDialog() {
  const whatsNew = useUpdateStore((s) => s.whatsNew);
  const showWhatsNew = useUpdateStore((s) => s.showWhatsNew);
  const dismissWhatsNew = useUpdateStore((s) => s.dismissWhatsNew);

  const html = useMemo(() => {
    if (!whatsNew?.releaseNotes) return null;
    return renderMarkdownSafe(whatsNew.releaseNotes);
  }, [whatsNew?.releaseNotes]);

  const handleDismiss = useCallback(() => {
    dismissWhatsNew();
  }, [dismissWhatsNew]);

  return (
    <Modal
      open={!!showWhatsNew && !!whatsNew && !!html}
      onClose={handleDismiss}
      width="w-[520px]"
      backdropTestId="whats-new-backdrop"
    >
      <div data-testid="whats-new-dialog">
        {/* Header */}
        <div className="-mx-5 -mt-5 px-6 pt-5 pb-3 border-b border-surface-0 mb-4">
          <h2 className="text-lg font-semibold text-ctp-text">
            What&apos;s New in v{whatsNew?.version}
          </h2>
        </div>

        {/* Body */}
        <div className="-mx-5 px-6 overflow-y-auto max-h-[50vh]">
          <div
            className="help-content"
            dangerouslySetInnerHTML={{ __html: html ?? '' }}
          />
        </div>

        {/* Footer */}
        <div className="-mx-5 -mb-5 px-6 py-4 border-t border-surface-0 flex justify-end mt-4">
          <button
            onClick={handleDismiss}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-ctp-accent hover:bg-ctp-accent/80 text-white transition-colors cursor-pointer"
            data-testid="whats-new-got-it"
          >
            Got it
          </button>
        </div>
      </div>
    </Modal>
  );
}
