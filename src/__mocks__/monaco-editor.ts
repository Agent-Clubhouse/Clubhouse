/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal mock for monaco-editor in vitest

const mockEditor = {
  dispose: () => {},
  getValue: () => '',
  setValue: () => {},
  getModel: () => null as any,
  addCommand: () => {},
  onDidChangeModelContent: () => ({ dispose: () => {} }),
};

export const editor = {
  create: (): typeof mockEditor => mockEditor,
  defineTheme: () => {},
  setTheme: () => {},
  setModelLanguage: () => {},
};

export const KeyMod = { CtrlCmd: 0x0800 };
export const KeyCode = { KeyS: 49 };
