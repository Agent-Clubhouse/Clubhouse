import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRendererTelemetryForTests, _setStateForTests, flushTelemetry, initRendererTelemetry } from './facade';
import { _resetRendererErrorHandlersForTests, installRendererErrorHandlers } from './errors';

const emit = vi.fn();
let target: EventTarget;

beforeEach(() => {
  emit.mockClear();
  initRendererTelemetry({ emit, rendererReady: vi.fn(), getState: async () => ({ enabled: true, level: 'standard' }), onStateChanged: () => () => {} });
  _setStateForTests({ enabled: true, level: 'errors' });
  target = new EventTarget();
  installRendererErrorHandlers(target as unknown as Window);
});

afterEach(() => {
  _resetRendererErrorHandlersForTests();
  _resetRendererTelemetryForTests();
});

describe('renderer error handlers', () => {
  it('reports uncaught errors and unhandled rejections', () => {
    const errorEvent = Object.assign(new Event('error'), { error: new SyntaxError('bad') });
    target.dispatchEvent(errorEvent);
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new RangeError('later') });
    target.dispatchEvent(rejection);
    flushTelemetry();
    const items = emit.mock.calls[0][0].items;
    expect(items.map((i: { errorType: string }) => i.errorType)).toEqual(['SyntaxError', 'RangeError']);
    expect(items.every((i: { handled: boolean }) => i.handled === false)).toBe(true);
  });

  it('ignores resource load errors that carry no error object', () => {
    target.dispatchEvent(new Event('error'));
    flushTelemetry();
    expect(emit).not.toHaveBeenCalled();
  });
});
