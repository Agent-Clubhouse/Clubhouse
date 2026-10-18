import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '../../components/Button';
import { drawStrokes, INKS, strokeWidthFor, toImagePoint, type Size, type Stroke } from './annotation';

interface Props {
  /** data:image/png preview of the capture. */
  src: string;
  strokes: Stroke[];
  onChange: (strokes: Stroke[]) => void;
}

/**
 * The screenshot preview with a freehand pen on top (#2099). The canvas backing store
 * is the capture's natural size and CSS scales it with the image, so what you draw
 * lands on the same pixels the upload is composited at.
 */
export function ScreenshotAnnotator({ src, strokes, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [color, setColor] = useState<string>(INKS[0].color);
  // The stroke being drawn; committed through onChange on every point so it shows live.
  const active = useRef<{ pointerId: number; base: Stroke[]; stroke: Stroke } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !size) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(ctx, strokes);
  }, [strokes, size]);

  const point = (e: PointerEvent<HTMLCanvasElement>) =>
    toImagePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), size!);

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!size || e.button !== 0 || active.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const stroke: Stroke = { color, width: strokeWidthFor(size), points: [point(e)] };
    active.current = { pointerId: e.pointerId, base: strokes, stroke };
    onChange([...strokes, stroke]);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const a = active.current;
    if (!a || a.pointerId !== e.pointerId) return;
    a.stroke = { ...a.stroke, points: [...a.stroke.points, point(e)] };
    onChange([...a.base, a.stroke]);
  };

  // pointerup and pointercancel both end the stroke; what was drawn stays.
  const endStroke = (e: PointerEvent<HTMLCanvasElement>) => {
    if (active.current?.pointerId !== e.pointerId) return;
    active.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const undo = () => onChange(strokes.slice(0, -1));
  const clear = () => onChange([]);

  // Cmd/Ctrl+Z only while the annotator has focus, so the notes field keeps its own undo.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && strokes.length > 0) {
      e.preventDefault();
      undo();
    }
  };

  return (
    <div className="space-y-2" onKeyDown={onKeyDown} data-testid="feedback-annotator">
      <div className="flex justify-center rounded-md border border-surface-0 bg-ctp-base">
        <div className="relative">
          <img
            src={src}
            alt="Screenshot of the Clubhouse window that will be sent"
            className="block max-w-full max-h-[300px] w-auto h-auto select-none"
            draggable={false}
            onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            data-testid="feedback-preview"
          />
          {size && (
            <canvas
              ref={canvasRef}
              width={size.width}
              height={size.height}
              className="absolute inset-0 w-full h-full cursor-crosshair touch-none focus-ring rounded-sm"
              tabIndex={0}
              role="img"
              aria-label={strokes.length === 0 ? 'Drawing area, no marks yet' : `Drawing area, ${strokes.length} ${strokes.length === 1 ? 'mark' : 'marks'}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              data-testid="feedback-ink-canvas"
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5" role="toolbar" aria-label="Drawing">
        <span className="text-xs text-ctp-subtext0 mr-1">Draw to point things out</span>
        {INKS.map((ink) => {
          const selected = ink.color === color;
          return (
            <button
              key={ink.id}
              type="button"
              aria-label={`${ink.label} ink`}
              aria-pressed={selected}
              title={`${ink.label} ink`}
              onClick={() => setColor(ink.color)}
              className={`w-5 h-5 rounded-full border border-surface-2 focus-ring ${selected ? 'ring-2 ring-offset-2 ring-offset-ctp-mantle ring-ctp-text' : ''}`}
              style={{ backgroundColor: ink.color }}
              data-testid={`feedback-ink-${ink.id}`}
            />
          );
        })}
        <span className="flex-1" />
        <Button kind="quiet" onClick={undo} disabled={strokes.length === 0} data-testid="feedback-ink-undo">Undo</Button>
        <Button kind="quiet" onClick={clear} disabled={strokes.length === 0} data-testid="feedback-ink-clear">Clear drawing</Button>
      </div>
    </div>
  );
}
