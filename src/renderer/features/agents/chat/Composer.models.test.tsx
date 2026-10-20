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
  const view = render(<Composer {...props} />);
  return { onModelChange, unmount: view.unmount };
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
  it('names an unknown model "Default model", not a guess, and still offers the menu (#2293)', () => {
    const { onModelChange } = renderComposer({ model: null, modelUnknown: true, effort: null, efforts: [] });
    const pill = screen.getByTestId('chat-model-pill');
    expect(pill.textContent).toBe('Default model');
    fireEvent.click(pill);
    fireEvent.click(screen.getByText('Sonnet 5.5'));
    expect(onModelChange).toHaveBeenCalledWith('sonnet', undefined);
  });

  it('shows no model chip while nothing about the model is known', () => {
    renderComposer({ model: null });
    expect(screen.queryByTestId('chat-model-pill')).toBeNull();
  });

  it('keeps each chip inside its box so a narrow composer truncates instead of overlapping (#2260)', () => {
    renderComposer({ layout: 'narrow' });
    // jsdom can't measure layout, so check the classes that make a chip shrink with its wrapper.
    for (const id of ['chat-model-pill', 'chat-effort-pill']) {
      const pill = screen.getByTestId(id);
      expect(pill.className).toMatch(/\bmax-w-full\b/);
      expect(pill.className).toMatch(/\boverflow-hidden\b/);
      expect(pill.className).toMatch(/\bmin-w-0\b/);
      // Never narrower than a readable stub (#2261 click test: 20px at a 340px pane).
      expect(pill.parentElement?.className).toMatch(/\bmin-w-\[72px\]/);
    }
  });

  it('wraps the line layout\'s tool row so 72px pills never overflow a short, narrow popout', () => {
    renderComposer({ layout: 'line' });
    fireEvent.click(screen.getByTestId('chat-composer-plus'));
    expect(screen.getByTestId('chat-composer-more').className).toMatch(/\bflex-wrap\b/);
  });

  it('wraps the footer so Steer, Queue and Stop move to their own row instead of covering a pill', () => {
    renderComposer({ layout: 'narrow', running: true, text: 'steer this' });
    const footer = screen.getByTestId('chat-composer-footer');
    expect(footer.className).toMatch(/\bflex-wrap\b/);
    // The send buttons stay one group pushed to the end, never shrunk under a pill.
    const send = screen.getByTestId('chat-send-primary').parentElement!;
    expect(send.parentElement).toBe(footer);
    expect(send.className).toMatch(/\bml-auto\b/);
    expect(send.className).toMatch(/\bflex-shrink-0\b/);
  });

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
    expect(items.map((i) => i.textContent)).toEqual(['Low', 'Medium', 'High', 'Max']);
    expect(items[2]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(items[3]);
    expect(onModelChange).toHaveBeenCalledWith('opus', 'max');
  });

  it('names every level in sentence case, xhigh as "Extra high" (#2181)', () => {
    expect(['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(effortWord)).toEqual(['None', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it('labels menu rows like the pill, not with raw ids (#2181)', () => {
    renderComposer({ effort: 'medium', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] });
    expect(screen.getByTestId('chat-effort-pill')).toHaveTextContent('Medium effort');
    fireEvent.click(screen.getByTestId('chat-effort-pill'));
    expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['None', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it('marks the level the default resolved to, with or without a Default row (#2181)', () => {
    for (const effortDefault of [true, false]) {
      const view = renderComposer({ effort: 'medium', effortIsDefault: true }, { effortDefault });
      expect(screen.getByTestId('chat-effort-pill')).toHaveTextContent('Medium effort (default)');
      fireEvent.click(screen.getByTestId('chat-effort-pill'));
      const rows = screen.getAllByRole('menuitemradio').filter((i) => i.dataset.testid !== 'chat-effort-default');
      expect(rows.map((i) => i.textContent)).toEqual(['Low', 'Mediumdefault', 'High', 'Max']);
      // Without a Default row to check, the default level itself is checked.
      expect(rows[1]).toHaveAttribute('aria-checked', effortDefault ? 'false' : 'true');
      view.unmount();
    }
  });

  it('marks no level as the default once one is chosen', () => {
    renderComposer({ effort: 'medium' });
    fireEvent.click(screen.getByTestId('chat-effort-pill'));
    expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['Low', 'Medium', 'High', 'Max']);
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

  it('on the provider default: shows the level as the default, checks Default, and choosing that level pins it', () => {
    const { onModelChange } = renderComposer({ effort: 'high', effortIsDefault: true }, { effortDefault: true });
    const pill = screen.getByTestId('chat-effort-pill');
    expect(pill).toHaveTextContent('High effort (default)');
    fireEvent.click(pill);
    expect(screen.getByTestId('chat-effort-default')).toHaveAttribute('aria-checked', 'true');
    const high = screen.getAllByRole('menuitemradio').find((i) => i.textContent === 'Highdefault')!;
    expect(high).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(high);
    expect(onModelChange).toHaveBeenCalledWith('opus', 'high');
  });

  it('on the provider default, a model switch leaves the effort to the new model', () => {
    const { onModelChange } = renderComposer({ effort: 'high', effortIsDefault: true });
    fireEvent.click(screen.getByTestId('chat-model-pill'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Sonnet 5.5/ }));
    expect(onModelChange).toHaveBeenCalledWith('sonnet', undefined);
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

  it('waits for the session to report its effort instead of flashing Default effort (#2188 review)', () => {
    const { rerender } = renderComposerWithRerender({ model: 'opus', effort: null, effortReported: false });
    expect(screen.queryByTestId('chat-effort-pill')).toBeNull();
    rerender({ model: 'opus', effort: 'medium', effortIsDefault: true, effortReported: true });
    expect(screen.getByTestId('chat-effort-pill')).toHaveTextContent('Medium effort (default)');
    // Reported, with no effort: the provider's default really applies.
    rerender({ model: 'opus', effort: null, effortReported: true });
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
    expect(pill.parentElement?.className).toContain('max-w-[180px]');
    expect(pill.querySelector('span.truncate')).toHaveTextContent('Opus 5.5 · 1M');
    expect(pill).toHaveAttribute('title', 'Opus 5.5 · 1M (claude-opus-5-5[1m])');
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
