import { typePrompt, promptSource, promptSelection, selectPrompt } from './prompt-editor.testing';
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

const box = () => screen.getByLabelText('Message') as HTMLElement;
/** Fires the chord at the composer; true when a handler took it (preventDefault). */
const press = (chord: string, extra: KeyboardEventInit = {}) => !fireEvent.keyDown(box(), { ...chordEventInit(chord), ...extra });
function caretAt(at: number) {
  selectPrompt(box(), at);
}

describe('Composer editing keys (#2314)', () => {
  afterEach(() => setPlatform(originalPlatform as KeyPlatform));

  it.each(KEY_PLATFORMS.flatMap((p) => [[p, false], [p, true]] as const))(
    'keeps editing keys in the editor and never triggers app actions on %s (running: %s)',
    (platform, running) => {
      setPlatform(platform);
      const onSend = vi.fn();
      const onStop = vi.fn();
      render(<Harness initial={DRAFT} running={running} onSend={onSend} onStop={onStop} />);
      caretAt(15);
      const editorKeys = /^(Ctrl\+A|Meta\+A|.*(?:Backspace|Delete|Enter)|.*\+(?:Z|Y))$/;
      const taken = [...EDITING_KEYS[platform]].filter((c) => !editorKeys.test(c) && press(c));
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
    expect(promptSource(box())).toBe(DRAFT);
  });

  it('Shift+Enter and Option/Alt+Enter are soft returns, idle and during a turn', () => {
    for (const running of [false, true]) {
      const onSend = vi.fn();
      const { unmount } = render(<Harness initial="draft" running={running} onSend={onSend} />);
      expect(press('Shift+Enter')).toBe(true);
      // Alt+Enter is inserted by the composer: Chromium won't on Windows and Linux.
      typePrompt(box(), 'draft');
      caretAt(2);
      press('Alt+Enter');
      expect(promptSource(box())).toBe('dr\naft');
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
    typePrompt(box(), '/co', 3);
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
    typePrompt(box(), '/co', 3);
    expect(screen.getByTestId('chat-slash-menu')).toBeInTheDocument();
    press('Alt+Enter');
    expect(promptSource(box())).toBe('/co\n');
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
    expect(promptSource(box())).toBe('1. first\n2. ');
    expect(promptSelection(box())[0]).toBe(12);
    press(chord);
    expect(promptSource(box())).toBe('1. first\n');
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([['darwin', 'Meta'], ['win32', 'Ctrl'], ['linux', 'Ctrl']] as const)('formats on %s and sends source byte for byte', (platform, mod) => {
    setPlatform(platform);
    const onSend = vi.fn();
    render(<Harness initial={'  word\n'} onSend={onSend} />);
    selectPrompt(box(), 2, 6);
    press(`${mod}+B`);
    expect(promptSource(box())).toBe('  **word**\n');
    expect(promptSelection(box())).toEqual([4, 8]);
    press(`${mod}+B`);
    expect(promptSource(box())).toBe('  word\n');
    press(`${mod}+I`);
    expect(promptSource(box())).toBe('  *word*\n');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith('*word*', 'send');
  });

  it('Tab only indents list items and the slash menu still owns Tab', () => {
    render(<Harness initial={'- first\n- item'} />);
    caretAt(14);
    expect(press('Tab')).toBe(true);
    expect(promptSource(box())).toBe('- first\n  - item');
    expect(press('Shift+Tab')).toBe(true);
    expect(promptSource(box())).toBe('- first\n- item');
    typePrompt(box(), 'plain');
    expect(press('Tab')).toBe(false);
    expect(press('Shift+Tab')).toBe(false);
    typePrompt(box(), '- /co', 5);
    expect(screen.getByTestId('chat-slash-menu')).toBeInTheDocument();
    expect(press('Tab')).toBe(true);
    expect(promptSource(box())).toBe('- /compact ');
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves all aid keys to IME: %s', (extra) => {
    setPlatform('darwin');
    render(<Harness initial="- item" />);
    caretAt(6);
    for (const chord of ['Meta+B', 'Meta+I', 'Tab', 'Shift+Tab', 'Shift+Enter', 'Alt+Enter']) {
      expect(press(chord, extra)).toBe(false);
      expect(promptSource(box())).toBe('- item');
    }
  });

  it('does not take Ctrl+B on macOS or modified formatting chords', () => {
    setPlatform('darwin');
    render(<Harness initial="draft" />);
    for (const chord of ['Ctrl+B', 'Meta+Shift+B', 'Meta+Alt+I', 'Meta+ArrowLeft', 'Meta+Z']) expect(press(chord)).toBe(false);
    expect(promptSource(box())).toBe('draft');
  });

  it('undo restores the document from before a list aid', () => {
    setPlatform('darwin');
    render(<Harness initial="- item" />);
    caretAt(6);
    press('Shift+Enter');
    expect(promptSource(box())).toBe('- item\n- ');
    press('Meta+Z');
    expect(promptSource(box())).toBe('- item');
  });

  it('editor updates the caller draft, which survives remounting', () => {
    let draft = '- item';
    const onTextChange = (value: string) => { draft = value; };
    const { unmount } = render(<Harness text={draft} onTextChange={onTextChange} />);
    caretAt(6);
    press('Shift+Enter');
    expect(draft).toBe('- item\n- ');
    unmount();
    render(<Harness text={draft} onTextChange={onTextChange} />);
    expect(promptSource(box())).toBe('- item\n- ');
    expect(screen.queryByTestId('chat-slash-menu')).not.toBeInTheDocument();
  });
});

describe('structured composer accessibility and paste', () => {
  it('exposes a multiline textbox, semantic lists and discoverable shortcuts', () => {
    render(<Harness initial={'4. first\n5. second\n   - nested'} />);
    expect(box()).toHaveAttribute('role', 'textbox');
    expect(box()).toHaveAttribute('aria-multiline', 'true');
    expect(box()).toHaveAttribute('aria-placeholder');
    expect(box()).not.toHaveAttribute('title');
    expect(box()).toHaveAttribute('contenteditable', 'true');
    expect(box()).toHaveAttribute('aria-description', expect.stringContaining('+B bold'));
    expect(box().querySelector('ol')).toHaveAttribute('start', '4');
    expect(box().querySelector('ol ul li')).toHaveTextContent('nested');
  });

  it('pastes only literal plain text even when HTML and Markdown are offered', () => {
    render(<Harness />);
    const text = '- pasted\n**literal**\n<tag>literal</tag>';
    fireEvent.paste(box(), { clipboardData: {
      files: [], types: ['text/plain', 'text/html'],
      getData: (kind: string) => kind === 'text/plain' ? text : '<h1>unsafe</h1>',
    } });
    expect(box().querySelector('ul, strong, tag, h1')).toBeNull();
    expect(box()).toHaveTextContent('- pasted**literal**<tag>literal</tag>');
    expect(promptSource(box())).toBe(text);
  });

  it('extracts text from HTML-only clipboard content without inserting HTML', () => {
    render(<Harness />);
    fireEvent.paste(box(), { clipboardData: {
      files: [], types: ['text/html'],
      getData: (kind: string) => kind === 'text/html' ? '<b>plain</b><img src="invalid" onerror="bad()">' : '',
    } });
    expect(box()).toHaveTextContent('plain');
    expect(box().querySelector('b, strong, img')).toBeNull();
  });

  it.each([
    ['<p>first</p><p>second</p>', 'first\nsecond'],
    ['<div>first<br>second</div><div>third</div>', 'first\nsecond\nthird'],
    ['<ul><li>first</li><li>second</li></ul><script>bad()</script>', 'first\nsecond'],
    ['<p>first<br></p>', 'first\n'],
  ])('keeps block breaks from inert HTML-only paste %s', (html, expected) => {
    render(<Harness />);
    fireEvent.paste(box(), { clipboardData: {
      files: [], types: ['text/html'], getData: (kind: string) => kind === 'text/html' ? html : '',
    } });
    expect(promptSource(box())).toBe(expected);
    expect(box().querySelector('script, ul')).toBeNull();
  });

  it('shows the placeholder only for an empty paragraph, not an empty list or soft return', () => {
    render(<Harness />);
    expect(box()).toHaveAttribute('data-empty', 'true');
    typePrompt(box(), '- ');
    expect(box()).toHaveAttribute('data-empty', 'false');
    typePrompt(box(), '');
    press('Shift+Enter');
    expect(box()).toHaveAttribute('data-empty', 'false');
  });

  it('keeps disabled drafts readable without editing', () => {
    render(<Harness disabled initial="- saved" />);
    expect(box()).toHaveAttribute('contenteditable', 'false');
    expect(box()).toHaveAttribute('aria-readonly', 'true');
    expect(box()).toHaveAttribute('aria-disabled', 'true');
    expect(box().querySelector('li')).toHaveTextContent('saved');
  });
});
