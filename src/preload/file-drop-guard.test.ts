// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFileDropGuard } from './file-drop-guard';

/** jsdom has no DataTransfer, so dispatch a plain cancelable event carrying one. */
function dragEvent(type: 'dragover' | 'drop', types: string[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event;
}

describe('installFileDropGuard (#3881)', () => {
  let uninstall: () => void;
  let surface: HTMLDivElement;
  let plain: HTMLDivElement;

  beforeEach(() => {
    uninstall = installFileDropGuard(document);
    surface = document.createElement('div');
    plain = document.createElement('div');
    document.body.append(surface, plain);
  });

  afterEach(() => {
    uninstall();
    surface.remove();
    plain.remove();
  });

  it.each(['dragover', 'drop'] as const)('cancels a file %s over a surface with no handler', (type) => {
    const event = dragEvent(type, ['Files']);
    plain.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['dragover', 'drop'] as const)('leaves a %s without files alone', (type) => {
    const event = dragEvent(type, ['text/plain', 'text/uri-list']);
    plain.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('still delivers the drop to a surface handler, bubbling and capturing', () => {
    const bubble = vi.fn();
    const capture = vi.fn();
    const onDocument = vi.fn();
    surface.addEventListener('drop', bubble);
    surface.addEventListener('drop', capture, true);
    document.addEventListener('drop', onDocument);
    const event = dragEvent('drop', ['Files']);
    surface.dispatchEvent(event);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(bubble).toHaveBeenCalledTimes(1);
    expect(onDocument).toHaveBeenCalledTimes(1);
    expect(bubble.mock.calls[0][0]).toBe(event);
    document.removeEventListener('drop', onDocument);
  });

  it('can be uninstalled', () => {
    uninstall();
    const event = dragEvent('drop', ['Files']);
    plain.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    uninstall = () => {};
  });
});
