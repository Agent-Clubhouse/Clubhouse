import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

import { registerCanvasTools } from './canvas-tools';
import { getScopedToolList, _resetForTesting as resetToolRegistry } from '../tool-registry';
import { bindingManager } from '../binding-manager';

describe('CanvasTools (removed)', () => {
  beforeEach(() => {
    resetToolRegistry();
    bindingManager._resetForTesting();
  });

  it('registerCanvasTools is a no-op and does not throw', () => {
    expect(() => registerCanvasTools()).not.toThrow();
  });

  it('non-assistant agents get 0 canvas tools after registerCanvasTools', () => {
    registerCanvasTools();
    const tools = getScopedToolList('any-agent-id');
    const canvasTools = tools.filter((t) => t.name.startsWith('canvas__'));
    expect(canvasTools).toHaveLength(0);
  });

  it('no global tools are registered', () => {
    registerCanvasTools();
    const tools = getScopedToolList('any-agent-id');
    expect(tools).toHaveLength(0);
  });
});
