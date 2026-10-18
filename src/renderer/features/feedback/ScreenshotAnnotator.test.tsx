import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotAnnotator } from './ScreenshotAnnotator';
import type { Stroke } from './annotation';

const SRC = 'data:image/png;base64,iVBORw0KGgo=';
const ctx = { clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn() };

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  // The preview is drawn at 480x300 CSS pixels for a 2880x1800 capture.
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 480, height: 300, right: 480, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => vi.restoreAllMocks());

let latest: Stroke[] = [];
function Harness({ initial = [] as Stroke[], disabled = false }) {
  const [strokes, setStrokes] = useState<Stroke[]>(initial);
  latest = strokes;
  return (
    <>
      <ScreenshotAnnotator src={SRC} strokes={strokes} onChange={setStrokes} disabled={disabled} />
      <textarea aria-label="notes" />
    </>
  );
}

function loadPreview() {
  const img = screen.getByTestId('feedback-preview') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { value: 2880, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 1800, configurable: true });
  fireEvent.load(img);
  return screen.getByTestId('feedback-ink-canvas') as HTMLCanvasElement;
}

function draw(canvas: HTMLCanvasElement, points: Array<[number, number]>, end: 'pointerUp' | 'pointerCancel' = 'pointerUp') {
  const [first, ...rest] = points;
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, buttons: 1, clientX: first[0], clientY: first[1] });
  for (const [x, y] of rest) fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: x, clientY: y });
  fireEvent[end](canvas, { pointerId: 1 });
}

describe('ScreenshotAnnotator', () => {
  it('sizes the drawing surface to the capture, not the preview', () => {
    render(<Harness />);
    const canvas = loadPreview();
    expect(canvas.width).toBe(2880);
    expect(canvas.height).toBe(1800);
  });

  it('records a stroke in image pixels in the selected ink', () => {
    render(<Harness />);
    const canvas = loadPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Blue ink' }));
    draw(canvas, [[10, 10], [20, 10], [20, 20]]);
    expect(latest).toHaveLength(1);
    expect(latest[0].color).toBe('#0a84ff');
    expect(latest[0].width).toBe(10);
    expect(latest[0].points).toEqual([{ x: 60, y: 60 }, { x: 120, y: 60 }, { x: 120, y: 120 }]);
  });

  it('keeps a single click as a dot and ends a stroke on pointercancel', () => {
    render(<Harness />);
    const canvas = loadPreview();
    draw(canvas, [[5, 5]]);
    draw(canvas, [[30, 30], [40, 40]], 'pointerCancel');
    // A move after the cancel doesn't extend the cancelled stroke.
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: 90, clientY: 90 });
    expect(latest.map((s) => s.points.length)).toEqual([1, 2]);
  });

  it('ignores non-primary buttons', () => {
    render(<Harness />);
    const canvas = loadPreview();
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 2, clientX: 5, clientY: 5 });
    expect(latest).toEqual([]);
  });

  it('shows the current ink with aria-pressed, red first', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Red ink' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Yellow ink' }));
    expect(screen.getByRole('button', { name: 'Yellow ink' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Red ink' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByRole('button', { name: / ink$/ })).toHaveLength(4);
  });

  it('undoes the last stroke and clears all, both disabled with no ink', () => {
    render(<Harness />);
    const canvas = loadPreview();
    const undo = screen.getByRole('button', { name: 'Undo' });
    const clear = screen.getByRole('button', { name: 'Clear drawing' });
    expect(undo).toBeDisabled();
    expect(clear).toBeDisabled();
    draw(canvas, [[1, 1], [2, 2]]);
    draw(canvas, [[3, 3], [4, 4]]);
    fireEvent.click(undo);
    expect(latest).toHaveLength(1);
    fireEvent.click(clear);
    expect(latest).toEqual([]);
    expect(clear).toBeDisabled();
  });

  it('undoes with Cmd/Ctrl+Z only while the annotator has focus', () => {
    render(<Harness />);
    const canvas = loadPreview();
    draw(canvas, [[1, 1]]);
    draw(canvas, [[2, 2]]);
    fireEvent.keyDown(screen.getByLabelText('notes'), { key: 'z', metaKey: true });
    expect(latest).toHaveLength(2);
    fireEvent.keyDown(canvas, { key: 'z', metaKey: true });
    expect(latest).toHaveLength(1);
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    expect(latest).toHaveLength(0);
  });

  it('redraws the strokes when they change', () => {
    render(<Harness initial={[{ color: '#ff3b30', width: 10, points: [{ x: 1, y: 1 }] }]} />);
    loadPreview();
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 2880, 1800);
    expect(ctx.arc).toHaveBeenCalled();
  });

  it('stops inking when the release was lost (no buttons down, or capture lost)', () => {
    render(<Harness />);
    const canvas = loadPreview();
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, buttons: 1, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: 2, clientY: 2 });
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 0, clientX: 60, clientY: 60 });
    expect(latest[0].points).toHaveLength(2);

    fireEvent.pointerDown(canvas, { pointerId: 2, button: 0, buttons: 1, clientX: 5, clientY: 5 });
    fireEvent(canvas, new PointerEvent('lostpointercapture', { pointerId: 2, bubbles: true }));
    fireEvent.pointerMove(canvas, { pointerId: 2, buttons: 1, clientX: 70, clientY: 70 });
    expect(latest[1].points).toHaveLength(1);
  });

  it('keeps an Undo made mid-drag', () => {
    render(<Harness />);
    const canvas = loadPreview();
    draw(canvas, [[1, 1], [2, 2]]);
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, buttons: 1, clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.pointerMove(canvas, { pointerId: 1, buttons: 1, clientX: 9, clientY: 9 });
    expect(latest).toHaveLength(1);
    expect(latest[0].points).toHaveLength(2);
  });

  it('turns the pen and tools off while disabled (sending)', () => {
    render(<Harness disabled initial={[{ color: '#ff3b30', width: 10, points: [{ x: 1, y: 1 }] }]} />);
    const canvas = loadPreview();
    draw(canvas, [[10, 10], [20, 20]]);
    expect(latest).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear drawing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Blue ink' })).toBeDisabled();
    fireEvent.keyDown(canvas, { key: 'z', metaKey: true });
    expect(latest).toHaveLength(1);
  });
});
