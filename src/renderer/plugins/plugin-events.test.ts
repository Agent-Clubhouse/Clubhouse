import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRendererLog = vi.fn();
vi.mock('./renderer-logger', () => ({
  rendererLog: (...args: unknown[]) => mockRendererLog(...args),
}));

import { pluginEventBus } from './plugin-events';

describe('PluginEventBus', () => {
  beforeEach(() => {
    pluginEventBus.clear();
  });

  it('calls handler when event is emitted', () => {
    const handler = vi.fn();
    pluginEventBus.on('test', handler);
    pluginEventBus.emit('test', 'arg1', 'arg2');
    expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
  });

  it('supports multiple handlers for the same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    pluginEventBus.on('test', h1);
    pluginEventBus.on('test', h2);
    pluginEventBus.emit('test');
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not call handlers for other events', () => {
    const handler = vi.fn();
    pluginEventBus.on('event-a', handler);
    pluginEventBus.emit('event-b');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a disposable that removes the handler', () => {
    const handler = vi.fn();
    const disposable = pluginEventBus.on('test', handler);
    disposable.dispose();
    pluginEventBus.emit('test');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not affect other handlers when one is disposed', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const d1 = pluginEventBus.on('test', h1);
    pluginEventBus.on('test', h2);
    d1.dispose();
    pluginEventBus.emit('test');
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('catches and logs handler errors without affecting other handlers', () => {
    mockRendererLog.mockClear();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const surviving = vi.fn();
    pluginEventBus.on('test', throwing);
    pluginEventBus.on('test', surviving);
    pluginEventBus.emit('test');
    expect(throwing).toHaveBeenCalled();
    expect(surviving).toHaveBeenCalled();
    expect(mockRendererLog).toHaveBeenCalledWith(
      'core:plugin-events',
      'error',
      expect.stringContaining('test'),
      expect.objectContaining({ meta: expect.objectContaining({ event: 'test' }) }),
    );
  });

  it('does nothing when emitting an event with no listeners', () => {
    // Should not throw
    expect(() => pluginEventBus.emit('nonexistent')).not.toThrow();
  });

  it('clear() removes all listeners', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    pluginEventBus.on('a', h1);
    pluginEventBus.on('b', h2);
    pluginEventBus.clear();
    pluginEventBus.emit('a');
    pluginEventBus.emit('b');
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('passes all arguments to handler', () => {
    const handler = vi.fn();
    pluginEventBus.on('test', handler);
    pluginEventBus.emit('test', 1, 'two', { three: 3 });
    expect(handler).toHaveBeenCalledWith(1, 'two', { three: 3 });
  });
});
