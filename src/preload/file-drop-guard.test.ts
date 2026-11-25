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

  it.each(['dragover', 'drop'] as const)('cancels a link %s over a surface with no handler', (type) => {
    const event = dragEvent(type, ['text/uri-list', 'text/plain']);
    plain.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('still delivers a link drop to a surface that takes links', () => {
    const take = vi.fn();
    surface.addEventListener('drop', take);
    const event = dragEvent('drop', ['text/uri-list']);
    surface.dispatchEvent(event);
    expect(take).toHaveBeenCalledWith(event);
  });

  it.each([
    () => document.createElement('textarea'),
    () => document.createElement('input'),
    () => { const d = document.createElement('div'); d.setAttribute('contenteditable', 'true'); return d; },
    () => { const d = document.createElement('div'); d.setAttribute('contenteditable', 'true'); const s = document.createElement('span'); d.append(s); return s; },
  ])('leaves a link drop over an editable field to the browser, which inserts it as text (%#)', (make) => {
    const el = make();
    document.body.append(el.parentElement && el.parentElement !== document.body ? el.parentElement : el);
    for (const type of ['dragover', 'drop'] as const) {
      const event = dragEvent(type, ['text/uri-list', 'text/plain']);
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    (el.parentElement && el.parentElement !== document.body ? el.parentElement : el).remove();
  });

  it('still cancels a file drop over an editable field', () => {
    const area = document.createElement('textarea');
    document.body.append(area);
    const event = dragEvent('drop', ['Files']);
    area.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    area.remove();
  });

  it.each(['dragover', 'drop'] as const)('leaves a plain-text or internal %s alone', (type) => {
    const event = dragEvent(type, ['text/plain', 'application/x-clubhouse-agent']);
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
