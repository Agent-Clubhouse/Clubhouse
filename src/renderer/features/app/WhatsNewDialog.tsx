import { useMemo, useCallback } from 'react';
import { useUpdateStore } from '../../stores/updateStore';
import { renderMarkdownSafe } from '../../utils/safe-markdown';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';

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
      title={`What's new in v${whatsNew?.version}`}
      width="w-[520px]"
      backdropTestId="whats-new-backdrop"
      testId="whats-new-dialog"
      footer={<Button kind="primary" onClick={handleDismiss} data-testid="whats-new-got-it">Got it</Button>}
    >
      <div className="overflow-y-auto max-h-[50vh]">
        <div
          className="help-content"
          dangerouslySetInnerHTML={{ __html: html ?? '' }}
        />
      </div>
    </Modal>
  );
}
