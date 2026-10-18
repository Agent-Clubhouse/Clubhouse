import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type ChatModelOption } from '../../../../shared/chat';
import { Composer, effortWord, switchNote, type ComposerProps } from './Composer';

const MODELS: ChatModelOption[] = [
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5.5', description: 'Faster', costHint: '1x' },
];

function renderComposer(overrides: Partial<ComposerProps> = {}, caps: Partial<ChatCapabilities> = {}) {
  const onModelChange = vi.fn();
  const props: ComposerProps = {
    agentName: 'gallant-swift',
    capabilities: { ...MINIMAL_CHAT_CAPABILITIES, modelSwitch: 'live', effortSwitch: 'live', ...caps },
    running: false,
    level: 'ask',
    model: 'opus',
    effort: 'high',
    models: MODELS,
    efforts: ['low', 'medium', 'high', 'max'],
    commands: [],
    text: '',
    onTextChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onLevelChange: vi.fn(),
    onModelChange,
    ...overrides,
  };
  render(<Composer {...props} />);
  return { onModelChange };
}

function renderComposerWithRerender(initial: Partial<ComposerProps>) {
  const base: ComposerProps = {
    agentName: 'gallant-swift',
    capabilities: { ...MINIMAL_CHAT_CAPABILITIES, modelSwitch: 'live', effortSwitch: 'live' },
    running: false,
    level: 'ask',
    model: null,
    effort: null,
    models: MODELS,
    efforts: ['low', 'medium', 'high', 'max'],
    commands: [],
    text: '',
    onTextChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onLevelChange: vi.fn(),
    onModelChange: vi.fn(),
  };
  const view = render(<Composer {...base} {...initial} />);
  return { rerender: (next: Partial<ComposerProps>) => view.rerender(<Composer {...base} {...next} />) };
}

describe('Composer model and effort chips (#2091)', () => {
  it('shows the model label, and switches model keeping an effort still on offer', () => {
    const { onModelChange } = renderComposer();
    const pill = screen.getByTestId('chat-model-pill');
    expect(pill).toHaveTextContent('Opus 5.5');
    expect(pill).not.toHaveTextContent('high');
    fireEvent.click(pill);
    expect(screen.getByTestId('chat-model-menu')).toBeInTheDocument();
    expect(screen.getByText('1x')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }));
    expect(onModelChange).toHaveBeenCalledWith('sonnet', 'high');
    expect(screen.queryByTestId('chat-model-menu')).toBeNull();
  });

  it('shows the effort in its own chip with a menu of the model\'s levels', () => {
    const { onModelChange } = renderComposer();
    const pill = screen.getByTestId('chat-effort-pill');
    expect(pill).toHaveTextContent('High effort');
    fireEvent.click(pill);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['low', 'medium', 'high', 'max']);
    expect(items[2]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(items[3]);
    expect(onModelChange).toHaveBeenCalledWith('opus', 'max');
  });

  it('names xhigh "Extra high"', () => {
    expect(effortWord('xhigh')).toBe('Extra high');
    expect(effortWord('max')).toBe('Max');
  });

  it('offers a Default row that returns the effort to the provider default (#2136)', () => {
    const { onModelChange } = renderComposer({}, { effortDefault: true });
    fireEvent.click(screen.getByTestId('chat-effort-pill'));
    const row = screen.getByTestId('chat-effort-default');
    expect(row).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(row);
    expect(onModelChange).toHaveBeenCalledWith('opus', null);
  });

  it('checks Default when no effort is set', () => {
    renderComposer({ effort: null }, { effortDefault: true });
    fireEvent.click(screen.getByTestId('chat-effort-pill'));
    expect(screen.getByTestId('chat-effort-default')).toHaveAttribute('aria-checked', 'true');
  });

  it('has no Default row without effortDefault', () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('chat-effort-pill'));
    expect(screen.queryByTestId('chat-effort-default')).toBeNull();
  });

  it('says Default effort before the provider reports one', () => {
    renderComposer({ effort: null });
    expect(screen.getByTestId('chat-effort-pill')).toHaveTextContent('Default effort');
  });

  it('hides the effort chip when the model has no effort levels', () => {
    renderComposer({ effort: null, efforts: [] });
    expect(screen.queryByTestId('chat-effort-pill')).toBeNull();
    expect(screen.getByTestId('chat-model-pill')).toBeInTheDocument();
  });

  it('follows model and effort changes from outside the menu (e.g. /model, /effort)', () => {
    const props = { model: 'opus', effort: 'high' };
    const { rerender } = renderComposerWithRerender(props);
    rerender({ model: 'sonnet', effort: 'low' });
    expect(screen.getByTestId('chat-model-pill')).toHaveTextContent('Sonnet 5.5');
    expect(screen.getByTestId('chat-effort-pill')).toHaveTextContent('Low effort');
  });

  it('explains when effort changes apply on restart', () => {
    renderComposer({}, { modelSwitch: 'none', effortSwitch: 'restart' });
    expect(screen.getByTestId('chat-model-pill')).toBeDisabled();
    fireEvent.click(screen.getByTestId('chat-effort-pill'));
    expect(screen.getByText('Effort applies the next time the agent starts.')).toBeInTheDocument();
  });

  it('says when model and effort changes apply, separately when they differ', () => {
    expect(switchNote('restart', 'restart')).toBe('Applies the next time the agent starts.');
    expect(switchNote('per_turn', 'none')).toBe('Applies from the next message.');
    expect(switchNote('none', 'per_turn')).toBe('Effort applies from the next message.');
    expect(switchNote('live', 'restart')).toBe('Model changes apply now; effort changes the next time the agent starts.');
    expect(switchNote('per_turn', 'restart')).toBe('Model changes apply from the next message; effort changes the next time the agent starts.');
    expect(switchNote('live', 'live')).toBeUndefined();
  });

  it('drops an effort the list no longer offers when switching model', () => {
    const { onModelChange } = renderComposer({ effort: 'xhigh' });
    fireEvent.click(screen.getByTestId('chat-model-pill'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }));
    expect(onModelChange).toHaveBeenCalledWith('sonnet', undefined);
  });

  it('keeps a long model name on one line with the full name in the tooltip (#2112)', () => {
    renderComposer({ model: 'claude-opus-5-5[1m]' });
    const pill = screen.getByTestId('chat-model-pill');
    expect(pill.className).toContain('whitespace-nowrap');
    expect(pill.className).toContain('max-w-[180px]');
    expect(pill.querySelector('span.truncate')).toHaveTextContent('claude-opus-5-5[1m]');
    expect(pill).toHaveAttribute('title', 'claude-opus-5-5[1m]');
  });

  it('shows plain labels when the driver cannot switch model or effort', () => {
    renderComposer({}, { modelSwitch: 'none', effortSwitch: 'none' });
    expect(screen.getByTestId('chat-model-pill')).toBeDisabled();
    expect(screen.getByTestId('chat-effort-pill')).toBeDisabled();
  });

  it('shows native level names under each permission level', () => {
    renderComposer({ levelNames: { auto_edit: 'acceptEdits', ask: 'default' } }, { liveLevels: ['plan', 'ask', 'auto_edit'] });
    fireEvent.click(screen.getByTestId('chat-level-pill'));
    expect(screen.getByTestId('chat-level-native-auto_edit')).toHaveTextContent('acceptEdits');
    expect(screen.getByTestId('chat-level-native-ask')).toHaveTextContent('default');
  });
});
