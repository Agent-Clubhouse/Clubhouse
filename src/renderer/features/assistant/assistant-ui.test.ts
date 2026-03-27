import { describe, it, expect } from 'vitest';
import { useUIStore } from '../../stores/uiStore';

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
