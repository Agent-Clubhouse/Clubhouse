import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MINIMAL_CHAT_CAPABILITIES, type AvailableCommand, type ChatCapabilities } from '../../../../shared/chat';
import { Composer, type ComposerProps } from './Composer';
import { EDITING_KEYS, KEY_PLATFORMS, type KeyPlatform } from '../../../editing-keys';
import { chordEventInit } from '../../../editing-keys.testing';

const COMMANDS: AvailableCommand[] = [{ name: 'effort' }, { name: 'compact' }];
const STEER: ChatCapabilities = { ...MINIMAL_CHAT_CAPABILITIES, steer: true, interrupt: true, queue: 'client', slashCommands: true };
const DRAFT = 'first line\nsecond line\nthird line';

const originalPlatform = window.clubhouse.platform;
const setPlatform = (p: KeyPlatform) => { (window.clubhouse as { platform: string }).platform = p; };

function Harness({ initial = '', ...props }: Partial<ComposerProps> & { initial?: string }) {
  const [text, setText] = useState(initial);
  return (
    <Composer
      agentName="gallant-swift"
      capabilities={STEER}
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
/** Fires the chord at the composer; true when a handler took it (preventDefault). */
const press = (chord: string, extra: KeyboardEventInit = {}) => !fireEvent.keyDown(box(), { ...chordEventInit(chord), ...extra });
function caretAt(at: number) {
  box().setSelectionRange(at, at);
  fireEvent.select(box());
}

describe('Composer editing keys (#2314)', () => {
  afterEach(() => setPlatform(originalPlatform as KeyPlatform));

  it.each(KEY_PLATFORMS.flatMap((p) => [[p, false], [p, true]] as const))(
    'leaves every editing key but Enter and Alt+Enter to the textarea on %s (running: %s)',
    (platform, running) => {
      setPlatform(platform);
      const onSend = vi.fn();
      const onStop = vi.fn();
      render(<Harness initial={DRAFT} running={running} onSend={onSend} onStop={onStop} />);
      caretAt(15);
      const taken = [...EDITING_KEYS[platform]].filter((c) => c !== 'Enter' && c !== 'Alt+Enter' && press(c));
      expect(taken).toEqual([]);
      expect(onSend).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
    },
  );

  it.each(['ArrowUp', 'ArrowDown'])('%s moves the caret on every line of a multi-line draft (no history recall)', (key) => {
    render(<Harness initial={DRAFT} />);
    for (const at of [0, 3, 15, DRAFT.length]) {
      caretAt(at);
      expect(press(key)).toBe(false);
    }
    expect(box()).toHaveValue(DRAFT);
  });

  it('Shift+Enter and Option/Alt+Enter are soft returns, idle and during a turn', () => {
    for (const running of [false, true]) {
      const onSend = vi.fn();
      const { unmount } = render(<Harness initial="draft" running={running} onSend={onSend} />);
      expect(press('Shift+Enter')).toBe(false);
      // Alt+Enter is inserted by the composer: Chromium won't on Windows and Linux.
      caretAt(2);
      press('Alt+Enter');
      expect(box()).toHaveValue('dr\naft');
      expect(onSend).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('Enter sends', () => {
    const onSend = vi.fn();
    render(<Harness initial="ship it" onSend={onSend} />);
    expect(press('Enter')).toBe(true);
    expect(onSend).toHaveBeenCalledWith('ship it', 'send');
  });

  it.each([['darwin', 'Meta+Enter'], ['win32', 'Ctrl+Enter'], ['linux', 'Ctrl+Enter']] as const)(
    'on %s, %s queues during a turn and sends when idle',
    (platform, chord) => {
      setPlatform(platform);
      const onSend = vi.fn();
      const { unmount } = render(<Harness initial="then rebase" running onSend={onSend} />);
      expect(screen.getByTestId('chat-send-secondary')).toHaveTextContent(platform === 'darwin' ? '⌘⏎' : 'Ctrl+⏎');
      expect(press(chord)).toBe(true);
      expect(onSend).toHaveBeenLastCalledWith('then rebase', 'queue');
      unmount();
      render(<Harness initial="hello" onSend={onSend} />);
      expect(press(chord)).toBe(true);
      expect(onSend).toHaveBeenLastCalledWith('hello', 'send');
    },
  );

  it('leaves Ctrl+Enter to the textarea on macOS', () => {
    setPlatform('darwin');
    const onSend = vi.fn();
    render(<Harness initial="draft" running onSend={onSend} />);
    expect(press('Ctrl+Enter')).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Esc stops the turn; it is not an editing key', () => {
    const onStop = vi.fn();
    render(<Harness initial="draft" running onStop={onStop} />);
    expect(press('Escape')).toBe(true);
    expect(onStop).toHaveBeenCalled();
  });

  it('ignores Enter and Esc while an IME is composing', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<Harness initial="にほんご" running onSend={onSend} onStop={onStop} />);
    expect(press('Enter', { isComposing: true })).toBe(false);
    expect(press('Escape', { isComposing: true })).toBe(false);
    expect(press('Enter', { keyCode: 229 })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('the slash menu takes Up/Down/Esc only while it is open', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '/co', selectionStart: 3, selectionEnd: 3 } });
    expect(screen.getByTestId('chat-slash-menu')).toBeInTheDocument();
    expect(press('ArrowDown')).toBe(true);
    expect(press('ArrowUp')).toBe(true);
    expect(press('Escape')).toBe(true);
    expect(screen.queryByTestId('chat-slash-menu')).not.toBeInTheDocument();
    expect(press('ArrowDown')).toBe(false);
    expect(press('ArrowUp')).toBe(false);
  });

  it('modified Enter does not pick from the open slash menu', () => {
    setPlatform('darwin');
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(box(), { target: { value: '/co', selectionStart: 3, selectionEnd: 3 } });
    expect(screen.getByTestId('chat-slash-menu')).toBeInTheDocument();
    press('Alt+Enter');
    expect(box()).toHaveValue('/co\n');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Composer Markdown source aids (#3540)', () => {
  afterEach(() => setPlatform(originalPlatform as KeyPlatform));

  it.each(['Shift+Enter', 'Alt+Enter'])('%s continues and exits lists without sending', (chord) => {
    const onSend = vi.fn();
    render(<Harness initial="1. first" onSend={onSend} />);
    caretAt(8);
    expect(press(chord)).toBe(true);
    expect(box()).toHaveValue('1. first\n2. ');
    expect(box().selectionStart).toBe(12);
    press(chord);
    expect(box()).toHaveValue('1. first\n');
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([['darwin', 'Meta'], ['win32', 'Ctrl'], ['linux', 'Ctrl']] as const)('formats on %s and sends source byte for byte', (platform, mod) => {
    setPlatform(platform);
    const onSend = vi.fn();
    render(<Harness initial={'  word\n'} onSend={onSend} />);
    box().setSelectionRange(2, 6);
    press(`${mod}+B`);
    expect(box()).toHaveValue('  **word**\n');
    expect([box().selectionStart, box().selectionEnd]).toEqual([4, 8]);
    press(`${mod}+B`);
    expect(box()).toHaveValue('  word\n');
    press(`${mod}+I`);
    expect(box()).toHaveValue('  *word*\n');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith('  *word*\n', 'send');
  });

  it('Tab only indents list items and the slash menu still owns Tab', () => {
    render(<Harness initial="- item" />);
    caretAt(6);
    expect(press('Tab')).toBe(true);
    expect(box()).toHaveValue('  - item');
    expect(press('Shift+Tab')).toBe(true);
    expect(box()).toHaveValue('- item');
    fireEvent.change(box(), { target: { value: 'plain' } });
    expect(press('Tab')).toBe(false);
    expect(press('Shift+Tab')).toBe(false);
    fireEvent.change(box(), { target: { value: '- /co', selectionStart: 5, selectionEnd: 5 } });
    expect(screen.getByTestId('chat-slash-menu')).toBeInTheDocument();
    expect(press('Tab')).toBe(true);
    expect(box()).toHaveValue('- /compact ');
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves all aid keys to IME: %s', (extra) => {
    setPlatform('darwin');
    render(<Harness initial="- item" />);
    caretAt(6);
    for (const chord of ['Meta+B', 'Meta+I', 'Tab', 'Shift+Tab', 'Shift+Enter', 'Alt+Enter']) {
      expect(press(chord, extra)).toBe(false);
      expect(box()).toHaveValue('- item');
    }
  });

  it('does not take Ctrl+B on macOS or modified formatting chords', () => {
    setPlatform('darwin');
    render(<Harness initial="draft" />);
    for (const chord of ['Ctrl+B', 'Meta+Shift+B', 'Meta+Alt+I', 'Meta+ArrowLeft', 'Meta+Z']) expect(press(chord)).toBe(false);
    expect(box()).toHaveValue('draft');
  });

  it('uses a single native insertion for the aid, leaving undo to the textarea', () => {
    setPlatform('darwin');
    const native = vi.fn((_command: string, _ui: boolean, inserted: string) => {
      box().setRangeText(inserted, box().selectionStart, box().selectionEnd, 'end');
      fireEvent.input(box());
      return true;
    });
    const previous = document.execCommand;
    document.execCommand = native;
    try {
      render(<Harness initial="- item" />);
      caretAt(6);
      press('Shift+Enter');
      expect(native).toHaveBeenCalledExactlyOnceWith('insertText', false, '\n- ');
      expect(box()).toHaveValue('- item\n- ');
      expect(press('Meta+Z')).toBe(false);
    } finally { document.execCommand = previous; }
  });

  it('fallback updates the caller draft, which survives remounting', () => {
    let draft = '- item';
    const onTextChange = (value: string) => { draft = value; };
    const { unmount } = render(<Harness text={draft} onTextChange={onTextChange} />);
    caretAt(6);
    press('Shift+Enter');
    expect(draft).toBe('- item\n- ');
    unmount();
    render(<Harness text={draft} onTextChange={onTextChange} />);
    expect(box()).toHaveValue('- item\n- ');
    expect(screen.queryByTestId('chat-slash-menu')).not.toBeInTheDocument();
  });
});
