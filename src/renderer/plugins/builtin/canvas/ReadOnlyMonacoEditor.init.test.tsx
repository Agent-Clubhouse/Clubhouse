import React from 'react';
import { render, act, waitFor } from '@testing-library/react';

const KeyMod = { CtrlCmd: 0x0800 };
const KeyCode = { KeyS: 49 };
const SAVE = KeyMod.CtrlCmd | KeyCode.KeyS;

const fake = vi.hoisted(() => ({
  editors: [] as any[],
  createdModels: [] as Array<{ value: string; language: string }>,
  release: null as null | (() => void),
}));

vi.mock('../files/monaco-theme', () => ({
  loadMonaco: () => new Promise((resolve) => {
    fake.release = () => resolve({
      KeyMod,
      KeyCode,
      editor: {
        createModel: (value: string, language: string) => {
          fake.createdModels.push({ value, language });
          const lines = value.split('\n');
          return { getValue: () => value, getLineCount: () => lines.length, getLineMaxColumn: (n: number) => lines[n - 1].length + 1, dispose: () => {} };
        },
        create: (_el: HTMLElement, options: any) => {
          let model = options.model;
          const commands = new Map<number, () => void>();
          const ed = {
            options,
            commands,
            getModel: () => model,
            setModel: (m: any) => { model = m; },
            addCommand: (k: number, fn: () => void) => { commands.set(k, fn); },
            updateOptions: vi.fn(),
            setScrollTop: () => {},
            setScrollLeft: () => {},
            setSelection: vi.fn(),
            setPosition: vi.fn(),
            revealLineInCenter: vi.fn(),
            revealPositionInCenter: vi.fn(),
            dispose: () => {},
          };
          fake.editors.push(ed);
          return ed;
        },
      },
    });
  }),
  ensureThemes: async () => {},
  applyMonacoTheme: () => {},
  monacoThemeName: (id: string) => `clubhouse-${id}`,
}));

vi.mock('../../../stores/themeStore', () => ({
  useThemeStore: (sel: (s: { themeId: string; theme: { id: string } }) => string) => sel({ themeId: 'mocha', theme: { id: 'mocha' } }),
}));

import { ReadOnlyMonacoEditor } from './ReadOnlyMonacoEditor';

beforeEach(() => {
  fake.editors = [];
  fake.createdModels = [];
  fake.release = null;
});

describe('ReadOnlyMonacoEditor — async initialization', () => {
  it('creates the editor from props that changed while Monaco was loading', async () => {
    const firstSave = vi.fn();
    const latestSave = vi.fn();
    const { rerender } = render(<ReadOnlyMonacoEditor value="old" filePath="a.ts" readOnly onSave={firstSave} />);
    await waitFor(() => expect(fake.release).not.toBeNull());

    rerender(<ReadOnlyMonacoEditor value="new" filePath="b.py" readOnly={false} onSave={latestSave} />);
    await act(async () => { fake.release!(); });
    await waitFor(() => expect(fake.editors.length).toBe(1));

    expect(fake.createdModels).toEqual([{ value: 'new', language: 'python' }]);
    expect(fake.editors[0].options.readOnly).toBe(false);

    fake.editors[0].commands.get(SAVE)!();
    expect(firstSave).not.toHaveBeenCalled();
    expect(latestSave).toHaveBeenCalledWith('new');
  });

  it('reveals a place asked for while Monaco was loading, and a new one after', async () => {
    const { rerender } = render(<ReadOnlyMonacoEditor value={'a\nhello\nc'} filePath="a.ts" reveal={{ line: 2, column: 3 }} />);
    await waitFor(() => expect(fake.release).not.toBeNull());
    await act(async () => { fake.release!(); });
    await waitFor(() => expect(fake.editors.length).toBe(1));
    expect(fake.editors[0].setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 3 });
    expect(fake.editors[0].revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 2, column: 3 });
    rerender(<ReadOnlyMonacoEditor value={'a\nhello\nc'} filePath="a.ts" reveal={{ line: 9 }} />);
    expect(fake.editors[0].revealLineInCenter).toHaveBeenLastCalledWith(3);
  });

  it('does not save while read-only', async () => {
    const onSave = vi.fn();
    render(<ReadOnlyMonacoEditor value="x" filePath="a.ts" readOnly onSave={onSave} />);
    await waitFor(() => expect(fake.release).not.toBeNull());
    await act(async () => { fake.release!(); });
    await waitFor(() => expect(fake.editors.length).toBe(1));

    fake.editors[0].commands.get(SAVE)!();
    expect(onSave).not.toHaveBeenCalled();
  });
});
