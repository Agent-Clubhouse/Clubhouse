import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PluginManifest } from '../../shared/plugin-types';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}));

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

vi.mock('../services/clubhouse-mcp/plugin-tool-registry', () => ({
  registerPluginTools: vi.fn(),
  removePluginTools: vi.fn(),
  listPluginTools: vi.fn(),
  resolvePluginToolCall: vi.fn(() => true),
}));

import { BrowserWindow, ipcMain } from 'electron';
import {
  listPluginTools,
  registerPluginTools,
  removePluginTools,
  resolvePluginToolCall,
} from '../services/clubhouse-mcp/plugin-tool-registry';
import { _resetForTesting as resetTokens, resolveToken } from '../services/clubhouse-mcp/plugin-mcp-tokens';
import { clear as clearManifests, registerTrustedManifest } from '../services/plugin-manifest-registry';
import { IPC } from '../../shared/ipc-channels';
import { _resetForTesting as resetHandlers, configurePluginMcpHost, registerPluginMcpHandlers } from './plugin-mcp-handlers';

type Listener = (...args: unknown[]) => void;

const ENTRY = 'http://localhost:3000/main_window/index.html';
const MAIN = 1;

/** A fake renderer page: its webContents id, top frame URL, and the listeners main put on it. */
function makePage(id: number, url = ENTRY) {
  const listeners = new Map<string, Listener[]>();
  const add = (name: string, fn: Listener) => listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  const mainFrame = { url };
  const sender = { id, on: vi.fn(add), once: vi.fn(add), mainFrame };
  return {
    event: { sender, senderFrame: mainFrame as { url: string } },
    emit: (name: string, ...args: unknown[]) => { for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
}

function manifest(id: string, permissions: PluginManifest['permissions']): PluginManifest {
  return { id, name: id, version: '1.0.0', engine: { api: 0.9 }, scope: 'project', permissions, contributes: { help: {} } };
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as (...args: unknown[]) => unknown;
}

function toolResultListener(): (event: unknown, data: unknown) => void {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([ch]) => ch === IPC.PLUGIN_MCP.TOOL_RESULT);
  return call![1] as (event: unknown, data: unknown) => void;
}

const tools = [{ name: 'tool1', description: 'A tool', inputSchema: { type: 'object' } }];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('plugin-mcp-handlers', () => {
  let page: ReturnType<typeof makePage>;
  let secret: string;

  /** Claim the issuer and issue a token, as the renderer's plugin host does. */
  async function tokenFor(pluginId: string, p = page, s = secret): Promise<string> {
    return await handler(IPC.PLUGIN_MCP.ISSUE_TOKEN)(p.event, s, pluginId) as string;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetTokens();
    resetHandlers();
    clearManifests();
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never);
    registerTrustedManifest('plugin-a', manifest('plugin-a', ['mcp.tools']));
    registerTrustedManifest('plugin-b', manifest('plugin-b', ['mcp.tools']));
    registerTrustedManifest('no-mcp', manifest('no-mcp', ['files']));
    registerPluginMcpHandlers();
    configurePluginMcpHost({ getMainWebContentsId: () => MAIN, entryUrl: ENTRY });
    page = makePage(MAIN);
    secret = handler(IPC.PLUGIN_MCP.CLAIM_ISSUER)(page.event) as string;
  });

  describe('issuer and tokens', () => {
    it('issues unguessable tokens that resolve to the plugin they were issued for', async () => {
      const token = await tokenFor('plugin-a');
      expect(token).toMatch(UUID);
      expect(resolveToken(token)).toEqual({ pluginId: 'plugin-a', webContentsId: 1 });
    });

    it('refuses a second claim of the issuer from the same page', () => {
      expect(() => handler(IPC.PLUGIN_MCP.CLAIM_ISSUER)(page.event)).toThrow(/already claimed/);
    });

    describe('only the plugin host can claim it', () => {
      const claim = (event: unknown) => {
        resetTokens(); // free the issuer the main page claimed in beforeEach
        return () => handler(IPC.PLUGIN_MCP.CLAIM_ISSUER)(event);
      };

      it('refuses a window.open child or pop-out, which inherit the preload and are app windows', () => {
        // Even showing an app URL: it is not the main window.
        expect(claim(makePage(2).event)).toThrow(/not the plugin host/);
        expect(claim(makePage(2, 'file:///plugins/evil/claim.html').event)).toThrow(/not the plugin host/);
      });

      it('refuses the main window once it shows anything but the app entry page', () => {
        expect(claim(makePage(MAIN, 'file:///plugins/evil/claim.html').event)).toThrow(/not the plugin host/);
        expect(claim(makePage(MAIN, 'http://localhost:3000/other/index.html').event)).toThrow(/not the plugin host/);
      });

      it('refuses a subframe of the main window', () => {
        const p = makePage(MAIN);
        expect(claim({ ...p.event, senderFrame: { url: ENTRY } })).toThrow(/not the plugin host/);
      });

      it('refuses a webview, and refuses everyone before the host is configured', () => {
        vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
        expect(claim(makePage(MAIN).event)).toThrow(/not the plugin host/);
        vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({} as never);
        resetHandlers();
        expect(claim(makePage(MAIN).event)).toThrow(/not the plugin host/);
      });

      it('accepts the main window on the entry page, whatever its query or hash', () => {
        expect(claim(makePage(MAIN, `${ENTRY}?popout=0#/projects`).event)()).toMatch(UUID);
      });
    });

    it('refuses a token without the issuer secret, or for a plugin without mcp.tools', async () => {
      await expect(tokenFor('plugin-a', page, 'guessed')).rejects.toThrow(/not the plugin host/);
      await expect(tokenFor('no-mcp')).rejects.toThrow(/requires 'mcp.tools'/);
      await expect(tokenFor('not-installed')).rejects.toThrow(/requires 'mcp.tools'/);
    });

    it("refuses a second issuer while one is held, from any page", () => {
      expect(() => handler(IPC.PLUGIN_MCP.CLAIM_ISSUER)(makePage(MAIN).event)).toThrow(/already claimed/);
    });

    it("refuses one page's secret on another page", async () => {
      const other = makePage(2);
      await expect(tokenFor('plugin-a', other, secret)).rejects.toThrow(/not the plugin host/);
    });
  });

  describe('every operation resolves the plugin from the token', () => {
    it('contribute, remove and list act on the plugin the token was issued for', async () => {
      const token = await tokenFor('plugin-a');
      vi.mocked(listPluginTools).mockReturnValueOnce(['plugin__plugin_a__tool1']);

      await handler(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS)(page.event, token, tools);
      await expect(handler(IPC.PLUGIN_MCP.LIST_TOOLS)(page.event, token)).resolves.toEqual(['plugin__plugin_a__tool1']);
      await handler(IPC.PLUGIN_MCP.REMOVE_TOOLS)(page.event, token);

      expect(registerPluginTools).toHaveBeenCalledWith('plugin-a', tools);
      expect(listPluginTools).toHaveBeenCalledWith('plugin-a');
      expect(removePluginTools).toHaveBeenCalledWith('plugin-a');
    });

    it.each([
      [IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, [tools]],
      [IPC.PLUGIN_MCP.REMOVE_TOOLS, []],
      [IPC.PLUGIN_MCP.LIST_TOOLS, []],
    ])('%s rejects a forged pluginId in place of a token', async (channel, rest) => {
      await expect(handler(channel)(page.event, 'plugin-a', ...rest)).rejects.toThrow(/unknown or revoked token/);
      expect(registerPluginTools).not.toHaveBeenCalled();
      expect(removePluginTools).not.toHaveBeenCalled();
      expect(listPluginTools).not.toHaveBeenCalled();
    });

    it.each([IPC.PLUGIN_MCP.REMOVE_TOOLS, IPC.PLUGIN_MCP.LIST_TOOLS])(
      "%s from plugin B can only reach B's tools, never A's",
      async (channel) => {
        await tokenFor('plugin-a');
        const bToken = await tokenFor('plugin-b');
        await handler(channel)(page.event, bToken);
        const target = channel === IPC.PLUGIN_MCP.REMOVE_TOOLS ? removePluginTools : listPluginTools;
        expect(target).toHaveBeenCalledWith('plugin-b');
        expect(target).not.toHaveBeenCalledWith('plugin-a');
      },
    );

    it("rejects a token used from a page other than the one it was issued to", async () => {
      const token = await tokenFor('plugin-a');
      const other = makePage(2);
      await expect(handler(IPC.PLUGIN_MCP.LIST_TOOLS)(other.event, token)).rejects.toThrow(/unknown or revoked token/);
    });

    it('rechecks mcp.tools on every operation, so a manifest that loses it loses access', async () => {
      const token = await tokenFor('plugin-a');
      registerTrustedManifest('plugin-a', manifest('plugin-a', ['files']));
      await expect(handler(IPC.PLUGIN_MCP.LIST_TOOLS)(page.event, token)).rejects.toThrow(/requires 'mcp.tools'/);
    });

    it.each([
      ['a missing tool name', [{ description: 'desc', inputSchema: {} }], 'name must be a non-empty string'],
      ['a missing description', [{ name: 'tool', inputSchema: {} }], 'description must be a non-empty string'],
      ['a missing inputSchema', [{ name: 'tool', description: 'desc' }], 'inputSchema must be an object'],
      ['an array inputSchema', [{ name: 'tool', description: 'desc', inputSchema: [] }], 'inputSchema must be an object'],
      ['tools that are not an array', 'nope', 'must be an array'],
    ])('contribute rejects %s', async (_label, bad, message) => {
      const token = await tokenFor('plugin-a');
      expect(() => handler(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS)(page.event, token, bad)).toThrow(message);
    });
  });

  describe('revocation', () => {
    it('a revoked token is refused, and the plugin loses its tools when its last token goes', async () => {
      const first = await tokenFor('plugin-a');
      const second = await tokenFor('plugin-a');

      await handler(IPC.PLUGIN_MCP.REVOKE_TOKEN)(page.event, first);
      expect(removePluginTools).not.toHaveBeenCalled();
      await expect(handler(IPC.PLUGIN_MCP.LIST_TOOLS)(page.event, first)).rejects.toThrow(/unknown or revoked token/);

      await handler(IPC.PLUGIN_MCP.REVOKE_TOKEN)(page.event, second);
      expect(removePluginTools).toHaveBeenCalledWith('plugin-a');
    });

    it("a page can't revoke another page's token", async () => {
      const token = await tokenFor('plugin-a');
      await handler(IPC.PLUGIN_MCP.REVOKE_TOKEN)(makePage(2).event, token);
      expect(resolveToken(token)).toBeDefined();
    });

    it('a committed reload revokes the tokens and frees the issuer for the new page', async () => {
      const token = await tokenFor('plugin-a');
      page.emit('did-navigate', {}, ENTRY);

      expect(resolveToken(token)).toBeUndefined();
      expect(removePluginTools).toHaveBeenCalledWith('plugin-a');
      expect(handler(IPC.PLUGIN_MCP.CLAIM_ISSUER)(page.event)).toMatch(UUID);
    });

    it('a navigation that starts but never commits (a download, window.stop) keeps the tokens and the issuer', async () => {
      const token = await tokenFor('plugin-a');
      page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });

      expect(resolveToken(token)).toBeDefined();
      expect(removePluginTools).not.toHaveBeenCalled();
      expect(() => handler(IPC.PLUGIN_MCP.CLAIM_ISSUER)(makePage(MAIN).event)).toThrow(/already claimed/);
    });

    it('destroying the page revokes its tokens', async () => {
      const token = await tokenFor('plugin-a');
      page.emit('destroyed');
      expect(resolveToken(token)).toBeUndefined();
    });
  });

  describe('tool results', () => {
    const result = { content: [{ type: 'text' as const, text: 'ok' }] };

    it('resolves the call as the plugin the token belongs to', async () => {
      const token = await tokenFor('plugin-a');
      toolResultListener()(page.event, { token, callId: 'c1', result });
      expect(resolvePluginToolCall).toHaveBeenCalledWith('c1', result, 'plugin-a');
    });

    it.each([
      ['no token', (_t: string) => ({ callId: 'c1', result })],
      ['a forged token', (_t: string) => ({ token: 'plugin-a', callId: 'c1', result })],
    ])('drops a spoofed result with %s', async (_label, build) => {
      const token = await tokenFor('plugin-a');
      expect(() => toolResultListener()(page.event, build(token))).not.toThrow();
      expect(resolvePluginToolCall).not.toHaveBeenCalled();
    });

    it("drops a result sent with a token from another page", async () => {
      const token = await tokenFor('plugin-a');
      toolResultListener()(makePage(2).event, { token, callId: 'c1', result });
      expect(resolvePluginToolCall).not.toHaveBeenCalled();
    });

    it.each([
      ['null', null],
      ['a missing callId', { result: { content: [] } }],
      ['a result without content', { callId: 'c1', result: {} }],
    ])('drops a malformed tool result (%s) without throwing', async (_label, payload) => {
      const token = await tokenFor('plugin-a');
      const data = payload && { token, ...payload };
      expect(() => toolResultListener()(page.event, data)).not.toThrow();
      expect(resolvePluginToolCall).not.toHaveBeenCalled();
    });
  });
});

describe('registerPluginMcpHandlers registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHandlers();
  });

  it('replaces its own handlers and listener, so registering again never throws', () => {
    registerPluginMcpHandlers();
    registerPluginMcpHandlers();

    const channels = [
      IPC.PLUGIN_MCP.CLAIM_ISSUER, IPC.PLUGIN_MCP.ISSUE_TOKEN, IPC.PLUGIN_MCP.REVOKE_TOKEN,
      IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, IPC.PLUGIN_MCP.REMOVE_TOOLS, IPC.PLUGIN_MCP.LIST_TOOLS,
    ];
    const removed = vi.mocked(ipcMain.removeHandler).mock.calls.map(([ch]) => ch);
    expect(removed).toEqual([...channels, ...channels]);
    // Each removeHandler precedes its handle: a second handle() on a channel throws in Electron.
    const removeOrder = vi.mocked(ipcMain.removeHandler).mock.invocationCallOrder;
    const handleOrder = vi.mocked(ipcMain.handle).mock.invocationCallOrder;
    expect(removeOrder[channels.length]).toBeLessThan(handleOrder[channels.length]);
    // The same listener function is removed and re-added, so results never resolve twice.
    const [[, onListener]] = vi.mocked(ipcMain.on).mock.calls;
    expect(vi.mocked(ipcMain.removeListener).mock.calls[1]).toEqual([IPC.PLUGIN_MCP.TOOL_RESULT, onListener]);
  });
});
