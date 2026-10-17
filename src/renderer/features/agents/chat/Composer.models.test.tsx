import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MINIMAL_CHAT_CAPABILITIES, type ChatCapabilities, type ChatModelOption } from '../../../../shared/chat';
import { Composer, switchNote, type ComposerProps } from './Composer';

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

describe('Composer model menu', () => {
  it('shows the model label and effort, and switches model', () => {
    const { onModelChange } = renderComposer();
    const pill = screen.getByTestId('chat-model-pill');
    expect(pill).toHaveTextContent('Opus 5.5');
    expect(pill).toHaveTextContent('high');
    fireEvent.click(pill);
    expect(screen.getByTestId('chat-model-menu')).toBeInTheDocument();
    expect(screen.getByText('1x')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }));
    expect(onModelChange).toHaveBeenCalledWith('sonnet', 'high');
  });

  it('changes effort for the current model', () => {
    const { onModelChange } = renderComposer();
    fireEvent.click(screen.getByTestId('chat-model-pill'));
    fireEvent.click(screen.getByRole('button', { name: 'max' }));
    expect(onModelChange).toHaveBeenCalledWith('opus', 'max');
  });

  it('explains when changes apply on restart', () => {
    renderComposer({}, { modelSwitch: 'none', effortSwitch: 'restart' });
    fireEvent.click(screen.getByTestId('chat-model-pill'));
    expect(screen.getByText('Effort applies the next time the agent starts.')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ })).toBeDisabled();
  });

  it('says when model and effort changes apply, separately when they differ', () => {
    expect(switchNote('restart', 'restart')).toBe('Applies the next time the agent starts.');
    expect(switchNote('per_turn', 'none')).toBe('Applies from the next message.');
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

  it('is a plain label when the driver cannot switch models', () => {
    renderComposer({}, { modelSwitch: 'none', effortSwitch: 'none' });
    expect(screen.getByTestId('chat-model-pill')).toBeDisabled();
  });

  it('shows native level names under each permission level', () => {
    renderComposer({ levelNames: { auto_edit: 'acceptEdits', ask: 'default' } }, { liveLevels: ['plan', 'ask', 'auto_edit'] });
    fireEvent.click(screen.getByTestId('chat-level-pill'));
    expect(screen.getByTestId('chat-level-native-auto_edit')).toHaveTextContent('acceptEdits');
    expect(screen.getByTestId('chat-level-native-ask')).toHaveTextContent('default');
  });
});
