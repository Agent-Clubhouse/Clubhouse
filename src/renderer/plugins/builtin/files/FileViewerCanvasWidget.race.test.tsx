import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { createMockAPI } from '../../testing';
import type { PluginAPI } from '../../../../shared/plugin-types';

const editorProps = vi.hoisted(() => ({ current: null as null | { value: string; filePath: string; onSave?: (c: string) => unknown } }));

vi.mock('../canvas/ReadOnlyMonacoEditor', () => ({
  ReadOnlyMonacoEditor: (props: { value: string; filePath: string; onSave?: (c: string) => unknown }) => {
    editorProps.current = props;
    return React.createElement('div', { 'data-testid': 'editor' }, `${props.filePath}:${props.value}`);
  },
}));
vi.mock('../canvas/CanvasFileTree', () => ({ CanvasFileTree: () => null }));
vi.mock('../canvas/ResizableSidebar', () => ({
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('./MarkdownPreview', () => ({ MarkdownPreview: () => null }));
vi.mock('../../../../renderer/stores/editorSettingsStore', () => ({
  useEditorSettingsStore: (sel: (s: { editorName: string; loadSettings: () => void }) => unknown) =>
    sel({ editorName: 'Editor', loadSettings: () => {} }),
}));

import { FileViewerCanvasWidget } from './FileViewerCanvasWidget';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const reads = new Map<string, ReturnType<typeof deferred<string>>>();
  const writeFile = vi.fn(async () => {});
  const showError = vi.fn();
  const base = createMockAPI();
  const api = createMockAPI({
    context: { mode: 'project', projectId: 'p1', projectPath: '/p' } as PluginAPI['context'],
    projects: { list: () => [{ id: 'p1', name: 'Proj', path: '/p' }], getActive: () => null } as unknown as PluginAPI['projects'],
    project: {
      ...base.project,
      readFile: vi.fn((rel: string) => {
        const d = deferred<string>();
        reads.set(rel, d);
        return d.promise;
      }),
      writeFile,
    },
    ui: { ...base.ui, showError },
  });
  const props = (filePath: string) => ({
    widgetId: 'w1',
    api,
    metadata: { projectId: 'p1', filePath },
    onUpdateMetadata: vi.fn(),
    size: { width: 400, height: 300 },
  }) as unknown as React.ComponentProps<typeof FileViewerCanvasWidget>;
  return { api, reads, writeFile, showError, props };
}

describe('FileViewerCanvasWidget — stale reads', () => {
  beforeEach(() => { editorProps.current = null; });

  it('ignores a late read for a previously selected file and never saves it over the new file', async () => {
    const { reads, writeFile, props } = setup();
    const { rerender } = render(<FileViewerCanvasWidget {...props('a.ts')} />);
    await waitFor(() => expect(reads.has('a.ts')).toBe(true));

    // Switch to B before A's read resolves
    rerender(<FileViewerCanvasWidget {...props('b.ts')} />);
    await waitFor(() => expect(reads.has('b.ts')).toBe(true));

    await act(async () => { reads.get('a.ts')!.resolve('A content'); });
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();

    await act(async () => { reads.get('b.ts')!.resolve('B content'); });
    expect(screen.getByTestId('editor').textContent).toBe('b.ts:B content');

    await act(async () => { await editorProps.current!.onSave!('B edited'); });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('b.ts', 'B edited');
  });

  it('does not open a failed read in the editor, so the error text cannot be saved', async () => {
    const { reads, writeFile, props } = setup();
    render(<FileViewerCanvasWidget {...props('a.ts')} />);
    await waitFor(() => expect(reads.has('a.ts')).toBe(true));

    await act(async () => { reads.get('a.ts')!.reject(new Error('EIO')); });
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText('Error reading file')).toBeInTheDocument();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('surfaces a failed save', async () => {
    const { reads, writeFile, showError, props } = setup();
    writeFile.mockRejectedValueOnce(new Error('EACCES'));
    render(<FileViewerCanvasWidget {...props('a.ts')} />);
    await waitFor(() => expect(reads.has('a.ts')).toBe(true));
    await act(async () => { reads.get('a.ts')!.resolve('A content'); });

    await act(async () => { await editorProps.current!.onSave!('A edited'); });
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});
