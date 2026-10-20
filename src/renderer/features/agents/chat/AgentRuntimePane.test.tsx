import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { useChatStore } from '../../../stores/chatStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentStore } from '../../../stores/agentStore';
import { AgentRuntimePane, resetChatFlagCache, switchAgentRuntime } from './AgentRuntimePane';
import { chatFixture, FIXTURE_AGENT_ID } from './fixtures';
import { CHAT_DEFAULT_TIP_KEY } from './chat-default-tip';
import { CHAT_CONTRACT_VERSION, MINIMAL_CHAT_CAPABILITIES, type ChatEvent } from '../../../../shared/chat';

const agent: Agent = {
  id: FIXTURE_AGENT_ID,
  projectId: 'proj-1',
  name: 'gallant-swift',
  kind: 'durable',
  status: 'running',
  color: 'emerald',
  orchestrator: 'codex-cli',
};

const terminal = <div data-testid="fake-terminal">terminal</div>;
const api = window.clubhouse;

function setFlag(on: boolean, eligible = true) {
  api.app.getExperimentalSettings = vi.fn(async () => ({ chat: on })) as typeof api.app.getExperimentalSettings;
  api.app.isPreviewEligible = vi.fn(async () => eligible);
}

function setRuntime(chat: boolean, chatAvailable: boolean) {
  api.chat.getAgentRuntime = vi.fn(async () => ({ chat, chatAvailable }));
}

describe('AgentRuntimePane', () => {
  beforeEach(() => {
    resetChatFlagCache();
    useChatStore.setState({ agents: {}, loading: {}, loaded: {} });
    api.chat.readTranscript = vi.fn(async () => []);
    useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'Clubhouse', path: '/work/clubhouse' }] } as never);
  });

  it('renders the terminal under the pane toolbar and never asks for the runtime with the flag off', async () => {
    setFlag(false);
    setRuntime(true, true);
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('fake-terminal')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-pane-bar')).toBeInTheDocument();
    expect(screen.getByTestId('agent-details-toggle')).toBeInTheDocument();
    expect(api.chat.getAgentRuntime).not.toHaveBeenCalled();
    // No Chat to switch to: the switch is Terminal and the Changes review.
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Terminal', 'Changes']);
  });

  it('renders the terminal alone outside the main pane', async () => {
    setFlag(false);
    const { container } = render(<AgentRuntimePane agent={agent} terminal={terminal} canSwitch={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.firstChild).toBe(screen.getByTestId('fake-terminal'));
  });

  it('keeps the flag off in builds that are not preview-eligible', async () => {
    setFlag(true, false);
    setRuntime(true, true);
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('fake-terminal')).toBeInTheDocument();
    expect(api.chat.getAgentRuntime).not.toHaveBeenCalled();
  });

  it('shows ChatView for an agent running in chat', async () => {
    setFlag(true);
    setRuntime(true, true);
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('chat-view');
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    expect(api.chat.getAgentRuntime).toHaveBeenCalledWith(FIXTURE_AGENT_ID, 'codex-cli', { projectPath: '/work/clubhouse', starting: false });
  });

  describe('waking (#2206)', () => {
    const waking: Agent = { ...agent, status: 'waking' };

    it('shows the pending view, not the terminal, while a chat agent wakes', async () => {
      setFlag(true);
      // Main: it will use chat, but no chat runtime runs it yet.
      api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: false, chatAvailable: true }));
      render(<AgentRuntimePane agent={waking} terminal={terminal} />);
      await waitFor(() => expect(api.chat.getAgentRuntime).toHaveBeenCalledWith(FIXTURE_AGENT_ID, 'codex-cli', { projectPath: '/work/clubhouse', starting: true }));
      expect(await screen.findByText('Connecting to gallant-swift…')).toBeInTheDocument();
      expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('terminal-runtime-bar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
      // Starting into chat isn't running in chat: status surfaces don't overlay chat state yet.
      expect(useChatStore.getState().live[FIXTURE_AGENT_ID]).toBe(false);
    });

    it('shows ChatView once the chat runtime runs, and the terminal when the chat start fell back', async () => {
      setFlag(true);
      api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: false, chatAvailable: true }));
      api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
      const { rerender } = render(<AgentRuntimePane agent={waking} terminal={terminal} />);
      await screen.findByTestId('agent-runtime-pending');

      api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: true, chatAvailable: true }));
      rerender(<AgentRuntimePane agent={{ ...agent, status: 'running' }} terminal={terminal} />);
      await screen.findByTestId('chat-view');
      expect(useChatStore.getState().live[FIXTURE_AGENT_ID]).toBe(true);

      // A driver failure falls back to the terminal: the status change refetches and the terminal shows.
      api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: false, chatAvailable: true }));
      rerender(<AgentRuntimePane agent={{ ...agent, status: 'spawning' }} terminal={terminal} />);
      await screen.findByTestId('agent-runtime-pending');
      api.chat.getAgentRuntime = vi.fn(async () => ({ chat: false, live: false, chatAvailable: true }));
      rerender(<AgentRuntimePane agent={{ ...agent, status: 'running' }} terminal={terminal} />);
      await screen.findByTestId('fake-terminal');
      expect(screen.getByTestId('terminal-runtime-bar')).toBeInTheDocument();
    });

    it('shows the terminal while a terminal agent wakes', async () => {
      setFlag(true);
      setRuntime(false, true);
      render(<AgentRuntimePane agent={waking} terminal={terminal} />);
      await screen.findByTestId('fake-terminal');
      // The first terminal shown already has the switch: no plain terminal from before the flag loaded.
      expect(screen.getByTestId('terminal-runtime-bar')).toBeInTheDocument();
      expect(screen.queryByTestId('agent-runtime-pending')).not.toBeInTheDocument();
    });

    it("doesn't show the terminal answer from before the wake while waking", async () => {
      setFlag(true);
      setRuntime(false, true);
      const { unmount } = render(<AgentRuntimePane agent={{ ...agent, status: 'running' }} terminal={terminal} />);
      await screen.findByTestId('fake-terminal');
      unmount();

      api.chat.getAgentRuntime = vi.fn(() => new Promise(() => {}));
      render(<AgentRuntimePane agent={waking} terminal={terminal} />);
      expect(screen.getByTestId('agent-runtime-pending')).toBeInTheDocument();
      expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    });
  });

  it('offers the switch over the terminal only when the provider has a chat driver', async () => {
    setFlag(true);
    setRuntime(false, false);
    const { unmount } = render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await waitFor(() => expect(api.chat.getAgentRuntime).toHaveBeenCalled());
    expect(screen.queryByTestId('terminal-runtime-bar')).not.toBeInTheDocument();
    unmount();

    setRuntime(false, true);
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('terminal-runtime-bar');
    expect(screen.getByTestId('fake-terminal')).toBeInTheDocument();
  });

  it('hides the switch in both runtimes when switching is left to the main pane', async () => {
    setFlag(true);
    setRuntime(true, true);
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    const { unmount } = render(<AgentRuntimePane agent={agent} terminal={terminal} canSwitch={false} context="popout" />);
    await screen.findByTestId('chat-view');
    expect(screen.queryByTestId('runtime-switch')).not.toBeInTheDocument();
    unmount();

    setRuntime(false, true);
    const { container } = render(<AgentRuntimePane agent={agent} terminal={terminal} canSwitch={false} />);
    await waitFor(() => expect(container.firstChild).toBe(screen.queryByTestId('fake-terminal')));
    expect(screen.queryByTestId('terminal-runtime-bar')).not.toBeInTheDocument();
  });

  it('shows a neutral placeholder, not the terminal, until the flag and runtime are known', async () => {
    let answer!: (v: { chat: boolean; chatAvailable: boolean }) => void;
    setFlag(true);
    api.chat.getAgentRuntime = vi.fn(() => new Promise((r) => { answer = r; }));
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    expect(screen.getByTestId('agent-runtime-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    await waitFor(() => expect(api.chat.getAgentRuntime).toHaveBeenCalled());
    await act(async () => { answer({ chat: true, chatAvailable: true }); });
    await screen.findByTestId('chat-view');
    expect(screen.queryByTestId('agent-runtime-pending')).not.toBeInTheDocument();
  });

  it('says it is connecting when the runtime takes a while to answer', async () => {
    setFlag(true);
    api.chat.getAgentRuntime = vi.fn(() => new Promise(() => {}));
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    // Blank at first, so a fast answer doesn't flash text.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(await screen.findByText('Connecting to gallant-swift…')).toBeInTheDocument();
    // Still unknown after the flag loads: no terminal in the meantime.
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-runtime-pending')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders quick agents\' terminals from the first paint, even before the flag loads', () => {
    setFlag(true);
    render(<AgentRuntimePane agent={{ ...agent, kind: 'quick' }} terminal={terminal} />);
    expect(screen.getByTestId('fake-terminal')).toBeInTheDocument();
  });

  it('never offers chat for quick agents', async () => {
    setFlag(true);
    setRuntime(false, true);
    render(<AgentRuntimePane agent={{ ...agent, kind: 'quick' }} terminal={terminal} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.chat.getAgentRuntime).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-runtime-bar')).not.toBeInTheDocument();
  });

  it('switches an idle chat agent to the terminal, resuming its session', async () => {
    setFlag(true);
    setRuntime(true, true);
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    const updateDurableConfig = vi.fn(async () => {});
    const config = { id: FIXTURE_AGENT_ID, name: 'gallant-swift', color: 'emerald', lastSessionId: 'native-1', orchestrator: 'codex-cli' };
    api.agent.updateDurableConfig = updateDurableConfig as typeof api.agent.updateDurableConfig;
    api.agent.getDurableConfig = vi.fn(async () => config) as unknown as typeof api.agent.getDurableConfig;
    const killAgent = vi.fn(async () => {});
    const spawnDurableAgent = vi.fn(async () => FIXTURE_AGENT_ID);
    useAgentStore.setState({ killAgent, spawnDurableAgent } as never);

    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('chat-turn-footer');
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }));
    await waitFor(() => expect(spawnDurableAgent).toHaveBeenCalled());
    expect(updateDurableConfig).toHaveBeenCalledWith('/work/clubhouse', FIXTURE_AGENT_ID, { runtimeMode: 'terminal' });
    // Waits for the exit so the respawn resumes the session the old process just saved.
    expect(killAgent).toHaveBeenCalledWith(FIXTURE_AGENT_ID, '/work/clubhouse', { waitForExit: true });
    expect(spawnDurableAgent).toHaveBeenCalledWith('proj-1', '/work/clubhouse', config, true);
    // Choosing Terminal is explicit: the "Agents now open in Chat" tip is never needed again.
    expect(localStorage.getItem(CHAT_DEFAULT_TIP_KEY)).toBe('chose_terminal');
    localStorage.removeItem(CHAT_DEFAULT_TIP_KEY);
  });

  it('asks before switching during a turn', async () => {
    setFlag(true);
    setRuntime(true, true);
    api.chat.readTranscript = vi.fn(async () => chatFixture('claude', 'steer'));
    const killAgent = vi.fn(async () => {});
    useAgentStore.setState({ killAgent, spawnDurableAgent: vi.fn(async () => FIXTURE_AGENT_ID) } as never);
    api.agent.getDurableConfig = vi.fn(async () => ({ id: FIXTURE_AGENT_ID })) as unknown as typeof api.agent.getDurableConfig;

    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('chat-queue');
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }));
    expect(await screen.findByText('Interrupt and switch?')).toBeInTheDocument();
    expect(killAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    await waitFor(() => expect(killAgent).toHaveBeenCalled());
  });

  it('asks before switching a busy terminal agent to chat', async () => {
    setFlag(true);
    setRuntime(false, true);
    const killAgent = vi.fn(async () => {});
    useAgentStore.setState({ killAgent, agentDetailedStatus: { [FIXTURE_AGENT_ID]: { state: 'working', message: '', timestamp: 1 } } } as never);
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('terminal-runtime-bar');
    fireEvent.click(screen.getByRole('radio', { name: 'Chat' }));
    expect(await screen.findByText('Interrupt and switch?')).toBeInTheDocument();
    expect(killAgent).not.toHaveBeenCalled();
  });

  it('remounts straight into the last known runtime instead of flashing the terminal', async () => {
    setFlag(true);
    setRuntime(true, true);
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    const first = render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('chat-view');
    first.unmount();

    api.chat.getAgentRuntime = vi.fn(() => new Promise(() => {}));
    render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    await screen.findByTestId('chat-view');
  });

  it('does not show one agent\'s runtime for another', async () => {
    setFlag(true);
    setRuntime(true, true);
    api.chat.readTranscript = vi.fn(async () => []);
    const first = render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('chat-view');
    first.unmount();

    api.chat.getAgentRuntime = vi.fn(() => new Promise(() => {}));
    render(<AgentRuntimePane agent={{ ...agent, id: 'other-agent' }} terminal={terminal} />);
    await act(async () => { await Promise.resolve(); });
    // Unknown for this agent: neither its terminal nor the first agent's chat.
    expect(screen.getByTestId('agent-runtime-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
  });
});

describe('switchAgentRuntime breadcrumbs (#2098)', () => {
  it('notes the switch and its failure for feedback reports, with the mode only', async () => {
    useProjectStore.setState({ projects: [] } as never);
    const record = vi.spyOn(window.clubhouse.feedback, 'recordBreadcrumb');
    await expect(switchAgentRuntime(agent, 'chat')).rejects.toThrow('Project not found');
    expect(record.mock.calls.map(([c]) => c)).toEqual([
      { kind: 'event', code: 'runtime.switch.chat' },
      { kind: 'error', code: 'runtime.switch_failed.chat' },
    ]);
    record.mockRestore();
  });
});

describe('/clear swapping the chat session (#2218)', () => {
  const NEW_SESSION = 'session-after-clear';
  let seq = 0;

  function emit(type: ChatEvent['type'], data: unknown) {
    act(() => {
      useChatStore.getState().applyEvent({
        v: CHAT_CONTRACT_VERSION, agentId: FIXTURE_AGENT_ID, sessionId: NEW_SESSION, seq: ++seq, ts: Date.now(), type, data,
      } as ChatEvent);
    });
  }

  /** What clearContext emits after the old session closes, in order. */
  const clearNotice = () => emit('notice', { level: 'info', code: 'context_cleared', message: 'Started a new conversation.' });
  function newSessionOpens() {
    emit('session_state', { state: 'starting' });
    emit('session_started', { driver: 'codex-app-server', provider: 'codex-cli', cwd: '/work/clubhouse', resumed: false, capabilities: MINIMAL_CHAT_CAPABILITIES });
    emit('session_state', { state: 'idle' });
  }

  async function mountInChat() {
    setFlag(true);
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: true, chatAvailable: true }));
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
    const view = render(<AgentRuntimePane agent={agent} terminal={terminal} />);
    await screen.findByTestId('chat-view');
    return view;
  }

  beforeEach(() => {
    seq = 0;
    resetChatFlagCache();
    useChatStore.setState({ agents: {}, loading: {}, loaded: {}, live: {} });
    useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'Clubhouse', path: '/work/clubhouse' }] } as never);
  });

  it('returns to ChatView without a remount when main answered "not chat" before the new session opened', async () => {
    await mountInChat();
    // Mid-clear: the old session is closed and the new one isn't open yet.
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: false, live: false, chatAvailable: true }));
    clearNotice();
    await waitFor(() => expect(api.chat.getAgentRuntime).toHaveBeenCalledTimes(1));
    // The stuck state from the report: the terminal pane for a chat agent.
    await screen.findByTestId('fake-terminal');

    // The swap completes; main now answers chat.
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: true, chatAvailable: true }));
    newSessionOpens();
    await screen.findByTestId('chat-view');
    expect(api.chat.getAgentRuntime).toHaveBeenCalled();
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    expect(useChatStore.getState().live[FIXTURE_AGENT_ID]).toBe(true);
  });

  it('never shows the terminal when the "not chat" answer arrives after the new session opened', async () => {
    await mountInChat();
    let answer!: (info: { chat: boolean; live: boolean; chatAvailable: boolean }) => void;
    api.chat.getAgentRuntime = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    clearNotice();
    await waitFor(() => expect(api.chat.getAgentRuntime).toHaveBeenCalledTimes(1));
    newSessionOpens();

    // The answer from mid-clear lands last. It's older than the events, so it's asked again.
    const stale = api.chat.getAgentRuntime;
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, live: true, chatAvailable: true }));
    await act(async () => { answer({ chat: false, live: false, chatAvailable: true }); });
    await waitFor(() => expect(api.chat.getAgentRuntime).toHaveBeenCalledTimes(1));
    expect(stale).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
    expect(screen.queryByTestId('fake-terminal')).not.toBeInTheDocument();
    expect(useChatStore.getState().live[FIXTURE_AGENT_ID]).toBe(true);
  });

  it('still settles on the terminal when chat really ended, without asking again', async () => {
    const { rerender } = await mountInChat();
    // Switched to the terminal: the chat session ends, then the restart answers terminal.
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: false, live: false, chatAvailable: true }));
    emit('session_ended', { reason: 'stopped', exitCode: 0 });
    rerender(<AgentRuntimePane agent={{ ...agent, status: 'sleeping' }} terminal={terminal} />);
    await screen.findByTestId('fake-terminal');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.chat.getAgentRuntime).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });
});
