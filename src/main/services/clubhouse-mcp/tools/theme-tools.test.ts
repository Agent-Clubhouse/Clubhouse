import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const data = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => data.dir } }));
vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));
vi.mock('../dispatcher-gate', async (original) => ({ ...await original<typeof import('../dispatcher-gate')>(), isDispatcherAgent: (id: string) => id === 'dispatcher' }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../agent-config', () => ({ getDurableConfig: async () => ({ name: 'Agent' }) }));
vi.mock('../../../telemetry/feature-events', () => ({ themeChanged: vi.fn() }));
vi.mock('../../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../annex-server', () => ({ broadcastThemeChanged: vi.fn() }));

import { registerThemeTools } from './theme-tools';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { getSettings } from '../../theme-service';
import { resetAllSettingsStoresForTests } from '../../settings-store';
import { syncPluginThemes } from '../../plugin-theme-store';
import { _resetGrantRequestsForTesting, listGrantRequests, takeGrantRequest } from '../../grant-requests';
import { updateAgentGrantChanges } from '../../agent-grants-store';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { IPC } from '../../../../shared/ipc-channels';

const invoke = (id = 'dispatcher', theme_id = 'nord') => callTool(id, 'set_theme', { theme_id });

beforeEach(() => {
  data.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-tools-'));
  vi.clearAllMocks();
  resetAllSettingsStoresForTests();
  _resetGrantRequestsForTesting();
  _resetForTesting();
  syncPluginThemes([{ id: 'plugin:test:ocean', name: 'Ocean', type: 'dark' }, { id: 'custom:mine', name: 'Mine', type: 'light' }]);
  registerThemeTools();
  for (const id of ['dispatcher', 'plain']) agentRegistry.register(id, { projectPath: data.dir, orchestrator: 'claude-code', runtime: 'chat' });
});
afterEach(() => {
  _resetGrantRequestsForTesting();
  for (const id of ['dispatcher', 'plain']) agentRegistry.untrack(id);
  syncPluginThemes([]);
  fs.rmSync(data.dir, { recursive: true, force: true });
});

describe('set_theme', () => {
  it('offers the Dispatcher the tool and enforces approval before saving and applying it', async () => {
    expect(getScopedToolList('dispatcher').map((tool) => tool.name)).toContain('set_theme');
    expect(JSON.stringify(await invoke())).toContain('Needs you');
    expect(getSettings().themeId).toBe('catppuccin-mocha');
    expect(broadcastToAllWindows).not.toHaveBeenCalled();
    const [request] = listGrantRequests();
    expect(request).toMatchObject({ toolName: 'set_theme', argumentsText: JSON.stringify({ theme_id: 'nord' }, null, 2) });
    takeGrantRequest(request.requestId, true);
    expect((await invoke()).isError).toBeFalsy();
    expect(getSettings().themeId).toBe('nord');
    expect(broadcastToAllWindows).toHaveBeenCalledWith(IPC.APP.THEME_CHANGED);
    expect(JSON.stringify(await invoke())).toContain('Needs you');
  });

  it('rejects unknown ids before asking, listing built-in, plugin and custom ids', async () => {
    const result = await invoke('dispatcher', 'missing');
    expect(result.isError).toBe(true);
    for (const id of ['nord', 'plugin:test:ocean', 'custom:mine']) expect(JSON.stringify(result)).toContain(id);
    expect(listGrantRequests()).toEqual([]);
    expect(getSettings().themeId).toBe('catppuccin-mocha');
  });

  it('hides and refuses the tool without a grant, and accepts installed plugin and custom themes with Allow', async () => {
    expect(getScopedToolList('plain').map((tool) => tool.name)).not.toContain('set_theme');
    expect((await invoke('plain')).isError).toBe(true);
    await updateAgentGrantChanges('plain', () => ({ changes: [{ action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' }] }));
    expect(getScopedToolList('plain').map((tool) => tool.name)).toContain('set_theme');
    for (const id of ['plugin:test:ocean', 'custom:mine']) {
      expect((await invoke('plain', id)).isError).toBeFalsy();
      expect(getSettings().themeId).toBe(id);
    }
    expect(listGrantRequests()).toEqual([]);
    await updateAgentGrantChanges('plain', () => undefined);
  });

  it('refuses a theme removed while its approval waits', async () => {
    await invoke('dispatcher', 'plugin:test:ocean');
    takeGrantRequest(listGrantRequests()[0].requestId, true);
    syncPluginThemes([]);
    expect((await invoke('dispatcher', 'plugin:test:ocean')).isError).toBe(true);
    expect(getSettings().themeId).toBe('catppuccin-mocha');
  });
});
