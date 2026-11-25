import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useFileDropGuard } from './useFileDropGuard';

function Guarded({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFileDropGuard(ref);
  return <div ref={ref} data-testid="guarded"><span data-testid="child" />{children}</div>;
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

  it('still lets a drop target inside the canvas (a terminal or chat card) accept a file', () => {
    const onDrop = vi.fn((e: React.DragEvent) => { e.preventDefault(); });
    render(
      <Guarded>
        <div
          data-testid="card-drop-target"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={onDrop}
        />
      </Guarded>,
    );
    const target = screen.getByTestId('card-drop-target');

    const over = dragEvent('dragover', ['Files']);
    target.dispatchEvent(over);
    // The card's handler has the last word on the cursor: the guard doesn't block it.
    expect(over.dataTransfer!.dropEffect).toBe('copy');
    expect(over.defaultPrevented).toBe(true);

    const drop = dragEvent('drop', ['Files']);
    target.dispatchEvent(drop);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(drop.defaultPrevented).toBe(true);
  });
});
