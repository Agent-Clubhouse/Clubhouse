/**
 * Inline audio and video cards in chat (experimental rich chat content,
 * #2425). Audio is a compact row with Play that grows the player's controls
 * while it plays; video is a poster with a play overlay and its duration that
 * opens an inline player with picture-in-picture and fullscreen. Nothing
 * loads until the card is near the viewport and nothing plays until asked.
 * The file preview popover stays reachable from every card.
 *
 * Unmounting a card (its message scrolled out of the window, the transcript
 * closed) pauses it, keeps where it stopped and frees the source; playing it
 * again resumes there. Only one chat player plays at a time.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Button } from '../../../../components/Button';
import { AudioIcon, FullscreenIcon, PlayIcon, PopOutIcon, PreviewIcon, VideoIcon, XIcon } from '../icons';
import { useOpenFilePreview } from './FileChips';
import {
  formatDuration,
  installSinglePlayback,
  MEDIA_SUPERSEDED,
  loadMediaMeta,
  loadMediaSource,
  placeMediaCards,
  savePosition,
  savedPosition,
  type MediaCardHost,
  type MediaMeta,
} from './media-cards';

/** Start loading metadata this far before the card scrolls into view. */
const NEAR_VIEWPORT = '300px';

type Playback =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'open'; src: string }
  | { state: 'too-large' }
  | { state: 'error' };

/** Metadata once the card is near the viewport. Without IntersectionObserver it waits for Play. */
function useLazyMeta(card: MediaCardHost, agentId: string, el: React.RefObject<HTMLElement | null>): MediaMeta | undefined {
  const [meta, setMeta] = useState<MediaMeta | undefined>(undefined);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof IntersectionObserver !== 'function') return;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      // Skipped if the card is gone before its turn in the queue (scrolled past quickly).
      void loadMediaMeta(agentId, card.path, card.kind, card.size, () => !cancelled).then((m) => { if (!cancelled) setMeta(m); });
    }, { rootMargin: NEAR_VIEWPORT });
    io.observe(node);
    return () => { cancelled = true; io.disconnect(); };
  }, [agentId, card.path, card.kind, card.size, el]);
  return meta;
}

function Status({ playback, meta, onPreview }: { playback: Playback; meta?: MediaMeta; onPreview: (e: React.MouseEvent<HTMLElement>) => void }) {
  const tooLarge = playback.state === 'too-large' || (playback.state === 'idle' && meta?.tooLarge);
  if (!tooLarge && playback.state !== 'error') return null;
  return (
    <div className="flex items-center gap-2 text-[12px] text-ctp-subtext0 min-w-0" role="status" data-testid="chat-media-status">
      <span className="min-w-0">{tooLarge ? 'Too large to play here.' : "Couldn't play this file."}</span>
      <button type="button" className="text-ctp-accent hover:underline flex-shrink-0" onClick={onPreview}>Open preview</button>
    </div>
  );
}

export function MediaCard({ card, agentId }: { card: MediaCardHost; agentId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  const meta = useLazyMeta(card, agentId, root);
  const [playback, setPlayback] = useState<Playback>({ state: 'idle' });
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [resumeAt, setResumeAt] = useState<number | undefined>(() => savedPosition(agentId, card.path));
  const openPreview = useOpenFilePreview();
  const alive = useRef(true);
  const loading = useRef(false);
  const playButton = useRef<HTMLButtonElement>(null);
  /** Where keyboard focus goes after the next render: the opened player, or Play once it closes. */
  const focusNext = useRef<'player' | 'play' | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const shownDuration = formatDuration(duration ?? meta?.duration);
  const group = { role: 'group', 'aria-label': `${card.kind === 'audio' ? 'Audio' : 'Video'}: ${card.name}` };
  const Icon = card.kind === 'audio' ? AudioIcon : VideoIcon;

  const play = async () => {
    // A ref, not state: a double-click lands before the re-render that disables Play.
    if (loading.current || playback.state === 'open') return;
    loading.current = true;
    // Asked now: by the time the source loads, focus may have moved on (or the button been disabled).
    const keyboard = !!root.current?.contains(document.activeElement);
    setPlayback({ state: 'loading' });
    const source = await loadMediaSource(agentId, card.path);
    loading.current = false;
    if (!alive.current) return;
    if (source.status === 'ok' && keyboard && (document.activeElement === document.body || root.current?.contains(document.activeElement))) focusNext.current = 'player';
    setPlayback(source.status === 'ok' ? { state: 'open', src: source.src } : { state: source.status });
  };

  /** Pause, remember where, and let the source go. */
  const release = useCallback(() => {
    const el = player.current;
    if (!el) return;
    el.pause();
    const at = el.ended ? undefined : el.currentTime;
    savePosition(agentId, card.path, at);
    setResumeAt(at !== undefined && at > 0.5 ? at : undefined);
    el.removeAttribute('src');
    try { el.load(); } catch { /* telemetry-exempt: freeing the buffer is best-effort. */ }
  }, [agentId, card.path]);

  const close = (refocus = true) => {
    if (refocus && root.current?.contains(document.activeElement)) focusNext.current = 'play';
    release();
    setPlayback({ state: 'idle' });
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const target = focusNext.current === 'player' ? player.current : focusNext.current === 'play' ? playButton.current : null;
    focusNext.current = null;
    target?.focus();
  });
  // Scrolled out of the transcript's window, or the transcript closed. A layout
  // cleanup runs before React detaches the player's ref.
  useLayoutEffect(() => () => release(), [release]);

  const attach = useCallback((el: HTMLMediaElement | null) => { player.current = el; }, []);
  const src = playback.state === 'open' ? playback.src : null;
  useEffect(() => {
    const el = player.current;
    if (!src || !el) return;
    // Another chat player started: this one closes, so its source doesn't stay in memory.
    const superseded = () => closeRef.current(false);
    el.addEventListener(MEDIA_SUPERSEDED, superseded);
    // Started by the Play click; never on load.
    const started = el.play();
    // telemetry-exempt: if the runtime refuses, the controls are there to start it.
    if (started && typeof started.catch === 'function') started.catch((): undefined => undefined);
    return () => el.removeEventListener(MEDIA_SUPERSEDED, superseded);
  }, [src]);

  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const el = e.currentTarget;
    if (Number.isFinite(el.duration)) setDuration(el.duration);
    const at = savedPosition(agentId, card.path);
    if (at !== undefined && Number.isFinite(el.duration) && at < el.duration - 1) el.currentTime = at;
  };
  const mediaEvents = {
    onLoadedMetadata,
    onEnded: () => { savePosition(agentId, card.path, undefined); setResumeAt(undefined); },
    onError: () => { if (player.current?.getAttribute('src')) setPlayback({ state: 'error' }); },
  };
  const preview = (e: React.MouseEvent<HTMLElement>) => openPreview?.(card.path, card.kind, e.currentTarget);
  const previewButton = openPreview && (
    <Button kind="quiet" icon={<PreviewIcon />} aria-label={`Open preview of ${card.name}`} title="Open preview" onClick={preview} />
  );
  const playLabel = resumeAt !== undefined ? `Resume ${card.name} from ${formatDuration(resumeAt)}` : `Play ${card.name}`;

  if (card.kind === 'audio') {
    const open = playback.state === 'open';
    return (
      <div
        ref={root}
        data-chat-media="audio"
        {...group}
        data-state={playback.state}
        className="chat-media-card my-1.5 w-full max-w-[440px] min-w-0 rounded-lg border border-surface-1 bg-ctp-mantle"
      >
        <div className="flex items-center gap-2 h-11 pl-2 pr-1.5 min-w-0">
          {open ? (
            <span className="w-7 h-7 flex items-center justify-center text-ctp-overlay1 flex-shrink-0"><Icon /></span>
          ) : (
            <button
              ref={playButton}
              type="button"
              onClick={() => void play()}
              aria-busy={playback.state === 'loading'}
              aria-label={playLabel}
              title={playLabel}
              className="w-7 h-7 rounded-full bg-surface-1 text-ctp-text flex items-center justify-center flex-shrink-0 hover:bg-surface-2 aria-busy:opacity-60"
            >
              <PlayIcon size={12} />
            </button>
          )}
          {!open && <Icon className="text-ctp-overlay1" />}
          <span className="truncate min-w-0 text-[12.5px] text-ctp-text" title={card.path}>{card.name}</span>
          <span className="ml-auto flex items-center gap-1 flex-shrink-0">
            {playback.state === 'loading' && <span className="text-[11.5px] text-ctp-overlay1" role="status">Loading…</span>}
            {playback.state !== 'loading' && resumeAt !== undefined && !open && <span className="text-[11.5px] text-ctp-overlay1 tabular-nums">{formatDuration(resumeAt)} /</span>}
            {shownDuration && playback.state !== 'loading' && <span className="text-[11.5px] text-ctp-overlay1 tabular-nums" data-testid="chat-media-duration">{shownDuration}</span>}
            {previewButton}
            {open && <Button kind="quiet" icon={<XIcon />} aria-label={`Close the player for ${card.name}`} title="Close" onClick={() => close()} />}
          </span>
        </div>
        {open && (
          <div className="px-2 pb-2">
            <audio ref={attach} src={src ?? undefined} controls tabIndex={0} preload="metadata" className="w-full h-9" aria-label={card.name} {...mediaEvents} />
          </div>
        )}
        {(playback.state === 'error' || playback.state === 'too-large' || meta?.tooLarge) && (
          <div className="px-2.5 pb-2"><Status playback={playback} meta={meta} onPreview={preview} /></div>
        )}
      </div>
    );
  }

  const open = playback.state === 'open';
  // Reserved before anything loads; the player keeps the video's own shape once it's known.
  const aspect = meta?.aspect && meta.aspect > 0.2 && meta.aspect < 5 ? meta.aspect : 16 / 9;
  return (
    <div
      ref={root}
      data-chat-media="video"
      {...group}
      data-state={playback.state}
      className={`chat-media-card my-1.5 min-w-0 ${open ? 'w-full max-w-[560px]' : 'w-[280px] max-w-full'}`}
    >
      {open ? (
        <div
          className="w-full max-h-[420px] [aspect-ratio:var(--chat-media-aspect)] rounded-lg overflow-hidden bg-black flex items-center justify-center"
          style={{ '--chat-media-aspect': String(aspect) } as React.CSSProperties}
        >
          <video ref={attach} src={src ?? undefined} controls tabIndex={0} preload="metadata" className="w-full h-full" aria-label={card.name} {...mediaEvents} />
        </div>
      ) : (
        <button
          ref={playButton}
          type="button"
          onClick={() => void play()}
          aria-busy={playback.state === 'loading'}
          aria-label={playLabel}
          title={playLabel}
          className="group relative block w-full aspect-video rounded-lg overflow-hidden border border-surface-1 bg-ctp-crust"
        >
          {meta?.poster
            ? <img src={meta.poster} alt="" className="absolute inset-0 w-full h-full object-contain" data-testid="chat-media-poster" />
            : <span className="absolute inset-0 flex items-center justify-center text-ctp-overlay0"><VideoIcon size={28} /></span>}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-11 h-11 rounded-full bg-black/60 text-white flex items-center justify-center group-hover:bg-black/75">
              {playback.state === 'loading' ? <span className="text-[11px]">…</span> : <PlayIcon size={16} />}
            </span>
          </span>
          {shownDuration && (
            <span className="absolute right-1.5 bottom-1.5 px-1.5 rounded bg-black/65 text-white text-[11px] leading-[18px] tabular-nums" data-testid="chat-media-duration">
              {resumeAt !== undefined ? `${formatDuration(resumeAt)} / ` : ''}{shownDuration}
            </span>
          )}
        </button>
      )}
      <div className="mt-1 flex items-center gap-1.5 min-w-0 h-7">
        <Icon className="text-ctp-overlay1" />
        <span className="truncate min-w-0 text-[12px] text-ctp-subtext1" title={card.path}>{card.name}</span>
        {playback.state === 'loading' && <span className="text-[11.5px] text-ctp-overlay1 flex-shrink-0" role="status">Loading…</span>}
        <span className="ml-auto flex items-center flex-shrink-0">
          {open && typeof document !== 'undefined' && document.pictureInPictureEnabled && (
            <Button
              kind="quiet"
              icon={<PopOutIcon />}
              aria-label={`Pop out ${card.name}`}
              title="Picture in picture"
              onClick={() => { void (player.current as HTMLVideoElement | null)?.requestPictureInPicture?.().catch((): undefined => undefined); }}
            />
          )}
          {open && (
            <Button
              kind="quiet"
              icon={<FullscreenIcon />}
              aria-label={`Play ${card.name} full screen`}
              title="Full screen"
              onClick={() => { void player.current?.requestFullscreen?.().catch((): undefined => undefined); }}
            />
          )}
          {previewButton}
          {open && <Button kind="quiet" icon={<XIcon />} aria-label={`Close the player for ${card.name}`} title="Close" onClick={() => close()} />}
        </span>
      </div>
      <Status playback={playback} meta={meta} onPreview={preview} />
    </div>
  );
}

/**
 * Cards for the returned media in a rendered message. Call `scan` after the
 * message's chips are hydrated (and after every rebuild of its DOM); the
 * returned portals render each card into its place in the message.
 */
export function useMediaCards(agentId: string | null): { scan: (root: Element | null, async?: boolean) => void; portals: ReactNode } {
  const [cards, setCards] = useState<MediaCardHost[]>([]);
  useEffect(() => { if (agentId) installSinglePlayback(); }, [agentId]);
  const scan = useCallback((root: Element | null, async = false) => {
    const next = root && agentId ? placeMediaCards(root) : [];
    const update = () => setCards((prev) => (prev.length === next.length && prev.every((c, i) => c === next[i]) ? prev : next));
    // After hydration (a promise), commit the cards before the next paint: the
    // paragraph a card replaces is already hidden, so there's no frame without either.
    if (async) flushSync(update); else update();
  }, [agentId]);
  const portals = agentId && cards.length
    ? cards.map((c) => createPortal(<MediaCard card={c} agentId={agentId} />, c.host, c.key))
    : null;
  return { scan, portals };
}
