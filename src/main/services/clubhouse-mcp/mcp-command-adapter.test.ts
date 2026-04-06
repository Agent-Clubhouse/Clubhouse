import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerMcpCommand, toCommandId, _resetAdapterForTesting } from './mcp-command-adapter';
import { commandRegistry } from '../../../shared/command-registry';
// tool-registry is mocked — no need to import _resetForTesting

// Mock tool-registry to capture registrations without side effects
const registeredTemplates: Array<{ targetKind: string; nameSuffix: string }> = [];
vi.mock('./tool-registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tool-registry')>();
  return {
    ...original,
    registerToolTemplate: vi.fn((targetKind: string, nameSuffix: string) => {
      registeredTemplates.push({ targetKind, nameSuffix });
    }),
  };
});

beforeEach(() => {
  _resetAdapterForTesting();
  commandRegistry.clear();
  registeredTemplates.length = 0;
});

describe('toCommandId', () => {
  it('converts snake_case suffix to camelCase dot-notation', () => {
    expect(toCommandId('assistant', 'find_git_repos')).toBe('assistant.findGitRepos');
  });

  it('handles single-word suffix', () => {
    expect(toCommandId('assistant', 'wake')).toBe('assistant.wake');
  });

  it('handles multi-segment suffix', () => {
    expect(toCommandId('assistant', 'create_canvas_from_blueprint')).toBe('assistant.createCanvasFromBlueprint');
  });
});

describe('registerMcpCommand', () => {
  const sampleDef = {
    id: 'assistant.testTool',
    category: 'assistant',
    label: 'Test Tool',
    description: 'A test tool for unit tests',
    inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } } },
    targetKind: 'assistant' as const,
    nameSuffix: 'test_tool',
    handler: vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'hello' }],
    })),
  };

  it('registers command in the CommandRegistry', () => {
    registerMcpCommand(sampleDef);
    const cmd = commandRegistry.get('assistant.testTool');
    expect(cmd).toBeDefined();
    expect(cmd!.id).toBe('assistant.testTool');
    expect(cmd!.category).toBe('assistant');
    expect(cmd!.label).toBe('Test Tool');
  });

  it('registers tool template for backward compatibility', () => {
    registerMcpCommand(sampleDef);
    expect(registeredTemplates).toHaveLength(1);
    expect(registeredTemplates[0]).toEqual({
      targetKind: 'assistant',
      nameSuffix: 'test_tool',
    });
  });

  it('returns a disposable that removes from registry', () => {
    const disposable = registerMcpCommand(sampleDef);
    expect(commandRegistry.get('assistant.testTool')).toBeDefined();
    disposable.dispose();
    expect(commandRegistry.get('assistant.testTool')).toBeUndefined();
  });

  it('wraps MCP handler in CommandResult format', async () => {
    registerMcpCommand(sampleDef);
    const cmd = commandRegistry.get('assistant.testTool')!;
    const result = await cmd.handler({ source: 'mcp', agentId: 'agent-1' }, {});
    expect(result.success).toBe(true);
    expect(result.data).toBe('hello');
  });

  it('wraps MCP handler errors in CommandResult format', async () => {
    const errorDef = {
      ...sampleDef,
      id: 'assistant.errorTool',
      handler: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'Something went wrong' }],
        isError: true,
      })),
    };
    registerMcpCommand(errorDef);
    const cmd = commandRegistry.get('assistant.errorTool')!;
    const result = await cmd.handler({ source: 'mcp' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('Something went wrong');
  });

  it('handles handler exceptions gracefully', async () => {
    const throwDef = {
      ...sampleDef,
      id: 'assistant.throwTool',
      handler: vi.fn(async () => { throw new Error('boom'); }),
    };
    registerMcpCommand(throwDef);
    const cmd = commandRegistry.get('assistant.throwTool')!;
    const result = await cmd.handler({ source: 'mcp' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('sets process to main and mcp scoping to binding', () => {
    registerMcpCommand(sampleDef);
    const cmd = commandRegistry.get('assistant.testTool')!;
    expect(cmd.process).toBe('main');
    expect(cmd.mcp).toEqual({ scoping: 'binding' });
  });
});

describe('assistant tools registration count', () => {
  it('registers all 38 assistant tools in the CommandRegistry', async () => {
    // Reset state
    _resetAdapterForTesting();
    commandRegistry.clear();

    // Import and call registerAssistantTools
    // This tests the actual integration — all 38 tools should register
    const { registerAssistantTools } = await import('./tools/assistant-tools');
    registerAssistantTools();

    const assistantCommands = commandRegistry.list({ category: 'assistant' });
    expect(assistantCommands.length).toBe(38);
  });

  it('all assistant commands have proper IDs in dot-notation', async () => {
    _resetAdapterForTesting();
    commandRegistry.clear();

    const { registerAssistantTools } = await import('./tools/assistant-tools');
    registerAssistantTools();

    const assistantCommands = commandRegistry.list({ category: 'assistant' });
    for (const cmd of assistantCommands) {
      expect(cmd.id).toMatch(/^assistant\.[a-zA-Z]+$/);
      expect(cmd.label).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it('non-assistant category returns 0 assistant tools', async () => {
    _resetAdapterForTesting();
    commandRegistry.clear();

    const { registerAssistantTools } = await import('./tools/assistant-tools');
    registerAssistantTools();

    const agentCommands = commandRegistry.list({ category: 'agent' });
    expect(agentCommands.length).toBe(0);
  });
});
