/**
 * Module boundary tests — verify each assistant-tools sub-module registers its
 * tools independently when called in isolation.
 *
 * These are smoke tests: they confirm each module is importable and that its
 * register function calls registerMcpCommand the expected number of times.
 * Full handler coverage lives in assistant-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../mcp-command-adapter', () => ({
  registerMcpCommand: vi.fn(),
  toCommandId: (_category: string, name: string) => `assistant:${name}`,
}));

vi.mock('../../project-store', () => ({ list: vi.fn().mockResolvedValue([]) }));
vi.mock('../../agent-config', () => ({
  listDurable: vi.fn().mockResolvedValue([]),
  createDurable: vi.fn(),
  updateDurable: vi.fn(),
  updateDurableConfig: vi.fn(),
  deleteDurable: vi.fn(),
}));
vi.mock('../../agent-system', () => ({
  getAvailableOrchestrators: vi.fn().mockReturnValue([]),
  checkAvailability: vi.fn().mockResolvedValue({ available: true }),
  resolveOrchestrator: vi.fn().mockResolvedValue({ id: 'claude-code', displayName: 'Claude Code', writeInstructions: vi.fn() }),
}));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../theme-service', () => ({ getSettings: vi.fn().mockReturnValue({ themeId: 'catppuccin-mocha' }), saveSettings: vi.fn() }));
vi.mock('../../plugin-theme-store', () => ({ getPluginThemes: vi.fn().mockReturnValue([]) }));
vi.mock('../../plugin-discovery', () => ({ discoverCommunityPlugins: vi.fn().mockResolvedValue([]) }));
vi.mock('../../marketplace-service', () => ({ fetchAllRegistries: vi.fn().mockResolvedValue({ allPlugins: [] }), installPlugin: vi.fn() }));
vi.mock('../../custom-marketplace-service', () => ({ listCustomMarketplaces: vi.fn().mockResolvedValue([]) }));
vi.mock('../canvas-command', () => ({ sendCanvasCommand: vi.fn().mockResolvedValue({ success: true, data: {} }) }));
vi.mock('../canvas-layout', () => ({
  computeRelativePosition: vi.fn().mockReturnValue({ x: 0, y: 0 }),
  layoutGrid: vi.fn().mockReturnValue([]),
  DEFAULT_CARD_SIZES: { agent: { width: 300, height: 200 }, zone: { width: 600, height: 400 }, anchor: { width: 200, height: 100 }, 'sticky-note': { width: 250, height: 250 } },
}));
vi.mock('../elk-layout', () => ({ layoutElk: vi.fn().mockResolvedValue({ nodes: [], edges: [] }) }));
vi.mock('../../../../renderer/features/help/help-content', () => ({ HELP_SECTIONS: [] }));
vi.mock('../../../../renderer/features/help/help-search', () => ({ searchHelpTopics: vi.fn().mockReturnValue([]) }));
vi.mock('../../../../renderer/features/assistant/content/personas', () => ({
  getPersonaTemplate: vi.fn().mockReturnValue(null),
  getPersonaIds: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../../renderer/themes', () => ({ BUILTIN_THEMES: {} }));
vi.mock('../../../../shared/ipc-channels', () => ({ IPC: { APP: { THEME_CHANGED: 'theme-changed' }, WINDOW: { NAVIGATE_TO_PLUGIN_SETTINGS: 'navigate-plugin-settings' } } }));
vi.mock('../../../../shared/name-generator', () => ({ AGENT_COLORS: [{ id: 'emerald' }] }));
vi.mock('../../../../shared/marketplace-types', () => ({ SUPPORTED_PLUGIN_API_VERSIONS: [0.9] }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('assistant tool module registration', () => {
  let registerMcpCommand: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const adapter = await import('../mcp-command-adapter');
    registerMcpCommand = adapter.registerMcpCommand as ReturnType<typeof vi.fn>;

    // mockReset: true clears mockReturnValue implementations between tests.
    // Re-apply any mocks evaluated at registration time (not in handlers).
    const personas = await import('../../../../renderer/features/assistant/content/personas');
    vi.mocked(personas.getPersonaIds).mockReturnValue([]);
    vi.mocked(personas.getPersonaTemplate).mockReturnValue(null);
  });

  it('registerContextTools registers 8 tools', async () => {
    const { registerContextTools } = await import('./assistant-context-tools');
    registerContextTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(8);
  });

  it('registerConfigTools registers 3 tools', async () => {
    const { registerConfigTools } = await import('./assistant-config-tools');
    registerConfigTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(3);
  });

  it('registerAgentTools registers 4 tools', async () => {
    const { registerAgentTools } = await import('./assistant-agent-tools');
    registerAgentTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(4);
  });

  it('registerProjectTools registers 3 tools', async () => {
    const { registerProjectTools } = await import('./assistant-project-tools');
    registerProjectTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(3);
  });

  it('registerCanvasTools registers 13 tools', async () => {
    const { registerCanvasTools } = await import('./assistant-canvas-tools');
    registerCanvasTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(13);
  });

  it('registerPluginTools registers 5 tools', async () => {
    const { registerPluginTools } = await import('./assistant-plugin-tools');
    registerPluginTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(5);
  });

  it('registerCommandTools registers 2 tools', async () => {
    const { registerCommandTools } = await import('./assistant-command-tools');
    registerCommandTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(2);
  });

  it('registerAssistantTools (barrel) registers all 38 tools', async () => {
    const { registerAssistantTools } = await import('./assistant-tools');
    registerAssistantTools();
    expect(registerMcpCommand).toHaveBeenCalledTimes(38);
  });
});
