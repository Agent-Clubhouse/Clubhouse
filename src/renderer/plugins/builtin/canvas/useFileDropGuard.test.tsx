import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useFileDropGuard } from './useFileDropGuard';

function Guarded() {
  const ref = useRef<HTMLDivElement>(null);
  useFileDropGuard(ref);
  return <div ref={ref} data-testid="guarded"><span data-testid="child" /></div>;
}

/** A cancelable drag event whose dataTransfer carries the given types. */
function dragEvent(type: 'dragover' | 'drop', types: string[]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: { types, dropEffect: 'copy' } });
  return event;
}

describe('useFileDropGuard', () => {
  it.each(['dragover', 'drop'] as const)('cancels %s for files, so the window never opens the file', (type) => {
    render(<Guarded />);
    const event = dragEvent(type, ['Files']);
    // Dispatched on a child: the guard covers everything inside the canvas.
    screen.getByTestId('child').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows a no-drop cursor over the canvas for files', () => {
    render(<Guarded />);
    const event = dragEvent('dragover', ['Files', 'text/uri-list']);
    screen.getByTestId('guarded').dispatchEvent(event);
    expect(event.dataTransfer!.dropEffect).toBe('none');
  });

  it.each(['dragover', 'drop'] as const)('leaves %s alone when no files are dragged', (type) => {
    render(<Guarded />);
    const event = dragEvent(type, ['text/plain']);
    screen.getByTestId('guarded').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops guarding after unmount', () => {
    const { unmount } = render(<Guarded />);
    const el = screen.getByTestId('guarded');
    unmount();
    const event = dragEvent('drop', ['Files']);
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
