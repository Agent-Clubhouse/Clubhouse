import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import {
  clampCamera, fitZoom, penWidth, renderMarks, toggleZoom, zoomCamera,
  type ScreenshotCamera, type ScreenshotEditorModel, type ScreenshotEditorState, type ScreenshotInkName, type ScreenshotMark, type ScreenshotPreview,
} from './pilot-vendor/screenshot-editor.mjs';
import { FEEDBACK_COPY } from './pilot-vendor/feedback-copy.mjs';

type Tool = 'move' | 'pen' | 'redact';
const TOOLS: Tool[] = ['move', 'pen', 'redact'];
const INKS: ScreenshotInkName[] = ['red', 'yellow', 'blue', 'white'];

interface Props {
  model: ScreenshotEditorModel;
  snapshot: ScreenshotEditorState;
  frame: ScreenshotPreview | null;
  /** Set on a model built for a reopened draft, which can't say its edits are final (no API for it). */
  carriedOver?: boolean;
  onClose: () => void;
}

type Live = { kind: 'pen'; points: [number, number][]; width: number; ink: ScreenshotInkName } | { kind: 'redact'; anchor: [number, number]; at: [number, number] };

function liveMark(live: Live): ScreenshotMark {
  if (live.kind === 'pen') return { type: 'pen', points: live.points, width: live.width, ink: live.ink };
  return { type: 'redact', x: Math.min(live.anchor[0], live.at[0]), y: Math.min(live.anchor[1], live.at[1]), width: Math.abs(live.at[0] - live.anchor[0]), height: Math.abs(live.at[1] - live.anchor[1]) };
}

/**
 * PILOT, never ships. The contract's editor as Clubhouse's own React UI over the pinned model: the model
 * and the camera helpers do the sums, this holds the tool, ink, camera and the mark being made. Keyboard
 * Pen and Redact and pinch aren't here: the contract requires both, and the mounted view already has them.
 */
export function ScreenshotAnnotator({ model, snapshot, frame, carriedOver = false, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [ink, setInk] = useState<ScreenshotInkName>(FEEDBACK_COPY.inks.default);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<ScreenshotCamera | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const live = useRef<Live | null>(null);
  const drag = useRef<{ pointerId: number; last: [number, number] } | null>(null);
  const openedView = useRef(snapshot.activeView);
  const image = useMemo(() => (frame ? { width: frame.width, height: frame.height } : null), [frame]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setStage({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!image || !stage.width || !stage.height) { setCamera(null); return; }
    setCamera((was) => clampCamera(was ?? { zoom: fitZoom(image, stage), panX: 0, panY: 0 }, image, stage));
  }, [image, stage]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(stage.width * ratio));
    canvas.height = Math.max(1, Math.round(stage.height * ratio));
    context.fillStyle = getComputedStyle(canvas).getPropertyValue('background-color') || 'rgb(38,38,38)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!frame || !camera || !image) return;
    context.setTransform(ratio * camera.zoom, 0, 0, ratio * camera.zoom, ratio * camera.panX, ratio * camera.panY);
    context.imageSmoothingEnabled = camera.zoom < 2;
    if (!frame.draw(context)) return;
    const marks = live.current ? [...snapshot.marks, liveMark(live.current)] : snapshot.marks;
    renderMarks(context, marks, image);
  }, [frame, camera, image, stage, snapshot.marks]);
  useEffect(draw, [draw]);

  // React's onWheel is passive at the root, so zoom needs its own listener to stop the page scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || tool !== 'move') return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = canvas.getBoundingClientRect();
      setCamera((was) => (was ? zoomCamera(was, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - box.left, e.clientY - box.top, image, stage) : was));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [image, stage, tool]);

  const stagePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const box = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  const imagePoint = ([x, y]: [number, number]): [number, number] => [
    Math.min(image!.width, Math.max(0, (x - camera!.panX) / camera!.zoom)),
    Math.min(image!.height, Math.max(0, (y - camera!.panY) / camera!.zoom)),
  ];

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!image || !camera || busy || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const at = stagePoint(e);
    drag.current = { pointerId: e.pointerId, last: at };
    if (tool === 'pen') live.current = { kind: 'pen', points: [imagePoint(at)], width: penWidth(camera.zoom, fitZoom(image, stage)), ink };
    if (tool === 'redact') live.current = { kind: 'redact', anchor: imagePoint(at), at: imagePoint(at) };
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId || !image || !camera) return;
    const at = stagePoint(e);
    if (tool === 'move') {
      const [dx, dy] = [at[0] - drag.current.last[0], at[1] - drag.current.last[1]];
      setCamera((was) => (was ? clampCamera({ ...was, panX: was.panX + dx, panY: was.panY + dy }, image, stage) : was));
    } else if (live.current?.kind === 'pen') {
      live.current.points.push(imagePoint(at));
      draw();
    } else if (live.current) {
      live.current.at = imagePoint(at);
      draw();
    }
    drag.current.last = at;
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    const finished = live.current;
    live.current = null;
    if (!finished || e.type !== 'pointerup' || !camera) { draw(); return; }
    const mark = liveMark(finished);
    // Under two screen points isn't a redaction: the contract's rule, which the model leaves to the view.
    if (mark.type === 'redact' && (mark.width * camera.zoom < 2 || mark.height * camera.zoom < 2)) { draw(); return; }
    model.addMark(mark);
  };

  const zoomBy = (factor: number) => {
    if (image) setCamera((was) => (was ? zoomCamera(was, factor, stage.width / 2, stage.height / 2, image, stage) : was));
  };
  const toFit = () => { if (image) setCamera(clampCamera({ zoom: fitZoom(image, stage), panX: 0, panY: 0 }, image, stage)); };

  const cancel = () => {
    if (busy) return;
    live.current = null;
    model.revert();
    // A view chosen during this visit isn't kept either. Throws only if that view has gone.
    if (openedView.current) model.setActiveView(openedView.current);
    onClose();
  };
  const done = async () => {
    if (busy) return;
    if (!model.hasUncommittedMarks()) { onClose(); return; }
    setBusy(true);
    setProblem(false);
    try {
      await model.commit();
      onClose();
    } catch {
      // telemetry-exempt: pilot. The image hasn't changed, and the words say so.
      setBusy(false);
      setProblem(true);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); model.undo(); }
    if (tool !== 'move' || e.target !== canvasRef.current) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-') zoomBy(1 / 1.5);
    else if (e.key === '0') toFit();
  };

  const final = snapshot.editsAreFinal || carriedOver;
  return (
    <Modal open onClose={cancel} aria-label={FEEDBACK_COPY.labels.title} width="w-[calc(100vw-48px)] h-[calc(100vh-48px)]" padding="none" testId="pilot-react-editor">
      <div className="flex flex-col h-[calc(100vh-50px)]" onKeyDown={onKeyDown}>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <Button kind="quiet" onClick={cancel} disabled={busy} data-testid="pilot-cancel">{FEEDBACK_COPY.labels.cancel}</Button>
          <Button kind="quiet" onClick={() => model.undo()} disabled={!snapshot.canUndo || busy} data-testid="pilot-undo">{FEEDBACK_COPY.labels.undo}</Button>
          <Button onClick={() => void done()} disabled={!frame || busy} data-testid="pilot-done">{FEEDBACK_COPY.labels.done}</Button>
        </div>
        <div ref={stageRef} className="relative flex-1 min-h-0 bg-ctp-crust">
          <canvas
            ref={canvasRef}
            tabIndex={0}
            role="img"
            aria-label={`${FEEDBACK_COPY.editor.screenshot}, ${snapshot.marks.length} ${snapshot.marks.length === 1 ? FEEDBACK_COPY.editor.mark : FEEDBACK_COPY.editor.marks}`}
            className="absolute inset-0 w-full h-full touch-none focus-ring"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) => { if (tool === 'move' && image && camera) setCamera(toggleZoom(camera, ...stagePoint(e), image, stage)); }}
            data-testid="pilot-stage"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          {TOOLS.map((name) => (
            <Button key={name} kind={tool === name ? 'primary' : 'quiet'} aria-pressed={tool === name} onClick={() => setTool(name)} data-testid={`pilot-tool-${name}`}>{FEEDBACK_COPY.labels[name]}</Button>
          ))}
          {tool === 'pen' && INKS.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={FEEDBACK_COPY.editor[name]}
              aria-pressed={ink === name}
              onClick={() => setInk(name)}
              className={`w-6 h-6 rounded-full border border-surface-2 focus-ring ${ink === name ? 'ring-2 ring-offset-2 ring-offset-ctp-mantle ring-ctp-text' : ''}`}
              style={{ backgroundColor: `rgb(${FEEDBACK_COPY.inks[name].join(',')})` }}
              data-testid={`pilot-ink-${name}`}
            />
          ))}
          {tool === 'move' && (
            <>
              <Button kind="quiet" aria-label={FEEDBACK_COPY.editor.zoomOut} onClick={() => zoomBy(1 / 1.5)} data-testid="pilot-zoom-out">-</Button>
              <Button kind="quiet" aria-label={FEEDBACK_COPY.editor.zoomIn} onClick={() => zoomBy(1.5)} data-testid="pilot-zoom-in">+</Button>
              <Button kind="quiet" onClick={toFit} data-testid="pilot-zoom-fit">{FEEDBACK_COPY.editor.zoomFit}</Button>
            </>
          )}
          <span className="flex-1" />
          <Button kind="quiet" onClick={() => setConfirming(true)} disabled={!snapshot.canUndo || busy} data-testid="pilot-clear">{FEEDBACK_COPY.labels.clearEdits}</Button>
          <p className="basis-full text-xs text-ctp-subtext0" data-testid="pilot-hint">{FEEDBACK_COPY.editorHints[tool]}</p>
          {problem && <p className="basis-full text-xs text-ctp-error" role="alert">{FEEDBACK_COPY.notes.cannotFinish}</p>}
        </div>
      </div>
      {confirming && (
        <Modal open onClose={() => setConfirming(false)} aria-label={FEEDBACK_COPY.labels.clearEdits} testId="pilot-clear-confirm">
          <p className="text-sm text-ctp-text mb-3" data-testid="pilot-clear-text">{final ? FEEDBACK_COPY.confirm.clearFinal : FEEDBACK_COPY.confirm.clearReversible}</p>
          <div className="flex justify-end gap-2">
            <Button kind="quiet" onClick={() => setConfirming(false)}>{FEEDBACK_COPY.labels.cancel}</Button>
            <Button onClick={() => { live.current = null; model.clear(); setConfirming(false); }} data-testid="pilot-clear-yes">{FEEDBACK_COPY.labels.clearEdits}</Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
