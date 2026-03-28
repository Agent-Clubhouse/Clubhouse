import { createElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../../stores/uiStore';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import { AssistantHeader } from './AssistantHeader';

describe('uiStore assistant integration', () => {
  it('toggleAssistant sets explorerTab to assistant', () => {
    const store = useUIStore.getState();
    // Start from agents
    useUIStore.setState({ explorerTab: 'agents', previousExplorerTab: null });
    store.toggleAssistant();

    const state = useUIStore.getState();
    expect(state.explorerTab).toBe('assistant');
    expect(state.previousExplorerTab).toBe('agents');
  });

  it('toggleAssistant again restores previous tab', () => {
    useUIStore.setState({ explorerTab: 'agents', previousExplorerTab: null });
    const store = useUIStore.getState();

    store.toggleAssistant();
    expect(useUIStore.getState().explorerTab).toBe('assistant');

    useUIStore.getState().toggleAssistant();
    expect(useUIStore.getState().explorerTab).toBe('agents');
    expect(useUIStore.getState().previousExplorerTab).toBeNull();
  });

  it('toggleAssistant from help preserves help as previous', () => {
    useUIStore.setState({ explorerTab: 'help', previousExplorerTab: 'agents' });
    useUIStore.getState().toggleAssistant();

    const state = useUIStore.getState();
    expect(state.explorerTab).toBe('assistant');
    expect(state.previousExplorerTab).toBe('help');
  });

  it('toggleAssistant defaults to agents when no previous tab', () => {
    useUIStore.setState({ explorerTab: 'assistant', previousExplorerTab: null });
    useUIStore.getState().toggleAssistant();

    expect(useUIStore.getState().explorerTab).toBe('agents');
  });

  it('toggleHelp and toggleAssistant are independent', () => {
    useUIStore.setState({ explorerTab: 'agents', previousExplorerTab: null });

    // Open assistant
    useUIStore.getState().toggleAssistant();
    expect(useUIStore.getState().explorerTab).toBe('assistant');

    // Switch to help from assistant
    useUIStore.getState().toggleHelp();
    expect(useUIStore.getState().explorerTab).toBe('help');
    expect(useUIStore.getState().previousExplorerTab).toBe('assistant');

    // Toggle help off goes back to assistant
    useUIStore.getState().toggleHelp();
    expect(useUIStore.getState().explorerTab).toBe('assistant');
  });
});

describe('AssistantFeed component', () => {
  it('renders suggestion chips in welcome state', () => {
    const onSendPrompt = vi.fn();
    render(createElement(AssistantFeed, { items: [], status: 'idle', onSendPrompt }));

    const chips = screen.getAllByTestId('suggested-prompt');
    expect(chips.length).toBe(6);
    expect(chips[0]).toHaveTextContent('Set up a project');
  });

  it('suggestion chip click calls onSendPrompt with prompt text', () => {
    const onSendPrompt = vi.fn();
    render(createElement(AssistantFeed, { items: [], status: 'idle', onSendPrompt }));

    const chips = screen.getAllByTestId('suggested-prompt');
    fireEvent.click(chips[0]);
    expect(onSendPrompt).toHaveBeenCalledWith('Help me set up a new project in Clubhouse');
  });

  it('shows typing indicator when status is responding', () => {
    const items = [
      { type: 'message' as const, message: { id: 'u1', role: 'user' as const, content: 'hello', timestamp: Date.now() } },
    ];
    render(createElement(AssistantFeed, { items, status: 'responding', onSendPrompt: vi.fn() }));
    expect(screen.getByTestId('assistant-typing')).toBeTruthy();
  });

  it('hides typing indicator when status is active', () => {
    const items = [
      { type: 'message' as const, message: { id: 'u1', role: 'user' as const, content: 'hello', timestamp: Date.now() } },
    ];
    render(createElement(AssistantFeed, { items, status: 'active', onSendPrompt: vi.fn() }));
    expect(screen.queryByTestId('assistant-typing')).toBeNull();
  });
});

describe('AssistantInput component', () => {
  it('shows default placeholder when idle', () => {
    render(createElement(AssistantInput, { onSend: vi.fn(), status: 'idle' }));
    const textarea = screen.getByTestId('assistant-message-input') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain('Ask anything');
  });

  it('shows responding placeholder when responding', () => {
    render(createElement(AssistantInput, { onSend: vi.fn(), disabled: true, status: 'responding' }));
    const textarea = screen.getByTestId('assistant-message-input') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain('Waiting for response');
  });

  it('shows starting placeholder when starting', () => {
    render(createElement(AssistantInput, { onSend: vi.fn(), disabled: true, status: 'starting' }));
    const textarea = screen.getByTestId('assistant-message-input') as HTMLTextAreaElement;
    expect(textarea.placeholder).toContain('Starting assistant');
  });
});

describe('AssistantHeader component', () => {
  it('shows idle status text', () => {
    render(createElement(AssistantHeader, {
      onReset: vi.fn(),
      mode: 'headless',
      onModeChange: vi.fn(),
      orchestrator: null,
      onOrchestratorChange: vi.fn(),
      status: 'idle',
    }));
    expect(screen.getByTestId('assistant-status')).toHaveTextContent('Ready to help');
  });

  it('shows responding status text', () => {
    render(createElement(AssistantHeader, {
      onReset: vi.fn(),
      mode: 'headless',
      onModeChange: vi.fn(),
      orchestrator: null,
      onOrchestratorChange: vi.fn(),
      status: 'responding',
    }));
    expect(screen.getByTestId('assistant-status')).toHaveTextContent('Thinking');
  });

  it('shows error status text', () => {
    render(createElement(AssistantHeader, {
      onReset: vi.fn(),
      mode: 'headless',
      onModeChange: vi.fn(),
      orchestrator: null,
      onOrchestratorChange: vi.fn(),
      status: 'error',
    }));
    expect(screen.getByTestId('assistant-status')).toHaveTextContent('Something went wrong');
  });

  it('mode toggle highlights active mode', () => {
    render(createElement(AssistantHeader, {
      onReset: vi.fn(),
      mode: 'structured',
      onModeChange: vi.fn(),
      orchestrator: null,
      onOrchestratorChange: vi.fn(),
      status: 'idle',
    }));
    const structuredBtn = screen.getByTestId('mode-structured');
    expect(structuredBtn.className).toContain('bg-ctp-accent');
  });
});
