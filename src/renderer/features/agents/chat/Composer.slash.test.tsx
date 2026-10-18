import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MINIMAL_CHAT_CAPABILITIES, type AvailableCommand } from '../../../../shared/chat';
import { Composer, slashTokenAt, type ComposerProps } from './Composer';

const COMMANDS: AvailableCommand[] = [
  { name: 'effort', description: 'Set reasoning effort' },
  { name: 'compact', description: 'Compact the context' },
  { name: 'review' },
];

let setDraftFromOutside: (text: string) => void = () => {};

function Harness(props: Partial<ComposerProps>) {
  const [text, setText] = useState('');
  setDraftFromOutside = setText;
  return (
    <Composer
      agentName="gallant-swift"
      capabilities={{ ...MINIMAL_CHAT_CAPABILITIES, slashCommands: true }}
      running={false}
      level="ask"
      model={null}
      effort={null}
      commands={COMMANDS}
      text={text}
      onTextChange={setText}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onLevelChange={vi.fn()}
      {...props}
    />
  );
}

const box = () => screen.getByLabelText('Message') as HTMLTextAreaElement;
/** Types the whole value with the caret at `caret` (the end by default). */
function type(value: string, caret = value.length) {
  const el = box();
  fireEvent.change(el, { target: { value, selectionStart: caret, selectionEnd: caret } });
}
const menu = () => screen.queryByTestId('chat-slash-menu');

describe('slashTokenAt', () => {
  it('finds a slash word at the start or after whitespace', () => {
    expect(slashTokenAt('/eff', 4)).toEqual({ start: 0, end: 4, query: 'eff' });
    expect(slashTokenAt('a test /effor', 13)).toEqual({ start: 7, end: 13, query: 'effor' });
    expect(slashTokenAt('line one\n/co', 12)).toEqual({ start: 9, end: 12, query: 'co' });
    expect(slashTokenAt('say / ', 5)).toEqual({ start: 4, end: 5, query: '' });
  });

  it('takes the rest of the word after the caret', () => {
    expect(slashTokenAt('try /effort now', 7)).toEqual({ start: 4, end: 11, query: 'ef' });
  });

  it('ignores paths, URLs and slashes inside words', () => {
    expect(slashTokenAt('see src/foo', 11)).toBeNull();
    expect(slashTokenAt('open /tmp/x', 11)).toBeNull();
    expect(slashTokenAt('open /tmp/x', 8)).toBeNull();
    expect(slashTokenAt('https://x.y', 11)).toBeNull();
    expect(slashTokenAt('and/or', 6)).toBeNull();
    expect(slashTokenAt('/effort high', 12)).toBeNull();
  });
});

describe('Composer slash menu (#2090)', () => {
  it('opens for a slash after other text and completes in place', () => {
    render(<Harness />);
    type('this is a test message for the screenshot /effor');
    expect(menu()).toHaveTextContent('/effort');
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(box()).toHaveValue('this is a test message for the screenshot /effort ');
    expect(menu()).toBeNull();
  });

  it('completes a slash in the middle and keeps the text after it', () => {
    render(<Harness />);
    type('please /co then stop', 10);
    expect(menu()).toHaveTextContent('/compact');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box()).toHaveValue('please /compact then stop');
  });

  it('still works at the start of the message', () => {
    render(<Harness />);
    type('/re');
    expect(menu()).toHaveTextContent('/review');
    fireEvent.mouseDown(screen.getByRole('option', { name: /review/ }));
    expect(box()).toHaveValue('/review ');
  });

  it('Esc closes the menu, keeps the text and does not stop the turn', () => {
    const onStop = vi.fn();
    render(<Harness running onStop={onStop} capabilities={{ ...MINIMAL_CHAT_CAPABILITIES, slashCommands: true, interrupt: true }} />);
    type('hello /eff');
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(box()).toHaveValue('hello /eff');
    expect(onStop).not.toHaveBeenCalled();
    // Typing on in the same word keeps it closed; a new slash word opens it again.
    type('hello /effo');
    expect(menu()).toBeNull();
    type('hello /effo /co');
    expect(menu()).toHaveTextContent('/compact');
  });

  it('sends plain text containing a slash as typed', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type('compare src/a.ts and/or /tmp/b');
    expect(menu()).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('compare src/a.ts and/or /tmp/b', 'send');
  });

  it('sends after Esc dismisses a menu', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type('ship it /co');
    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('ship it /co', 'send');
  });

  it('sends a complete command typed mid-message on Enter', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type('then /compact');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('then /compact', 'send');
  });

  it('a pick that changes nothing leaves no caret jump for the next edit', () => {
    render(<Harness />);
    type('/effort foo', 7);
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(box()).toHaveValue('/effort foo');
    expect(box().selectionStart).toBe(8);
    type('a/effort foo', 1);
    expect(box().selectionStart).toBe(1);
  });

  it('a draft changed from outside opens no menu until the user types', () => {
    render(<Harness />);
    type('hello!', 6);
    act(() => setDraftFromOutside('see /co'));
    expect(box()).toHaveValue('see /co');
    expect(menu()).toBeNull();
    type('see /com');
    expect(menu()).toHaveTextContent('/compact');
  });

  it('Enter after a bare slash sends; Tab still picks', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type('yes and /');
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('yes and /', 'send');
    type('yes and /');
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(box()).toHaveValue('yes and /effort ');
  });

  it('an Enter that commits an IME composition does not pick', () => {
    render(<Harness />);
    type('hi /co');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(box()).toHaveValue('hi /co');
  });
});
