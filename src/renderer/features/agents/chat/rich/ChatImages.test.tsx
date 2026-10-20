import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ChatEvent, ChatEventDataMap, ChatImage } from '../../../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../../../shared/chat';
import { foldChatEvents, type ToolCallItem } from '../../../../stores/chatStore';
import { ExploreGroup, ToolCallView } from '../ToolBlocks';
import { buildStreamBlocks } from '../view-model';
import { ChatMediaContext } from './ChatImages';
import { clearMediaCache } from './media';

const REF = `${'ab'.repeat(32)}.png`;
const SVG_REF = `${'cd'.repeat(32)}.svg`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function tool(over: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: 'tool_call', id: 't-1', sessionId: 's-1', seq: 1, ts: 0, toolCallId: 't-1',
    toolKind: 'read', title: 'Read shot.png', status: 'completed', toolName: 'Read', locations: [{ path: 'shot.png' }], content: [],
    ...over,
  };
}

const stored: ChatImage = { type: 'image', mimeType: 'image/png', mediaRef: REF, width: 800, height: 600 };

function withMedia(children: ReactNode, agentId: string | null = 'agent-1') {
  return <ChatMediaContext.Provider value={agentId}>{children}</ChatMediaContext.Provider>;
}

const readMedia = vi.fn();
const mediaAction = vi.fn();
const fetchRemoteImage = vi.fn();

beforeEach(() => {
  clearMediaCache();
  readMedia.mockReset().mockImplementation(async (_agent: string, ref: string) => (ref === SVG_REF ? { mimeType: 'image/svg+xml', data: SVG } : { mimeType: 'image/png', data: PNG }));
  mediaAction.mockReset().mockResolvedValue(undefined);
  fetchRemoteImage.mockReset().mockResolvedValue({ mimeType: 'image/png', data: PNG });
  Object.assign(window.clubhouse.chat, { readMedia, mediaAction, fetchRemoteImage });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rich chat content off', () => {
  it('renders a tool call with images exactly like one without them', () => {
    const plain = render(<ToolCallView tool={tool()} />).container.innerHTML;
    const rich = render(<ToolCallView tool={tool({ media: [stored, { type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' }] })} />).container.innerHTML;
    expect(rich).toBe(plain);
    // Also with the provider present but no agent (flag off).
    expect(render(withMedia(<ToolCallView tool={tool({ media: [stored] })} />, null)).container.innerHTML).toBe(plain);
    expect(readMedia).not.toHaveBeenCalled();
  });

  it('renders an explore group and a media-only call as before', () => {
    const tools = [tool({ id: 'a', media: [stored] }), tool({ id: 'b', toolKind: 'search', title: 'Search x' })];
    const before = render(<ExploreGroup tools={tools.map(({ media: _m, ...t }) => t)} />).container.innerHTML;
    expect(render(<ExploreGroup tools={tools} />).container.innerHTML).toBe(before);
    const gen = tool({ toolKind: 'other', toolName: 'imageGeneration', mediaOnly: true, title: 'a red fox', locations: undefined });
    expect(render(<ToolCallView tool={{ ...gen, media: [stored] }} />).container.innerHTML).toBe(render(<ToolCallView tool={gen} />).container.innerHTML);
  });

  it('keeps grouping read calls with images unless media is visible', () => {
    const tools = [tool({ id: 'a', media: [stored] }), tool({ id: 'b', toolKind: 'search' })];
    const state = { items: tools, subagents: {}, capabilities: null };
    expect(buildStreamBlocks(state).map((b) => b.type)).toEqual(['explore']);
    expect(buildStreamBlocks(state, { mediaVisible: true }).map((b) => b.type)).toEqual(['item', 'item']);
  });
});

describe('rich chat content on', () => {
  it('shows a stored image as a thumbnail <img> from a data: URL', async () => {
    render(withMedia(<ToolCallView tool={tool({ media: [stored] })} />));
    const thumb = await screen.findByTestId('chat-image-thumb');
    const img = await waitFor(() => { const el = thumb.querySelector('img'); expect(el).not.toBeNull(); return el!; });
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(readMedia).toHaveBeenCalledWith('agent-1', REF);
    // The space is reserved from the header size: 240 x 180 for 800 x 600.
    expect(thumb.style.width).toBe('240px');
    expect(thumb.style.height).toBe('180px');
  });

  it('renders SVG only as an <img>, never as markup', async () => {
    const { container } = render(withMedia(<ToolCallView tool={tool({ media: [{ type: 'image', mimeType: 'image/svg+xml', mediaRef: SVG_REF }] })} />));
    const thumb = await screen.findByTestId('chat-image-thumb');
    const img = await waitFor(() => { const el = thumb.querySelector('img'); expect(el).not.toBeNull(); return el!; });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('alert(1)');
    expect(thumb.querySelector('svg')).toBeNull();
  });

  it('opens the viewer with zoom, copy and reveal', async () => {
    render(withMedia(<ToolCallView tool={tool({ media: [stored] })} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Open image' }));
    const full = await screen.findByTestId('chat-image-full');
    await waitFor(() => expect(full.getAttribute('src')).toMatch(/^data:image\/png;base64,/));
    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(mediaAction).toHaveBeenCalledWith('agent-1', REF, 'copy'));
    expect(await screen.findByText('Copied')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Show in|Open in/ }));
    await waitFor(() => expect(mediaAction).toHaveBeenCalledWith('agent-1', REF, 'reveal'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('chat-image-full')).toBeNull());
  });

  it('offers no Copy for SVG', async () => {
    render(withMedia(<ToolCallView tool={tool({ media: [{ type: 'image', mimeType: 'image/svg+xml', mediaRef: SVG_REF }] })} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Open image' }));
    await screen.findByTestId('chat-image-full');
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('opens an image with no thumbnail (a large SVG) from a View image button', async () => {
    const big = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(300 * 1024)}</svg>`);
    readMedia.mockImplementation(async () => ({ mimeType: 'image/svg+xml', data: big }));
    render(withMedia(<ToolCallView tool={tool({ media: [{ type: 'image', mimeType: 'image/svg+xml', mediaRef: SVG_REF }] })} />));
    fireEvent.click(await screen.findByTestId('chat-image-view'));
    const full = await screen.findByTestId('chat-image-full');
    expect(full.tagName).toBe('IMG');
    expect(full.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('says so when a stored image is gone', async () => {
    readMedia.mockRejectedValue(new Error('ENOENT'));
    render(withMedia(<ToolCallView tool={tool({ media: [stored] })} />));
    expect(await screen.findByTestId('chat-image-unavailable')).toBeTruthy();
  });

  it('never fetches a remote image until the user clicks Load image', async () => {
    render(withMedia(<ToolCallView tool={tool({ media: [{ type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' }] })} />));
    const button = screen.getByRole('button', { name: /Load image/ });
    expect(button.textContent).toContain('example.com');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(fetchRemoteImage).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(fetchRemoteImage).toHaveBeenCalledWith('https://example.com/a.png'));
    const thumb = await screen.findByTestId('chat-image-thumb');
    expect(thumb.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('shows why a remote image would not load', async () => {
    fetchRemoteImage.mockRejectedValue(new Error("Error invoking remote method 'chat:fetch-remote-image': Error: Images from this address are not loaded"));
    render(withMedia(<ToolCallView tool={tool({ media: [{ type: 'image', mimeType: 'image/png', uri: 'http://10.0.0.1/a.png' }] })} />));
    fireEvent.click(screen.getByRole('button', { name: /Load image/ }));
    expect(await screen.findByText('Images from this address are not loaded')).toBeTruthy();
  });

  it('labels a media-only call as an image', () => {
    render(withMedia(<ToolCallView tool={tool({ toolKind: 'other', toolName: 'imageGeneration', mediaOnly: true, title: 'a red fox', locations: undefined })} />));
    expect(screen.getByText('Image')).toBeTruthy();
  });
});

describe('chat store media', () => {
  const env = <T extends 'tool_call' | 'tool_call_update'>(seq: number, type: T, data: ChatEventDataMap[T]): ChatEvent =>
    ({ v: CHAT_CONTRACT_VERSION, agentId: 'a', sessionId: 's', seq, ts: seq, type, data }) as ChatEvent;

  it('adds images from updates once each', () => {
    const second: ChatImage = { type: 'image', mimeType: 'image/png', mediaRef: `${'ef'.repeat(32)}.png` };
    const state = foldChatEvents(undefined, 'a', [
      env(1, 'tool_call', { toolCallId: 't', kind: 'read', title: 'x', status: 'pending', media: [stored] }),
      env(2, 'tool_call_update', { toolCallId: 't', status: 'completed', media: [stored, second] }),
      env(3, 'tool_call_update', { toolCallId: 't', content: [{ type: 'text', text: 'ok' }] }),
    ]);
    const item = state.items.find((i) => i.kind === 'tool_call') as ToolCallItem;
    expect(item.media).toEqual([stored, second]);
    expect(item.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('leaves items without images as they were', () => {
    const state = foldChatEvents(undefined, 'a', [env(1, 'tool_call', { toolCallId: 't', kind: 'read', title: 'x', status: 'completed' })]);
    expect(state.items[0]).not.toHaveProperty('media');
  });
});
