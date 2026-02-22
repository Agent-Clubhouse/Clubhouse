import { describe, it, expect, vi } from 'vitest';

// Mock all handler registration functions
vi.mock('./pty-handlers', () => ({ registerPtyHandlers: vi.fn() }));
vi.mock('./project-handlers', () => ({ registerProjectHandlers: vi.fn() }));
vi.mock('./file-handlers', () => ({ registerFileHandlers: vi.fn() }));
vi.mock('./git-handlers', () => ({ registerGitHandlers: vi.fn() }));
vi.mock('./agent-handlers', () => ({ registerAgentHandlers: vi.fn() }));
vi.mock('./agent-settings-handlers', () => ({ registerAgentSettingsHandlers: vi.fn() }));
vi.mock('./app-handlers', () => ({ registerAppHandlers: vi.fn() }));
vi.mock('./plugin-handlers', () => ({ registerPluginHandlers: vi.fn() }));
vi.mock('./process-handlers', () => ({ registerProcessHandlers: vi.fn() }));
vi.mock('./window-handlers', () => ({ registerWindowHandlers: vi.fn() }));
vi.mock('./annex-handlers', () => ({
  registerAnnexHandlers: vi.fn(),
  maybeStartAnnex: vi.fn(),
}));
vi.mock('./marketplace-handlers', () => ({ registerMarketplaceHandlers: vi.fn() }));
vi.mock('../orchestrators', () => ({ registerBuiltinProviders: vi.fn() }));
vi.mock('../services/hook-server', () => ({
  start: vi.fn(async () => {}),
}));
vi.mock('../services/log-service', () => ({
  init: vi.fn(),
  appLog: vi.fn(),
}));

import { registerAllHandlers } from './index';
import { registerPtyHandlers } from './pty-handlers';
import { registerProjectHandlers } from './project-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerAgentSettingsHandlers } from './agent-settings-handlers';
import { registerAppHandlers } from './app-handlers';
import { registerPluginHandlers } from './plugin-handlers';
import { registerProcessHandlers } from './process-handlers';
import { registerWindowHandlers } from './window-handlers';
import { registerAnnexHandlers, maybeStartAnnex } from './annex-handlers';
import { registerMarketplaceHandlers } from './marketplace-handlers';
import { registerBuiltinProviders } from '../orchestrators';
import * as hookServer from '../services/hook-server';
import * as logService from '../services/log-service';

describe('registerAllHandlers', () => {
  it('calls all handler registration functions', () => {
    registerAllHandlers();

    expect(registerBuiltinProviders).toHaveBeenCalled();
    expect(logService.init).toHaveBeenCalled();
    expect(registerPtyHandlers).toHaveBeenCalled();
    expect(registerProjectHandlers).toHaveBeenCalled();
    expect(registerFileHandlers).toHaveBeenCalled();
    expect(registerGitHandlers).toHaveBeenCalled();
    expect(registerAgentHandlers).toHaveBeenCalled();
    expect(registerAgentSettingsHandlers).toHaveBeenCalled();
    expect(registerAppHandlers).toHaveBeenCalled();
    expect(registerPluginHandlers).toHaveBeenCalled();
    expect(registerProcessHandlers).toHaveBeenCalled();
    expect(registerWindowHandlers).toHaveBeenCalled();
    expect(registerAnnexHandlers).toHaveBeenCalled();
    expect(registerMarketplaceHandlers).toHaveBeenCalled();
  });

  it('registers orchestrator providers before other handlers', () => {
    const callOrder: string[] = [];
    vi.mocked(registerBuiltinProviders).mockImplementation(() => { callOrder.push('providers'); });
    vi.mocked(registerPtyHandlers).mockImplementation(() => { callOrder.push('pty'); });

    registerAllHandlers();

    expect(callOrder.indexOf('providers')).toBeLessThan(callOrder.indexOf('pty'));
  });

  it('initializes logging before registering handlers', () => {
    const callOrder: string[] = [];
    vi.mocked(logService.init).mockImplementation(() => { callOrder.push('log-init'); });
    vi.mocked(registerPtyHandlers).mockImplementation(() => { callOrder.push('pty'); });

    registerAllHandlers();

    expect(callOrder.indexOf('log-init')).toBeLessThan(callOrder.indexOf('pty'));
  });

  it('starts the hook server', () => {
    registerAllHandlers();
    expect(hookServer.start).toHaveBeenCalled();
  });

  it('calls maybeStartAnnex after handler registration', () => {
    registerAllHandlers();
    expect(maybeStartAnnex).toHaveBeenCalled();
  });
});
