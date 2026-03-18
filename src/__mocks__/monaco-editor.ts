// Minimal mock for monaco-editor in vitest
/// <reference types="vitest/globals" />

const mockModel = {
  dispose: () => {},
  getValue: () => '',
  setValue: () => {},
  onDidChangeModelContent: () => ({ dispose: () => {} }),
};

const mockEditor = {
  dispose: () => {},
  getValue: () => '',
  setValue: () => {},
  getModel: () => mockModel as any,
  setModel: () => {},
  addCommand: vi.fn(),
  trigger: vi.fn(),
  updateOptions: vi.fn(),
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  setPosition: () => {},
  getScrollTop: () => 0,
  getScrollLeft: () => 0,
  setScrollTop: () => {},
  setScrollLeft: () => {},
  onDidChangeModelContent: () => ({ dispose: () => {} }),
  onDidChangeCursorPosition: () => ({ dispose: () => {} }),
  hasTextFocus: vi.fn(() => false),
  focus: () => {},
  revealLineInCenter: () => {},
  setSelection: () => {},
};

export const editor = {
  create: (): typeof mockEditor => mockEditor,
  defineTheme: () => {},
  setTheme: () => {},
  setModelLanguage: () => {},
  getModel: () => null as any,
  createModel: () => mockModel,
  getEditors: vi.fn(() => [mockEditor]),
};

export const Uri = {
  parse: (value: string) => ({ toString: () => value }),
};

export const KeyMod = { CtrlCmd: 0x0800, Alt: 0x0100, Shift: 0x0400 };
export const KeyCode = {
  KeyS: 49,
  KeyF: 36,
  KeyH: 38,
  KeyG: 37,
  KeyD: 34,
  KeyL: 42,
  KeyZ: 56,
};
