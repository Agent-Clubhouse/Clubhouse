import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderMarkdownSafe } from '../../../../utils/safe-markdown';
import { Markdown } from '../MessageBlocks';
import { clearLoadedImages, isLocalImageSrc, renderChatMarkdown, rewriteMarkdownImages } from './markdown-images';
import { resetRichChatContentFlag } from './rich-flag';
import { ChatMediaContext } from './ChatImages';
import { clearMediaCache } from './media';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TEXT = 'See ![chart](https://example.com/chart.png), ![local](/Users/me/secret.png) and ![inline](data:image/png;base64,iVBORw0KGgo=).';

let flags: Record<string, boolean> = {};
const fetchRemoteImage = vi.fn();
const importLocalImage = vi.fn();
const readMedia = vi.fn();
const MEDIA_REF = `${'a'.repeat(64)}.png`;

beforeEach(() => {
  flags = {};
  resetRichChatContentFlag();
  clearLoadedImages();
  clearMediaCache();
  vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockImplementation(async () => flags);
  fetchRemoteImage.mockReset().mockResolvedValue({ mimeType: 'image/png', data: PNG });
  importLocalImage.mockReset().mockResolvedValue({ ok: true, mediaRef: MEDIA_REF, mimeType: 'image/png', width: 10, height: 10 });
  readMedia.mockReset().mockResolvedValue({ mimeType: 'image/png', data: PNG });
  Object.assign(window.clubhouse.chat, { fetchRemoteImage, importLocalImage, readMedia });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRichChatContentFlag();
});

describe('rewriteMarkdownImages', () => {
  it('leaves HTML without images untouched', () => {
    const html = renderMarkdownSafe('Plain **text** with [a link](https://example.com)');
    expect(rewriteMarkdownImages(html)).toBe(html);
  });

  it('turns web images into a Load image button, local ones into placeholders, and keeps data: images', () => {
    const out = rewriteMarkdownImages(renderMarkdownSafe(TEXT));
    const root = document.createElement('div');
    root.innerHTML = out;
    const imgs = [...root.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,iVBORw0KGgo=']);
    const button = root.querySelector('button[data-chat-remote-image]')!;
    expect(button.getAttribute('data-chat-remote-image')).toBe('https://example.com/chart.png');
    expect(button.textContent).toBe('Load imageexample.com');
    expect(root.querySelector('[data-chat-local-image]')!.getAttribute('data-chat-local-image')).toBe('/Users/me/secret.png');
    expect(root.textContent).toContain('local');
  });
});

describe('renderChatMarkdown', () => {
  const sources = (md: string) => {
    const root = document.createElement('div');
    root.innerHTML = renderChatMarkdown(md);
    // No <img> ever points at a local file.
    for (const img of root.querySelectorAll('img')) expect(img.getAttribute('src')).toMatch(/^data:image\//);
    return [...root.querySelectorAll('[data-chat-local-image]')].map((el) => el.getAttribute('data-chat-local-image'));
  };

  it('keeps local sources the sanitizer would drop: absolute, relative, file: URLs, drive letters, encoded spaces', () => {
    expect(sources('![a](/Users/me/a.png) ![b](./assets/icon.png) ![c](file:///Users/me/a%20b.png) ![d](C:\\x\\y.png) ![e](<./my shot.png>) ![f](./my%20shot.png)'))
      .toEqual(['/Users/me/a.png', './assets/icon.png', 'file:///Users/me/a%20b.png', 'C:\\x\\y.png', './my shot.png', './my%20shot.png']);
  });

  it('says other schemes are not shown, and a marker written in the text maps to nothing', () => {
    const root = document.createElement('div');
    root.innerHTML = renderChatMarkdown('![x](javascript:alert(1)) ![y](blob:abc) ![z](#chat-local-image-zzzz-0)');
    expect(root.querySelector('[data-chat-local-image]')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelectorAll('.chat-image-not-shown')).toHaveLength(3);
    expect(root.textContent).toContain('Image not shown.');
  });

  it('tells local sources from others', () => {
    for (const src of ['/a.png', './a.png', 'a.png', '~/a.png', 'file:///a.png', 'C:/a.png', 'C:\\a.png']) expect(isLocalImageSrc(src)).toBe(true);
    for (const src of ['', '#x', '//host/a.png', '\\\\host\\a.png', 'https://x/a.png', 'data:image/png;base64,x', 'blob:x', 'javascript:x']) expect(isLocalImageSrc(src)).toBe(false);
  });
});

describe('Markdown images', () => {
  it('with rich chat content off, renders exactly the sanitized markdown', async () => {
    const { container } = render(<Markdown text={TEXT} />);
    await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
    expect(container.firstElementChild!.innerHTML).toBe(renderMarkdownSafe(TEXT));
  });

  it('with it on, loads a web image only when its button is clicked', async () => {
    flags = { richChatContent: true };
    const { container } = render(<Markdown text={TEXT} />);
    const button = await screen.findByRole('button', { name: /Load image/ });
    expect(container.querySelector('img[src^="https:"]')).toBeNull();
    expect(fetchRemoteImage).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(fetchRemoteImage).toHaveBeenCalledWith('https://example.com/chart.png'));
    await waitFor(() => expect(container.querySelectorAll('img[src^="data:image/png"]')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
  });

  it('shows why a web image would not load', async () => {
    flags = { richChatContent: true };
    fetchRemoteImage.mockRejectedValue(new Error('Images from this address are not loaded'));
    render(<Markdown text="![x](http://10.0.0.1/a.png)" />);
    fireEvent.click(await screen.findByRole('button', { name: /Load image/ }));
    expect(await screen.findByText('Images from this address are not loaded')).toBeTruthy();
  });
});

describe('Markdown local images (#2422)', () => {
  const withAgent = (ui: React.ReactElement) => render(<ChatMediaContext.Provider value="a1">{ui}</ChatMediaContext.Provider>);

  it('stores a local image through main and shows its thumbnail, never the path, and opens the viewer on click', async () => {
    flags = { richChatContent: true };
    const { container } = withAgent(<Markdown text="![Screenshot](./assets/icon.png)" />);
    const thumb = await screen.findByRole('button', { name: 'Open image: Screenshot' });
    expect(importLocalImage).toHaveBeenCalledWith('a1', './assets/icon.png');
    expect(readMedia).toHaveBeenCalledWith('a1', MEDIA_REF);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toMatch(/^data:image\/png/);
    expect(container.innerHTML).not.toContain('src="./assets');
    fireEvent.click(thumb);
    expect(await screen.findByTestId('chat-image-viewer')).toBeTruthy();
  });

  it.each([
    ['outside', "Image not shown. It's outside the project."],
    ['missing', 'Image not found.'],
    ['unsupported', 'Not an image chat can show.'],
    ['too-large', 'Image too large to show.'],
  ] as const)('explains a %s image instead of a bare caption', async (reason, text) => {
    flags = { richChatContent: true };
    importLocalImage.mockResolvedValue({ ok: false, reason });
    const { container } = withAgent(<Markdown text="![Screenshot](/Users/me/Desktop/shot.png)" />);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText('Screenshot')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('says it could not load the image when main fails', async () => {
    flags = { richChatContent: true };
    importLocalImage.mockRejectedValue(new Error('boom'));
    withAgent(<Markdown text="![a](file:///Users/me/a%20b.png)" />);
    expect(await screen.findByText("Couldn't load the image.")).toBeTruthy();
    expect(importLocalImage).toHaveBeenCalledWith('a1', 'file:///Users/me/a%20b.png');
  });

  it('waits for a streaming message to finish before asking main', async () => {
    flags = { richChatContent: true };
    const { rerender } = withAgent(<Markdown text="![a](./a.png)" streaming />);
    expect(await screen.findByText('Loading image…')).toBeTruthy();
    expect(importLocalImage).not.toHaveBeenCalled();
    rerender(<ChatMediaContext.Provider value="a1"><Markdown text="![a](./a.png)" /></ChatMediaContext.Provider>);
    await waitFor(() => expect(importLocalImage).toHaveBeenCalledWith('a1', './a.png'));
  });

  it('with rich chat content off, asks main nothing', async () => {
    const { container } = withAgent(<Markdown text="![a](./a.png)" />);
    await waitFor(() => expect(window.clubhouse.app.getExperimentalSettings).toHaveBeenCalled());
    expect(container.firstElementChild!.innerHTML).toBe(renderMarkdownSafe('![a](./a.png)'));
    expect(importLocalImage).not.toHaveBeenCalled();
  });
});
