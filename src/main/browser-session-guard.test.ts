import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  session: { fromPartition: vi.fn(() => ({ protocol: { handle } })) },
}));
vi.mock('./services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('./browser-file-access', () => ({
  BROWSER_FILE_SETTING_LOCATION: 'Settings > Plugins > Browser > Allow file:// URLs',
  isBrowserFileAccessAllowed: vi.fn(() => false),
}));

import { net, session } from 'electron';
import { isBrowserFileAccessAllowed } from './browser-file-access';
import { appLog } from './services/log-service';
import * as fs from 'fs';
import * as path from 'path';
import { _resetBrowserSessionGuardForTesting, handleBrowserFileRequest, installBrowserSessionGuard } from './browser-session-guard';

describe('Browser session file:// gate (#3869)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetBrowserSessionGuardForTesting();
    vi.mocked(isBrowserFileAccessAllowed).mockReturnValue(false);
  });

  it('installs a file handler on the Browser session only', () => {
    installBrowserSessionGuard();
    expect(session.fromPartition).toHaveBeenCalledWith('persist:plugin-browser');
    expect(handle).toHaveBeenCalledWith('file', expect.any(Function));
  });

  it('installs once per process', () => {
    installBrowserSessionGuard();
    installBrowserSessionGuard();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('is installed on app ready before the first window, so before any Browser webview can attach', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    const ready = source.indexOf("app.on('ready'");
    const install = source.indexOf('installBrowserSessionGuard();', ready);
    const firstWindow = source.indexOf('createWindow();', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(ready);
    expect(firstWindow).toBeGreaterThan(install);
  });

  // Chromium lowercases the scheme before a handler sees it, and file://localhost
  // and file://host forms are still the file scheme, so they reach this handler too.
  it.each([
    'file:///etc/hosts',
    'FILE:///etc/hosts',
    'file://localhost/etc/hosts',
    'file:///C:/Users/someone/secret.html',
    'file://server/share/doc.html',
    'FiLe:///etc/hosts',
    'file:////server/share/doc.html',
    'file://LOCALHOST/etc/hosts',
    'file:///etc/hosts?x=1#y',
  ])('answers 403 and reads nothing for %s when the setting is off everywhere', async (url) => {
    const passThrough = vi.fn();
    const res = await handleBrowserFileRequest(new Request(url), { allowed: () => false, passThrough });
    expect(res.status).toBe(403);
    expect(passThrough).not.toHaveBeenCalled();
  });

  it('logs protocol and host only', async () => {
    await handleBrowserFileRequest(new Request('file://server/Users/someone/secret.html?token=x'));
    const logged = JSON.stringify(vi.mocked(appLog).mock.calls);
    expect(logged).toContain('"stage":"browser-session-file"');
    expect(logged).toContain('"host":"server"');
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('token');
  });

  it('passes the request through unchanged when the setting is on', async () => {
    const ok = new Response('local page');
    const passThrough = vi.fn(async () => ok);
    const request = new Request('file:///tmp/page.html');
    expect(await handleBrowserFileRequest(request, { allowed: () => true, passThrough })).toBe(ok);
    expect(passThrough).toHaveBeenCalledWith(request);
  });

  it('answers a clean 404 when the pass-through fails (missing file, unreadable directory)', async () => {
    const res = await handleBrowserFileRequest(new Request('file:///no/such/file.html'), {
      allowed: () => true,
      passThrough: async () => { throw new Error('net::ERR_FILE_NOT_FOUND'); },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('/no/such');
  });

  it('uses net.fetch with custom handlers bypassed for the pass-through', async () => {
    vi.mocked(isBrowserFileAccessAllowed).mockReturnValue(true);
    vi.mocked(net.fetch).mockResolvedValue(new Response('x'));
    const request = new Request('file:///tmp/page.html');
    await handleBrowserFileRequest(request);
    expect(net.fetch).toHaveBeenCalledWith(request, { bypassCustomProtocolHandlers: true });
  });

  it('checks the setting on every request', async () => {
    vi.mocked(isBrowserFileAccessAllowed).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(net.fetch).mockResolvedValue(new Response('x'));
    expect((await handleBrowserFileRequest(new Request('file:///a'))).status).toBe(200);
    expect((await handleBrowserFileRequest(new Request('file:///a'))).status).toBe(403);
  });
});
