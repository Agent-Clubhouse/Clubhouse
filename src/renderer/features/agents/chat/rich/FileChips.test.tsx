import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatFileInfo, ChatFilePreview } from '../../../../../shared/chat';
import { useAgentStore } from '../../../../stores/agentStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { Markdown } from '../MessageBlocks';
import { CommandCard } from '../ToolBlocks';
import type { ToolCallItem } from '../../../../stores/chatStore';
import { RichLinkProvider } from './RichLinks';
import { FileChipProvider, clearFileChipCache } from './FileChips';
import { resetRichChatContentFlag } from './rich-flag';

vi.mock('../../../../plugins/builtin/canvas/ReadOnlyMonacoEditor', () => ({
  ReadOnlyMonacoEditor: ({ value, filePath, reveal }: { value: string; filePath: string; reveal?: { line: number; column?: number } }) => (
    <pre data-testid="monaco" data-path={filePath} data-reveal={reveal ? `${reveal.line}:${reveal.column ?? ''}` : undefined}>{value}</pre>
  ),
}));
const bridge = vi.hoisted(() => ({ handleProtocolAction: vi.fn() }));
vi.mock('../../../../app-event-bridge', () => bridge);

const MD = 'Changed `src/main.ts:12` and src/missing.ts, see /repo/README.md and https://example.com/a.ts.\n\n```\nsrc/main.ts in a block\n```';
const EXISTING: Record<string, ChatFileInfo> = {
  'src/main.ts': { path: 'src/main.ts', exists: true, kind: 'text', size: 20, name: 'main.ts' },
  '/repo/README.md': { path: '/repo/README.md', exists: true, kind: 'text', size: 9, name: 'README.md' },
  'shots/a.png': { path: 'shots/a.png', exists: true, kind: 'image', size: 11, name: 'a.png' },
  '/tmp/CH media probe/notes.md': { path: '/tmp/CH media probe/notes.md', exists: true, kind: 'text', size: 20, name: 'notes.md' },
  'docs/My Notes.md': { path: 'docs/My Notes.md', exists: true, kind: 'text', size: 20, name: 'My Notes.md' },
  'big.log': { path: 'big.log', exists: true, kind: 'text', size: 900_000, name: 'big.log' },
};

const statPaths = vi.fn(async (_agent: string, paths: string[]) => paths.map((p) => EXISTING[p] ?? { path: p, exists: false }));
const readFilePreview = vi.fn(async (_agent: string, p: string): Promise<ChatFilePreview> => (p === 'shots/a.png'
  ? { kind: 'image', name: 'a.png', size: 11, mimeType: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) }
  : p === 'big.log' ? { kind: 'text', name: 'big.log', size: 900_000, text: 'a\nb\nc', truncated: true }
    : { kind: 'text', name: 'main.ts', size: 20, text: 'export const x = 1;\n', truncated: false }));
const fileAction = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);

function setFlag(on: boolean) {
  window.clubhouse.app.getExperimentalSettings = vi.fn(async () => (on ? { richChatContent: true } : {}));
}

async function renderRich(ui: React.ReactElement, agentId: string | null = 'a1') {
  const r = render(<RichLinkProvider agentId="a1"><FileChipProvider agentId={agentId}>{ui}</FileChipProvider></RichLinkProvider>);
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  return r;
}

beforeEach(() => {
  resetRichChatContentFlag();
  clearFileChipCache();
  statPaths.mockClear();
  readFilePreview.mockClear();
  fileAction.mockReset();
  fileAction.mockImplementation(async () => null);
  bridge.handleProtocolAction.mockClear();
  Object.assign(window.clubhouse.chat, { statPaths, readFilePreview, fileAction });
  window.clubhouse.git.githubRepo = vi.fn(async () => null);
  useAgentStore.setState({ agents: { a1: { id: 'a1', projectId: 'p1', name: 'a', kind: 'durable', status: 'running', color: 'indigo' } as never } });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/repo' } as never] });
});

describe('file chips off', () => {
  it('renders markdown exactly as without chips', async () => {
    setFlag(true);
    const without = await renderRich(<Markdown text={MD} />, null);
    const html = without.container.innerHTML;
    without.unmount();
    setFlag(false);
    resetRichChatContentFlag();
    const plain = render(<Markdown text={MD} />);
    expect(plain.container.querySelector('[data-chat-path]')).toBeNull();
    expect(statPaths).not.toHaveBeenCalled();
    expect(html).not.toContain('data-chat-path');
  });
});

describe('file chips on', () => {
  beforeEach(() => setFlag(true));

  it('makes chips only of files main confirms, in text and inline code, not in code blocks or URLs', async () => {
    const { container } = await renderRich(<Markdown text={MD} />);
    await waitFor(() => expect(container.querySelectorAll('[data-chat-file]')).toHaveLength(2));
    expect(statPaths).toHaveBeenCalledTimes(1);
    expect(statPaths.mock.calls[0][1].sort()).toEqual(['/repo/README.md', 'src/main.ts', 'src/missing.ts']);
    const chips = [...container.querySelectorAll('[data-chat-file]')];
    expect(chips.map((c) => [c.tagName, c.textContent, c.getAttribute('data-chat-line')])).toEqual([
      ['CODE', 'src/main.ts:12', '12'],
      ['SPAN', '/repo/README.md', null],
    ]);
    // A path with no file is plain text again; the URL is still a link; the code block is untouched.
    await waitFor(() => expect(container.querySelector('[data-chat-path="src/missing.ts"]')).toBeNull());
    expect(container.textContent).toContain('src/missing.ts');
    expect(container.querySelector('a[href="https://example.com/a.ts"]')).not.toBeNull();
    expect(container.querySelector('pre [data-chat-path]')).toBeNull();
  });

  it('leaves a path inside a link to the link', async () => {
    const { container } = await renderRich(<Markdown text={'See [`src/main.ts`](https://example.com/x) and `src/main.ts`.'} />);
    await waitFor(() => expect(container.querySelectorAll('[data-chat-file]')).toHaveLength(1));
    expect(container.querySelector('a [data-chat-path]')).toBeNull();
  });

  it('waits for a streaming message to finish before asking about its paths', async () => {
    const { rerender } = await renderRich(<Markdown text="Editing src/main.ts" streaming />);
    expect(statPaths).not.toHaveBeenCalled();
    rerender(<RichLinkProvider agentId="a1"><FileChipProvider agentId="a1"><Markdown text="Editing src/main.ts" /></FileChipProvider></RichLinkProvider>);
    await waitFor(() => expect(statPaths).toHaveBeenCalledTimes(1));
  });

  it('opens a text preview in a read-only editor, and Open in Files / reveal go through main', async () => {
    const { container } = await renderRich(<Markdown text={MD} />);
    const chip = await waitFor(() => { const el = container.querySelector('code[data-chat-file]'); expect(el).not.toBeNull(); return el!; });
    fireEvent.click(chip);
    expect(await screen.findByTestId('chat-file-preview')).toBeTruthy();
    expect((await screen.findByTestId('monaco')).textContent).toBe('export const x = 1;\n');
    expect(readFilePreview).toHaveBeenCalledWith('a1', 'src/main.ts');
    fireEvent.click(screen.getByRole('button', { name: /Show in|Open in Finder/ }));
    await waitFor(() => expect(fileAction).toHaveBeenCalledWith('a1', 'src/main.ts', 'reveal'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('chat-file-preview')).toBeNull());
  });

  it('opens with Enter too, and previews an image as an <img>', async () => {
    const tool: ToolCallItem = {
      kind: 'tool_call', id: 't', sessionId: 's', seq: 1, ts: 0, toolCallId: 't', toolKind: 'execute', title: 'ls', status: 'completed',
      content: [{ type: 'terminal', command: 'ls', output: 'wrote shots/a.png\n', exitCode: 0 }],
    };
    const { container } = await renderRich(<CommandCard tool={tool} />);
    fireEvent.click(screen.getByRole('button', { name: /Expand command/ }));
    const chip = await waitFor(() => { const el = container.querySelector('pre [data-chat-file="image"]'); expect(el).not.toBeNull(); return el as HTMLElement; });
    fireEvent.keyDown(chip, { key: 'Enter' });
    const img = await screen.findByTestId('chat-file-preview-image');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('chips a whole code span or a quoted path with spaces, and not its fragments (#2423)', async () => {
    const { container } = await renderRich(<Markdown text={'See `/tmp/CH media probe/notes.md` and "docs/My Notes.md:4:2", not /tmp/CH media probe/notes.md.'} />);
    await waitFor(() => expect(container.querySelectorAll('[data-chat-file]')).toHaveLength(2));
    const chips = [...container.querySelectorAll('[data-chat-file]')];
    expect(chips.map((c) => [c.tagName, c.textContent, c.getAttribute('data-chat-path'), c.getAttribute('data-chat-line'), c.getAttribute('data-chat-col')])).toEqual([
      ['CODE', '/tmp/CH media probe/notes.md', '/tmp/CH media probe/notes.md', null, null],
      ['SPAN', 'docs/My Notes.md:4:2', 'docs/My Notes.md', '4', '2'],
    ]);
    // The prose copy is split, and its pieces are only asked about, never chips.
    expect(statPaths.mock.calls.flatMap((c) => c[1])).toEqual(expect.arrayContaining(['/tmp/CH', 'probe/notes.md']));
    expect(container.textContent).toContain('"docs/My Notes.md:4:2"');
  });
});

describe('file chip locations (#2424)', () => {
  beforeEach(() => setFlag(true));

  async function openChip(md: string) {
    const { container } = await renderRich(<Markdown text={md} />);
    const chip = await waitFor(() => { const el = container.querySelector('[data-chat-file]'); expect(el).not.toBeNull(); return el!; });
    fireEvent.click(chip);
    return screen.findByTestId('monaco');
  }

  it('reveals the line, and the column, in the preview', async () => {
    expect((await openChip('`src/main.ts:12:5`')).getAttribute('data-reveal')).toBe('12:5');
    expect(screen.getByTestId('chat-file-preview').textContent).toContain('src/main.ts:12:5');
  });

  it('reads #L anchors', async () => {
    expect((await openChip('`src/main.ts#L7`')).getAttribute('data-reveal')).toBe('7:');
  });

  it('leaves a plain path where it was', async () => {
    expect((await openChip('`src/main.ts`')).getAttribute('data-reveal')).toBeNull();
    expect(screen.queryByTestId('chat-file-preview-note')).toBeNull();
  });

  it('says when the line is past the end of the file, or of a truncated preview', async () => {
    await openChip('`src/main.ts:40`');
    expect(screen.getByTestId('chat-file-preview-note').textContent).toBe('Line 40 is past the end of this file, which has 2 lines.');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('chat-file-preview')).toBeNull());
    await openChip('`big.log:500`');
    expect(screen.getByTestId('chat-file-preview-note').textContent).toMatch(/^Line 500 is past the first .* shown here\. Open it in Files to go there\.$/);
  });

  it('opens Files at the same line and column', async () => {
    fileAction.mockImplementation(async () => ({ kind: 'open-file', projectId: 'p1', relativePath: 'src/main.ts' }));
    await openChip('`src/main.ts:12:5`');
    fireEvent.click(screen.getByRole('button', { name: 'Open in Files' }));
    await waitFor(() => expect(bridge.handleProtocolAction).toHaveBeenCalledWith({ kind: 'open-file', projectId: 'p1', relativePath: 'src/main.ts', line: 12, column: 5 }));
    expect(fileAction).toHaveBeenCalledWith('a1', 'src/main.ts', 'open');
  });

  it('opens Files at the top for a plain path', async () => {
    fileAction.mockImplementation(async () => ({ kind: 'open-file', projectId: 'p1', relativePath: 'src/main.ts' }));
    await openChip('`src/main.ts`');
    fireEvent.click(screen.getByRole('button', { name: 'Open in Files' }));
    await waitFor(() => expect(bridge.handleProtocolAction).toHaveBeenCalledWith({ kind: 'open-file', projectId: 'p1', relativePath: 'src/main.ts' }));
  });
});
