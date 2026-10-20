import { describe, it, expect } from 'vitest';
import { bindingChord, EDITING_KEYS, eventChord, isEditingKeyEvent, isTextInputTarget, KEY_PLATFORMS, keyPlatform } from './editing-keys';
import { chordEventInit } from './editing-keys.testing';

/** The issue's matrix (#2314), as physical chords, with Shift where it selects. */
const MATRIX: Record<'darwin' | 'pc', string[]> = {
  darwin: [
    'Meta+ArrowLeft', 'Meta+ArrowRight', 'Meta+Shift+ArrowLeft', 'Meta+Shift+ArrowRight',
    'Ctrl+A', 'Ctrl+E', 'Ctrl+Shift+A', 'Ctrl+Shift+E', 'Ctrl+K',
    'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Shift+ArrowLeft', 'Alt+Shift+ArrowRight',
    'Meta+ArrowUp', 'Meta+ArrowDown', 'Meta+Shift+ArrowUp', 'Meta+Shift+ArrowDown',
    'Alt+Backspace', 'Meta+Backspace',
    'ArrowUp', 'ArrowDown', 'Shift+ArrowUp', 'Shift+ArrowDown',
    'Shift+Enter', 'Alt+Enter',
    'Meta+C', 'Meta+X', 'Meta+V', 'Meta+A', 'Meta+Z', 'Meta+Shift+Z',
  ],
  pc: [
    'Home', 'End', 'Shift+Home', 'Shift+End',
    'Ctrl+ArrowLeft', 'Ctrl+ArrowRight', 'Ctrl+Shift+ArrowLeft', 'Ctrl+Shift+ArrowRight',
    'Ctrl+Home', 'Ctrl+End', 'Ctrl+Shift+Home', 'Ctrl+Shift+End',
    'Ctrl+Backspace', 'Ctrl+Delete',
    'ArrowUp', 'ArrowDown', 'Shift+ArrowUp', 'Shift+ArrowDown',
    'Shift+Enter', 'Alt+Enter',
    'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y',
  ],
};

const event = (chord: string) => new KeyboardEvent('keydown', chordEventInit(chord));

describe('EDITING_KEYS', () => {
  it.each(KEY_PLATFORMS)('covers the #2314 matrix on %s', (platform) => {
    const matrix = MATRIX[platform === 'darwin' ? 'darwin' : 'pc'];
    expect(matrix.filter((c) => !isEditingKeyEvent(event(c), platform))).toEqual([]);
  });

  it('leaves the app chords that are not editing keys', () => {
    for (const c of ['Meta+K', 'Meta+Shift+N', 'Meta+Alt+ArrowLeft', 'Meta+1', 'Escape']) {
      expect(isEditingKeyEvent(event(c), 'darwin')).toBe(false);
    }
    for (const c of ['Ctrl+K', 'Ctrl+Shift+N', 'Ctrl+Alt+ArrowLeft', 'Ctrl+1', 'Escape']) {
      expect(isEditingKeyEvent(event(c), 'win32')).toBe(false);
      expect(isEditingKeyEvent(event(c), 'linux')).toBe(false);
    }
  });

  it('tells Ctrl from Cmd on macOS, where bindings cannot', () => {
    expect(isEditingKeyEvent(event('Ctrl+K'), 'darwin')).toBe(true);
    expect(isEditingKeyEvent(event('Meta+K'), 'darwin')).toBe(false);
  });

  it('treats IME composition and AltGr characters as typing', () => {
    expect(isEditingKeyEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }), 'darwin')).toBe(true);
    expect(isEditingKeyEvent({ key: 'Process', keyCode: 229 }, 'win32')).toBe(true);
    // Hungarian AltGr+W types '|'; Windows reports it as Ctrl+Alt.
    const altGr = { key: '|', code: 'KeyW', ctrlKey: true, altKey: true, getModifierState: (k: string) => k === 'AltGraph' };
    expect(isEditingKeyEvent(altGr, 'win32')).toBe(true);
  });

  it('reads the letter from the physical key when Option changes it', () => {
    expect(eventChord({ key: '˚', code: 'KeyK', altKey: true, metaKey: true })).toBe('Meta+Alt+K');
  });

  it('has the same matrix on Windows and Linux', () => {
    expect([...EDITING_KEYS.linux]).toEqual([...EDITING_KEYS.win32]);
  });
});

describe('bindingChord', () => {
  it('maps Meta to Cmd on macOS and Ctrl elsewhere', () => {
    expect(bindingChord('Meta+Shift+ArrowLeft', 'darwin')).toBe('Meta+Shift+ArrowLeft');
    expect(bindingChord('Meta+Shift+ArrowLeft', 'win32')).toBe('Ctrl+Shift+ArrowLeft');
    expect(bindingChord('Meta+Alt+R', 'linux')).toBe('Ctrl+Alt+R');
  });
});

describe('keyPlatform', () => {
  it('falls back to linux for other platforms', () => {
    expect(keyPlatform('darwin')).toBe('darwin');
    expect(keyPlatform('win32')).toBe('win32');
    expect(keyPlatform('freebsd')).toBe('linux');
  });
});

describe('isTextInputTarget', () => {
  it('knows inputs, textareas, contenteditable and Monaco', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.appendChild(inner);
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const inMonaco = document.createElement('div');
    monaco.appendChild(inMonaco);
    expect(isTextInputTarget(document.createElement('input'))).toBe(true);
    expect(isTextInputTarget(document.createElement('textarea'))).toBe(true);
    expect(isTextInputTarget(inner)).toBe(true);
    expect(isTextInputTarget(inMonaco)).toBe(true);
    expect(isTextInputTarget(document.createElement('button'))).toBe(false);
    expect(isTextInputTarget(null)).toBe(false);
  });
});
