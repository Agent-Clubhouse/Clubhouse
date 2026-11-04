import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Modal } from '../../components/Modal';
import { FEEDBACK_DIAGNOSTICS, type FeedbackCaptureResult, type FeedbackDiagnosticLine, type FeedbackDiagnosticsOutcome, type FeedbackShot, type FeedbackStatus } from '../../../shared/feedback-types';
import { savedReportsNeedSend, useFeedbackStore, type FeedbackReopened } from '../../stores/feedbackStore';
import { useUIStore } from '../../stores/uiStore';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { sendFields, useEditorPreview, useScreenshotEditorModel, type EditorOptions } from './pilot-editor';
import { pilotHooks } from './pilot-hooks';
import { FEEDBACK_COPY, logsControl, type LogsFacts } from './pilot-vendor/feedback-copy.mjs';
import { mountScreenshotEditor, renderMarks, type ScreenshotEditorModel, type ScreenshotEditorState, type ScreenshotPreview } from './pilot-vendor/screenshot-editor.mjs';
import { ScreenshotAnnotator } from './ScreenshotAnnotator';

interface Props {
  draft: FeedbackCaptureResult;
  /** Set when this draft replaced one whose enrollment changed: what it keeps. */
  reopened?: FeedbackReopened | null;
  onClose: () => void;
  /** Pilot: tests inject a raster, as jsdom has no canvas or createImageBitmap. */
  editorOptions?: EditorOptions;
}

type Phase = 'review' | 'sending' | 'saved';

/** A scene code for the report: the current Clubhouse tab, never user text. */
function currentScene(): string {
  const tab = useUIStore.getState().explorerTab;
  return typeof tab === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(tab) ? tab : 'app';
}

/** The windows captured, falling back to the single preview from an older main. */
function shotsOf(draft: FeedbackCaptureResult): FeedbackShot[] {
  if (draft.shots?.length) return draft.shots;
  return draft.preview ? [{ shotId: '', label: 'This window', preview: draft.preview }] : [];
}

/** One diagnostic line as the reporter reads it: every field that would be sent. */
function diagnosticLineText(line: FeedbackDiagnosticLine): string {
  const attrs = Object.entries(line.attrs ?? {}).map(([key, value]) => `${key}=${value}`).join(' ');
  return `${new Date(line.at).toLocaleTimeString()} ${line.level} ${line.ns} ${line.event}${attrs && ` ${attrs}`}`;
}

const NO_DIAGNOSTICS_TEXT = {
  no_lines: 'No recent diagnostics to include.',
  collection_failed: 'Recent diagnostics could not be read, so none are included.',
  no_review: 'No diagnostics were reviewed for this report, so none are included.',
  not_connected: 'Diagnostics weren\'t queued because feedback isn\'t connected.',
} as const;

function diagnosticsOutcomeText(outcome: FeedbackDiagnosticsOutcome): string {
  if (outcome.status === 'attached') return `Diagnostics attached to this report (${outcome.lines} ${outcome.lines === 1 ? 'line' : 'lines'}).`;
  if (outcome.status === 'queued') return `Diagnostics queued to send (${outcome.lines} ${outcome.lines === 1 ? 'line' : 'lines'}).`;
  return outcome.status === 'left_out' ? 'Diagnostics left out.' : NO_DIAGNOSTICS_TEXT[outcome.reason];
}

/** Clubhouse's true facts for the logs control. Whether diagnostics are in the report is main's to say. */
function logsFacts(draft: FeedbackCaptureResult, checked: boolean): LogsFacts {
  return {
    attach: draft.diagnostics?.status === 'available' ? 'report-lines' : 'none',
    available: draft.diagnostics?.status === 'available',
    // Telemetry is off unless turned on in Settings, and an unticked box sends no marker (feedback-service.ts sendExcerpt).
    automatic: 'separate-consent',
    marker: false,
    checked,
    lines: draft.diagnosticsInReport
      ? { delivery: 'in-report' }
      : { delivery: 'separate', lostOnQuit: true, retention: `They are kept for ${FEEDBACK_DIAGNOSTICS.retentionDays} days, even if the report is deleted.` },
  };
}

/** The selected view with its marks, at the size it's shown: a full-size canvas would hold a second copy of the image. */
function ComposerPreview({ frame, snapshot, onOpen, disabled }: { frame: ScreenshotPreview | null; snapshot: ScreenshotEditorState; onOpen: () => void; disabled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !context || !frame) return;
    const scale = Math.min(1, 520 / frame.width, 300 / frame.height);
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
    if (frame.draw(context)) renderMarks(context, snapshot.marks, { width: frame.width, height: frame.height });
  }, [frame, snapshot.marks]);
  return (
    <button type="button" onClick={onOpen} disabled={disabled || !frame} aria-label="Open the screenshot editor" className="block mx-auto rounded-md border border-surface-0 focus-ring disabled:cursor-default" data-testid="pilot-edit-react">
      <canvas ref={ref} className="block max-w-full max-h-[300px]" data-testid="feedback-preview" />
    </button>
  );
}

/** The SDK's ready-made view inside the app's Modal, for comparing. Its theme comes through custom properties. */
function MountedEditor({ model, carriedOver, onClose }: { model: ScreenshotEditorModel; carriedOver: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // No API says a fresh model's edits are final, so a reopened draft swaps the words instead.
    const copy = carriedOver ? { ...FEEDBACK_COPY, confirm: { ...FEEDBACK_COPY.confirm, clearReversible: FEEDBACK_COPY.confirm.clearFinal } } : FEEDBACK_COPY;
    const view = mountScreenshotEditor(ref.current!, { model, copy, onDone: () => close.current(), onCancel: () => close.current() });
    return () => view.destroy();
  }, [model, carriedOver]);
  return (
    <div
      ref={ref}
      data-testid="pilot-mounted-slot"
      style={{
        '--feedback-editor-background': 'rgb(var(--ctp-base))',
        '--feedback-editor-text': 'rgb(var(--ctp-text))',
        '--feedback-editor-panel': 'rgb(var(--ctp-mantle))',
        '--feedback-editor-stage': 'rgb(var(--ctp-crust))',
        '--feedback-editor-accent': 'rgb(var(--ctp-accent))',
        '--feedback-editor-on-accent': 'rgb(var(--ctp-crust))',
        '--feedback-editor-button': 'rgb(var(--ctp-surface0))',
        '--feedback-editor-border': 'rgb(var(--ctp-surface1))',
      } as React.CSSProperties}
    />
  );
}

/** States that still hold the enrollment's credential, so delivery only needs the network. */
const DELIVERS_WHEN_REACHABLE: ReadonlySet<FeedbackStatus['state']> = new Set(['connected', 'offline', 'checking', 'stopped']);

/** Where a saved report stands. In any other state it can't go until a new connection is made. */
function savedText(status: FeedbackStatus | null): string {
  // Bound to a connection that can't come back, so it's held once a new one is made.
  if (status && savedReportsNeedSend(status.notice)) {
    const connect = status.notice === 'connection-uncertain' ? 'Connect again' : 'Connect with a new invitation';
    return `Saved on this computer, but it can't be sent yet. ${connect} in Settings, Feedback, then send it from there.`;
  }
  const waiting = status !== null && (status.notice !== null || !DELIVERS_WHEN_REACHABLE.has(status.state));
  return waiting
    ? 'Saved. It\'s queued on this computer and waits until Clubhouse is connected again.'
    : 'Saved. It\'s queued on this computer and is sent as soon as Clubhouse can reach the server.';
}

/**
 * Review a captured screenshot before it leaves the computer: preview, notes, and Send,
 * "Send without screenshot" or Cancel. After sending it shows "Saved" (queued on this
 * computer), then "Received" once the server acknowledges the report.
 */
export function FeedbackReviewDialog({ draft, reopened = null, onClose, editorOptions }: Props) {
  const reopenDraft = useFeedbackStore((s) => s.reopenDraft);
  const [notes, setNotes] = useState(reopened?.notes ?? '');
  const [phase, setPhase] = useState<Phase>('review');
  const [reportId, setReportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeCorrelation, setIncludeCorrelation] = useState(reopened?.includeCorrelation ?? true);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(reopened?.includeDiagnostics ?? true);
  const [outcome, setOutcome] = useState<FeedbackDiagnosticsOutcome | null>(null);
  const [earlierMayDeliver, setEarlierMayDeliver] = useState(false);
  const diagnostics = draft.diagnostics;
  const received = useFeedbackStore((s) => (reportId ? s.status?.received.includes(reportId) === true : false));
  const saved = useFeedbackStore((s) => savedText(s.status));
  const shots = shotsOf(draft);
  const { model, snapshot } = useScreenshotEditorModel(shots, editorOptions ?? pilotHooks.editorOptions);
  const frame = useEditorPreview(model, snapshot);
  const [editor, setEditor] = useState<'react' | 'mounted' | null>(null);
  const shotIndex = Math.max(0, snapshot?.views.findIndex((view) => view.id === snapshot.activeView) ?? 0);
  const views = snapshot?.views ?? [];
  const hasScreenshot = snapshot !== null && snapshot.status !== 'removed' && snapshot.status !== 'failed' && snapshot.included;
  const canSend = hasScreenshot || notes.trim() !== '';
  const carriedOver = reopened !== null;
  const setShotIndex = (i: number) => { if (views[i]) model?.setActiveView(views[i].id); };
  const logs = logsControl(logsFacts(draft, includeDiagnostics));

  const onShotKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || phase === 'sending') return;
    e.preventDefault();
    const next = (shotIndex + step + views.length) % views.length;
    setShotIndex(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const cancel = useCallback(() => {
    if (phase === 'review') void window.clubhouse.feedback.cancel(draft.draftId);
    onClose();
  }, [phase, draft.draftId, onClose]);

  const send = async () => {
    // beginSend takes no note, and ok:true means final, so the empty Send is refused before it.
    if (!canSend) return;
    setPhase('sending');
    setError(null);
    try {
      const begun = model ? await model.beginSend() : null;
      // Not `!begun.ok`: with strictNullChecks off, as here, that doesn't narrow the union.
      if (begun?.ok === false) {
        // Nothing has ended and no save starts. A disposed model means the dialog has gone.
        if (begun.code !== 'disposed') {
          setError(snapshot?.included === false ? `${begun.block} Remove the screenshot to send your note.` : begun.block);
          setPhase('review');
        }
        return;
      }
      // The model dropped the other windows and the original, and these strings still hold them.
      if (model) useFeedbackStore.setState({ draft: { ...draft, preview: null, shots: [] } });
      const fields = begun?.ok === true ? await sendFields(begun) : { includeScreenshot: false };
      const result = await (pilotHooks.send ?? window.clubhouse.feedback.send)({
        draftId: draft.draftId,
        notes,
        ...(draft.correlation && { includeCorrelation }),
        ...(diagnostics?.status === 'available' && { includeDiagnostics }),
        scene: currentScene(),
        ...fields,
      });
      if (result.status === 'enrollment-changed') {
        // Nothing was saved. A new report with new contents needs its own review and Send.
        reopenDraft(result.draft, { notes, includeCorrelation, includeDiagnostics });
        return;
      }
      setReportId(result.id);
      setOutcome(result.diagnostics ?? null);
      setEarlierMayDeliver(result.earlierMayDeliver === true);
      setPhase('saved');
    } catch (err) {
      // telemetry-exempt: shown to the user; the reviewed draft is kept for a retry.
      setError(ipcErrorMessage(err));
      setPhase('review');
    }
  };

  return (
    <Modal open onClose={phase === 'sending' ? () => undefined : cancel} title="Send feedback" width="w-[560px]">
      <div className="px-5 pb-5 pt-3 space-y-3" data-testid="feedback-review">
        {phase === 'saved' ? (
          <div className="space-y-3">
            <p className="text-sm text-ctp-text" role="status" data-testid="feedback-sent-state">
              {received ? 'Received. Thanks for the feedback.' : saved}
            </p>
            {earlierMayDeliver && (
              <p className="text-sm text-ctp-text" data-testid="feedback-both-may-deliver">
                Clubhouse couldn't confirm whether your earlier try was saved, so the developer may get both reports.
              </p>
            )}
            {outcome && <p className="text-xs text-ctp-subtext0" data-testid="feedback-diagnostics-outcome">{diagnosticsOutcomeText(outcome)}</p>}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md bg-surface-0 text-ctp-text hover:bg-surface-1">Close</button>
            </div>
          </div>
        ) : (
          <>
            {reopened && (
              <p className="text-sm text-ctp-text" role="status" data-testid="feedback-reopened">
                Your feedback connection changed, so nothing was sent. This is a new report with your note and image. Check what it includes below, then choose Send.
              </p>
            )}
            {views.length > 1 && (
              <div className="flex gap-2 overflow-x-auto" role="radiogroup" aria-label="Window to send" onKeyDown={onShotKey} data-testid="feedback-shots">
                {views.map((view, i) => {
                  const thumb = shots.find((s) => s.shotId === view.id)?.preview;
                  return (
                    <button
                      key={view.id}
                      type="button"
                      role="radio"
                      aria-checked={i === shotIndex}
                      // Roving tabindex: one Tab stop for the group, arrows move between windows.
                      tabIndex={i === shotIndex ? 0 : -1}
                      disabled={phase === 'sending'}
                      onClick={() => setShotIndex(i)}
                      className={`flex-shrink-0 w-32 p-1 rounded-md border text-left focus-ring disabled:opacity-50 ${i === shotIndex ? 'border-ctp-accent bg-surface-0' : 'border-surface-1 hover:bg-surface-0'}`}
                      data-testid={`feedback-shot-${i}`}
                    >
                      {thumb && <img src={thumb} alt="" className="block w-full h-16 object-cover rounded-sm bg-ctp-base" draggable={false} />}
                      <span className="block mt-1 text-xs text-ctp-subtext1 truncate" title={view.label}>{view.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {snapshot && snapshot.status !== 'removed' ? (
              <div className="space-y-2">
                {snapshot.status === 'failed' ? (
                  <p className="text-sm text-ctp-subtext0" data-testid="pilot-failed">{FEEDBACK_COPY.notes.unavailableFailed}</p>
                ) : (
                  <ComposerPreview frame={frame} snapshot={snapshot} disabled={phase === 'sending' || !snapshot.included} onOpen={() => setEditor('react')} />
                )}
                <div className="flex flex-wrap items-center gap-3 text-xs text-ctp-subtext0">
                  <label>
                    <input type="checkbox" checked={snapshot.included} disabled={phase === 'sending'} onChange={(e) => model?.setIncluded(e.target.checked)} data-testid="feedback-include" />{' '}
                    {FEEDBACK_COPY.labels.includeScreenshot}
                  </label>
                  <button type="button" disabled={phase === 'sending'} onClick={() => model?.remove()} className="underline disabled:opacity-50" data-testid="feedback-remove">Remove</button>
                  <button type="button" disabled={phase === 'sending' || !snapshot.included || !frame} onClick={() => setEditor('mounted')} className="underline disabled:opacity-50" data-testid="pilot-edit-mounted">Edit (mounted view)</button>
                </div>
                <p className="text-xs text-ctp-subtext0" data-testid="pilot-state">
                  {!snapshot.included ? FEEDBACK_COPY.notes.screenshotLeftOut
                    : snapshot.editsAreFinal || carriedOver ? FEEDBACK_COPY.notes.editedFinal
                    : snapshot.edited ? FEEDBACK_COPY.notes.edited.replace('{action}', 'Click')
                    : FEEDBACK_COPY.notes.imageTools.replace('{action}', 'Click')}
                </p>
                {editor === 'react' && <ScreenshotAnnotator model={model!} snapshot={snapshot} frame={frame} carriedOver={carriedOver} onClose={() => setEditor(null)} />}
                {editor === 'mounted' && <MountedEditor model={model!} carriedOver={carriedOver} onClose={() => setEditor(null)} />}
              </div>
            ) : (
              <p className="text-sm text-ctp-subtext0">{reopened ? 'This report has no screenshot.' : snapshot ? 'The screenshot was removed. You can still send a note.' : 'No screenshot could be taken. You can still send a note.'}</p>
            )}
            <label htmlFor="feedback-notes" className="block text-sm text-ctp-text">What happened?</label>
            <textarea
              id="feedback-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="What you were doing, what you expected, what went wrong"
              className="w-full px-3 py-2 text-sm rounded-md bg-ctp-base border border-surface-1 text-ctp-text placeholder:text-ctp-overlay0 resize-none"
            />
            <p className="text-xs text-ctp-subtext0">
              Only Clubhouse windows are captured, and only the one you choose is sent. Links, email addresses and file paths in notes are removed before sending.
            </p>
            {draft.correlation && (
              <label className="block text-xs text-ctp-subtext0">
                <input type="checkbox" checked={includeCorrelation} disabled={phase === 'sending'} onChange={e => setIncludeCorrelation(e.target.checked)} />{' '}
                Include tracing references captured when feedback opened
                <span className="block mt-1">
                  {draft.correlation.traceCount} trace/span references
                  {draft.correlation.scope === 'incident' && `, ${draft.correlation.phoneCount} phone process, ${draft.correlation.hostCount} host process and ${draft.correlation.connectionCount} connections`}.
                  {' '}These contain no chat or network payloads and do not guarantee the tracing backend retained the traces.
                </span>
              </label>
            )}
            {diagnostics?.status === 'available' && (
              <div className="text-xs text-ctp-subtext0" data-testid="feedback-diagnostics">
                <label className="block">
                  <input type="checkbox" checked={logs.checked} disabled={phase === 'sending' || !logs.enabled} onChange={e => setIncludeDiagnostics(e.target.checked)} />{' '}
                  {logs.label}
                </label>
                <span className="block mt-1" data-testid="pilot-logs-explanation">
                  Connection, agent and chat events from the last {FEEDBACK_DIAGNOSTICS.windowMinutes} minutes, with no messages, paths or chat content.
                  {' '}{logs.explanation.join(' ')}
                </span>
                <details className="mt-1">
                  <summary className="cursor-pointer">Show {diagnostics.lines.length} {diagnostics.lines.length === 1 ? 'line' : 'lines'}{diagnostics.dropped > 0 && ` (${diagnostics.dropped} older left out)`}</summary>
                  <ul className="mt-1 max-h-32 overflow-y-auto font-mono break-all" data-testid="feedback-diagnostics-lines">
                    {diagnostics.lines.map((line, i) => <li key={i}>{diagnosticLineText(line)}</li>)}
                  </ul>
                </details>
              </div>
            )}
            {diagnostics?.status === 'none' && (
              <p className="text-xs text-ctp-subtext0" data-testid="feedback-diagnostics-none">{NO_DIAGNOSTICS_TEXT[diagnostics.reason ?? 'no_lines']}</p>
            )}
            {error && <p className="text-sm text-ctp-error" role="alert" data-testid="feedback-error">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={cancel} disabled={phase === 'sending'} className="px-3 py-1.5 text-sm rounded-md text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0 disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={phase === 'sending' || !canSend || snapshot?.flattening === true}
                title={canSend ? undefined : FEEDBACK_COPY.notes.emptySend}
                className="px-3 py-1.5 text-sm rounded-md bg-ctp-accent text-white disabled:opacity-50"
                data-testid="feedback-send"
              >
                {phase === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
