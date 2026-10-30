/**
 * A PDF in the file preview popover (rich chat content, #2478): page 1 first,
 * then previous and next with the page count. pdf.js loads on first use.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/Button';
import type { OpenedPdf } from './pdf-document';
import { loadPdfDocument } from './pdf-loader';

/** Room for the page inside the popover body, in CSS pixels. */
const PAGE_W = 536;
const PAGE_H = 300;

export function PdfPreview({ data }: { data: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<OpenedPdf | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: OpenedPdf | undefined;
    setPdf(null);
    setPage(1);
    setError(null);
    loadPdfDocument().then(({ openPdf }) => openPdf(data)).then(
      (doc) => { if (cancelled) doc.close(); else { opened = doc; setPdf(doc); } },
      // telemetry-exempt: shown in the preview.
      (err: unknown) => { if (!cancelled) setError(err instanceof Error && err.message === 'password' ? 'This PDF is password protected.' : "Couldn't read this PDF."); },
    );
    return () => { cancelled = true; opened?.close(); };
  }, [data]);

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    const width = Math.min(PAGE_W, canvas.current.parentElement?.clientWidth || PAGE_W);
    const render = pdf.renderPage(page, canvas.current, width, PAGE_H);
    // telemetry-exempt: a page that won't draw says so; cancelling on page change rejects too.
    render.done.catch((err: unknown) => { if (!(err instanceof Error && err.name === 'RenderingCancelledException')) setError("Couldn't draw this page."); });
    return () => render.cancel();
  }, [pdf, page]);

  if (error) return <div className="p-4 text-[12.5px] text-ctp-subtext0 flex-1" data-testid="chat-file-preview-pdf-error">{error}</div>;
  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="chat-file-preview-pdf">
      <div className="flex-1 min-h-0 flex items-center justify-center bg-ctp-crust p-2 overflow-hidden">
        {pdf ? <canvas ref={canvas} aria-label={`Page ${page} of ${pdf.numPages}`} /> : <span className="text-[12.5px] text-ctp-overlay1">Loading…</span>}
      </div>
      {pdf && pdf.numPages > 1 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-t border-surface-0 text-[11.5px] text-ctp-overlay1">
          <Button kind="quiet" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
          <span data-testid="chat-file-preview-pdf-page">Page {page} of {pdf.numPages}</span>
          <Button kind="quiet" disabled={page >= pdf.numPages} onClick={() => setPage((p) => Math.min(pdf.numPages, p + 1))}>Next</Button>
        </div>
      )}
      {pdf && pdf.numPages === 1 && <div className="px-3 py-1.5 border-t border-surface-0 text-[11.5px] text-ctp-overlay1" data-testid="chat-file-preview-pdf-page">1 page</div>}
    </div>
  );
}
