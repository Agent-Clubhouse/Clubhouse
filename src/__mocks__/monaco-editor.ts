// Minimal mock for monaco-editor in vitest

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
  addCommand: () => {},
  updateOptions: () => {},
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  setPosition: () => {},
  getScrollTop: () => 0,
  getScrollLeft: () => 0,
  setScrollTop: () => {},
  setScrollLeft: () => {},
  onDidChangeModelContent: () => ({ dispose: () => {} }),
  onDidChangeCursorPosition: () => ({ dispose: () => {} }),
};

export const editor = {
  create: (): typeof mockEditor => mockEditor,
  defineTheme: () => {},
  setTheme: () => {},
  setModelLanguage: () => {},
  getModel: () => null as any,
  createModel: () => mockModel,
};

export const Uri = {
  parse: (value: string) => ({ toString: () => value }),
};

export const KeyMod = { CtrlCmd: 0x0800 };
export const KeyCode = { KeyS: 49 };
