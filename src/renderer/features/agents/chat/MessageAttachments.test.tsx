import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ChatFileInfo, ChatFilePreview, ContentBlock } from '../../../../shared/chat';
import type { UserMessageItem } from '../../../stores/chatStore';
import { UserMessage } from './MessageBlocks';
import { attachmentName } from './attachments';
import { ChatMediaContext } from './rich/ChatImages';
import { FileChipProvider, clearFileChipCache } from './rich/FileChips';
import { clearLoadedImages } from './rich/markdown-images';
import { clearMediaCache } from './rich/media';
import { clearMediaCardCaches } from './rich/media-cards';

vi.mock('../../../plugins/builtin/canvas/ReadOnlyMonacoEditor', () => ({
  ReadOnlyMonacoEditor: ({ value }: { value: string }) => <pre data-testid="monaco">{value}</pre>,
}));

const REF = `${'ab'.repeat(32)}.png`;
const IMPORTED_REF = `${'cd'.repeat(32)}.png`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const STORED = '/u/chat-attachments/a1/4331c774-0000-4000-8000-000000000000.png';

const FILES: Record<string, ChatFileInfo> = {
  '/work/notes.md': { path: '/work/notes.md', exists: true, kind: 'text', size: 5, name: 'notes.md' },
  '/work/talk.wav': { path: '/work/talk.wav', exists: true, kind: 'audio', size: 4, name: 'talk.wav' },
  '/work/demo.webm': { path: '/work/demo.webm', exists: true, kind: 'video', size: 4, name: 'demo.webm' },
};

const readMedia = vi.fn();
const importLocalImage = vi.fn();
const statPaths = vi.fn(async (_agent: string, paths: string[]) => paths.map((p) => FILES[p] ?? { path: p, exists: false, reason: 'missing' }));
const readFilePreview = vi.fn(async (_agent: string, p: string): Promise<ChatFilePreview> => ({ kind: 'text', name: FILES[p]?.name ?? p, size: 5, text: 'hello' }));

function item(content: ContentBlock[], over: Partial<UserMessageItem> = {}): UserMessageItem {
  return {
    id: 'user:s:m1', sessionId: 's', seq: 1, ts: 1, kind: 'user_message', messageId: 'm1',
    content, text: '', source: 'user', delivery: 'prompt', ...over,
  };
}

/** The transcript's providers as ChatStream sets them while rich chat content is on (null: off). */
function rich(children: ReactNode, agentId: string | null = 'a1') {
  return (
    <ChatMediaContext.Provider value={agentId}>
      <FileChipProvider agentId={agentId}>{children}</FileChipProvider>
    </ChatMediaContext.Provider>
  );
}

async function settle() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

beforeEach(() => {
  clearMediaCache();
  clearLoadedImages();
  clearFileChipCache();
  clearMediaCardCaches();
  readMedia.mockReset().mockResolvedValue({ mimeType: 'image/png', data: PNG });
  importLocalImage.mockReset().mockResolvedValue({ ok: true, mediaRef: IMPORTED_REF, mimeType: 'image/png', width: 400, height: 200 });
  statPaths.mockClear();
  readFilePreview.mockClear();
  Object.assign(window.clubhouse.chat, { readMedia, importLocalImage, statPaths, readFilePreview, fileAction: vi.fn(async () => null) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachmentName', () => {
  it('prefers the name it was attached under, and falls back to the file name for older messages', () => {
    expect(attachmentName({ type: 'image', mimeType: 'image/png', path: STORED, name: 'screenshot.png' })).toBe('screenshot.png');
    expect(attachmentName({ type: 'image', mimeType: 'image/png', path: STORED })).toBe('4331c774-0000-4000-8000-000000000000.png');
    expect(attachmentName({ type: 'file', path: '/work/notes.md', name: 'Notes.md' })).toBe('Notes.md');
    expect(attachmentName({ type: 'file', path: '/work/notes.md' })).toBe('notes.md');
  });
});

describe('sent message attachments', () => {
  it('shows an image as a thumbnail from its stored copy, named as attached, and opens the viewer on click', async () => {
    render(rich(<UserMessage item={item([{ type: 'image', mimeType: 'image/png', path: STORED, mediaRef: REF, width: 800, height: 400, name: 'screenshot.png' }])} />));
    const thumb = await screen.findByRole('button', { name: 'Open image: screenshot.png' });
    const img = await waitFor(() => { const el = thumb.querySelector('img'); expect(el).not.toBeNull(); return el!; });
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(readMedia).toHaveBeenCalledWith('a1', REF);
    expect(importLocalImage).not.toHaveBeenCalled();
    // Bounded: 160 x 80 for 800 x 400.
    expect(thumb.style.width).toBe('160px');
    expect(thumb.style.height).toBe('80px');
    expect(screen.queryByText(/4331c774/)).toBeNull();
    fireEvent.click(thumb);
    expect(await screen.findByTestId('chat-image-viewer')).toBeTruthy();
    expect(readMedia).toHaveBeenLastCalledWith('a1', REF);
  });

  it('imports an older message\'s image by its path when it has no stored copy', async () => {
    render(rich(<UserMessage item={item([{ type: 'image', mimeType: 'image/png', path: STORED }])} />));
    const thumb = await screen.findByTestId('chat-attachment-thumb');
    await waitFor(() => expect(thumb.querySelector('img')).not.toBeNull());
    expect(importLocalImage).toHaveBeenCalledWith('a1', STORED);
    expect(readMedia).toHaveBeenCalledWith('a1', IMPORTED_REF);
  });

  it('falls back to the name chip when the image is gone', async () => {
    readMedia.mockRejectedValue(new Error('gone'));
    importLocalImage.mockResolvedValue({ ok: false, reason: 'missing' });
    render(rich(<UserMessage item={item([{ type: 'image', mimeType: 'image/png', path: STORED, mediaRef: REF, name: 'shot.png' }])} />));
    const chip = await screen.findByTestId('chat-attachment-chip');
    expect(chip).toHaveTextContent('shot.png');
    expect(chip.tagName).toBe('SPAN');
    expect(screen.queryByTestId('chat-attachment-thumb')).toBeNull();
  });

  it('keeps every attachment a plain name chip while rich chat content is off', async () => {
    render(rich(<UserMessage item={item([
      { type: 'image', mimeType: 'image/png', path: STORED, mediaRef: REF, name: 'shot.png' },
      { type: 'file', path: '/work/notes.md' },
    ])} />, null));
    await settle();
    const chips = screen.getAllByTestId('chat-attachment-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['shot.png', 'notes.md']);
    expect(chips.every((c) => c.tagName === 'SPAN')).toBe(true);
    expect(readMedia).not.toHaveBeenCalled();
    expect(importLocalImage).not.toHaveBeenCalled();
    expect(statPaths).not.toHaveBeenCalled();
  });

  it('keeps a file a chip that opens its preview', async () => {
    render(rich(<UserMessage item={item([{ type: 'file', path: '/work/notes.md' }])} />));
    await settle();
    const chip = screen.getByTestId('chat-attachment-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveTextContent('notes.md');
    fireEvent.click(chip);
    expect(await screen.findByTestId('chat-file-preview')).toBeTruthy();
    expect(readFilePreview).toHaveBeenCalledWith('a1', '/work/notes.md');
    expect(await screen.findByTestId('monaco')).toHaveTextContent('hello');
  });

  it('keeps a missing file a plain chip', async () => {
    render(rich(<UserMessage item={item([{ type: 'file', path: '/work/gone.md' }])} />));
    await settle();
    const chip = screen.getByTestId('chat-attachment-chip');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent('gone.md');
  });

  it('shows attached audio and video as the inline player cards', async () => {
    const { container } = render(rich(<UserMessage item={item([{ type: 'file', path: '/work/talk.wav' }, { type: 'file', path: '/work/demo.webm' }])} />));
    await settle();
    const cards = [...container.querySelectorAll<HTMLElement>('[data-chat-media]')];
    expect(cards.map((c) => c.dataset.chatMedia)).toEqual(['audio', 'video']);
    expect(screen.getByRole('button', { name: 'Play talk.wav' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play demo.webm' })).toBeTruthy();
  });

  it.each([['steer'], ['queued']] as const)('renders a %s message\'s attachments the same way', async (delivery) => {
    render(rich(<UserMessage item={item([{ type: 'image', mimeType: 'image/png', path: STORED, mediaRef: REF, name: 'shot.png' }], { delivery })} />));
    const thumb = await screen.findByRole('button', { name: 'Open image: shot.png' });
    await waitFor(() => expect(thumb.querySelector('img')).not.toBeNull());
  });

  it('shows attachments on a message from another agent too', async () => {
    render(rich(<UserMessage item={item([{ type: 'text', text: 'see this' }, { type: 'image', mimeType: 'image/png', path: STORED, mediaRef: REF, name: 'shot.png' }], {
      text: 'see this', source: 'mcp', routed: [{ sender: { agentId: 'other', name: 'other' }, text: 'see this' }],
    })} />));
    expect(await screen.findByRole('button', { name: 'Open image: shot.png' })).toBeTruthy();
  });
});
