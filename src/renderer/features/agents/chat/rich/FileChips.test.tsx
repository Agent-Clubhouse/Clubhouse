import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatFileInfo, ChatFilePreview } from '../../../../../shared/chat';
import { useAgentStore } from '../../../../stores/agentStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { Markdown } from '../MessageBlocks';
import { CommandCard } from '../ToolBlocks';
import type { ToolCallItem } from '../../../../stores/chatStore';
import { RichLinkProvider } from './RichLinks';
import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../../../shared/dispatcher-types';
import { useDispatcherStore } from '../../../dispatcher/dispatcherStore';
import { FileChipProvider, clearFileChipCache, inDispatcherFolder } from './FileChips';
import { resetRichChatContentFlag } from './rich-flag';

vi.mock('../../../../plugins/builtin/canvas/ReadOnlyMonacoEditor', () => ({
  ReadOnlyMonacoEditor: ({ value, filePath, reveal }: { value: string; filePath: string; reveal?: { line: number; column?: number } }) => (
    <pre data-testid="monaco" data-path={filePath} data-reveal={reveal ? `${reveal.line}:${reveal.column ?? ''}` : undefined}>{value}</pre>
  ),
}));
const bridge = vi.hoisted(() => ({ handleProtocolAction: vi.fn() }));
vi.mock('../../../../app-event-bridge', () => bridge);
// pdf.js needs a real canvas and worker: the preview is tested against a stand-in.
const pdfjs = vi.hoisted(() => ({
  renderPage: vi.fn((_n: number) => ({ done: Promise.resolve(), cancel: () => undefined })),
  close: vi.fn(),
  openPdf: vi.fn(),
  loadPdfDocument: vi.fn(),
}));
vi.mock('./pdf-loader', () => ({ loadPdfDocument: pdfjs.loadPdfDocument }));

const MD = 'Changed `src/main.ts:12` and src/missing.ts, see /repo/README.md and https://example.com/a.ts.\n\n```\nsrc/main.ts in a block\n```';
const EXISTING: Record<string, ChatFileInfo> = {
  'src/main.ts': { path: 'src/main.ts', exists: true, kind: 'text', size: 20, name: 'main.ts' },
  '/repo/README.md': { path: '/repo/README.md', exists: true, kind: 'text', size: 9, name: 'README.md' },
  'shots/a.png': { path: 'shots/a.png', exists: true, kind: 'image', size: 11, name: 'a.png' },
  '/tmp/CH media probe/notes.md': { path: '/tmp/CH media probe/notes.md', exists: true, kind: 'text', size: 20, name: 'notes.md' },
  'notes/plan.md': { path: 'notes/plan.md', exists: true, kind: 'text', size: 20, name: 'plan.md' },
  'docs/My Notes.md': { path: 'docs/My Notes.md', exists: true, kind: 'text', size: 20, name: 'My Notes.md' },
  'big.log': { path: 'big.log', exists: true, kind: 'text', size: 900_000, name: 'big.log' },
  '/elsewhere/report.pdf': { path: '/elsewhere/report.pdf', exists: true, kind: 'pdf', size: 2048, name: 'report.pdf' },
  '/elsewhere/locked.pdf': { path: '/elsewhere/locked.pdf', exists: true, kind: 'pdf', size: 2048, name: 'locked.pdf' },
  '/elsewhere/huge.pdf': { path: '/elsewhere/huge.pdf', exists: true, kind: 'pdf', size: 40_000_000, name: 'huge.pdf', tooLarge: true },
};
/** Paths main can't show, and why. */
const UNAVAILABLE: Record<string, ChatFileInfo> = {
  '/gone/report.pdf': { path: '/gone/report.pdf', exists: false, reason: 'missing' },
  'src/old.ts': { path: 'src/old.ts', exists: false, reason: 'missing' },
  '/dev/thing.sock': { path: '/dev/thing.sock', exists: false, reason: 'not-a-file' },
  '/repo/src': { path: '/repo/src', exists: false, reason: 'folder' },
  '/repo/later.md': { path: '/repo/later.md', exists: false, reason: 'missing' },
};
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

const statPaths = vi.fn(async (_agent: string, paths: string[]) => paths.map((p) => EXISTING[p] ?? UNAVAILABLE[p] ?? { path: p, exists: false }));
const readFilePreview = vi.fn(async (_agent: string, p: string): Promise<ChatFilePreview> => (p.endsWith('.pdf')
  ? EXISTING[p]?.tooLarge ? { kind: 'pdf', name: 'huge.pdf', size: 40_000_000, tooLarge: true } : { kind: 'pdf', name: p.split('/').pop()!, size: 2048, mimeType: 'application/pdf', data: PDF_BYTES }
  : p === 'shots/a.png'
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
  pdfjs.renderPage.mockClear();
  pdfjs.close.mockClear();
  pdfjs.openPdf.mockReset();
  pdfjs.openPdf.mockImplementation(async () => ({ numPages: 3, renderPage: pdfjs.renderPage, close: pdfjs.close }));
  pdfjs.loadPdfDocument.mockReset();
  pdfjs.loadPdfDocument.mockImplementation(async () => ({ openPdf: pdfjs.openPdf }));
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

describe('files chat cannot show (#2478)', () => {
  beforeEach(() => setFlag(true));

  it('keeps a clear path that main cannot show as a muted chip with its reason', async () => {
    const { container } = await renderRich(<Markdown text={'Wrote /gone/report.pdf and `src/old.ts`, see /dev/thing.sock.'} />);
    await waitFor(() => expect(container.querySelectorAll('[data-chat-file-unavailable]')).toHaveLength(3));
    const muted = [...container.querySelectorAll('[data-chat-file-unavailable]')];
    expect(muted.map((m) => [m.tagName, m.textContent, m.getAttribute('data-chat-file-unavailable'), m.getAttribute('title')])).toEqual([
      ['SPAN', '/gone/report.pdf', 'missing', 'File not found'],
      ['CODE', 'src/old.ts', 'missing', 'File not found'],
      ['SPAN', '/dev/thing.sock', 'not-a-file', 'Not a regular file'],
    ]);
    expect(muted.every((m) => m.classList.contains('chat-file-chip-muted') && !m.hasAttribute('data-chat-file') && !m.hasAttribute('role'))).toBe(true);
    // Not a button: clicking opens nothing.
    fireEvent.click(muted[0]);
    expect(screen.queryByTestId('chat-file-preview')).toBeNull();
  });

  it('leaves folders, loose prose matches and failed lookups as plain text', async () => {
    statPaths.mockImplementationOnce(async (_a: string, paths: string[]) => paths.map((p) => UNAVAILABLE[p] ?? { path: p, exists: false, reason: 'missing' as const }));
    const { container } = await renderRich(<Markdown text={'See /repo/src and src/also/missing.ts here, then `console.log` and `package.json`.'} />);
    await waitFor(() => expect(statPaths).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-chat-path]')).toBeNull());
    expect(container.querySelector('[data-chat-file-unavailable]')).toBeNull();
    expect(container.textContent).toContain('See /repo/src and src/also/missing.ts here, then console.log and package.json.');
  });

  it('turns a muted chip into a chip once the file is there', async () => {
    const { hydrateFileChips } = await import('./FileChips');
    const root = document.createElement('div');
    root.innerHTML = '<p><code data-chat-path="/repo/later.md">/repo/later.md</code></p>';
    document.body.append(root);
    await hydrateFileChips(root, 'a1');
    const code = root.querySelector('code')!;
    expect(code.getAttribute('data-chat-file-unavailable')).toBe('missing');
    clearFileChipCache();
    statPaths.mockImplementationOnce(async () => [{ path: '/repo/later.md', exists: true, kind: 'text', size: 3, name: 'later.md' }]);
    await hydrateFileChips(root, 'a1');
    expect(code.getAttribute('data-chat-file')).toBe('text');
    expect(code.hasAttribute('data-chat-file-unavailable')).toBe(false);
    expect(code.classList.contains('chat-file-chip-muted')).toBe(false);
    expect(code.getAttribute('title')).toBe('later.md · 3 B');
    root.remove();
  });

  it('says on the chip when a file is too large to preview', async () => {
    const { container } = await renderRich(<Markdown text={'`/elsewhere/huge.pdf`'} />);
    const chip = await waitFor(() => { const el = container.querySelector('[data-chat-file="pdf"]'); expect(el).not.toBeNull(); return el!; });
    expect(chip.getAttribute('title')).toBe('huge.pdf · 38.1 MB · Too large to preview');
    fireEvent.click(chip);
    expect((await screen.findByTestId('chat-file-preview-none')).textContent).toBe('This file is too large to preview here.');
    expect(pdfjs.loadPdfDocument).not.toHaveBeenCalled();
  });
});

describe('PDF previews (#2478)', () => {
  beforeEach(() => setFlag(true));

  async function openPdfChip(p: string) {
    const { container } = await renderRich(<Markdown text={`Saved \`${p}\`.`} />);
    const chip = await waitFor(() => { const el = container.querySelector('[data-chat-file="pdf"]'); expect(el).not.toBeNull(); return el!; });
    fireEvent.click(chip);
  }

  it('loads pdf.js only when a PDF preview opens, and shows page 1 with the page count', async () => {
    const { container } = await renderRich(<Markdown text={'`/elsewhere/report.pdf`'} />);
    await waitFor(() => expect(container.querySelector('[data-chat-file="pdf"]')).not.toBeNull());
    expect(pdfjs.loadPdfDocument).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-chat-file="pdf"]')!);
    expect((await screen.findByTestId('chat-file-preview-pdf-page')).textContent).toBe('Page 1 of 3');
    expect(pdfjs.openPdf).toHaveBeenCalledWith(PDF_BYTES);
    await waitFor(() => expect(pdfjs.renderPage).toHaveBeenCalledWith(1, expect.any(HTMLCanvasElement), expect.any(Number), expect.any(Number)));
    expect(screen.queryByTestId('chat-file-preview-text')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open in Files' })).toBeTruthy();
  });

  it('pages with Previous and Next, within the document', async () => {
    await openPdfChip('/elsewhere/report.pdf');
    await screen.findByText('Page 1 of 3');
    const prev = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('Page 3 of 3')).toBeTruthy();
    expect(next.disabled).toBe(true);
    await waitFor(() => expect(pdfjs.renderPage).toHaveBeenLastCalledWith(3, expect.anything(), expect.any(Number), expect.any(Number)));
    fireEvent.click(prev);
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
  });

  it('closes the document with the preview', async () => {
    await openPdfChip('/elsewhere/report.pdf');
    await screen.findByText('Page 1 of 3');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(pdfjs.close).toHaveBeenCalled());
  });

  it('says when a PDF is password protected or unreadable', async () => {
    pdfjs.openPdf.mockRejectedValueOnce(new Error('password'));
    await openPdfChip('/elsewhere/locked.pdf');
    expect((await screen.findByTestId('chat-file-preview-pdf-error')).textContent).toBe('This PDF is password protected.');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('chat-file-preview')).toBeNull());
    clearFileChipCache();
    pdfjs.openPdf.mockRejectedValueOnce(new Error('invalid'));
    await openPdfChip('/elsewhere/report.pdf');
    expect((await screen.findByTestId('chat-file-preview-pdf-error')).textContent).toBe("Couldn't read this PDF.");
  });
});

describe("the Dispatcher's notes (#2557)", () => {
  const FOLDER = 'C:\\Users\\me\\.clubhouse\\dispatcher';
  beforeEach(() => {
    useDispatcherStore.getState().setState({ enabled: true, flagOn: true, agentId: 'disp', path: FOLDER, config: null });
    useAgentStore.setState({ agents: { disp: { id: 'disp', projectId: DISPATCHER_PROJECT_ID, name: 'Dispatcher', kind: 'durable', status: 'running', color: 'indigo' } as never } });
  });
  afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

  it('tells files in its folder apart from files elsewhere', () => {
    expect(inDispatcherFolder('disp', 'notes/plan.md')).toBe(true);
    expect(inDispatcherFolder('a1', 'notes/plan.md')).toBe(false);
    expect(inDispatcherFolder('a1', `${FOLDER}\\notes\\plan.md`)).toBe(true);
    expect(inDispatcherFolder('disp', `${FOLDER}-old\\plan.md`)).toBe(false);
    expect(inDispatcherFolder('disp', 'D:\\repo\\src\\main.ts')).toBe(false);
    useDispatcherStore.getState().setState({ ...DISPATCHER_OFF, agentId: 'disp' });
    expect(inDispatcherFolder('disp', 'notes/plan.md')).toBe(false);
  });

  it('previews and reveals a notes file, and says why Open in Files is off', async () => {
    const { container } = await renderRich(<Markdown text={'Plan in `notes/plan.md`.'} />, 'disp');
    const chip = await waitFor(() => { const el = container.querySelector('code[data-chat-file]'); expect(el).not.toBeNull(); return el!; });
    fireEvent.click(chip);
    expect(await screen.findByTestId('monaco')).toBeTruthy();
    expect(readFilePreview).toHaveBeenCalledWith('disp', 'notes/plan.md');
    const open = screen.getByRole('button', { name: 'Open in Files' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    const note = screen.getByTestId('chat-file-no-open');
    expect(open.getAttribute('aria-describedby')).toBe(note.id);
    expect(note.textContent).toBe('The Dispatcher’s folder isn’t a project, so this doesn’t open in Files.');
    fireEvent.click(screen.getByRole('button', { name: /Show in|Open in Finder/ }));
    await waitFor(() => expect(fileAction).toHaveBeenCalledWith('disp', 'notes/plan.md', 'reveal'));
    expect(fileAction).not.toHaveBeenCalledWith('disp', 'notes/plan.md', 'open');
  });
});
