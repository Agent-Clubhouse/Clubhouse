import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { McpOffImpact } from '../../../shared/mcp-off-impact';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { MCP_OFF_RESTORE_NOTE, mcpOffCounts, mcpOffKeeps, mcpOffLead } from './McpOffConfirm';
import { McpSettingsView } from './McpSettingsView';

const IMPACT: McpOffImpact = {
  turnsOff: true,
  appLoses: true,
  projectsLosing: ['site'],
  agentsLosing: 3,
  quickAgentsLosing: 0,
  agentsKeeping: 4,
  helpersReportOnly: 2,
  orchestratorsLosing: 2,
  connectedLosing: 2,
  runningLosing: 2,
  runningOrchestratorsWithHelpers: 1,
  dispatcherGoesOff: true,
  dispatcherRunning: true,
  keeps: { projects: [{ name: 'api', via: 'project_setting' }, { name: 'docs', via: 'project_setting' }], agents: [{ name: 'lead', project: 'site' }] },
  unreadableProjects: [],
};

const realSaveSettings = useMcpSettingsStore.getState().saveSettings;

/** As the real store: a save that takes shows in its state, and a failed one rolls back and resolves. */
let saveWorks = true;
const saveSettings = vi.fn(async (updates: object) => {
  if (saveWorks) useMcpSettingsStore.setState(updates as never);
});
const toggle = () => screen.getByRole('switch', { name: 'MCP bridge' });

beforeEach(() => {
  saveSettings.mockClear();
  saveWorks = true;
  useMcpSettingsStore.setState({ enabled: true, projectDefault: true, loaded: true, loadSettings: async () => {}, saveSettings } as never);
  window.clubhouse.app.getMcpOffImpact = vi.fn(async () => IMPACT);
  window.clubhouse.dispatcher.stop = vi.fn(async () => ({}) as never);
});

async function openDialog(impact: McpOffImpact = IMPACT): Promise<void> {
  window.clubhouse.app.getMcpOffImpact = vi.fn(async () => impact);
  render(<McpSettingsView />);
  await act(async () => { fireEvent.click(toggle()); });
  await screen.findByTestId('mcp-off-dialog');
}

describe('McpSettingsView', () => {
  it('has no Project default control: nothing reads it', () => {
    render(<McpSettingsView />);
    expect(screen.queryByRole('switch', { name: 'Project default' })).toBeNull();
  });

  it('turns on with no dialog', async () => {
    useMcpSettingsStore.setState({ enabled: false } as never);
    render(<McpSettingsView />);
    await act(async () => { fireEvent.click(toggle()); });
    expect(saveSettings).toHaveBeenCalledWith({ enabled: true });
    // Only the note's read of where things stand, never a proposal to confirm.
    expect(vi.mocked(window.clubhouse.app.getMcpOffImpact).mock.calls.every(([proposal]) => Object.keys(proposal).length === 0)).toBe(true);
    expect(screen.queryByTestId('mcp-off-dialog')).toBeNull();
  });

  it('says what restart does and what a running agent keeps, truthfully', () => {
    render(<McpSettingsView />);
    expect(screen.getByText(/The bridge server keeps running until you restart Clubhouse/)).toBeInTheDocument();
    expect(screen.getByText(/Turning MCP off stops new Clubhouse tool calls at once/)).toBeInTheDocument();
    expect(screen.getByText(/An agent that started without it needs a restart to get it/)).toBeInTheDocument();
    expect(screen.queryByText(/Start the bridge server for every project/)).toBeNull();
  });

  it('has no Clubhouse Mode note, and asks main nothing until the switch is turned off (#2901)', async () => {
    useMcpSettingsStore.setState({ enabled: false } as never);
    render(<McpSettingsView />);
    expect(screen.queryByText(/Clubhouse keeps MCP on/)).toBeNull();
    expect(screen.queryByTestId('mcp-kept-by-clubhouse-mode')).toBeNull();
  });

  it('asks before saving, with counts, what keeps MCP, and that MCP back starts nothing', async () => {
    await openDialog();
    expect(window.clubhouse.app.getMcpOffImpact).toHaveBeenCalledWith({ mcp: { enabled: false } });
    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('mcp-off-lead')).toHaveTextContent('Helpers, orchestration, connections to the Dispatcher and the Dispatcher itself stop working.');
    expect(screen.getByTestId('mcp-off-counts')).toHaveTextContent('3 agents lose Clubhouse tools, and 4 keep them. 2 helpers can only report to their parent. 1 running orchestrator has helpers. The Dispatcher is running.');
    expect(screen.getByTestId('mcp-off-keeps')).toHaveTextContent('These keep Clubhouse MCP: api (its own setting), docs (its own setting) and lead in site (its own setting).');
    expect(screen.getByText('Stops new Clubhouse tool calls for these agents now. Running agents keep working on what they can do without Clubhouse tools, and can’t message other agents. Helpers can still report to their parent.')).toBeInTheDocument();
    expect(screen.getByText(MCP_OFF_RESTORE_NOTE)).toBeInTheDocument();
    expect(document.querySelector('[data-testid="mcp-off-dialog"]')?.textContent).not.toMatch(/—/);
  });

  it('Cancel leaves everything as it is', async () => {
    await openDialog();
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-cancel')); });
    expect(saveSettings).not.toHaveBeenCalled();
    expect(window.clubhouse.dispatcher.stop).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mcp-off-dialog')).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('confirming saves and leaves the Dispatcher running: the stop is unchecked', async () => {
    await openDialog();
    const stop = screen.getByTestId('mcp-off-stop-dispatcher') as HTMLInputElement;
    expect(stop.checked).toBe(false);
    expect(stop.closest('label')).toHaveTextContent('Also stop the Dispatcher now. This interrupts whatever it is doing.');
    expect(screen.getByTestId('mcp-off-older-go')).toHaveTextContent('Older Clubhouse Go versions may not show a Dispatcher that’s still running with MCP off. You can stop it here.');
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(saveSettings).toHaveBeenCalledWith({ enabled: false });
    expect(window.clubhouse.dispatcher.stop).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mcp-off-dialog')).toBeNull();
  });

  it('a save that fails says so, stays open, and stops nothing', async () => {
    saveWorks = false;
    await openDialog();
    fireEvent.click(screen.getByTestId('mcp-off-stop-dispatcher'));
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(screen.getByTestId('mcp-off-failure')).toHaveTextContent('Couldn’t save, so Clubhouse MCP hasn’t changed. Try again.');
    expect(screen.getByTestId('mcp-off-dialog')).toBeInTheDocument();
    expect(window.clubhouse.dispatcher.stop).not.toHaveBeenCalled();
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    // And it can be tried again.
    saveWorks = true;
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(screen.queryByTestId('mcp-off-dialog')).toBeNull();
    expect(window.clubhouse.dispatcher.stop).toHaveBeenCalledTimes(1);
  });

  it('through the real store: a failed save leaves the switch on what is saved, and a retry saves it', async () => {
    useMcpSettingsStore.setState({ saveSettings: realSaveSettings });
    const save = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    window.clubhouse.settings.save = save as never;
    await openDialog();
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mcp-off-failure')).toHaveTextContent('Couldn’t save');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(useMcpSettingsStore.getState().enabled).toBe(true);

    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toMatchObject({ enabled: false });
    expect(screen.queryByTestId('mcp-off-dialog')).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('a save that throws reads the same', async () => {
    saveSettings.mockRejectedValueOnce(new Error('disk'));
    await openDialog();
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(screen.getByTestId('mcp-off-failure')).toHaveTextContent('Couldn’t save');
  });

  it('a stop that fails after a good save says so plainly', async () => {
    window.clubhouse.dispatcher.stop = vi.fn(async () => { throw new Error('busy'); });
    await openDialog();
    fireEvent.click(screen.getByTestId('mcp-off-stop-dispatcher'));
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    expect(saveSettings).toHaveBeenCalled();
    expect(screen.getByTestId('mcp-off-failure')).toHaveTextContent('Clubhouse MCP is off, but the Dispatcher couldn’t be stopped.');
  });

  it('counts running quick agents', () => {
    expect(mcpOffCounts({ ...IMPACT, quickAgentsLosing: 2 })).toContain('2 running quick agents lose them too.');
    expect(mcpOffCounts({ ...IMPACT, quickAgentsLosing: 1 })).toContain('1 running quick agent loses them too.');
    expect(mcpOffCounts(IMPACT)).not.toContain('quick');
  });

  it('stops it when asked to, after saving', async () => {
    await openDialog();
    fireEvent.click(screen.getByTestId('mcp-off-stop-dispatcher'));
    await act(async () => { fireEvent.click(screen.getByTestId('mcp-off-confirm')); });
    await waitFor(() => expect(window.clubhouse.dispatcher.stop).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenCalledWith({ enabled: false });
  });

  it('offers the stop only while it is running', async () => {
    await openDialog({ ...IMPACT, dispatcherRunning: false });
    expect(screen.queryByTestId('mcp-off-stop-dispatcher')).toBeNull();
    expect(screen.queryByTestId('mcp-off-older-go')).toBeNull();
    expect(screen.getByTestId('mcp-off-counts')).toHaveTextContent('The Dispatcher is not running.');
  });

  it('still asks when the counts can\'t be read', async () => {
    window.clubhouse.app.getMcpOffImpact = vi.fn(async () => { throw new Error('IPC down'); });
    render(<McpSettingsView />);
    await act(async () => { fireEvent.click(toggle()); });
    await screen.findByTestId('mcp-off-dialog');
    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mcp-off-counts')).toBeNull();
  });
});

describe('the dialog copy', () => {
  it('never sends people to the retired Clubhouse mode setting (#2901)', () => {
    for (const impact of [IMPACT, { ...IMPACT, turnsOff: false, appLoses: false, dispatcherGoesOff: false }, null]) {
      expect(mcpOffLead(impact)).not.toMatch(/Clubhouse mode/i);
    }
  });

  it('narrows to the project, with no Dispatcher line', () => {
    const impact = { ...IMPACT, appLoses: false, dispatcherGoesOff: false };
    expect(mcpOffLead(impact, 'site')).toBe('In site, helpers, orchestration and connections to the Dispatcher stop working.');
    expect(mcpOffCounts(impact)).toBe('3 agents lose Clubhouse tools, and 4 keep them. 2 helpers can only report to their parent. 1 running orchestrator has helpers.');
    expect(mcpOffCounts({ ...impact, agentsKeeping: 0, helpersReportOnly: 1 })).toBe('3 agents lose Clubhouse tools. 1 helper can only report to its parent. 1 running orchestrator has helpers.');
  });

  it('says nothing about keeping when nothing does', () => {
    expect(mcpOffKeeps({ ...IMPACT, keeps: { projects: [], agents: [] } })).toBe('');
  });
});
