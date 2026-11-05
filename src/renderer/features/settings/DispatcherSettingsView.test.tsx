import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DispatcherState } from '../../../shared/dispatcher-types';
import type { OrchestratorInfo } from '../../../shared/types';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { DispatcherSettingsView, dispatcherSwitchHelp } from './DispatcherSettingsView';

const FOLDER = 'dispatcher-folder';
const OFF: DispatcherState = { enabled: false, flagOn: true, savedOn: false, offReason: 'switch_off', mcpOff: false, classic: false, running: false, agentId: null, path: null, config: null };
const ON: DispatcherState = {
  enabled: true,
  flagOn: true,
  savedOn: true,
  offReason: null,
  mcpOff: false,
  classic: false,
  running: false,
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
    state = on ? ON : { ...ON, enabled: false, savedOn: false, offReason: 'switch_off' };
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
    // The page title only: no section heading repeats it.
    expect(screen.getAllByRole('heading', { name: 'Dispatcher' })).toHaveLength(1);
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

  it('warns before a new CLI drops its saved session (#2593)', async () => {
    state = ON;
    window.clubhouse.agent.getDurableConfig = vi.fn(async () => ({ id: 'disp', lastSessionId: 's1' })) as never;
    render(<DispatcherSettingsView />);
    const select = await screen.findByLabelText('CLI') as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: 'claude-code' } }); });
    expect(screen.getByText(/The Dispatcher starts a new session on .* the next time it wakes/)).toBeInTheDocument();
    expect(window.clubhouse.agent.updateDurableConfig).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-destructive-confirm')); });
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

  it('shows a loading line until the read lands', async () => {
    let resolve!: (s: DispatcherState) => void;
    window.clubhouse.dispatcher.get = vi.fn(() => new Promise<DispatcherState>((r) => { resolve = r; }));
    render(<DispatcherSettingsView />);
    expect(screen.getByRole('heading', { name: 'Dispatcher' })).toBeTruthy();
    expect(screen.getByTestId('dispatcher-loading').textContent).toBe('Loading');
    await act(async () => { resolve(OFF); });
    expect(screen.queryByTestId('dispatcher-loading')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Turn on Dispatcher' })).toBeTruthy();
  });

  it('says when the read fails, and Retry reads again', async () => {
    window.clubhouse.dispatcher.get = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'dispatcher:get': Error: IPC down"))
      .mockResolvedValue(OFF);
    render(<DispatcherSettingsView />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Couldn’t load the Dispatcher’s settings. IPC down');
    expect(alert.className).toContain('text-ctp-error');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByRole('switch', { name: 'Turn on Dispatcher' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is off and disabled with MCP off, naming the setting, with its saved value kept', async () => {
    state = { ...ON, enabled: false, offReason: 'mcp_off', mcpOff: true };
    render(<DispatcherSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute('aria-describedby')).toBe('dispatcher-enabled-help');
    expect(document.getElementById('dispatcher-enabled-help')?.textContent).toContain('Turn on Clubhouse MCP in Settings.');
    fireEvent.click(toggle);
    expect(window.clubhouse.dispatcher.setEnabled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dispatcher-still-running')).toBeNull();
  });

  it('says a running one is still running with MCP off', async () => {
    state = { ...ON, enabled: false, offReason: 'mcp_off', mcpOff: true, running: true };
    render(<DispatcherSettingsView />);
    expect((await screen.findByTestId('dispatcher-still-running')).textContent).toContain('It is still running. It can’t use Clubhouse tools');
  });

  it('shows switch and save errors as alerts in the error colour', async () => {
    window.clubhouse.dispatcher.setEnabled = vi.fn().mockRejectedValue(new Error('disk full'));
    const { unmount } = render(<DispatcherSettingsView />);
    const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
    await act(async () => { fireEvent.click(toggle); });
    const switchAlert = await screen.findByRole('alert');
    expect(switchAlert.textContent).toBe('Couldn’t turn it on. disk full');
    expect(switchAlert.className).toContain('text-ctp-error');
    unmount();

    state = ON;
    window.clubhouse.agent.updateDurableConfig = vi.fn().mockRejectedValue(new Error('read-only'));
    render(<DispatcherSettingsView />);
    const runsIn = await screen.findByLabelText('Runs in');
    await act(async () => { fireEvent.change(runsIn, { target: { value: 'terminal' } }); });
    const saveAlert = await screen.findByRole('alert');
    expect(saveAlert.textContent).toBe('Couldn’t save. read-only');
    expect(saveAlert.className).toContain('text-ctp-error');
  });

  it('on the classic layout, missing or off can\'t be turned on, and says what to change (#2565)', async () => {
    for (const offState of [
      { ...OFF, classic: true, offReason: 'classic_layout' as const },
      { ...OFF, classic: true, offReason: 'switch_off' as const },
    ]) {
      state = offState;
      const { unmount } = render(<DispatcherSettingsView />);
      const toggle = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(document.getElementById('dispatcher-enabled-help')?.textContent)
        .toBe('On by default in the new layout only. To turn it on, turn off Classic layout in Settings > Display & UI.');
      fireEvent.click(toggle);
      expect(window.clubhouse.dispatcher.setEnabled).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('on the classic layout, a saved on can be turned off, and the page says it won\'t turn back on (#2565)', async () => {
    state = { ...ON, classic: true };
    render(<DispatcherSettingsView />);
    const on = await screen.findByRole('switch', { name: 'Turn on Dispatcher' });
    expect(on.getAttribute('aria-checked')).toBe('true');
    expect((on as HTMLButtonElement).disabled).toBe(false);
    const help = document.getElementById('dispatcher-enabled-help')?.textContent;
    expect(help).toContain('It has no row here because its row and view are in the new layout only.');
    expect(help).toContain('Classic layout in Settings > Display & UI');
    expect(help).toContain('can’t be turned back on');
    await act(async () => { fireEvent.click(on); });
    expect(window.clubhouse.dispatcher.setEnabled).toHaveBeenCalledWith(false);
  });

  describe('help text in every combination', () => {
    const help = (s: Partial<DispatcherState>) => dispatcherSwitchHelp({ enabled: false, savedOn: false, mcpOff: false, classic: false, ...s });

    it.each([
      ['new layout, on', { enabled: true, savedOn: true }, ['On by default in the new layout.', 'stays asleep'], ['Classic layout', 'Clubhouse MCP']],
      ['new layout, off', {}, ['On by default in the new layout, and turned off here.'], ['Classic layout', 'Clubhouse MCP']],
      ['new layout, MCP off, saved on', { savedOn: true, mcpOff: true }, ['Off because Clubhouse MCP is off.', 'Clubhouse MCP in Settings', 'doesn’t start any session'], ['Classic layout']],
      ['new layout, MCP off, saved off', { mcpOff: true }, ['Clubhouse MCP in Settings', 'doesn’t start any session'], ['Classic layout']],
      ['classic, saved on', { enabled: true, savedOn: true, classic: true }, ['Classic layout in Settings > Display & UI', 'can’t be turned back on'], ['Clubhouse MCP']],
      ['classic, off', { classic: true }, ['On by default in the new layout only.', 'Classic layout in Settings > Display & UI'], ['Clubhouse MCP']],
      ['classic, MCP off, saved on', { savedOn: true, mcpOff: true, classic: true }, ['Clubhouse MCP in Settings', 'Classic layout in Settings > Display & UI', 'doesn’t start any session'], []],
      ['classic, MCP off, off', { mcpOff: true, classic: true }, ['new layout only', 'Clubhouse MCP in Settings', 'Classic layout in Settings > Display & UI'], []],
    ] as const)('%s', (_name, s, has, hasNot) => {
      const text = help(s);
      for (const part of has) expect(text).toContain(part);
      for (const part of hasNot) expect(text).not.toContain(part);
      expect(text).not.toMatch(/\u2014/);
    });
  });
});
