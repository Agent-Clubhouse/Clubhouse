import { fireEvent, render, screen } from '@testing-library/react';
import { PreviewBody } from './FileChips';
import { useFilePreviewStore } from '../../../../stores/filePreviewStore';

vi.mock('../../../../plugins/builtin/canvas/ReadOnlyMonacoEditor', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../plugins/builtin/canvas/ReadOnlyMonacoEditor')>(),
  ReadOnlyMonacoEditor: ({ value, reveal, onSave }: { value: string; reveal?: { line: number }; onSave?: unknown }) =>
    <pre data-testid="source" data-line={reveal?.line} data-save={!!onSave}>{value}</pre>,
}));

const text = '# Notes\r\n\r\n**Keep**  spaces\n';
const preview = { kind: 'text' as const, name: 'notes.md', text, size: text.length };

beforeEach(() => useFilePreviewStore.getState().close());
afterEach(() => useFilePreviewStore.getState().close());

it.each(['notes.md', 'notes.markdown', 'notes.mdx', 'NOTES.MD'])('defaults %s to Preview and preserves exact raw Source', (path) => {
  const { rerender } = render(<PreviewBody preview={preview} target={{ path, line: 3 }} />);
  expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  expect(screen.queryByTestId('source')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByTestId('source').textContent).toBe(text);
  expect(screen.getByTestId('source')).toHaveAttribute('data-line', '3');
  expect(screen.getByTestId('source')).toHaveAttribute('data-save', 'false');
  rerender(<PreviewBody preview={{ ...preview }} target={{ path, line: 3 }} />);
  expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
});

it('shows other text without a toggle', () => {
  render(<PreviewBody preview={preview} target={{ path: 'notes.txt' }} />);
  expect(screen.queryByRole('group', { name: 'Markdown view' })).toBeNull();
  expect(screen.getByTestId('source').textContent).toBe(text);
});

it('resets the mode for a different file', () => {
  const { rerender } = render(<PreviewBody preview={preview} target={{ path: 'first.md' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  rerender(<PreviewBody preview={preview} target={{ path: 'second.md' }} />);
  expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
});

it('renders available truncated Markdown and keeps the existing note in both modes', () => {
  render(<PreviewBody preview={{ ...preview, truncated: true }} target={{ path: 'notes.md', line: 100 }} showOpenHint={false} />);
  expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  const note = screen.getByTestId('chat-file-preview-note').textContent;
  expect(note).toMatch(/^Line 100 is past the first .* shown here\.$/);
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByTestId('source').textContent).toBe(text);
  expect(screen.getByTestId('chat-file-preview-note').textContent).toBe(note);
});

it.each([true, false])('blocks local images and safely handles links with allowLocalFiles=%s', (allowLocalFiles) => {
  const openExternal = vi.spyOn(window.clubhouse.app, 'openExternalUrl');
  const content = '[external](https://example.com) [local](/tmp/notes.md) [relative](next.md)\n\n![relative](./image.png) ![absolute](/tmp/image.png) ![file](file:///tmp/image.png) ![remote](https://example.com/image.png)\n\n<script>alert(1)</script>';
  const { container } = render(<PreviewBody preview={{ ...preview, text: content }} target={{ path: 'notes.md' }} allowLocalFiles={allowLocalFiles} />);
  expect(container.querySelector('script')).toBeNull();
  for (const name of ['relative', 'absolute', 'file']) expect(screen.getByAltText(name)).not.toHaveAttribute('src');
  expect(screen.getByAltText('remote')).toHaveAttribute('src', 'https://example.com/image.png');
  for (const name of ['external', 'relative', 'local']) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('link', { name }), event);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(openExternal).toHaveBeenCalledWith('https://example.com');
  expect(useFilePreviewStore.getState().target?.path ?? null).toBe(allowLocalFiles ? '/tmp/notes.md' : null);
});
