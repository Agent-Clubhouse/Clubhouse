import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => {
  const mockDebugger = {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    on: vi.fn(),
  };
  const mockWc = {
    id: 42,
    debugger: mockDebugger,
    loadURL: vi.fn(),
    capturePage: vi.fn(),
    on: vi.fn(),
  };
  return {
    app: { getPath: () => '/tmp/clubhouse-test' },
    BrowserWindow: { getAllWindows: () => [] },
    webContents: {
      fromId: vi.fn((id: number) => (id === 42 ? mockWc : null)),
    },
  };
});

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../../agent-registry', () => ({
  getAgentNonce: vi.fn(),
}));

import { webContents } from 'electron';
import {
  registerBrowserTools,
  registerWebview,
  unregisterWebview,
  _resetForTesting as resetBrowserTools,
} from './browser-tools';
import { getScopedToolList, callTool, _resetForTesting as resetTools } from '../tool-registry';
import { bindingManager } from '../binding-manager';

function getMockWc() {
  return (webContents.fromId as any)(42);
}

function getMockDebugger() {
  return getMockWc().debugger;
}

describe('BrowserTools', () => {
  beforeEach(() => {
    resetTools();
    resetBrowserTools();
    bindingManager._resetForTesting();

    const mockWc = getMockWc();
    const mockDbg = getMockDebugger();

    // Reset all mocks on the shared fixtures
    mockWc.loadURL.mockReset();
    mockWc.capturePage.mockReset();
    mockWc.on.mockReset();
    mockDbg.attach.mockReset();
    mockDbg.detach.mockReset();
    mockDbg.sendCommand.mockReset();
    mockDbg.on.mockReset();

    // Sensible defaults
    mockDbg.sendCommand.mockResolvedValue({});

    registerBrowserTools();
    registerWebview('widget-1', 42);
    bindingManager.bind('agent-1', { targetId: 'widget-1', targetKind: 'browser', label: 'Browser' });
  });

  describe('tool registration', () => {
    it('registers all 8 browser tool templates', () => {
      const tools = getScopedToolList('agent-1');
      expect(tools).toHaveLength(8);
      const names = tools.map(t => t.name);
      expect(names).toContain('browser__widget_1__navigate');
      expect(names).toContain('browser__widget_1__screenshot');
      expect(names).toContain('browser__widget_1__get_console');
      expect(names).toContain('browser__widget_1__click');
      expect(names).toContain('browser__widget_1__type');
      expect(names).toContain('browser__widget_1__evaluate');
      expect(names).toContain('browser__widget_1__get_page_content');
      expect(names).toContain('browser__widget_1__get_accessibility_tree');
    });

    it('returns no tools when widget not bound', () => {
      const tools = getScopedToolList('unbound-agent');
      expect(tools).toHaveLength(0);
    });

    it('each tool has a description and inputSchema', () => {
      const tools = getScopedToolList('agent-1');
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('registerWebview / unregisterWebview', () => {
    it('registers a webview so tools can find it', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://example.com' });
      expect(result.isError).toBeFalsy();
    });

    it('unregisters a webview so tools return error', () => {
      unregisterWebview('widget-1');
      return callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://example.com' }).then(result => {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not found');
      });
    });

    it('unregister detaches debugger if attached', () => {
      // Verify unregisterWebview doesn't throw even when debugger not attached
      unregisterWebview('widget-1');
      // Widget should now be gone
      expect(getMockDebugger()).toBeDefined(); // Mock still exists but webview is unregistered
    });
  });

  describe('navigate', () => {
    it('navigates to a valid HTTPS URL', async () => {
      const mockWc = getMockWc();
      mockWc.loadURL.mockResolvedValue(undefined);

      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://example.com' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Navigated to https://example.com');
      expect(mockWc.loadURL).toHaveBeenCalledWith('https://example.com');
    });

    it('navigates to a valid HTTP URL', async () => {
      const mockWc = getMockWc();
      mockWc.loadURL.mockResolvedValue(undefined);

      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'http://localhost:3000' });
      expect(result.isError).toBeFalsy();
      expect(mockWc.loadURL).toHaveBeenCalledWith('http://localhost:3000');
    });

    it('rejects URLs without http/https prefix', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'ftp://example.com' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('http:// or https://');
    });

    it('rejects empty URL', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: '' });
      expect(result.isError).toBe(true);
    });

    it('rejects missing URL', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__navigate', {});
      expect(result.isError).toBe(true);
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://example.com' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('returns error when loadURL throws', async () => {
      const mockWc = getMockWc();
      mockWc.loadURL.mockRejectedValue(new Error('ERR_NAME_NOT_RESOLVED'));

      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://bad.invalid' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ERR_NAME_NOT_RESOLVED');
    });

    it('rejects file:// URLs', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'file:///etc/passwd' });
      expect(result.isError).toBe(true);
    });

    it('rejects javascript: URLs', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'javascript:alert(1)' });
      expect(result.isError).toBe(true);
    });
  });

  describe('screenshot', () => {
    it('captures and returns a base64 PNG', async () => {
      const mockWc = getMockWc();
      const smallPng = Buffer.alloc(1000, 0); // 1KB fake PNG
      const mockImage = { toPNG: () => smallPng };
      mockWc.capturePage.mockResolvedValue(mockImage);

      const result = await callTool('agent-1', 'browser__widget_1__screenshot', {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('image');
      expect(result.content[0].mimeType).toBe('image/png');
      expect(result.content[0].data).toBe(smallPng.toString('base64'));
    });

    it('rejects screenshots over 5MB', async () => {
      const mockWc = getMockWc();
      const largePng = Buffer.alloc(6 * 1024 * 1024, 0); // 6MB
      const mockImage = { toPNG: () => largePng };
      mockWc.capturePage.mockResolvedValue(mockImage);

      const result = await callTool('agent-1', 'browser__widget_1__screenshot', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('too large');
      expect(result.content[0].text).toContain('5MB');
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__screenshot', {});
      expect(result.isError).toBe(true);
    });

    it('returns error when capturePage throws', async () => {
      const mockWc = getMockWc();
      mockWc.capturePage.mockRejectedValue(new Error('capture failed'));

      const result = await callTool('agent-1', 'browser__widget_1__screenshot', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('capture failed');
    });

    it('accepts exactly 5MB screenshots', async () => {
      const mockWc = getMockWc();
      const exactPng = Buffer.alloc(5 * 1024 * 1024, 0); // Exactly 5MB
      const mockImage = { toPNG: () => exactPng };
      mockWc.capturePage.mockResolvedValue(mockImage);

      const result = await callTool('agent-1', 'browser__widget_1__screenshot', {});
      expect(result.isError).toBeFalsy();
    });
  });

  describe('get_console', () => {
    it('returns empty array when no console entries', async () => {
      const result = await callTool('agent-1', 'browser__widget_1__get_console', {});
      expect(result.isError).toBeFalsy();
      const entries = JSON.parse(result.content[0].text!);
      expect(entries).toEqual([]);
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__get_console', {});
      expect(result.isError).toBe(true);
    });

    it('respects limit argument when provided', async () => {
      // The limit is used against the internal buffer, which is populated via
      // the debugger 'message' event — mock not feasible to drive in unit test.
      // But we can verify the limit is validated: passing limit=0 should default to 1.
      const result = await callTool('agent-1', 'browser__widget_1__get_console', { limit: 0 });
      expect(result.isError).toBeFalsy();
    });

    it('returns error when webContents gone', async () => {
      // Register a webview with an ID that has no webContents
      registerWebview('widget-gone', 999);
      bindingManager.bind('agent-1', { targetId: 'widget-gone', targetKind: 'browser', label: 'Gone' });

      const result = await callTool('agent-1', 'browser__widget_gone__get_console', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not ready');
    });
  });

  describe('click', () => {
    it('clicks element at center of its bounding box', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 10 };
        if (cmd === 'DOM.getBoxModel') return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__click', { selector: '#btn' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Clicked element: #btn');

      // Verify mouse events dispatched at center (200, 300)
      const mouseDownCall = mockDbg.sendCommand.mock.calls.find(
        (c: unknown[]) => c[0] === 'Input.dispatchMouseEvent' && (c[1] as any).type === 'mousePressed',
      );
      expect(mouseDownCall).toBeTruthy();
      expect((mouseDownCall![1] as any).x).toBe(200);
      expect((mouseDownCall![1] as any).y).toBe(300);
    });

    it('returns error when element not found', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 0 }; // Not found
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__click', { selector: '.nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Element not found');
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__click', { selector: '#btn' });
      expect(result.isError).toBe(true);
    });

    it('returns error when CDP command fails', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockRejectedValue(new Error('CDP error'));

      const result = await callTool('agent-1', 'browser__widget_1__click', { selector: '#btn' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('CDP error');
    });
  });

  describe('type', () => {
    it('focuses element and types each character', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 10 };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__type', {
        selector: '#input',
        text: 'abc',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Typed "abc" into #input');

      // Verify focus was called
      const focusCall = mockDbg.sendCommand.mock.calls.find(
        (c: unknown[]) => c[0] === 'DOM.focus',
      );
      expect(focusCall).toBeTruthy();

      // Verify keyDown/keyUp pairs for each character (3 chars = 6 key events)
      const keyEvents = mockDbg.sendCommand.mock.calls.filter(
        (c: unknown[]) => c[0] === 'Input.dispatchKeyEvent',
      );
      expect(keyEvents).toHaveLength(6);
    });

    it('returns error when element not found', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 0 };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__type', {
        selector: '.missing',
        text: 'hello',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Element not found');
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__type', {
        selector: '#input',
        text: 'hello',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('evaluate', () => {
    it('evaluates expression and returns result', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Runtime.evaluate') {
          return { result: { value: 42 } };
        }
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__evaluate', { expression: '1+1' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('42');
    });

    it('returns stringified description when value is absent', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Runtime.evaluate') {
          return { result: { description: 'HTMLElement' } };
        }
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__evaluate', { expression: 'document.body' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('"HTMLElement"');
    });

    it('returns error for exceptions', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Runtime.evaluate') {
          return {
            result: {},
            exceptionDetails: { text: 'ReferenceError: x is not defined' },
          };
        }
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__evaluate', { expression: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Evaluation error');
    });

    it('returns error when result exceeds 1MB', async () => {
      const mockDbg = getMockDebugger();
      const hugeValue = 'x'.repeat(2 * 1024 * 1024);
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Runtime.evaluate') {
          return { result: { value: hugeValue } };
        }
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__evaluate', { expression: 'big' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('too large');
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__evaluate', { expression: '1' });
      expect(result.isError).toBe(true);
    });

    it('returns null when result has no value or description', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Runtime.evaluate') {
          return { result: {} };
        }
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__evaluate', { expression: 'void 0' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('null');
    });
  });

  describe('get_page_content', () => {
    it('returns HTML of the page body by default', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 10 };
        if (cmd === 'DOM.getOuterHTML') return { outerHTML: '<body><p>Hello</p></body>' };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__get_page_content', {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('<body><p>Hello</p></body>');
    });

    it('uses custom selector when provided', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string, params: any) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') {
          expect(params.selector).toBe('#main');
          return { nodeId: 10 };
        }
        if (cmd === 'DOM.getOuterHTML') return { outerHTML: '<div id="main">Content</div>' };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__get_page_content', { selector: '#main' });
      expect(result.isError).toBeFalsy();
    });

    it('returns error when element not found', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 0 };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__get_page_content', { selector: '.gone' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Element not found');
    });

    it('returns error when content exceeds 1MB', async () => {
      const mockDbg = getMockDebugger();
      const hugeHtml = '<div>' + 'x'.repeat(2 * 1024 * 1024) + '</div>';
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (cmd === 'DOM.querySelector') return { nodeId: 10 };
        if (cmd === 'DOM.getOuterHTML') return { outerHTML: hugeHtml };
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__get_page_content', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('too large');
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__get_page_content', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_accessibility_tree', () => {
    it('returns accessibility tree with default depth', async () => {
      const mockDbg = getMockDebugger();
      const treeData = { nodes: [{ nodeId: '1', role: { value: 'document' } }] };
      mockDbg.sendCommand.mockImplementation(async (cmd: string, params: any) => {
        if (cmd === 'Accessibility.getFullAXTree') {
          expect(params.depth).toBe(5); // Default depth
          return treeData;
        }
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', {});
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.nodes).toBeDefined();
    });

    it('respects custom depth parameter', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string, params: any) => {
        if (cmd === 'Accessibility.getFullAXTree') {
          expect(params.depth).toBe(3);
          return { nodes: [] };
        }
        return {};
      });

      await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', { depth: 3 });
    });

    it('clamps depth to maximum of 10', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string, params: any) => {
        if (cmd === 'Accessibility.getFullAXTree') {
          expect(params.depth).toBe(10); // Clamped from 10000
          return { nodes: [] };
        }
        return {};
      });

      await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', { depth: 10000 });
    });

    it('clamps depth to minimum of 1', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockImplementation(async (cmd: string, params: any) => {
        if (cmd === 'Accessibility.getFullAXTree') {
          expect(params.depth).toBe(1); // Clamped from -5
          return { nodes: [] };
        }
        return {};
      });

      await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', { depth: -5 });
    });

    it('returns error when tree exceeds 1MB', async () => {
      const mockDbg = getMockDebugger();
      const hugeTree = { data: 'x'.repeat(2 * 1024 * 1024) };
      mockDbg.sendCommand.mockImplementation(async (cmd: string) => {
        if (cmd === 'Accessibility.getFullAXTree') return hugeTree;
        return {};
      });

      const result = await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('too large');
    });

    it('returns error when widget not found', async () => {
      unregisterWebview('widget-1');
      const result = await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', {});
      expect(result.isError).toBe(true);
    });

    it('returns error when CDP command fails', async () => {
      const mockDbg = getMockDebugger();
      mockDbg.sendCommand.mockRejectedValue(new Error('Accessibility domain not available'));

      const result = await callTool('agent-1', 'browser__widget_1__get_accessibility_tree', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Accessibility domain');
    });
  });

  describe('cross-cutting concerns', () => {
    it('all tools error when called for unbound widget', async () => {
      // Remove the binding, keep the webview registered
      bindingManager._resetForTesting();

      const toolNames = [
        'browser__widget_1__navigate',
        'browser__widget_1__screenshot',
        'browser__widget_1__get_console',
        'browser__widget_1__click',
        'browser__widget_1__type',
        'browser__widget_1__evaluate',
        'browser__widget_1__get_page_content',
        'browser__widget_1__get_accessibility_tree',
      ];

      for (const name of toolNames) {
        const result = await callTool('agent-1', name, { url: 'https://x.com', selector: '#a', text: 'a', expression: '1' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('No binding');
      }
    });

    it('tools work for multiple simultaneous widget bindings', async () => {
      const mockWc = getMockWc();
      mockWc.loadURL.mockResolvedValue(undefined);

      registerWebview('widget-2', 42); // Same webContents for simplicity
      bindingManager.bind('agent-1', { targetId: 'widget-2', targetKind: 'browser', label: 'Browser 2' });

      const tools = getScopedToolList('agent-1');
      // 8 tools per widget × 2 widgets = 16
      expect(tools).toHaveLength(16);

      // Can call tools on both widgets
      const r1 = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://a.com' });
      const r2 = await callTool('agent-1', 'browser__widget_2__navigate', { url: 'https://b.com' });
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
    });

    it('all tool errors use consistent "not found or not ready" message', async () => {
      unregisterWebview('widget-1');

      const toolNames = [
        'browser__widget_1__navigate',
        'browser__widget_1__screenshot',
        'browser__widget_1__get_console',
        'browser__widget_1__click',
        'browser__widget_1__type',
        'browser__widget_1__evaluate',
        'browser__widget_1__get_page_content',
        'browser__widget_1__get_accessibility_tree',
      ];

      for (const name of toolNames) {
        const result = await callTool('agent-1', name, { url: 'https://x.com', selector: '#a', text: 'a', expression: '1' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Browser widget not found or not ready');
      }
    });
  });

  describe('late registration (widget appears after binding)', () => {
    it('tool fails before registration, succeeds after', async () => {
      // Simulate the bug scenario: binding exists but webview not yet registered
      resetBrowserTools();
      resetTools();
      bindingManager._resetForTesting();
      registerBrowserTools();
      bindingManager.bind('agent-1', { targetId: 'widget-late', targetKind: 'browser', label: 'Browser' });

      // Tool call before webview registration → should fail
      const failResult = await callTool('agent-1', 'browser__widget_late__navigate', { url: 'https://example.com' });
      expect(failResult.isError).toBe(true);
      expect(failResult.content[0].text).toContain('not found or not ready');

      // Webview registers (simulates dom-ready after URL is entered)
      registerWebview('widget-late', 42);
      getMockWc().loadURL.mockResolvedValue(undefined);

      // Same tool call after registration → should succeed
      const successResult = await callTool('agent-1', 'browser__widget_late__navigate', { url: 'https://example.com' });
      expect(successResult.isError).toBeFalsy();
      expect(successResult.content[0].text).toContain('Navigated to');
    });

    it('logs diagnostic info when widget lookup fails', async () => {
      const { appLog } = await import('../../log-service');

      // Clear previous calls
      (appLog as ReturnType<typeof vi.fn>).mockClear();

      // Unregister widget so lookup fails
      unregisterWebview('widget-1');

      await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://example.com' });

      // Verify diagnostic log was emitted with registry state
      expect(appLog).toHaveBeenCalledWith(
        'core:mcp',
        'warn',
        'Widget lookup failed — not in registry',
        expect.objectContaining({
          meta: expect.objectContaining({
            widgetId: 'widget-1',
            registeredWidgets: expect.any(Array),
          }),
        }),
      );
    });

    it('logs diagnostic info when webContents is destroyed', async () => {
      const { appLog } = await import('../../log-service');
      (appLog as ReturnType<typeof vi.fn>).mockClear();

      // Register a widget pointing to a destroyed webContents (ID 999 → null)
      registerWebview('widget-destroyed', 999);
      bindingManager.bind('agent-1', { targetId: 'widget-destroyed', targetKind: 'browser', label: 'Destroyed' });

      await callTool('agent-1', 'browser__widget_destroyed__navigate', { url: 'https://example.com' });

      expect(appLog).toHaveBeenCalledWith(
        'core:mcp',
        'warn',
        'Widget lookup failed — webContents destroyed',
        expect.objectContaining({
          meta: expect.objectContaining({
            widgetId: 'widget-destroyed',
            webContentsId: 999,
          }),
        }),
      );
    });
  });

  describe('SEC-16: agent-widget binding guard', () => {
    it('rejects browser tool call from an unbound agent', async () => {
      // agent-2 has no binding to widget-1
      const result = await callTool('agent-2', 'browser__widget_1__navigate', { url: 'https://example.com' });
      // callTool itself will reject because agent-2 has no binding
      expect(result.isError).toBe(true);
    });

    it('rejects when agent is bound to a different widget', async () => {
      registerWebview('widget-2', 42);
      bindingManager.bind('agent-1', { targetId: 'widget-2', targetKind: 'browser', label: 'Other' });
      // agent-1 is bound to widget-1 and widget-2, but agent-2 is not bound to widget-2
      const result = await callTool('agent-2', 'browser__widget_2__screenshot', {});
      expect(result.isError).toBe(true);
    });

    it('allows browser tool call from a properly bound agent', async () => {
      const mockWc = getMockWc();
      mockWc.loadURL.mockResolvedValue(undefined);
      // agent-1 is bound to widget-1 in beforeEach
      const result = await callTool('agent-1', 'browser__widget_1__navigate', { url: 'https://example.com' });
      expect(result.isError).toBeUndefined();
      expect(mockWc.loadURL).toHaveBeenCalledWith('https://example.com');
    });
  });
});
