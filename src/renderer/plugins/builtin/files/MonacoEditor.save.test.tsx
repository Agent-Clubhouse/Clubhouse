import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

// A small stateful Monaco fake: models hold real values, editors fire content
// listeners, and loadMonaco can be held open to exercise the async init window.

const KeyMod = { CtrlCmd: 0x0800, Alt: 0x0100, Shift: 0x0400 };
const KeyCode = { KeyS: 49, KeyF: 36, KeyH: 38, KeyG: 37, KeyD: 34, KeyL: 42, KeyZ: 56 };

interface FakeEditor {
  commands: Map<number, () => void>;
  options: any;
  type: (text: string) => void;
  getValue: () => string;
}

const fake = vi.hoisted(() => ({
  editors: [] as any[],
  createdModels: [] as Array<{ value: string; language: string }>,
  release: null as null | (() => void),
  hold: false,
  themeId: 'theme-a',
}));

function createFakeMonaco() {
  const createModel = (value: string, language: string) => {
    let v = value;
    fake.createdModels.push({ value, language });
    return { getValue: () => v, setValue: (nv: string) => { v = nv; }, dispose: vi.fn() };
  };
  return {
    KeyMod,
    KeyCode,
    Uri: { parse: (s: string) => s },
    editor: {
      getModel: () => null,
      createModel,
      setModelLanguage: () => {},
      create: (_el: HTMLElement, options: any) => {
        let model = options.model;
        const listeners = new Set<() => void>();
        const commands = new Map<number, () => void>();
        const ed = {
          commands,
          options,
          getValue: () => model.getValue(),
          getModel: () => model,
          setModel: (m: any) => { model = m; },
          type: (text: string) => { model.setValue(text); listeners.forEach((l) => l()); },
          addCommand: (key: number, fn: () => void) => { commands.set(key, fn); },
          trigger: () => {},
          updateOptions: () => {},
          onDidChangeModelContent: (fn: () => void) => {
            listeners.add(fn);
            return { dispose: () => listeners.delete(fn) };
          },
          onDidChangeCursorPosition: () => ({ dispose: () => {} }),
          getPosition: () => ({ lineNumber: 1, column: 1 }),
          setPosition: vi.fn(),
          getScrollTop: () => 0,
          getScrollLeft: () => 0,
          setScrollTop: vi.fn(),
          setScrollLeft: vi.fn(),
          revealLineInCenter: () => {},
          setSelection: () => {},
          focus: () => {},
          dispose: () => {},
        };
        fake.editors.push(ed);
        return ed;
      },
    },
  };
}

vi.mock('./monaco-theme', () => ({
  loadMonaco: () => {
    const m = createFakeMonaco();
    if (!fake.hold) return Promise.resolve(m);
    return new Promise((resolve) => { fake.release = () => resolve(m); });
  },
  ensureThemes: async () => {},
  applyMonacoTheme: () => {},
  monacoThemeName: (id: string) => `clubhouse-${id}`,
}));

vi.mock('../../../stores/themeStore', () => ({
  useThemeStore: (sel: (s: { themeId: string; theme: { id: string } }) => string) => sel({ themeId: fake.themeId, theme: { id: fake.themeId } }),
}));

import { MonacoEditor, disposeAllModels, isModelDirty, getModelContent } from './MonacoEditor';

const SAVE = KeyMod.CtrlCmd | KeyCode.KeyS;

function lastEditor(): FakeEditor {
  return fake.editors[fake.editors.length - 1];
}

async function renderEditor(props: Partial<React.ComponentProps<typeof MonacoEditor>> = {}) {
  const onDirtyChange = vi.fn();
  const onSave = vi.fn();
  const all = { value: 'original', language: 'typescript', filePath: 'a.ts', onSave, onDirtyChange, ...props };
  const utils = render(<MonacoEditor {...all} />);
  await waitFor(() => expect(fake.editors.length).toBeGreaterThan(0));
  return { ...utils, onDirtyChange: all.onDirtyChange as ReturnType<typeof vi.fn>, onSave: all.onSave };
}

beforeEach(() => {
  disposeAllModels();
  fake.editors = [];
  fake.createdModels = [];
  fake.hold = false;
  fake.release = null;
  fake.themeId = 'theme-a';
});

describe('MonacoEditor save baseline', () => {
  it('keeps the draft dirty when the save resolves false', async () => {
    const onSave = vi.fn(async () => false);
    const { onDirtyChange } = await renderEditor({ onSave });

    act(() => lastEditor().type('draft'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => { lastEditor().commands.get(SAVE)!(); });

    expect(onSave).toHaveBeenCalledWith('draft');
    expect(isModelDirty('a.ts')).toBe(true);
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false);
  });

  it('keeps the draft dirty when the save rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSave = vi.fn(async () => { throw new Error('EACCES'); });
    const { onDirtyChange } = await renderEditor({ onSave });

    act(() => lastEditor().type('draft'));
    await act(async () => { lastEditor().commands.get(SAVE)!(); });

    expect(isModelDirty('a.ts')).toBe(true);
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false);
    consoleError.mockRestore();
  });

  it('commits the baseline after a successful save', async () => {
    const onSave = vi.fn(async () => true);
    const { onDirtyChange } = await renderEditor({ onSave });

    act(() => lastEditor().type('draft'));
    await act(async () => { lastEditor().commands.get(SAVE)!(); });

    expect(isModelDirty('a.ts')).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not mark the baseline clean before the write settles', async () => {
    let finish!: (ok: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((r) => { finish = r; }));
    await renderEditor({ onSave });

    act(() => lastEditor().type('draft'));
    await act(async () => { lastEditor().commands.get(SAVE)!(); });
    expect(isModelDirty('a.ts')).toBe(true);

    await act(async () => { finish(true); });
    expect(isModelDirty('a.ts')).toBe(false);
  });
});

describe('MonacoEditor remount', () => {
  it('keeps unsaved edits when remounted with the same value (tab switch back)', async () => {
    const { unmount } = await renderEditor();
    act(() => lastEditor().type('draft'));
    unmount();

    const { onDirtyChange } = await renderEditor();
    expect(getModelContent('a.ts')).toBe('draft');
    expect(isModelDirty('a.ts')).toBe(true);
    expect(onDirtyChange).not.toHaveBeenLastCalledWith(false);
  });

  it('still applies an external value change', async () => {
    const { rerender, onSave, onDirtyChange } = await renderEditor();
    rerender(
      <MonacoEditor value="from disk" language="typescript" filePath="a.ts" onSave={onSave} onDirtyChange={onDirtyChange} />,
    );
    expect(getModelContent('a.ts')).toBe('from disk');
    expect(isModelDirty('a.ts')).toBe(false);
  });
});

describe('MonacoEditor async initialization', () => {
  it('creates the editor from the latest props when they change while Monaco loads', async () => {
    fake.hold = true;
    const onSave = vi.fn();
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      <MonacoEditor value="old" language="plaintext" filePath="a.ts" onSave={onSave} onDirtyChange={onDirtyChange} />,
    );
    await waitFor(() => expect(fake.release).not.toBeNull());

    fake.themeId = 'theme-b';
    const scroll = { scrollTop: 40, scrollLeft: 2, cursorLine: 5, cursorColumn: 3 };
    rerender(
      <MonacoEditor
        value="new"
        language="typescript"
        filePath="a.ts"
        onSave={onSave}
        onDirtyChange={onDirtyChange}
        initialScrollState={scroll}
      />,
    );

    await act(async () => { fake.release!(); });
    await waitFor(() => expect(fake.editors.length).toBe(1));

    expect(fake.createdModels).toEqual([{ value: 'new', language: 'typescript' }]);
    const ed = fake.editors[0];
    expect(ed.options.theme).toBe('clubhouse-theme-b');
    expect(ed.setScrollTop).toHaveBeenCalledWith(40);
    expect(ed.setPosition).toHaveBeenCalledWith({ lineNumber: 5, column: 3 });
  });
});
