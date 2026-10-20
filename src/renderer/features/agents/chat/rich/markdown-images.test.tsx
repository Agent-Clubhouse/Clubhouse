import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderMarkdownSafe } from '../../../../utils/safe-markdown';
import { Markdown } from '../MessageBlocks';
import { clearLoadedImages, rewriteMarkdownImages } from './markdown-images';
import { resetRichChatContentFlag } from './rich-flag';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TEXT = 'See ![chart](https://example.com/chart.png), ![local](/Users/me/secret.png) and ![inline](data:image/png;base64,iVBORw0KGgo=).';

let flags: Record<string, boolean> = {};
const fetchRemoteImage = vi.fn();

beforeEach(() => {
  flags = {};
  resetRichChatContentFlag();
  clearLoadedImages();
  vi.spyOn(window.clubhouse.app, 'getExperimentalSettings').mockImplementation(async () => flags);
  fetchRemoteImage.mockReset().mockResolvedValue({ mimeType: 'image/png', data: PNG });
  Object.assign(window.clubhouse.chat, { fetchRemoteImage });
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

  it('turns web images into a Load image button, local ones into text, and keeps data: images', () => {
    const out = rewriteMarkdownImages(renderMarkdownSafe(TEXT));
    const root = document.createElement('div');
    root.innerHTML = out;
    const imgs = [...root.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,iVBORw0KGgo=']);
    const button = root.querySelector('button[data-chat-remote-image]')!;
    expect(button.getAttribute('data-chat-remote-image')).toBe('https://example.com/chart.png');
    expect(button.textContent).toBe('Load imageexample.com');
    expect(root.textContent).toContain('local');
    expect(out).not.toContain('/Users/me/secret.png');
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
