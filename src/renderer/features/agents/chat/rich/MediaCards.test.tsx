import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatFileInfo, ChatFilePreview } from '../../../../../shared/chat';
import { useAgentStore } from '../../../../stores/agentStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { Markdown } from '../MessageBlocks';
import { RichLinkProvider } from './RichLinks';
import { FileChipProvider, clearFileChipCache } from './FileChips';
import { resetRichChatContentFlag } from './rich-flag';
import { clearMediaCardCaches, formatDuration, savedPosition } from './media-cards';

vi.mock('../../../../plugins/builtin/canvas/ReadOnlyMonacoEditor', () => ({
  ReadOnlyMonacoEditor: ({ value }: { value: string }) => <pre data-testid="monaco">{value}</pre>,
}));

const loadMediaMeta = vi.hoisted(() => vi.fn());
vi.mock('./media-cards', async (original) => ({ ...(await original<typeof import('./media-cards')>()), loadMediaMeta }));

const FILES: Record<string, ChatFileInfo> = {
  'out/talk.wav': { path: 'out/talk.wav', exists: true, kind: 'audio', size: 4, name: 'talk.wav' },
  'out/song.mp3': { path: 'out/song.mp3', exists: true, kind: 'audio', size: 4, name: 'song.mp3' },
  'out/demo.webm': { path: 'out/demo.webm', exists: true, kind: 'video', size: 4, name: 'demo.webm' },
  'out/huge.mp4': { path: 'out/huge.mp4', exists: true, kind: 'video', size: 4, name: 'huge.mp4' },
  'out/gone.wav': { path: 'out/gone.wav', exists: true, kind: 'audio', size: 4, name: 'gone.wav' },
};

const statPaths = vi.fn(async (_agent: string, paths: string[]) => paths.map((p) => FILES[p] ?? { path: p, exists: false }));
const readFilePreview = vi.fn(async (_agent: string, p: string): Promise<ChatFilePreview> => {
  if (p === 'out/huge.mp4') return { kind: 'video', name: 'huge.mp4', size: 99e6, tooLarge: true };
  if (p === 'out/gone.wav') throw new Error('gone');
  const kind = FILES[p].kind as 'audio' | 'video';
  return { kind, name: FILES[p].name!, size: 4, mimeType: kind === 'audio' ? 'audio/wav' : 'video/webm', data: new Uint8Array([1, 2, 3, 4]) };
});
const fileAction = vi.fn(async () => null);

// jsdom has no media playback: a minimal stand-in that tracks play/pause and fires their events.
const playing = new WeakSet<HTMLMediaElement>();
const times = new WeakMap<HTMLMediaElement, number>();
const play = vi.fn(function (this: HTMLMediaElement) {
  playing.add(this);
  this.dispatchEvent(new Event('play'));
  return Promise.resolve();
});
const pause = vi.fn(function (this: HTMLMediaElement) {
  if (!playing.has(this)) return;
  playing.delete(this);
  this.dispatchEvent(new Event('pause'));
});
const proto = HTMLMediaElement.prototype;
const saved = {
  play: Object.getOwnPropertyDescriptor(proto, 'play')!,
  pause: Object.getOwnPropertyDescriptor(proto, 'pause')!,
  load: Object.getOwnPropertyDescriptor(proto, 'load')!,
  paused: Object.getOwnPropertyDescriptor(proto, 'paused')!,
  currentTime: Object.getOwnPropertyDescriptor(proto, 'currentTime')!,
};

function setFlag(on: boolean) {
  window.clubhouse.app.getExperimentalSettings = vi.fn(async () => (on ? { richChatContent: true } : {}));
}

async function settle() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

async function renderRich(text: string, agentId: string | null = 'a1') {
  const r = render(<RichLinkProvider agentId="a1"><FileChipProvider agentId={agentId}><Markdown text={text} /></FileChipProvider></RichLinkProvider>);
  await settle();
  return r;
}

function cards(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-chat-media]')];
}

beforeEach(() => {
  resetRichChatContentFlag();
  clearFileChipCache();
  clearMediaCardCaches();
  statPaths.mockClear();
  readFilePreview.mockClear();
  play.mockClear();
  pause.mockClear();
  loadMediaMeta.mockReset();
  loadMediaMeta.mockResolvedValue({});
  Object.assign(window.clubhouse.chat, { statPaths, readFilePreview, fileAction });
  window.clubhouse.git.githubRepo = vi.fn(async () => null);
  useAgentStore.setState({ agents: { a1: { id: 'a1', projectId: 'p1', name: 'a', kind: 'durable', status: 'running', color: 'indigo' } as never } });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'proj', path: '/repo' } as never] });
  Object.defineProperty(proto, 'play', { configurable: true, value: play });
  Object.defineProperty(proto, 'pause', { configurable: true, value: pause });
  Object.defineProperty(proto, 'load', { configurable: true, value: vi.fn() });
  Object.defineProperty(proto, 'paused', { configurable: true, get(this: HTMLMediaElement) { return !playing.has(this); } });
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) { return times.get(this) ?? 0; },
    set(this: HTMLMediaElement, v: number) { times.set(this, v); },
  });
});

afterEach(() => {
  cleanup();
  for (const [k, d] of Object.entries(saved)) Object.defineProperty(proto, k, d);
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe('formatDuration', () => {
  it('reads like a player clock', () => {
    expect(formatDuration(7.9)).toBe('0:07');
    expect(formatDuration(205)).toBe('3:25');
    expect(formatDuration(3729)).toBe('1:02:09');
    expect(formatDuration(Infinity)).toBe('');
    expect(formatDuration(undefined)).toBe('');
  });
});

describe('media cards off', () => {
  it('leaves media paths as text with the flag off', async () => {
    setFlag(false);
    const { container } = await renderRich('Here is the recording: out/talk.wav', null);
    expect(cards(container)).toHaveLength(0);
    expect(statPaths).not.toHaveBeenCalled();
    expect(container.textContent).toContain('out/talk.wav');
  });
});

describe('media cards on', () => {
  beforeEach(() => setFlag(true));

  it('gives returned media a card and leaves mentions in prose as chips', async () => {
    const md = [
      'Here is the recording: out/talk.wav',
      '',
      '`out/demo.webm`',
      '',
      'I converted out/song.mp3 to a smaller file before trimming it.',
    ].join('\n');
    const { container } = await renderRich(md);
    await waitFor(() => expect(cards(container)).toHaveLength(2));
    expect(cards(container).map((c) => c.getAttribute('data-chat-media'))).toEqual(['audio', 'video']);
    // The mention in a sentence stays a chip.
    expect(container.querySelector('[data-chat-path="out/song.mp3"][data-chat-file="audio"]')).not.toBeNull();
    // A path alone on its line is replaced by its card; a captioned one keeps its caption.
    expect((container.querySelector('code[data-chat-path="out/demo.webm"]')!.closest('p') as HTMLElement).hidden).toBe(true);
    expect((container.querySelector('[data-chat-path="out/talk.wav"]')!.closest('p') as HTMLElement).hidden).toBe(false);
    // Nothing plays, or loads, until asked (no IntersectionObserver here).
    expect(play).not.toHaveBeenCalled();
    expect(loadMediaMeta).not.toHaveBeenCalled();
    expect(readFilePreview).not.toHaveBeenCalled();
    expect(container.querySelector('audio, video')).toBeNull();
  });

  it('plays audio inline on Play, and closing collapses it and keeps where it stopped', async () => {
    const { container } = await renderRich('out/talk.wav');
    fireEvent.click(await screen.findByRole('button', { name: 'Play talk.wav' }));
    const audio = await waitFor(() => { const el = container.querySelector('audio'); expect(el).not.toBeNull(); return el!; });
    expect(readFilePreview).toHaveBeenCalledWith('a1', 'out/talk.wav');
    expect(audio.getAttribute('src')).toMatch(/^data:audio\/wav;base64,/);
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.hasAttribute('autoplay')).toBe(false);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(audio.paused).toBe(false);

    audio.currentTime = 42;
    fireEvent.click(screen.getByRole('button', { name: 'Close the player for talk.wav' }));
    expect(pause).toHaveBeenCalled();
    expect(container.querySelector('audio')).toBeNull();
    expect(savedPosition('a1', 'out/talk.wav')).toBe(42);
    expect(screen.getByRole('button', { name: 'Resume talk.wav from 0:42' })).toBeTruthy();
  });

  it('plays one chat player at a time', async () => {
    const { container } = await renderRich('- out/talk.wav\n- out/song.mp3');
    await waitFor(() => expect(cards(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Play talk.wav' }));
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(1));
    const first = container.querySelector('audio')!;
    await waitFor(() => expect(first.paused).toBe(false));
    first.currentTime = 9;
    fireEvent.click(screen.getByRole('button', { name: 'Play song.mp3' }));
    // The first pauses and closes, letting its source go; the second plays.
    await waitFor(() => expect(first.paused).toBe(true));
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(1));
    expect(first.hasAttribute('src')).toBe(false);
    const second = container.querySelector('audio')!;
    expect(second.getAttribute('aria-label')).toBe('song.mp3');
    expect(second.paused).toBe(false);
    expect(screen.getByRole('button', { name: 'Resume talk.wav from 0:09' })).toBeTruthy();
  });

  it('moves focus into the player on Play and back to Play on Close, and a double-click loads once', async () => {
    const { container } = await renderRich('out/talk.wav');
    const playButton = await screen.findByRole('button', { name: 'Play talk.wav' });
    playButton.focus();
    fireEvent.click(playButton);
    fireEvent.click(playButton);
    const audio = await waitFor(() => { const el = container.querySelector('audio'); expect(el).not.toBeNull(); return el!; });
    expect(readFilePreview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(audio));
    fireEvent.click(screen.getByRole('button', { name: 'Close the player for talk.wav' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play talk.wav' })));
  });

  it('pauses and remembers the position when the message unmounts, and resumes there', async () => {
    const r = await renderRich('out/talk.wav');
    fireEvent.click(await screen.findByRole('button', { name: 'Play talk.wav' }));
    const audio = await waitFor(() => { const el = r.container.querySelector('audio'); expect(el).not.toBeNull(); return el!; });
    await waitFor(() => expect(audio.paused).toBe(false));
    audio.currentTime = 75;
    r.unmount();
    expect(audio.paused).toBe(true);
    expect(audio.hasAttribute('src')).toBe(false);
    expect(savedPosition('a1', 'out/talk.wav')).toBe(75);

    const again = await renderRich('out/talk.wav');
    fireEvent.click(await screen.findByRole('button', { name: 'Resume talk.wav from 1:15' }));
    const resumed = await waitFor(() => { const el = again.container.querySelector('audio'); expect(el).not.toBeNull(); return el!; });
    Object.defineProperty(resumed, 'duration', { configurable: true, value: 120 });
    fireEvent.loadedMetadata(resumed);
    expect(resumed.currentTime).toBe(75);
  });

  it('shows a video poster and duration once near the viewport, then plays inline with full screen and preview', async () => {
    const observe = vi.fn();
    let fire: (() => void) | undefined;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = (class {
      constructor(cb: IntersectionObserverCallback) { fire = () => cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never); }
      observe = observe;
      disconnect() { /* nothing to release */ }
    });
    loadMediaMeta.mockResolvedValue({ duration: 65, poster: 'data:image/webp;base64,AA', aspect: 4 / 3 });
    const { container } = await renderRich('Here is the demo: out/demo.webm');
    await waitFor(() => expect(observe).toHaveBeenCalled());
    expect(loadMediaMeta).not.toHaveBeenCalled();
    await act(async () => { fire!(); });
    await waitFor(() => expect(screen.getByTestId('chat-media-duration').textContent).toBe('1:05'));
    expect(loadMediaMeta).toHaveBeenCalledWith('a1', 'out/demo.webm', 'video', 4, expect.any(Function));
    expect(screen.getByTestId('chat-media-poster').getAttribute('src')).toBe('data:image/webp;base64,AA');

    fireEvent.click(screen.getByRole('button', { name: 'Play demo.webm' }));
    const video = await waitFor(() => { const el = container.querySelector('video'); expect(el).not.toBeNull(); return el!; });
    // The player keeps the video's shape, so it doesn't resize as it loads.
    expect(video.parentElement!.style.getPropertyValue('--chat-media-aspect')).toBe(String(4 / 3));
    expect(screen.getByRole('button', { name: 'Play demo.webm full screen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open preview of demo.webm' }));
    expect(await screen.findByTestId('chat-file-preview')).toBeTruthy();
  });

  it('fits a narrow pane: cards shrink to the column and names truncate', async () => {
    const { container } = await renderRich('out/demo.webm\n\nout/talk.wav');
    await waitFor(() => expect(cards(container)).toHaveLength(2));
    const [video, audio] = cards(container);
    expect(video.className).toContain('max-w-full');
    expect(video.className).toContain('min-w-0');
    expect(audio.className).toContain('w-full');
    expect(audio.className).toContain('min-w-0');
    for (const card of [video, audio]) expect(card.querySelector('[title^="out/"]')!.className).toContain('truncate');
    // The poster's space is reserved before it loads.
    expect(video.querySelector('button')!.className).toContain('aspect-video');
  });

  it('says when a file is too large or fails to play, with the preview as the way out', async () => {
    const { container } = await renderRich('out/huge.mp4\n\nout/gone.wav');
    await waitFor(() => expect(cards(container)).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Play huge.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play gone.wav' }));
    await waitFor(() => expect(screen.getAllByTestId('chat-media-status')).toHaveLength(2));
    const [large, failed] = screen.getAllByTestId('chat-media-status');
    expect(large.textContent).toContain('Too large to play here.');
    expect(failed.textContent).toContain("Couldn't play this file.");
    expect(container.querySelector('audio, video')).toBeNull();
    fireEvent.click(large.querySelector('button')!);
    expect(await screen.findByTestId('chat-file-preview')).toBeTruthy();
  });
});

describe('loadMediaMeta', () => {
  it('skips a queued load whose card has gone, and asks again next time', async () => {
    const { loadMediaMeta: real } = await vi.importActual<typeof import('./media-cards')>('./media-cards');
    Object.assign(window.clubhouse.chat, { readFilePreview });
    readFilePreview.mockClear();
    const skipped = await real('a1', 'out/huge.mp4', 'video', 4, () => false);
    expect(skipped.failed).toBe(true);
    expect(readFilePreview).not.toHaveBeenCalled();
    const loaded = await real('a1', 'out/huge.mp4', 'video', 4);
    expect(loaded).toEqual({ tooLarge: true });
    expect(readFilePreview).toHaveBeenCalledTimes(1);
    // Cached once it succeeded.
    await real('a1', 'out/huge.mp4', 'video', 4);
    expect(readFilePreview).toHaveBeenCalledTimes(1);
  });
});
