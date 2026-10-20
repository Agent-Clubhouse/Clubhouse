import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { createMockAPI } from '../../testing';

const openNewAgentOrDialog = vi.fn();
vi.mock('../../../chrome/startPage', async (orig) => ({
  ...(await orig<typeof import('../../../chrome/startPage')>()),
  openNewAgentOrDialog: (...args: unknown[]) => openNewAgentOrDialog(...args),
}));
import type { AgentInfo, PluginAgentDetailedStatus, PluginAPI } from '../../../../shared/plugin-types';
import { useChromeStore } from '../../../chrome/chromeStore';
import { useChromeFlagStore } from '../../../chrome/chromeFlag';
import { MainPanel } from './ReviewPanel';
import { browseAction, describeAgents, emptyCause, timeAgo } from './reviewModel';
import { FOCUS_ACTIVE_TERMINAL_EVENT } from './host';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return { id: 'agent-1', name: 'alpha', kind: 'durable', status: 'running', color: '#ff0000', projectId: 'proj-1', ...overrides };
}

const REMOTE = (id: string) => `remote||sat1||${id}`;

describe('emptyCause', () => {
  const on = { includeSleeping: true, includeRemote: true, needsYouOnly: false };

  it('no agents at all', () => {
    expect(emptyCause([], on)).toEqual({ kind: 'no-agents' });
  });

  it('everyone asleep with Sleeping off is nothing running', () => {
    const a = makeAgent({ id: 'a', status: 'sleeping' });
    const cause = emptyCause([a], { ...on, includeSleeping: false });
    expect(cause.kind).toBe('nothing-running');
  });

  it('Needs you only with agents running is nobody needs you, not nothing running', () => {
    const agents = [makeAgent({ id: 'a' }), makeAgent({ id: 'b' })];
    const cause = emptyCause(agents, { ...on, needsYouOnly: true });
    expect(cause).toMatchObject({ kind: 'nobody-needs-you' });
    expect(cause.kind === 'nobody-needs-you' && cause.others).toHaveLength(2);
  });

  it('blames Remote when remote agents are what is hidden', () => {
    const agents = [makeAgent({ id: 'a', status: 'sleeping' }), makeAgent({ id: REMOTE('r1') }), makeAgent({ id: REMOTE('r2') })];
    const cause = emptyCause(agents, { includeSleeping: false, includeRemote: false, needsYouOnly: false });
    expect(cause).toEqual({ kind: 'filtered', total: 3, hiddenBySleeping: 1, hiddenByRemote: 2 });
  });
});

describe('browseAction', () => {
  it('maps the browsing keys', () => {
    expect(browseAction({ key: 'ArrowLeft' })).toEqual({ type: 'prev' });
    expect(browseAction({ key: 'k' })).toEqual({ type: 'prev' });
    expect(browseAction({ key: 'ArrowRight' })).toEqual({ type: 'next' });
    expect(browseAction({ key: 'J' })).toEqual({ type: 'next' });
    expect(browseAction({ key: 's' })).toEqual({ type: 'sleep' });
    expect(browseAction({ key: 'w' })).toEqual({ type: 'wake' });
    expect(browseAction({ key: 'g' })).toEqual({ type: 'jump-list' });
    expect(browseAction({ key: 'Enter' })).toEqual({ type: 'type' });
    expect(browseAction({ key: '3' })).toEqual({ type: 'jump', index: 2 });
  });

  it('leaves modified keys and 0 alone', () => {
    expect(browseAction({ key: 'ArrowLeft', metaKey: true })).toBeNull();
    expect(browseAction({ key: 'j', ctrlKey: true })).toBeNull();
    expect(browseAction({ key: '0' })).toBeNull();
  });
});

describe('describeAgents', () => {
  it('counts running and sleeping agents separately', () => {
    expect(describeAgents([makeAgent({ id: 'a' }), makeAgent({ id: 'b' })])).toBe('2 agents are running');
    expect(describeAgents([makeAgent({ id: 'a' }), makeAgent({ id: 'b', status: 'sleeping' })])).toBe('1 agent is running and 1 is asleep');
    expect(describeAgents([makeAgent({ id: 'a', status: 'sleeping' })])).toBe('1 agent is asleep');
  });
});

describe('timeAgo', () => {
  it('formats minutes, hours and days', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(timeAgo('2026-10-17T11:55:00Z', now)).toBe('5m ago');
    expect(timeAgo('2026-10-17T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-10-15T12:00:00Z', now)).toBe('2d ago');
    expect(timeAgo(null, now)).toBeNull();
  });
});

describe('MainPanel', () => {
  function StubTerminal({ agentId, focused }: { agentId: string; focused?: boolean }) {
    return <div data-testid={`terminal-${agentId}`} data-focused={String(!!focused)} />;
  }
  /** The bare terminal widget, blank for an agent running in chat: Review must not use it (#2089). */
  function BareTerminal({ agentId }: { agentId: string }) {
    return <div data-testid={`bare-terminal-${agentId}`} />;
  }
  /** AgentView for an agent running in chat: the transcript and its composer. */
  function StubChat({ agentId }: { agentId: string }) {
    return <div data-testid={`chat-${agentId}`}><div data-testid="chat-composer"><textarea aria-label="Message" /></div></div>;
  }

  function makeApi(initial: AgentInfo[], opts: {
    settings?: Record<string, boolean>;
    detailed?: Record<string, PluginAgentDetailedStatus>;
    mode?: 'app' | 'project';
    view?: PluginAPI['widgets']['AgentView'];
    sessions?: Array<{ sessionId: string; startedAt: string; lastActiveAt: string; friendlyName?: string }>;
  } = {}) {
    let list = initial;
    const listeners = new Set<() => void>();
    const settings: Record<string, boolean> = { 'include-sleeping': true, 'include-remote': true, 'needs-attention-only': false, ...opts.settings };
    const set = vi.fn((key: string, value: boolean) => { settings[key] = value; });
    const setTitle = vi.fn();
    const resetTitle = vi.fn();
    const kill = vi.fn(async () => {});
    const base = createMockAPI();
    const api = createMockAPI({
      context: { mode: opts.mode ?? 'app', projectId: 'proj-1', projectPath: '/tmp/p1' },
      agents: {
        ...base.agents,
        list: () => list,
        kill,
        getDetailedStatus: (id: string) => opts.detailed?.[id] ?? null,
        onAnyChange: (cb: () => void) => { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
        listSessions: async () => opts.sessions ?? [],
        readSessionTranscript: async () => null,
        getSessionSummary: async () => null,
      },
      widgets: { ...base.widgets, AgentTerminal: BareTerminal, AgentView: opts.view ?? StubTerminal },
      settings: {
        get: <T,>(key: string): T | undefined => settings[key] as unknown as T,
        getAll: () => ({}),
        set: set as unknown as PluginAPI['settings']['set'],
        onChange: () => ({ dispose: () => {} }),
      },
      window: { ...base.window, setTitle, resetTitle },
    });
    return { api, set, setTitle, resetTitle, kill, setList: (next: AgentInfo[]) => { list = next; listeners.forEach((cb) => cb()); } };
  }

  const three = () => [makeAgent({ id: 'a1', name: 'one' }), makeAgent({ id: 'a2', name: 'two' }), makeAgent({ id: 'a3', name: 'three' })];
  const panel = () => screen.getByTestId('review-panel');
  const showing = (id: string) => screen.queryByTestId(`terminal-${id}`) !== null;

  beforeEach(() => {
    useChromeStore.setState({ appLaunch: null, appViewAgentId: null });
    useChromeFlagStore.setState({ enabled: false });
  });

  it('shows the status word from the shared vocabulary', () => {
    const { api } = makeApi([makeAgent({ id: 'a1' })], { detailed: { a1: { state: 'needs_permission', message: 'Bash' } } });
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('review-status-word').textContent).toBe('Needs you');
  });

  it('moves with arrow keys and J / K, and jumps with number keys', () => {
    const { api } = makeApi(three());
    render(<MainPanel api={api} />);
    expect(showing('a1')).toBe(true);
    fireEvent.keyDown(panel(), { key: 'ArrowRight' });
    expect(showing('a2')).toBe(true);
    fireEvent.keyDown(panel(), { key: 'j' });
    expect(showing('a3')).toBe(true);
    fireEvent.keyDown(panel(), { key: 'k' });
    expect(showing('a2')).toBe(true);
    fireEvent.keyDown(panel(), { key: '1' });
    expect(showing('a1')).toBe(true);
  });

  it('S sleeps the running agent', () => {
    const { api, kill } = makeApi(three());
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 's' });
    expect(kill).toHaveBeenCalledWith('a1');
  });

  it('Return hands the keyboard to the agent and ⌥⌘→ (next) returns to browsing', async () => {
    const { api } = makeApi(three());
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 'Enter' });
    expect(panel().getAttribute('data-mode')).toBe('typing');
    expect(screen.getByTestId('terminal-a1').getAttribute('data-focused')).toBe('true');
    expect(screen.getByTestId('review-hints').textContent).toContain('Typing to one');
    // Browsing keys no longer move while typing.
    fireEvent.keyDown(panel(), { key: 'j' });
    expect(showing('a1')).toBe(true);
    const { reviewNav } = await import('./commands');
    act(() => reviewNav.next?.());
    expect(panel().getAttribute('data-mode')).toBe('browsing');
    expect(showing('a2')).toBe(true);
  });

  it('Return asks the terminal to take focus', async () => {
    const { api } = makeApi(three());
    const onFocus = vi.fn();
    window.addEventListener(FOCUS_ACTIVE_TERMINAL_EVENT, onFocus);
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 'Enter' });
    await waitFor(() => expect(onFocus).toHaveBeenCalled());
    window.removeEventListener(FOCUS_ACTIVE_TERMINAL_EVENT, onFocus);
  });

  it('shows the agent through the runtime-aware view, never the bare terminal', () => {
    const { api } = makeApi([makeAgent({ id: 'a1' })], { view: StubChat });
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('chat-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('bare-terminal-a1')).not.toBeInTheDocument();
  });

  it('Return on an agent running in chat focuses its composer, not a terminal', async () => {
    const { api } = makeApi([makeAgent({ id: 'a1', name: 'one' })], { view: StubChat });
    const onFocus = vi.fn();
    window.addEventListener(FOCUS_ACTIVE_TERMINAL_EVENT, onFocus);
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 'Enter' });
    expect(panel().getAttribute('data-mode')).toBe('typing');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Message')));
    expect(onFocus).not.toHaveBeenCalled();
    window.removeEventListener(FOCUS_ACTIVE_TERMINAL_EVENT, onFocus);
  });

  it('clicking into the chat composer types to the agent, and leaving it goes back to browsing', () => {
    const { api } = makeApi([makeAgent({ id: 'a1', name: 'one' })], { view: StubChat });
    render(<MainPanel api={api} />);
    act(() => screen.getByLabelText('Message').focus());
    expect(panel().getAttribute('data-mode')).toBe('typing');
    expect(screen.getByTestId('review-hints').textContent).toContain('Typing to one');
    act(() => screen.getByTestId('review-jump-list-button').focus());
    expect(panel().getAttribute('data-mode')).toBe('browsing');
  });

  it('stops typing when the agent drops out of the list, so the next agent never gets the keys', () => {
    const agents = [makeAgent({ id: 'a1', name: 'one' }), makeAgent({ id: 'a2', name: 'two' })];
    const detailed: Record<string, PluginAgentDetailedStatus> = {
      a1: { state: 'needs_permission', message: 'Bash' },
      a2: { state: 'needs_permission', message: 'Bash' },
    };
    const { api, setList } = makeApi(agents, { settings: { 'needs-attention-only': true }, detailed });
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 'Enter' });
    expect(panel().getAttribute('data-mode')).toBe('typing');
    // Approving a1's prompt drops it from Needs you only.
    delete detailed.a1;
    act(() => setList([...agents]));
    expect(showing('a2')).toBe(true);
    expect(screen.getByTestId('terminal-a2').getAttribute('data-focused')).toBe('false');
    expect(panel().getAttribute('data-mode')).toBe('browsing');
    fireEvent.keyDown(panel(), { key: 'j' });
    expect(panel().getAttribute('data-mode')).toBe('browsing');
  });

  it('stops typing when the agent goes to sleep', () => {
    const agents = [makeAgent({ id: 'a1', name: 'one' }), makeAgent({ id: 'a2', name: 'two' })];
    const { api, setList } = makeApi(agents);
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 'Enter' });
    act(() => setList([{ ...agents[0], status: 'sleeping' }, agents[1]]));
    expect(screen.getByTestId('review-sleeping-card')).toBeTruthy();
    expect(panel().getAttribute('data-mode')).toBe('browsing');
  });

  it('S does nothing on a quick agent', () => {
    const { api, kill } = makeApi([makeAgent({ id: 'q1', kind: 'quick' })]);
    render(<MainPanel api={api} />);
    expect(screen.queryByTestId('review-sleep-button')).toBeNull();
    fireEvent.keyDown(panel(), { key: 's' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('G opens the jump list on the shared menu, and a number picks from it', () => {
    const { api } = makeApi(three());
    render(<MainPanel api={api} />);
    fireEvent.keyDown(panel(), { key: 'g' });
    const menu = screen.getByTestId('review-jump-list');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(screen.getByTestId('review-jump-list-a1').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('review-jump-list-a2').textContent).toContain('Done');
    fireEvent.keyDown(menu, { key: '3' });
    expect(screen.queryByTestId('review-jump-list')).toBeNull();
    expect(showing('a3')).toBe(true);
  });

  it('Needs you > Review applies Needs you only for the visit without saving it', () => {
    const agents = [makeAgent({ id: 'a1', name: 'one' }), makeAgent({ id: 'a2', name: 'two' })];
    const { api, set } = makeApi(agents, { detailed: { a2: { state: 'needs_permission', message: 'Bash' } } });
    act(() => useChromeStore.getState().launchApp('review', { needsYouOnly: true }));
    render(<MainPanel api={api} />);
    expect(showing('a2')).toBe(true);
    expect(showing('a1')).toBe(false);
    expect(screen.getByTestId('review-filter-needs-you').textContent).toContain('this visit');
    expect(set).not.toHaveBeenCalled();
  });

  it('a plain open after a Needs you visit uses the saved filters', () => {
    const agents = [makeAgent({ id: 'a1', name: 'one' }), makeAgent({ id: 'a2', name: 'two' })];
    const { api } = makeApi(agents, { detailed: { a2: { state: 'needs_permission', message: 'Bash' } } });
    act(() => useChromeStore.getState().launchApp('review', { needsYouOnly: true }));
    render(<MainPanel api={api} />);
    act(() => useChromeStore.getState().launchApp('review'));
    expect(showing('a1')).toBe(true);
    expect(screen.getByTestId('review-filter-needs-you').textContent).not.toContain('this visit');
  });

  it('says nobody needs you, and Show everyone turns the filter off and saves it', () => {
    const { api, set } = makeApi(three(), { settings: { 'needs-attention-only': true } });
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('review-empty').getAttribute('data-cause')).toBe('nobody-needs-you');
    expect(screen.getByText('Nobody needs you')).toBeTruthy();
    expect(screen.queryByTestId('review-hints')).toBeNull();
    fireEvent.click(screen.getByTestId('review-empty-show-everyone'));
    expect(set).toHaveBeenCalledWith('needs-attention-only', false);
    expect(showing('a1')).toBe(true);
  });

  it('names Remote as the filter that hides everyone', () => {
    const agents = [makeAgent({ id: REMOTE('r1'), name: 'far' })];
    const { api } = makeApi(agents, { settings: { 'include-remote': false } });
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('review-empty').getAttribute('data-cause')).toBe('filtered');
    expect(screen.getByTestId('review-empty').textContent).toContain('Remote');
    expect(screen.getByTestId('review-empty').textContent).not.toContain('Sleeping');
  });

  it('shows the last session\'s markdown as text and formatting on the sleeping card (#2092)', async () => {
    const { api } = makeApi([makeAgent({ id: 'a1', name: 'dozy', status: 'sleeping' })], {
      sessions: [{ sessionId: 's1', startedAt: '2026-10-17T00:00:00Z', lastActiveAt: '2026-10-17T01:00:00Z' }],
    });
    api.agents.getSessionSummary = async () => ({ summary: '**Triaged** the `audit`\n\n- one', filesModified: [], totalDurationMs: 0 }) as never;
    render(<MainPanel api={api} />);
    const card = screen.getByTestId('review-sleeping-card');
    await waitFor(() => expect(card.textContent).toContain('Triaged the audit'));
    expect(card.textContent).not.toContain('**');
    expect(card.querySelector('strong')).toHaveTextContent('Triaged');
  });

  it('shows the sleeping card with Wake in the toolbar, Skip and a wake prompt', async () => {
    const agents = [makeAgent({ id: 'a1', name: 'dozy', status: 'sleeping' }), makeAgent({ id: 'a2', name: 'two' })];
    const { api } = makeApi(agents);
    render(<MainPanel api={api} />);
    expect(screen.getByTestId('review-sleeping-card')).toBeTruthy();
    expect(screen.getByTestId('review-wake-button')).toBeTruthy();
    expect(screen.queryByTestId('review-sleep-button')).toBeNull();
    expect(screen.getByTestId('review-wake-prompt').getAttribute('placeholder')).toBe('Tell dozy what to do when it wakes…');
    await waitFor(() => expect(screen.getByTestId('review-sleeping-card').textContent).toContain('No earlier sessions'));
    fireEvent.click(screen.getByTestId('review-skip'));
    expect(showing('a2')).toBe(true);
  });

  it('keys typed in the wake prompt stay in the prompt', () => {
    const agents = [makeAgent({ id: 'a1', name: 'dozy', status: 'sleeping' }), makeAgent({ id: 'a2', name: 'two' })];
    const { api } = makeApi(agents);
    render(<MainPanel api={api} />);
    fireEvent.keyDown(screen.getByTestId('review-wake-prompt'), { key: 'j' });
    expect(screen.getByTestId('review-sleeping-card')).toBeTruthy();
  });

  it("New agent opens the New agent page for the active project (#2031)", () => {
    useChromeFlagStore.setState({ enabled: true });
    useProjectStore.setState({ activeProjectId: 'proj-1' });
    openNewAgentOrDialog.mockClear();
    const { api } = makeApi([]);
    render(<MainPanel api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    expect(openNewAgentOrDialog).toHaveBeenCalledExactlyOnceWith('durable', 'proj-1');
  });

  it('classic layout sets the window title', () => {
    const { api, setTitle } = makeApi(three());
    render(<MainPanel api={api} />);
    expect(setTitle).toHaveBeenCalledWith('Review — one');
  });

  it('new chrome leaves the breadcrumb alone and moves the sidebar selection', () => {
    useChromeFlagStore.setState({ enabled: true });
    const { api, setTitle } = makeApi(three());
    const { unmount } = render(<MainPanel api={api} />);
    expect(setTitle).not.toHaveBeenCalled();
    expect(useChromeStore.getState().appViewAgentId).toBe('a1');
    fireEvent.keyDown(panel(), { key: 'ArrowRight' });
    expect(useChromeStore.getState().appViewAgentId).toBe('a2');
    unmount();
    expect(useChromeStore.getState().appViewAgentId).toBeNull();
  });

  describe('sleeping card wake', () => {
    const spawnDurableAgent = vi.fn(async () => {});
    beforeEach(() => {
      spawnDurableAgent.mockClear();
      useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'one', path: '/projects/one' }] as never });
      useAgentStore.setState({ agents: { s1: { id: 's1', projectId: 'proj-1', name: 'dozy', kind: 'durable', status: 'sleeping' } } as never, spawnDurableAgent } as never);
      Object.assign(window.clubhouse.agent, { listDurable: vi.fn(async () => [{ id: 's1', name: 'dozy', lastSessionId: 'older' }]) });
    });

    it('shows the session a resume continues, and Wake resumes it with the prompt', async () => {
      const sessions = [
        { sessionId: 'newer', startedAt: '', lastActiveAt: '2026-10-17T10:00:00Z', friendlyName: 'Unresumable scratch run' },
        { sessionId: 'older', startedAt: '', lastActiveAt: '2026-10-16T10:00:00Z', friendlyName: 'Fix the flaky test' },
      ];
      const { api } = makeApi([makeAgent({ id: 's1', name: 'dozy', status: 'sleeping' })], { sessions });
      render(<MainPanel api={api} />);
      await waitFor(() => expect(screen.getByTestId('review-last-session').textContent).toContain('Fix the flaky test'));
      expect(screen.getByRole('switch', { name: 'Resume last session' })).toBeTruthy();
      fireEvent.change(screen.getByTestId('review-wake-prompt'), { target: { value: 'run the tests' } });
      fireEvent.click(screen.getByTestId('review-wake'));
      await waitFor(() => expect(spawnDurableAgent).toHaveBeenCalledWith('proj-1', '/projects/one', expect.objectContaining({ id: 's1' }), true, 'run the tests'));
    });

    it('shows why a wake failed and lets you try again', async () => {
      useAgentStore.setState({ agents: {} } as never);
      const { api } = makeApi([makeAgent({ id: 's1', name: 'dozy', status: 'sleeping' })]);
      render(<MainPanel api={api} />);
      fireEvent.click(screen.getByTestId('review-wake'));
      await waitFor(() => expect(screen.getByTestId('review-wake-error').textContent).toBe('This agent no longer exists.'));
      expect(screen.getByTestId('review-wake').textContent).toBe('Wake');
    });
  });
});
