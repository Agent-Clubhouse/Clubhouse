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
  ReadOnlyMonacoEditor: ({ value, filePath }: { value: string; filePath: string }) => <pre data-testid="monaco" data-path={filePath}>{value}</pre>,
}));

const MD = 'Changed `src/main.ts:12` and src/missing.ts, see /repo/README.md and https://example.com/a.ts.\n\n```\nsrc/main.ts in a block\n```';
const EXISTING: Record<string, ChatFileInfo> = {
  'src/main.ts': { path: 'src/main.ts', exists: true, kind: 'text', size: 20, name: 'main.ts' },
  '/repo/README.md': { path: '/repo/README.md', exists: true, kind: 'text', size: 9, name: 'README.md' },
  'shots/a.png': { path: 'shots/a.png', exists: true, kind: 'image', size: 11, name: 'a.png' },
};

const statPaths = vi.fn(async (_agent: string, paths: string[]) => paths.map((p) => EXISTING[p] ?? { path: p, exists: false }));
const readFilePreview = vi.fn(async (_agent: string, p: string): Promise<ChatFilePreview> => (p === 'shots/a.png'
  ? { kind: 'image', name: 'a.png', size: 11, mimeType: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) }
  : { kind: 'text', name: 'main.ts', size: 20, text: 'export const x = 1;\n', truncated: false }));
const fileAction = vi.fn(async () => null);

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
  fileAction.mockClear();
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
});
