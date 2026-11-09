import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../shared/chat';
import { DISPATCHER_OFF, type DispatcherState } from '../../../shared/dispatcher-types';
import type { DispatcherBehaviorState } from '../../../shared/dispatcher-behavior';
import type { OrchestratorInfo } from '../../../shared/types';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useUIStore } from '../../stores/uiStore';
import { Composer, type ComposerProps } from '../agents/chat/Composer';
import { BehaviorChip, DispatcherBehaviorChip } from './BehaviorChip';
import { dispatcherBehaviorLevel, useDispatcherStore } from './dispatcherStore';

const STANDARD: DispatcherBehaviorState = { level: 'standard', provider: 'claude-code', auto: { ready: true } };
const ON: DispatcherState = {
  ...DISPATCHER_OFF, enabled: true, savedOn: true, offReason: null,
  agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir', behavior: STANDARD,
};
const cli = (id: string, displayName: string) => ({ id, displayName, shortName: displayName, capabilities: {} }) as unknown as OrchestratorInfo;

function renderChip(behavior: DispatcherBehaviorState = STANDARD, onChange = vi.fn(async () => undefined)) {
  const onSetUpAuto = vi.fn();
  render(<BehaviorChip behavior={behavior} providerName="Codex CLI" onChange={onChange} onSetUpAuto={onSetUpAuto} />);
  return { onChange, onSetUpAuto };
}

beforeEach(() => {
  useOrchestratorStore.setState({ allOrchestrators: [cli('claude-code', 'Claude Code'), cli('future-cli', 'Future CLI')] });
});
afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

describe('BehaviorChip (#3045)', () => {
  it('shows the level, and its menu lists the three levels with the current one checked', () => {
    renderChip();
    const chip = screen.getByTestId('dispatcher-behavior-chip');
    expect(chip.textContent).toContain('Standard');
    expect(chip.getAttribute('aria-label')).toBe('Behavior: Standard');
    fireEvent.click(chip);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Light'), expect.stringContaining('Standard'), expect.stringContaining('Thorough'),
    ]);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });

  it('never shows an exact frequency', () => {
    renderChip();
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    const text = screen.getByTestId('dispatcher-behavior-menu').textContent ?? '';
    expect(text).toContain('occasionally');
    expect(text).toContain('frequently');
    expect(text).not.toMatch(/\d|minute|hour|daily|nightly|every/i);
  });

  it('saves a new level and closes; picking the current one saves nothing', async () => {
    const { onChange } = renderChip();
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    fireEvent.click(screen.getByTestId('dispatcher-behavior-standard'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dispatcher-behavior-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-behavior-thorough')); });
    expect(onChange).toHaveBeenCalledWith('thorough');
    expect(screen.queryByTestId('dispatcher-behavior-menu')).toBeNull();
  });

  it('keeps the menu open with an alert when saving fails', async () => {
    renderChip(STANDARD, vi.fn().mockRejectedValue(new Error('disk full')));
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-behavior-light')); });
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t change it. disk full');
    expect(screen.getByTestId('dispatcher-behavior-chip').getAttribute('data-level')).toBe('standard');
  });

  it('offers Set up Auto when the mapping has nothing for the level', () => {
    const { onSetUpAuto } = renderChip({ level: 'thorough', provider: 'codex-cli', auto: { ready: false, code: 'no_valid_mapping' } });
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    expect(screen.getByTestId('dispatcher-behavior-auto').textContent).toContain('Codex CLI');
    fireEvent.click(screen.getByTestId('dispatcher-behavior-setup-auto'));
    expect(onSetUpAuto).toHaveBeenCalled();
    expect(screen.queryByTestId('dispatcher-behavior-menu')).toBeNull();
  });

  it('explains a provider with no Auto mapping and still lets the level change', async () => {
    const { onChange } = renderChip({ level: 'standard', provider: 'future-cli', auto: { ready: false, code: 'auto_not_supported' } });
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    expect(screen.getByTestId('dispatcher-behavior-auto').textContent).toContain('Auto doesn’t support Codex CLI yet');
    expect(screen.queryByTestId('dispatcher-behavior-setup-auto')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-behavior-light')); });
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('shows the icon only when compact, with the level in its label', () => {
    render(<BehaviorChip behavior={STANDARD} providerName="Claude Code" onChange={vi.fn()} onSetUpAuto={vi.fn()} compact />);
    const chip = screen.getByTestId('dispatcher-behavior-chip');
    expect(chip.textContent).not.toContain('Standard');
    expect(chip.getAttribute('aria-label')).toBe('Behavior: Standard');
  });
});

describe('DispatcherBehaviorChip: in step with main', () => {
  it('shows main\'s level and follows a change made in Settings', async () => {
    useDispatcherStore.getState().setState(ON);
    window.clubhouse.dispatcher.setBehavior = vi.fn(async (level) => {
      const next = { ...ON, behavior: { ...STANDARD, level } };
      useDispatcherStore.getState().setState(next);
      return next;
    });
    render(<DispatcherBehaviorChip />);
    const chip = () => screen.getByTestId('dispatcher-behavior-chip');
    expect(chip().getAttribute('data-level')).toBe('standard');
    // Settings saved Light: main's broadcast reaches the store.
    act(() => useDispatcherStore.getState().setState({ ...ON, behavior: { ...STANDARD, level: 'light' } }));
    expect(chip().getAttribute('data-level')).toBe('light');
    expect(dispatcherBehaviorLevel()).toBe('light');
    // A pick here goes through main.
    fireEvent.click(chip());
    await act(async () => { fireEvent.click(screen.getByTestId('dispatcher-behavior-thorough')); });
    expect(window.clubhouse.dispatcher.setBehavior).toHaveBeenCalledWith('thorough');
    await waitFor(() => expect(chip().getAttribute('data-level')).toBe('thorough'));
  });

  it('Set up Auto opens Settings > Smart selection', () => {
    useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: true });
    useDispatcherStore.getState().setState({ ...ON, behavior: { level: 'thorough', provider: 'claude-code', auto: { ready: false, code: 'no_valid_mapping' } } });
    render(<DispatcherBehaviorChip />);
    fireEvent.click(screen.getByTestId('dispatcher-behavior-chip'));
    fireEvent.click(screen.getByTestId('dispatcher-behavior-setup-auto'));
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'smart-selection', dispatcherOpen: false });
  });

  it('renders nothing until main\'s state lands, and the level reads Standard meanwhile', () => {
    useDispatcherStore.getState().setState(null);
    const { container } = render(<DispatcherBehaviorChip />);
    expect(container.innerHTML).toBe('');
    expect(dispatcherBehaviorLevel()).toBe('standard');
  });
});

describe('Composer with a Behavior chip', () => {
  const props: ComposerProps = {
    agentName: 'Dispatcher',
    capabilities: { ...MINIMAL_CHAT_CAPABILITIES, modelSwitch: 'live', effortSwitch: 'live', liveLevels: ['ask', 'auto'] },
    running: false,
    level: 'ask',
    model: 'opus',
    effort: 'high',
    models: [{ id: 'opus', label: 'Opus' }],
    efforts: ['low', 'high'],
    commands: [],
    text: '',
    onTextChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onLevelChange: vi.fn(),
    onModelChange: vi.fn(),
  };

  it('takes the place of the permission, model and effort pickers', () => {
    render(<Composer {...props} behaviorChip={<BehaviorChip behavior={STANDARD} providerName="Claude Code" onChange={vi.fn()} onSetUpAuto={vi.fn()} />} />);
    expect(screen.getByTestId('dispatcher-behavior-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-level-pill')).toBeNull();
    expect(screen.queryByTestId('chat-model-pill')).toBeNull();
    expect(screen.queryByTestId('chat-effort-pill')).toBeNull();
  });

  it('keeps the pickers for every other agent', () => {
    render(<Composer {...props} />);
    expect(screen.getByTestId('chat-level-pill')).toBeInTheDocument();
    expect(screen.getByTestId('chat-model-pill')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatcher-behavior-chip')).toBeNull();
  });
});
