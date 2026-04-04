import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentQueueCanvasWidget } from './AgentQueueCanvasWidget';
import { useAgentQueueStore } from '../../../stores/agentQueueStore';
import { useOrchestratorStore } from '../../../stores/orchestratorStore';
import { useMcpSettingsStore } from '../../../stores/mcpSettingsStore';
import type { CanvasWidgetComponentProps, PluginAPI } from '../../../../shared/plugin-types';

// ── Stub helpers ──────────────────────────────────────────────────────

function makeApi(): PluginAPI {
  return {
    theme: {
      getCurrent: () => ({ id: 'test', name: 'Test', type: 'dark', colors: {}, hljs: {} }),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      getColor: () => null,
    },
    context: { mode: 'project', projectId: 'proj-1' },
  } as unknown as PluginAPI;
}

function makeProps(overrides: Partial<CanvasWidgetComponentProps> = {}): CanvasWidgetComponentProps {
  return {
    widgetId: 'w1',
    api: makeApi(),
    metadata: {},
    onUpdateMetadata: vi.fn(),
    size: { width: 300, height: 300 },
    ...overrides,
  };
}

const TEST_QUEUE = {
  id: 'aq_test_123',
  name: 'Test Queue',
  concurrency: 2,
  orchestrator: undefined as string | undefined,
  model: undefined as string | undefined,
  freeAgentMode: false,
  autoWorktree: false,
  createdAt: new Date().toISOString(),
  metadata: {},
};

beforeEach(() => {
  vi.clearAllMocks();

  // Enable MCP by default
  useMcpSettingsStore.setState({ enabled: true });

  // Set up queue store with a test queue
  useAgentQueueStore.setState({
    queues: [TEST_QUEUE],
    loaded: true,
  });

  // Set up orchestrator store with test orchestrators
  useOrchestratorStore.setState({
    enabled: ['claude-code', 'copilot-cli'],
    allOrchestrators: [
      { id: 'claude-code', displayName: 'Claude Code', capabilities: {} },
      { id: 'copilot-cli', displayName: 'Copilot CLI', capabilities: {} },
      { id: 'codex-cli', displayName: 'Codex CLI', capabilities: {} },
    ] as any[],
  });
});

// ── MCP disabled state ──────────────────────────────────────────────

describe('AgentQueueCanvasWidget', () => {
  it('shows MCP disabled message when MCP is off', () => {
    useMcpSettingsStore.setState({ enabled: false });
    render(<AgentQueueCanvasWidget {...makeProps()} />);
    expect(screen.getByTestId('agent-queue-mcp-disabled')).toBeInTheDocument();
  });

  it('shows creation form when no queueId in metadata', () => {
    render(<AgentQueueCanvasWidget {...makeProps()} />);
    expect(screen.getByPlaceholderText('Queue name...')).toBeInTheDocument();
  });
});

// ── Settings panel — orchestrator selector ─────────────────────────

describe('QueueSettings orchestrator selector', () => {
  function renderSettings() {
    const props = makeProps({
      metadata: { queueId: TEST_QUEUE.id },
    });
    return render(<AgentQueueCanvasWidget {...props} />);
  }

  it('renders orchestrator selector with enabled orchestrators', async () => {
    renderSettings();

    // Open settings panel
    const settingsBtn = screen.getByTitle('Settings');
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    });

    // Should show only enabled orchestrators (claude-code, copilot-cli)
    const select = screen.getByText('Orchestrator').closest('div')?.querySelector('select');
    expect(select).toBeTruthy();

    const options = select!.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('Claude Code');
    expect(options[1].textContent).toBe('Copilot CLI');
  });

  it('persists orchestrator selection on change', async () => {
    const mockIpcUpdate = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentQueue.update = mockIpcUpdate;

    renderSettings();

    // Open settings
    fireEvent.click(screen.getByTitle('Settings'));

    await waitFor(() => {
      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    });

    const select = screen.getByText('Orchestrator').closest('div')?.querySelector('select');
    expect(select).toBeTruthy();

    fireEvent.change(select!, { target: { value: 'copilot-cli' } });

    await waitFor(() => {
      expect(mockIpcUpdate).toHaveBeenCalledWith(
        TEST_QUEUE.id,
        expect.objectContaining({ orchestrator: 'copilot-cli' }),
      );
    });
  });

  it('resets model when orchestrator changes', async () => {
    const mockIpcUpdate = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.agentQueue.update = mockIpcUpdate;

    renderSettings();

    fireEvent.click(screen.getByTitle('Settings'));

    await waitFor(() => {
      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    });

    const select = screen.getByText('Orchestrator').closest('div')?.querySelector('select');
    fireEvent.change(select!, { target: { value: 'copilot-cli' } });

    await waitFor(() => {
      expect(mockIpcUpdate).toHaveBeenCalledWith(
        TEST_QUEUE.id,
        expect.objectContaining({ orchestrator: 'copilot-cli', model: undefined }),
      );
    });
  });

  it('shows existing orchestrator as selected value', async () => {
    useAgentQueueStore.setState({
      queues: [{ ...TEST_QUEUE, orchestrator: 'copilot-cli' }],
      loaded: true,
    });

    renderSettings();
    fireEvent.click(screen.getByTitle('Settings'));

    await waitFor(() => {
      const select = screen.getByText('Orchestrator').closest('div')?.querySelector('select') as HTMLSelectElement;
      expect(select.value).toBe('copilot-cli');
    });
  });

  it('hides orchestrator selector when no orchestrators are enabled', async () => {
    useOrchestratorStore.setState({
      enabled: [],
      allOrchestrators: [
        { id: 'claude-code', displayName: 'Claude Code', capabilities: {} },
      ] as any[],
    });

    renderSettings();
    fireEvent.click(screen.getByTitle('Settings'));

    // Should not find Orchestrator label
    await waitFor(() => {
      expect(screen.getByText('Concurrency')).toBeInTheDocument();
    });
    expect(screen.queryByText('Orchestrator')).not.toBeInTheDocument();
  });
});
