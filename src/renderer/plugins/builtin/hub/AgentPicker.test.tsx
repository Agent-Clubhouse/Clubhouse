import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentPicker } from './AgentPicker';
import { createMockAPI } from '../../testing';
import type { AgentInfo } from '../../../../shared/plugin-types';

const DURABLE_AGENT: AgentInfo = {
  id: 'durable-1',
  name: 'Builder',
  kind: 'durable',
  status: 'sleeping',
  color: 'emerald',
  emoji: undefined,
  projectId: 'proj-1',
};

const QUICK_AGENT: AgentInfo = {
  id: 'quick-1',
  name: 'Scout',
  kind: 'quick',
  status: 'running',
  color: 'blue',
  emoji: undefined,
  projectId: 'proj-1',
};

function createPickerAPI() {
  return createMockAPI({
    agents: {
      ...createMockAPI().agents,
      getModelOptions: vi.fn(async () => [
        { id: 'default', label: 'Default' },
        { id: 'opus', label: 'Opus' },
      ]),
      runQuick: vi.fn(async () => 'new-agent-id'),
    },
    ui: {
      ...createMockAPI().ui,
      showError: vi.fn(),
    },
  });
}

describe('AgentPicker', () => {
  it('"No agents available" when empty', async () => {
    const api = createPickerAPI();
    render(<AgentPicker api={api} agents={[]} onPick={vi.fn()} />);
    expect(screen.getByText('No agents available')).toBeInTheDocument();
  });

  it('durable + quick agents in separate sections', async () => {
    const api = createPickerAPI();
    render(<AgentPicker api={api} agents={[DURABLE_AGENT, QUICK_AGENT]} onPick={vi.fn()} />);

    expect(screen.getByText('Durable')).toBeInTheDocument();
    expect(screen.getByText('Quick')).toBeInTheDocument();
    expect(screen.getByText('Builder')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
  });

  it('click agent calls onPick(id)', async () => {
    const onPick = vi.fn();
    const api = createPickerAPI();
    render(<AgentPicker api={api} agents={[DURABLE_AGENT]} onPick={onPick} />);

    fireEvent.click(screen.getByText('Builder'));
    expect(onPick).toHaveBeenCalledWith('durable-1');
  });

  it('quick agent form: fill + Start calls api.agents.runQuick()', async () => {
    const onPick = vi.fn();
    const api = createPickerAPI();
    render(<AgentPicker api={api} agents={[]} onPick={onPick} />);

    // Click "+ Quick Agent" to show form
    fireEvent.click(screen.getByText('+ Quick Agent'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('What should the quick agent do?')).toBeInTheDocument();
    });

    // Fill in mission
    const textarea = screen.getByPlaceholderText('What should the quick agent do?');
    fireEvent.change(textarea, { target: { value: 'Fix the bug' } });

    // Click Start
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => {
      expect(api.agents.runQuick).toHaveBeenCalledWith('Fix the bug', { model: 'default' });
      expect(onPick).toHaveBeenCalledWith('new-agent-id');
    });
  });

  it('Cmd+Enter submits form', async () => {
    const onPick = vi.fn();
    const api = createPickerAPI();
    render(<AgentPicker api={api} agents={[]} onPick={onPick} />);

    fireEvent.click(screen.getByText('+ Quick Agent'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('What should the quick agent do?')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('What should the quick agent do?');
    fireEvent.change(textarea, { target: { value: 'Do stuff' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(api.agents.runQuick).toHaveBeenCalled();
    });
  });

  it('spawn error shows api.ui.showError()', async () => {
    const api = createPickerAPI();
    (api.agents.runQuick as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn failed'));
    render(<AgentPicker api={api} agents={[]} onPick={vi.fn()} />);

    fireEvent.click(screen.getByText('+ Quick Agent'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('What should the quick agent do?')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('What should the quick agent do?'), {
      target: { value: 'Fail' },
    });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => {
      expect(api.ui.showError).toHaveBeenCalledWith(expect.stringContaining('spawn failed'));
    });
  });
});
