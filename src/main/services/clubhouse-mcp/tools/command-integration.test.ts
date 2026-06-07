/**
 * Integration tests for list_commands and run_command MCP tool handlers
 * that bridge CommandRegistry + command palette.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ---- Mocks ---- */
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../../agent-registry', () => ({
  agentRegistry: {
    track: vi.fn(),
    untrack: vi.fn(),
    getAgent: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    _resetForTesting: vi.fn(),
  },
}));

vi.mock('../../group-project-registry', () => ({
  groupProjectRegistry: {
    getAll: vi.fn().mockReturnValue([]),
    getSync: vi.fn().mockReturnValue(null),
    onChange: vi.fn().mockReturnValue(() => {}),
    _resetForTesting: vi.fn(),
  },
}));

const mockSendCommandPaletteRequest = vi.fn();
vi.mock('../command-palette-bridge', () => ({
  sendCommandPaletteRequest: (...args: unknown[]) => mockSendCommandPaletteRequest(...args),
}));

import { _resetForTesting, callTool } from '../tool-registry';
import { bindingManager } from '..';
import { commandRegistry } from '../../../../shared/command-registry';

// Dynamically import registerAssistantTools since it has many transitive deps —
// we only need list_commands and run_command
let registerAssistantTools: () => void;

const TEST_AGENT_ID = 'cmd-test-agent';
const ASSISTANT_TARGET_ID = 'clubhouse_assistant';

function createAssistantBinding(): void {
  bindingManager.bind(TEST_AGENT_ID, {
    targetId: ASSISTANT_TARGET_ID,
    targetKind: 'assistant',
    label: 'Clubhouse Assistant',
  });
}

async function callAssistantTool(suffix: string, args: Record<string, unknown> = {}): Promise<any> {
  const toolName = `assistant__${ASSISTANT_TARGET_ID}__${suffix}`;
  return callTool(TEST_AGENT_ID, toolName, args);
}

describe('list_commands + run_command integration', () => {
  beforeEach(async () => {
    _resetForTesting();
    commandRegistry.clear();
    mockSendCommandPaletteRequest.mockReset();

    // Lazy import to avoid heavy transitive deps causing issues
    if (!registerAssistantTools) {
      const mod = await import('./assistant-tools');
      registerAssistantTools = mod.registerAssistantTools;
    }
    registerAssistantTools();
    createAssistantBinding();
  });

  afterEach(() => {
    bindingManager.unbind(TEST_AGENT_ID, ASSISTANT_TARGET_ID);
    commandRegistry.clear();
  });

  /* ---- list_commands ---- */

  describe('list_commands', () => {
    it('returns merged palette + registry results without duplicates', async () => {
      // Palette returns some commands
      mockSendCommandPaletteRequest.mockResolvedValue({
        success: true,
        data: [
          { id: 'nav:home', label: 'Go Home', category: 'Navigation', keywords: [] },
          { id: 'nav:settings', label: 'Settings', category: 'Navigation', keywords: [] },
        ],
      });

      // Register a command in the registry that's NOT in palette
      commandRegistry.register({
        id: 'canvas.add_canvas',
        category: 'canvas',
        label: 'Create Canvas',
        description: 'Create a new canvas',
        process: 'renderer',
        handler: () => ({ success: true }),
      });

      const result = await callAssistantTool('list_commands', {});
      const items = JSON.parse(result.content[0].text);
      expect(Array.isArray(items)).toBe(true);

      const ids = items.map((c: any) => c.id);
      expect(ids).toContain('nav:home');
      expect(ids).toContain('nav:settings');
      expect(ids).toContain('canvas.add_canvas');
      // No duplicates
      expect(ids.filter((id: string) => id === 'canvas.add_canvas')).toHaveLength(1);
    });

    it('deduplicates when same ID exists in palette and registry', async () => {
      mockSendCommandPaletteRequest.mockResolvedValue({
        success: true,
        data: [
          { id: 'canvas.add_canvas', label: 'Create Canvas (palette)', category: 'canvas', keywords: [] },
        ],
      });

      commandRegistry.register({
        id: 'canvas.add_canvas',
        category: 'canvas',
        label: 'Create Canvas (registry)',
        description: 'Create a new canvas',
        process: 'renderer',
        handler: () => ({ success: true }),
      });

      const result = await callAssistantTool('list_commands', {});
      const items = JSON.parse(result.content[0].text);
      const matching = items.filter((c: any) => c.id === 'canvas.add_canvas');
      expect(matching).toHaveLength(1);
      // Palette version takes precedence
      expect(matching[0].label).toBe('Create Canvas (palette)');
    });

    it('excludes palette-hidden registry commands', async () => {
      mockSendCommandPaletteRequest.mockResolvedValue({ success: true, data: [] });

      commandRegistry.register({
        id: 'canvas.move_view',
        category: 'canvas',
        label: 'Move View',
        description: 'Move a view',
        process: 'renderer',
        palette: { hidden: true },
        handler: () => ({ success: true }),
      });

      commandRegistry.register({
        id: 'canvas.add_canvas',
        category: 'canvas',
        label: 'Create Canvas',
        description: 'Create canvas',
        process: 'renderer',
        handler: () => ({ success: true }),
      });

      const result = await callAssistantTool('list_commands', {});
      const items = JSON.parse(result.content[0].text);
      const ids = items.map((c: any) => c.id);
      expect(ids).not.toContain('canvas.move_view');
      expect(ids).toContain('canvas.add_canvas');
    });

    it('returns partial indicator with registry commands when palette fails', async () => {
      // With assistant tools migrated to the registry, the registry is never
      // empty after registerAssistantTools() — so palette failure always returns
      // partial results rather than an error.
      mockSendCommandPaletteRequest.mockResolvedValue({
        success: false,
        error: 'No renderer window available',
      });

      const result = await callAssistantTool('list_commands', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.partial).toBe(true);
      expect(parsed.warning).toContain('registry commands only');
      // Should include all assistant commands from the registry
      expect(parsed.commands.length).toBeGreaterThanOrEqual(38);
    });

    it('includes additional registry commands alongside assistant commands when palette fails', async () => {
      mockSendCommandPaletteRequest.mockResolvedValue({
        success: false,
        error: 'No renderer window available',
      });

      commandRegistry.register({
        id: 'canvas.list_canvases',
        category: 'canvas',
        label: 'List Canvases',
        description: 'List canvases',
        process: 'renderer',
        handler: () => ({ success: true }),
      });

      const result = await callAssistantTool('list_commands', {});
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.partial).toBe(true);
      // 38 assistant + 1 canvas = 39 minimum
      expect(parsed.commands.length).toBeGreaterThanOrEqual(39);
      const ids = parsed.commands.map((c: any) => c.id);
      expect(ids).toContain('canvas.list_canvases');
    });
  });

  /* ---- run_command ---- */

  describe('run_command', () => {
    it('routes to registry when command exists there', async () => {
      const handler = vi.fn().mockReturnValue({ success: true, data: { done: true } });
      commandRegistry.register({
        id: 'canvas.add_canvas',
        category: 'canvas',
        label: 'Create Canvas',
        description: 'Create canvas',
        process: 'renderer',
        handler,
      });

      const result = await callAssistantTool('run_command', { command_id: 'canvas.add_canvas' });
      expect(handler).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.done).toBe(true);
    });

    it('does not leak command_id into handler args', async () => {
      const handler = vi.fn().mockReturnValue({ success: true });
      commandRegistry.register({
        id: 'canvas.add_canvas',
        category: 'canvas',
        label: 'Create Canvas',
        description: 'Create',
        process: 'renderer',
        handler,
      });

      await callAssistantTool('run_command', { command_id: 'canvas.add_canvas' });
      const [, args] = handler.mock.calls[0];
      expect(args).not.toHaveProperty('command_id');
    });

    it('falls back to palette when command not in registry', async () => {
      mockSendCommandPaletteRequest.mockResolvedValue({
        success: true,
        data: { command_id: 'nav:home', label: 'Go Home' },
      });

      const result = await callAssistantTool('run_command', { command_id: 'nav:home' });
      expect(mockSendCommandPaletteRequest).toHaveBeenCalledWith('run_command', { command_id: 'nav:home' });
      expect(result.isError).toBeUndefined();
    });

    it('returns error when registry command fails', async () => {
      commandRegistry.register({
        id: 'canvas.bad',
        category: 'canvas',
        label: 'Bad',
        description: 'Fails',
        process: 'renderer',
        handler: () => ({ success: false, error: 'Canvas not found' }),
      });

      const result = await callAssistantTool('run_command', { command_id: 'canvas.bad' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Canvas not found');
    });
  });
});
