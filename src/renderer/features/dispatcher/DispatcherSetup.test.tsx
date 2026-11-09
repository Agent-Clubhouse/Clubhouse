import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../agents/chat/AgentRuntimePane', () => ({
  AgentRuntimePane: ({ agent }: { agent: { id: string } }) => <div data-testid="runtime-pane">{agent.id}</div>,
}));
vi.mock('../agents/AgentTerminal', () => ({ AgentTerminal: () => null }));

import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID, type DispatcherState } from '../../../shared/dispatcher-types';
import { DEFAULT_DISPATCHER_PERSONALITY, PERSONALITY_PRESET_EXAMPLES, PERSONALITY_PRESET_TEXT, TRY_IT_OUT_QUESTION } from '../../../shared/dispatcher-personality';
import type { Agent, OrchestratorInfo } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { DispatcherSetup } from './DispatcherSetup';
import { DispatcherView } from './DispatcherView';
import { useDispatcherStore } from './dispatcherStore';
import { useSetupDraftStore } from './setupDraft';

const cli = (id: string, displayName: string) => ({ id, displayName, shortName: displayName, capabilities: { permissions: true } }) as unknown as OrchestratorInfo;

function makeState(over: Partial<DispatcherState> = {}): DispatcherState {
  return {
    ...DISPATCHER_OFF,
    enabled: true,
    savedOn: true,
    offReason: null,
    agentId: 'disp-work',
    path: 'dispatcher-dir',
    config: { id: 'disp-work', name: 'Dispatcher', color: 'indigo', createdAt: 'now', orchestrator: 'claude-code' },
    chatAgentId: 'disp',
    chatPath: 'dispatcher-chat-dir',
    behavior: { level: 'standard', provider: 'claude-code', auto: { ready: true } },
    personality: DEFAULT_DISPATCHER_PERSONALITY,
    setup: { status: 'pending', upgrade: false },
    ...over,
  };
}

const chatAgent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'disp', projectId: DISPATCHER_PROJECT_ID, name: 'Dispatcher', kind: 'durable', status: 'sleeping', color: 'indigo', ...over }) as Agent;

const d = window.clubhouse.dispatcher;
const original = { ...d };

/** Every agent-facing call the renderer could make. Try it out must make none of them. */
const AGENT_CALLS = ['spawnAgent', 'wakeAgent', 'killAgent', 'sendMessage', 'sendInput'] as const;

beforeEach(() => {
  useSetupDraftStore.getState().reset();
  useAgentStore.setState({ agents: { disp: chatAgent() }, agentIcons: {} });
  useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: true });
  useOrchestratorStore.setState({
    enabled: ['claude-code', 'codex-cli'],
    allOrchestrators: [cli('claude-code', 'Claude Code'), cli('codex-cli', 'Codex CLI'), cli('future-cli', 'Future CLI')],
    loadSettings: async () => {},
  });
  d.checkBehavior = vi.fn(async () => ({ ready: true as const }));
  d.tryPersonality = vi.fn(async () => ({ ok: true as const, text: 'I keep your agents on track.' }));
  d.completeSetup = vi.fn(async () => makeState({ setup: { status: 'done', upgrade: false } }));
  d.setSetupStatus = vi.fn(async (status: 'later' | 'done') => makeState({ setup: { status, upgrade: false } }));
});

afterEach(() => {
  Object.assign(d, original);
  useDispatcherStore.getState().setState(DISPATCHER_OFF);
  useDispatcherStore.setState({ setupOpen: false });
});

function renderSetup(state = makeState(), props: { reopened?: boolean } = {}) {
  useDispatcherStore.getState().setState(state);
  const onClose = vi.fn();
  render(<DispatcherSetup state={state} onClose={onClose} {...props} />);
  return { onClose };
}

const next = () => fireEvent.click(screen.getByTestId('dispatcher-setup-next'));

describe('DispatcherSetup: Name and look', () => {
  it('is prefilled, and the preview follows the name and color', () => {
    renderSetup();
    expect(screen.getByRole('heading', { name: 'Name and look' })).toBeTruthy();
    expect(screen.getByTestId('dispatcher-setup-progress').textContent).toBe('Step 1 of 3');
    const name = screen.getByTestId('dispatcher-setup-name') as HTMLInputElement;
    expect(name.value).toBe('Dispatcher');
    fireEvent.change(name, { target: { value: 'Rosie' } });
    expect(screen.getByTestId('dispatcher-setup-preview-name').textContent).toBe('Rosie');
    fireEvent.click(screen.getByTestId('dispatcher-setup-color-rose'));
    expect(screen.getByTestId('dispatcher-setup-color-rose').getAttribute('aria-checked')).toBe('true');
    expect(useSetupDraftStore.getState().draft).toMatchObject({ name: 'Rosie', color: 'rose' });
  });

  it('needs a name before going on', () => {
    renderSetup();
    fireEvent.change(screen.getByTestId('dispatcher-setup-name'), { target: { value: '   ' } });
    expect((screen.getByTestId('dispatcher-setup-next') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Give it a name.')).toBeTruthy();
  });

  it('says nothing about remembering for a new install', () => {
    renderSetup();
    expect(screen.queryByTestId('dispatcher-setup-upgrade-note')).toBeNull();
  });
});

describe('DispatcherSetup: Behavior and Runs on', () => {
  it('picks a level and a provider, checking Auto for the provider being picked', async () => {
    renderSetup();
    next();
    expect(screen.getByRole('heading', { name: 'Behavior' })).toBeTruthy();
    await waitFor(() => expect(d.checkBehavior).toHaveBeenCalledWith('claude-code', 'standard'));
    fireEvent.click(screen.getByTestId('dispatcher-setup-behavior-thorough'));
    fireEvent.change(screen.getByTestId('dispatcher-setup-provider'), { target: { value: 'codex-cli' } });
    await waitFor(() => expect(d.checkBehavior).toHaveBeenLastCalledWith('codex-cli', 'thorough'));
    expect(screen.getByText(/starts a fresh conversation on the new provider/)).toBeTruthy();
    expect(screen.getByTestId('dispatcher-setup-preview').textContent).toContain('Thorough on Codex CLI');
    // Only enabled providers are offered, and the one it runs on now.
    const options = within(screen.getByTestId('dispatcher-setup-provider')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Claude Code', 'Codex CLI']);
  });

  it('offers Set up Auto when the provider has a mapping with nothing for the level, which opens Settings > Smart selection', async () => {
    d.checkBehavior = vi.fn(async () => ({ ready: false as const, code: 'no_valid_mapping' as const }));
    renderSetup();
    next();
    fireEvent.click(await screen.findByTestId('dispatcher-setup-auto-button'));
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsSubPage: 'smart-selection', dispatcherOpen: false });
    // Coming back carries on where the user was.
    expect(useSetupDraftStore.getState().step).toBe('behavior');
  });

  it('explains a provider without Auto, with no button', async () => {
    d.checkBehavior = vi.fn(async () => ({ ready: false as const, code: 'auto_not_supported' as const }));
    renderSetup();
    next();
    expect(await screen.findByText(/Auto doesn’t support Claude Code yet/)).toBeTruthy();
    expect(screen.queryByTestId('dispatcher-setup-auto-button')).toBeNull();
  });
});

describe('DispatcherSetup: models chosen by hand (#3191)', () => {
  it('says finishing setup lets Behavior choose the models again', async () => {
    renderSetup(makeState({ models: { byHand: true, chat: null, work: null } }));
    next();
    expect(screen.getByTestId('dispatcher-setup-models-by-hand').textContent).toBe('You chose its models yourself. Finishing setup lets Behavior choose them again. Your picks stay in Settings for next time.');
    await waitFor(() => expect(d.checkBehavior).toHaveBeenCalled());
  });

  it('says nothing about it while Behavior chooses them', async () => {
    renderSetup();
    next();
    expect(screen.queryByTestId('dispatcher-setup-models-by-hand')).toBeNull();
    await waitFor(() => expect(d.checkBehavior).toHaveBeenCalled());
  });
});

describe('DispatcherSetup: Personality', () => {
  const toPersonality = () => { next(); next(); };

  it('fills the text from a preset, keeps it editable, and an edit becomes Custom', () => {
    renderSetup();
    toPersonality();
    const text = screen.getByTestId('dispatcher-setup-personality-text') as HTMLTextAreaElement;
    expect(text.value).toBe(PERSONALITY_PRESET_TEXT.concise);
    expect(screen.getByTestId('dispatcher-setup-example').textContent).toBe(PERSONALITY_PRESET_EXAMPLES.concise);
    fireEvent.click(screen.getByTestId('dispatcher-setup-preset-friendly'));
    expect(text.value).toBe(PERSONALITY_PRESET_TEXT.friendly);
    fireEvent.change(text, { target: { value: 'Talk like a pirate.' } });
    expect(screen.getByTestId('dispatcher-setup-preset-custom').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('dispatcher-setup-example').textContent).toBe('Try it out to hear how it sounds.');
    // Custom keeps what was written.
    fireEvent.click(screen.getByTestId('dispatcher-setup-preset-detailed'));
    fireEvent.click(screen.getByTestId('dispatcher-setup-preset-custom'));
    expect(text.value).toBe(PERSONALITY_PRESET_TEXT.detailed);
  });

  it('Try it out sends the choices so far and shows the real reply, contacting no agent', async () => {
    const agentSpies = AGENT_CALLS
      .filter((name) => typeof (window.clubhouse.agent as Record<string, unknown>)[name] === 'function')
      .map((name) => vi.spyOn(window.clubhouse.agent as Record<string, () => unknown>, name));
    const ptySpies = Object.keys(window.clubhouse.pty ?? {})
      .filter((name) => typeof (window.clubhouse.pty as Record<string, unknown>)[name] === 'function')
      .map((name) => vi.spyOn(window.clubhouse.pty as Record<string, () => unknown>, name));
    renderSetup();
    fireEvent.change(screen.getByTestId('dispatcher-setup-name'), { target: { value: 'Rosie' } });
    toPersonality();
    fireEvent.click(screen.getByTestId('dispatcher-setup-preset-friendly'));
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-try')); });
    expect(d.tryPersonality).toHaveBeenCalledWith({
      name: 'Rosie', provider: 'claude-code', behavior: 'standard', personality: { preset: 'friendly', text: PERSONALITY_PRESET_TEXT.friendly },
    });
    expect(screen.getByTestId('dispatcher-setup-reply').textContent).toBe('I keep your agents on track.');
    expect(screen.getByTestId('dispatcher-setup-preview').textContent).toContain(TRY_IT_OUT_QUESTION);
    for (const spy of [...agentSpies, ...ptySpies]) expect(spy).not.toHaveBeenCalled();
    expect(d.completeSetup).not.toHaveBeenCalled();
    // A change after trying goes back to the example until it is tried again.
    fireEvent.click(screen.getByTestId('dispatcher-setup-preset-concise'));
    expect(screen.queryByTestId('dispatcher-setup-reply')).toBeNull();
  });

  it('shows why there is no reply', async () => {
    d.tryPersonality = vi.fn(async () => ({ ok: false as const, error: 'Couldn’t get a reply. It took too long.' }));
    renderSetup();
    toPersonality();
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-try')); });
    expect(screen.getByTestId('dispatcher-setup-reply-error').textContent).toBe('Couldn’t get a reply. It took too long.');
  });

  it('Finish saves everything in one go and closes', async () => {
    const { onClose } = renderSetup();
    fireEvent.change(screen.getByTestId('dispatcher-setup-name'), { target: { value: ' Rosie ' } });
    fireEvent.click(screen.getByTestId('dispatcher-setup-color-rose'));
    next();
    fireEvent.click(screen.getByTestId('dispatcher-setup-behavior-light'));
    fireEvent.change(screen.getByTestId('dispatcher-setup-provider'), { target: { value: 'codex-cli' } });
    next();
    fireEvent.click(screen.getByTestId('dispatcher-setup-preset-detailed'));
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-finish')); });
    expect(d.completeSetup).toHaveBeenCalledWith({
      name: 'Rosie', color: 'rose', provider: 'codex-cli', behavior: 'light', personality: { preset: 'detailed', text: PERSONALITY_PRESET_TEXT.detailed },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useDispatcherStore.getState().state?.setup.status).toBe('done');
    expect(useSetupDraftStore.getState().draft).toBeNull();
  });

  it('keeps setup open with the reason when saving fails', async () => {
    d.completeSetup = vi.fn(async () => { throw new Error('disk full'); });
    const { onClose } = renderSetup();
    toPersonality();
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-finish')); });
    expect(screen.getByTestId('dispatcher-setup-error').textContent).toContain('disk full');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Set up later', () => {
  it('keeps the defaults and saves nothing else', async () => {
    const { onClose } = renderSetup();
    fireEvent.change(screen.getByTestId('dispatcher-setup-name'), { target: { value: 'Not saved' } });
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-later')); });
    expect(d.setSetupStatus).toHaveBeenCalledWith('later');
    expect(d.completeSetup).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    const state = useDispatcherStore.getState().state!;
    expect(state.setup.status).toBe('later');
    expect(state.config?.name).toBe('Dispatcher');
    expect(state.behavior.level).toBe('standard');
    expect(state.personality).toEqual(DEFAULT_DISPATCHER_PERSONALITY);
  });

  it('is Cancel when setup was opened again, which saves nothing', async () => {
    const { onClose } = renderSetup(makeState({ setup: { status: 'later', upgrade: false } }), { reopened: true });
    expect(screen.getByTestId('dispatcher-setup-later').textContent).toBe('Cancel');
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-later')); });
    expect(d.setSetupStatus).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DispatcherView and setup', () => {
  it('shows setup the first time instead of the chat', () => {
    useDispatcherStore.getState().setState(makeState());
    render(<DispatcherView />);
    expect(screen.getByTestId('dispatcher-setup')).toBeTruthy();
    expect(screen.queryByTestId('sleeping-agent')).toBeNull();
  });

  it('shows setup before the running chat, where the intro (#3048) lives, and the chat once setup is done', () => {
    useAgentStore.setState({ agents: { disp: chatAgent({ status: 'running' }) } });
    useDispatcherStore.getState().setState(makeState());
    const { unmount } = render(<DispatcherView />);
    expect(screen.getByTestId('dispatcher-setup')).toBeTruthy();
    expect(screen.queryByTestId('runtime-pane')).toBeNull();
    unmount();
    useDispatcherStore.getState().setState(makeState({ setup: { status: 'done', upgrade: false } }));
    render(<DispatcherView />);
    expect(screen.queryByTestId('dispatcher-setup')).toBeNull();
    expect(screen.getByTestId('runtime-pane').textContent).toBe('disp');
  });

  it('shows an upgrading user setup once, prefilled with their provider and name, with the note that it remembers', async () => {
    const upgrade = makeState({
      config: { id: 'disp-work', name: 'Rosie', color: 'rose', createdAt: 'then', orchestrator: 'codex-cli' },
      behavior: { level: 'standard', provider: 'codex-cli', auto: { ready: true } },
      setup: { status: 'pending', upgrade: true },
    });
    d.setSetupStatus = vi.fn(async () => ({ ...upgrade, setup: { status: 'later' as const, upgrade: true } }));
    useDispatcherStore.getState().setState(upgrade);
    useAgentStore.setState({ agents: { disp: chatAgent({ name: 'Rosie', color: 'rose' }) } });
    const { unmount } = render(<DispatcherView />);
    expect(screen.getByTestId('dispatcher-setup-upgrade-note').textContent).toBe('Rosie now remembers what you decide and who is doing what.');
    expect((screen.getByTestId('dispatcher-setup-name') as HTMLInputElement).value).toBe('Rosie');
    next();
    expect((screen.getByTestId('dispatcher-setup-provider') as HTMLSelectElement).value).toBe('codex-cli');
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-later')); });
    // Once: the chat is back, and setup doesn't come back by itself after a restart of the view.
    expect(screen.queryByTestId('dispatcher-setup')).toBeNull();
    unmount();
    render(<DispatcherView />);
    expect(screen.queryByTestId('dispatcher-setup')).toBeNull();
    expect(screen.getByTestId('sleeping-agent')).toBeTruthy();
  });

  it('after Set up later, offers setup again from the chat, and Hide puts the offer away', async () => {
    useDispatcherStore.getState().setState(makeState({ setup: { status: 'later', upgrade: false } }));
    render(<DispatcherView />);
    expect(screen.getByTestId('dispatcher-setup-offer').textContent).toContain('Dispatcher is using the default');
    fireEvent.click(screen.getByTestId('dispatcher-setup-offer-open'));
    expect(screen.getByTestId('dispatcher-setup')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-later')); });
    expect(screen.getByTestId('dispatcher-setup-offer')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-setup-offer-hide')); });
    expect(d.setSetupStatus).toHaveBeenCalledWith('done');
    expect(screen.queryByTestId('dispatcher-setup-offer')).toBeNull();
  });

  it('opens setup again from its menu once it is done', () => {
    useDispatcherStore.getState().setState(makeState({ setup: { status: 'done', upgrade: false } }));
    render(<DispatcherView />);
    expect(screen.queryByTestId('dispatcher-setup-offer')).toBeNull();
    fireEvent.click(screen.getByTestId('sleeping-more'));
    fireEvent.click(within(screen.getByTestId('agent-context-menu')).getByTestId('ctx-dispatcher-setup'));
    expect(screen.getByTestId('dispatcher-setup')).toBeTruthy();
    expect(screen.getByTestId('dispatcher-setup-later').textContent).toBe('Cancel');
  });
});
