import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilePreviewHost } from './FilePreviewHost';
import { useFilePreviewStore } from '../stores/filePreviewStore';

// Keep the preview component and routing real; Monaco/pdf.js need a browser engine.
vi.mock('../plugins/builtin/canvas/ReadOnlyMonacoEditor', () => ({
  ReadOnlyMonacoEditor: (props: { value: string; reveal?: { line: number; column?: number }; onSave?: unknown }) =>
    <div data-testid="readonly-editor" data-line={props.reveal?.line} data-column={props.reveal?.column} data-save={!!props.onSave}>{props.value}</div>,
}));
vi.mock('../features/agents/chat/rich/PdfPreview', () => ({ PdfPreview: () => <div>PDF pages</div> }));

const preview = vi.fn();
beforeEach(() => {
  useFilePreviewStore.getState().close();
  window.clubhouse.file.preview = preview;
});
afterEach(() => useFilePreviewStore.getState().close());

it('opens a scratch file in-app without a project, reveals the location and offers no save', async () => {
  preview.mockResolvedValue({ path: '/resolved/notes.md', preview: { kind: 'text', size: 7, name: 'notes.md', text: '# Notes' } });
  render(<FilePreviewHost />);
  act(() => useFilePreviewStore.getState().open('~/notes.md', 12, 5));
  expect(await screen.findByTestId('readonly-editor')).toHaveTextContent('# Notes');
  expect(preview).toHaveBeenCalledWith('~/notes.md');
  expect(screen.getByTestId('readonly-editor')).toHaveAttribute('data-line', '12');
  expect(screen.getByTestId('readonly-editor')).toHaveAttribute('data-column', '5');
  expect(screen.getByTestId('readonly-editor')).toHaveAttribute('data-save', 'false');
  expect(screen.getByText(/\/resolved\/notes.md/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('never displays a previous file while the next file is loading or after a late response', async () => {
  let first!: (value: unknown) => void;
  let second!: (value: unknown) => void;
  preview.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }));
  render(<FilePreviewHost />);
  act(() => useFilePreviewStore.getState().open('/scratch/first.txt'));
  act(() => useFilePreviewStore.getState().open('/scratch/second.txt'));
  await act(async () => first({ path: '/scratch/first.txt', preview: { kind: 'text', name: 'first.txt', size: 5, text: 'first' } }));
  expect(screen.queryByTestId('readonly-editor')).toBeNull();
  await act(async () => second({ path: '/scratch/second.txt', preview: { kind: 'text', name: 'second.txt', size: 6, text: 'second' } }));
  expect(screen.getByTestId('readonly-editor')).toHaveTextContent('second');
});

it('shows the actual preview failure and does not open an empty editor', async () => {
  preview.mockRejectedValue(new Error('That file is not available'));
  render(<FilePreviewHost />);
  act(() => useFilePreviewStore.getState().open('/scratch/unavailable.txt'));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That file is not available'));
  expect(screen.queryByTestId('readonly-editor')).toBeNull();
});
