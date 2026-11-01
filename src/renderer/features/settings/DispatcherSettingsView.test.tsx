import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import type { OrchestratorInfo } from '../../../shared/types';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { DispatcherSettingsView } from './DispatcherSettingsView';

const FOLDER = 'dispatcher-folder';
const OFF: DispatcherState = { enabled: false, agentId: null, path: null, config: null };
const ON: DispatcherState = {
  enabled: true,
  agentId: 'disp',
  path: FOLDER,
  config: { id: 'disp', name: 'Dispatcher', color: 'indigo', createdAt: 'now', orchestrator: 'codex-cli', idleSleep: 'never', runtimeMode: 'chat', freeAgentMode: true, persona: 'dispatcher' },
};

const cli = (id: string, displayName: string) => ({ id, displayName, shortName: displayName, capabilities: { permissions: true } }) as unknown as OrchestratorInfo;

let state: DispatcherState;
let emit: ((s: DispatcherState) => void) | null;

beforeEach(() => {
  state = OFF;
  emit = null;
  window.clubhouse.dispatcher.get = vi.fn(async () => state);
  window.clubhouse.dispatcher.setEnabled = vi.fn(async (on: boolean) => {
    state = on ? ON : { ...ON, enabled: false };
    emit?.(state);
    return state;
  });
  window.clubhouse.dispatcher.onChanged = vi.fn((cb) => { emit = cb; return () => { emit = null; }; });
  window.clubhouse.agent.updateDurableConfig = vi.fn(async () => undefined);
  window.clubhouse.agent.getModelOptions = vi.fn(async () => [{ id: 'default', label: 'Default' }, { id: 'gpt-5', label: 'GPT-5' }]) as never;
  useOrchestratorStore.setState({
    enabled: ['claude-code', 'codex-cli'],
    allOrchestrators: [cli('claude-code', 'Claude Code'), cli('copilot-cli', 'Copilot CLI'), cli('codex-cli', 'Codex CLI')],
    loadSettings: async () => {},
  });
});

describe('DispatcherSettingsView', () => {
  it('turns the Dispatcher on and then shows its agent settings', async () => {
    render(<DispatcherSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByLabelText('CLI')).toBeNull();

    await act(async () => { fireEvent.click(toggle); });
    expect(window.clubhouse.dispatcher.setEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Turn on Dispatcher' }).getAttribute('aria-checked')).toBe('true'));
    expect((screen.getByLabelText('CLI') as HTMLSelectElement).value).toBe('codex-cli');
    expect((screen.getByLabelText('Auto-sleep') as HTMLSelectElement).value).toBe('never');
    expect((screen.getByLabelText('Runs in') as HTMLSelectElement).value).toBe('chat');
  });

  it('lists only enabled CLIs and resets the model when the CLI changes', async () => {
    state = ON;
    render(<DispatcherSettingsView />);
    const select = await screen.findByLabelText('CLI') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['claude-code', 'codex-cli']);
    await act(async () => { fireEvent.change(select, { target: { value: 'claude-code' } }); });
    expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(FOLDER, 'disp', { orchestrator: 'claude-code', model: 'default' });
  });

  it('saves auto-sleep and access to the Dispatcher config', async () => {
    state = ON;
    render(<DispatcherSettingsView />);
    const autoSleep = await screen.findByLabelText('Auto-sleep');
    await act(async () => { fireEvent.change(autoSleep, { target: { value: '30' } }); });
    expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(FOLDER, 'disp', { idleSleep: 30 });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Free agent mode' })); });
    expect(window.clubhouse.agent.updateDurableConfig).toHaveBeenCalledWith(FOLDER, 'disp', { freeAgentMode: false });
  });

  it('keeps the folder line while off, and hides the agent settings', async () => {
    state = { ...ON, enabled: false };
    render(<DispatcherSettingsView />);
    expect(await screen.findByTestId('dispatcher-folder')).toBeTruthy();
    expect(screen.queryByLabelText('CLI')).toBeNull();
  });
});
