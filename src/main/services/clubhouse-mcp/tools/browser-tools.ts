/**
 * Browser Widget MCP Tools — allows agents to interact with canvas browser widgets via CDP.
 * Phase 3 implementation.
 */

import { webContents } from 'electron';
import { registerToolTemplate } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';

/** Map of widgetId → webContentsId for registered browser webviews. */
const webviewRegistry = new Map<string, number>();

/** Map of webContentsId → boolean indicating if debugger is attached. */
const attachedDebuggers = new Map<number, boolean>();

/** Console log buffer per webContentsId. */
const consoleBuffers = new Map<number, Array<{ level: string; text: string; timestamp: number }>>();
const MAX_CONSOLE_ENTRIES = 500;

export function registerWebview(widgetId: string, webContentsId: number): void {
  webviewRegistry.set(widgetId, webContentsId);
  appLog('core:mcp', 'debug', 'Webview registered', { meta: { widgetId, webContentsId } });
}

export function unregisterWebview(widgetId: string): void {
  const wcId = webviewRegistry.get(widgetId);
  if (wcId !== undefined) {
    detachDebugger(wcId);
    consoleBuffers.delete(wcId);
  }
  webviewRegistry.delete(widgetId);
}

function getWebContents(widgetId: string): Electron.WebContents | null {
  const wcId = webviewRegistry.get(widgetId);
  if (wcId === undefined) return null;
  return webContents.fromId(wcId) || null;
}

async function ensureDebuggerAttached(wc: Electron.WebContents): Promise<void> {
  const wcId = wc.id;
  if (attachedDebuggers.get(wcId)) return;

  try {
    wc.debugger.attach('1.3');
    attachedDebuggers.set(wcId, true);

    // Enable Runtime domain for console logging
    await wc.debugger.sendCommand('Runtime.enable');
    await wc.debugger.sendCommand('DOM.enable');

    // Listen for console messages
    wc.debugger.on('message', (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Runtime.consoleAPICalled') {
        const buffer = consoleBuffers.get(wcId) || [];
        const args = (params.args as Array<{ type: string; value?: unknown; description?: string }>) || [];
        const text = args.map(a => a.description || String(a.value ?? '')).join(' ');
        buffer.push({
          level: params.type as string,
          text,
          timestamp: Date.now(),
        });
        // Cap buffer size
        while (buffer.length > MAX_CONSOLE_ENTRIES) buffer.shift();
        consoleBuffers.set(wcId, buffer);
      }
    });

    wc.debugger.on('detach', () => {
      attachedDebuggers.delete(wcId);
      consoleBuffers.delete(wcId);
    });

    wc.on('destroyed', () => {
      attachedDebuggers.delete(wcId);
      consoleBuffers.delete(wcId);
    });
  } catch (err) {
    appLog('core:mcp', 'error', 'Failed to attach debugger', {
      meta: { webContentsId: wcId, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

function detachDebugger(wcId: number): void {
  if (!attachedDebuggers.get(wcId)) return;
  try {
    const wc = webContents.fromId(wcId);
    if (wc) wc.debugger.detach();
  } catch { /* already detached */ }
  attachedDebuggers.delete(wcId);
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** For testing: clear all internal state. */
export function _resetForTesting(): void {
  webviewRegistry.clear();
  attachedDebuggers.clear();
  consoleBuffers.clear();
}

/** Register all browser widget tool templates. */
export function registerBrowserTools(): void {
  // browser__<id>__navigate
  registerToolTemplate('browser', 'navigate', {
    description: 'Navigate the browser widget to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to (http/https only).' },
      },
      required: ['url'],
    },
  }, async (targetId, agentId, args) => {
    const url = args.url as string;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return errorResult('URL must start with http:// or https://');
    }
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found or not ready');

    try {
      await wc.loadURL(url);
      return textResult(`Navigated to ${url}`);
    } catch (err) {
      return errorResult(`Navigation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // browser__<id>__screenshot
  registerToolTemplate('browser', 'screenshot', {
    description: 'Take a screenshot of the browser widget.',
    inputSchema: { type: 'object', properties: {} },
  }, async (targetId) => {
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found or not ready');

    try {
      const image = await wc.capturePage();
      const png = image.toPNG();
      const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB
      if (png.length > MAX_SCREENSHOT_SIZE) {
        return errorResult(`Screenshot too large (${(png.length / 1024 / 1024).toFixed(1)}MB, max 5MB). Try reducing the page size.`);
      }
      return {
        content: [{
          type: 'image',
          data: png.toString('base64'),
          mimeType: 'image/png',
        }],
      };
    } catch (err) {
      return errorResult(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // browser__<id>__get_console
  registerToolTemplate('browser', 'get_console', {
    description: 'Get recent console log messages from the browser widget.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of entries to return (default 50).' },
      },
    },
  }, async (targetId, _agentId, args) => {
    const wcId = webviewRegistry.get(targetId);
    if (wcId === undefined) return errorResult('Browser widget not found');

    const wc = webContents.fromId(wcId);
    if (!wc) return errorResult('Browser widget not ready');

    await ensureDebuggerAttached(wc);
    const buffer = consoleBuffers.get(wcId) || [];
    const limit = Math.min(Math.max(Math.floor((args.limit as number) || 50), 1), 500);
    const entries = buffer.slice(-limit);
    return textResult(JSON.stringify(entries, null, 2));
  });

  // browser__<id>__click
  registerToolTemplate('browser', 'click', {
    description: 'Click an element in the browser widget by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
      },
      required: ['selector'],
    },
  }, async (targetId, _agentId, args) => {
    const selector = args.selector as string;
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found');

    try {
      await ensureDebuggerAttached(wc);
      const doc = await wc.debugger.sendCommand('DOM.getDocument') as { root: { nodeId: number } };
      const result = await wc.debugger.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      }) as { nodeId: number };

      if (!result.nodeId) return errorResult(`Element not found: ${selector}`);

      const boxModel = await wc.debugger.sendCommand('DOM.getBoxModel', { nodeId: result.nodeId }) as {
        model: { content: number[] };
      };
      const content = boxModel.model.content;
      const x = (content[0] + content[2]) / 2;
      const y = (content[1] + content[5]) / 2;

      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

      return textResult(`Clicked element: ${selector}`);
    } catch (err) {
      return errorResult(`Click failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // browser__<id>__type
  registerToolTemplate('browser', 'type', {
    description: 'Type text into a focused element in the browser widget.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to type into.' },
        text: { type: 'string', description: 'The text to type.' },
      },
      required: ['selector', 'text'],
    },
  }, async (targetId, _agentId, args) => {
    const selector = args.selector as string;
    const text = args.text as string;
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found');

    try {
      await ensureDebuggerAttached(wc);

      // Focus the element
      const doc = await wc.debugger.sendCommand('DOM.getDocument') as { root: { nodeId: number } };
      const result = await wc.debugger.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      }) as { nodeId: number };

      if (!result.nodeId) return errorResult(`Element not found: ${selector}`);
      await wc.debugger.sendCommand('DOM.focus', { nodeId: result.nodeId });

      // Type each character
      for (const char of text) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
      }

      return textResult(`Typed "${text}" into ${selector}`);
    } catch (err) {
      return errorResult(`Type failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // browser__<id>__evaluate
  registerToolTemplate('browser', 'evaluate', {
    description: 'Evaluate a JavaScript expression in the browser widget page context.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The JavaScript expression to evaluate.' },
      },
      required: ['expression'],
    },
  }, async (targetId, _agentId, args) => {
    const expression = args.expression as string;
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found');

    try {
      await ensureDebuggerAttached(wc);
      const result = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
      }) as { result: { value?: unknown; description?: string }; exceptionDetails?: unknown };

      if (result.exceptionDetails) {
        return errorResult(`Evaluation error: ${JSON.stringify(result.exceptionDetails)}`);
      }

      const value = JSON.stringify(result.result?.value ?? result.result?.description ?? null);
      // Cap result size at 1MB
      if (value.length > 1024 * 1024) {
        return errorResult('Result too large (>1MB)');
      }
      return textResult(value);
    } catch (err) {
      return errorResult(`Evaluate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // browser__<id>__get_page_content
  registerToolTemplate('browser', 'get_page_content', {
    description: 'Get the HTML content of the page or a specific element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (optional, defaults to document body).' },
      },
    },
  }, async (targetId, _agentId, args) => {
    const selector = (args.selector as string) || 'body';
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found');

    try {
      await ensureDebuggerAttached(wc);
      const doc = await wc.debugger.sendCommand('DOM.getDocument') as { root: { nodeId: number } };
      const result = await wc.debugger.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      }) as { nodeId: number };

      if (!result.nodeId) return errorResult(`Element not found: ${selector}`);

      const html = await wc.debugger.sendCommand('DOM.getOuterHTML', { nodeId: result.nodeId }) as { outerHTML: string };
      const content = html.outerHTML;

      if (content.length > 1024 * 1024) {
        return errorResult('Content too large (>1MB)');
      }
      return textResult(content);
    } catch (err) {
      return errorResult(`Failed to get content: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // browser__<id>__get_accessibility_tree
  registerToolTemplate('browser', 'get_accessibility_tree', {
    description: 'Get the accessibility tree of the browser widget page.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'number', description: 'Maximum depth to traverse (default 5).' },
      },
    },
  }, async (targetId, _agentId, args) => {
    const depth = Math.min(Math.max(Math.floor((args.depth as number) || 5), 1), 10);
    const wc = getWebContents(targetId);
    if (!wc) return errorResult('Browser widget not found');

    try {
      await ensureDebuggerAttached(wc);
      const tree = await wc.debugger.sendCommand('Accessibility.getFullAXTree', {
        depth,
      });
      const content = JSON.stringify(tree, null, 2);
      if (content.length > 1024 * 1024) {
        return errorResult('Accessibility tree too large (>1MB)');
      }
      return textResult(content);
    } catch (err) {
      return errorResult(`Failed to get accessibility tree: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
