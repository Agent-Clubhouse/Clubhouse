/**
 * Inline images in chat (experimental rich chat content, #2350): thumbnails
 * under the tool call that returned them, and a viewer to zoom, copy or
 * reveal one. Images render only as `<img>` from data: URLs. A remote image
 * is a "Load image" button until the user clicks it.
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ChatImage } from '../../../../../shared/chat';
import { Modal } from '../../../../components/Modal';
import { Button } from '../../../../components/Button';
import { ImageIcon } from '../icons';
import { dataUrlOf, loadFullImage, loadThumbnail, thumbnailOf, type MediaBytes, type Thumbnail } from './media';

/**
 * The agent whose images the transcript shows, when rich chat content is on;
 * null (the default) shows none, so the transcript renders as it did before.
 */
export const ChatMediaContext = createContext<string | null>(null);

/** Largest thumbnail edge in CSS pixels. */
const THUMB_MAX = 240;

function boxFor(image: ChatImage): { width: number; height: number } | undefined {
  if (!image.width || !image.height) return undefined;
  const scale = Math.min(1, THUMB_MAX / Math.max(image.width, image.height));
  return { width: Math.max(16, Math.round(image.width * scale)), height: Math.max(16, Math.round(image.height * scale)) };
}

function revealLabel(): string {
  return window.clubhouse?.platform === 'darwin' ? 'Show in Finder' : window.clubhouse?.platform === 'win32' ? 'Show in Explorer' : 'Show in folder';
}

/** True once the element is near the viewport (at once without IntersectionObserver). */
function useNearViewport(): [React.RefObject<HTMLButtonElement | null>, boolean] {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); setNear(true); }
    }, { rootMargin: '400px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, near];
}

const THUMB_FRAME = 'flex items-center justify-center rounded-md border border-surface-0 bg-ctp-mantle overflow-hidden';
const CHIP = 'h-7 max-w-[260px] flex items-center gap-1.5 px-2 rounded-md bg-surface-0 hover:bg-surface-1 text-[12px] text-ctp-subtext1 disabled:opacity-60';

/** An image with no thumbnail (a large SVG, say): opens straight in the viewer. */
function ViewChip({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className={CHIP} onClick={onOpen} data-testid="chat-image-view">
      <ImageIcon size={13} className="text-ctp-overlay1 flex-shrink-0" />
      <span>View image</span>
    </button>
  );
}

function StoredThumb({ agentId, image, onOpen }: { agentId: string; image: ChatImage & { mediaRef: string }; onOpen: () => void }) {
  const [loaded, setLoaded] = useState<Thumbnail | null | undefined>(undefined);
  const [ref, near] = useNearViewport();
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    void loadThumbnail(agentId, image.mediaRef).then((v) => { if (!cancelled) setLoaded(v); });
    return () => { cancelled = true; };
  }, [near, agentId, image.mediaRef]);
  const box = boxFor(image);
  const src = loaded?.thumb;
  if (loaded && !loaded.thumb) return <ViewChip onOpen={onOpen} />;
  if (loaded === null) {
    return (
      <span className="h-7 flex items-center gap-1.5 px-2 rounded-md bg-surface-0 text-[12px] text-ctp-overlay1" data-testid="chat-image-unavailable">
        <ImageIcon size={13} /> Image unavailable
      </span>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      className={`${THUMB_FRAME} hover:border-surface-2 cursor-zoom-in`}
      style={box ? { width: box.width, height: box.height } : { minWidth: 64, minHeight: 48, maxWidth: THUMB_MAX, maxHeight: THUMB_MAX }}
      onClick={onOpen}
      aria-label="Open image"
      data-testid="chat-image-thumb"
      data-media-ref={image.mediaRef}
    >
      {src && <img src={src} alt="" draggable={false} decoding="async" className="block max-w-full max-h-full object-contain" style={{ maxWidth: THUMB_MAX, maxHeight: THUMB_MAX }} />}
    </button>
  );
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    // telemetry-exempt: label only; an unparsable link shows as itself.
    return uri;
  }
}

/** A remote image: nothing is fetched until the user clicks Load image. */
function RemoteThumb({ image, onOpen }: { image: ChatImage & { uri: string }; onOpen: (bytes: MediaBytes) => void }) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; bytes: MediaBytes; thumb: string | null }>({ status: 'idle' });
  const load = async () => {
    setState({ status: 'loading' });
    try {
      const bytes = await window.clubhouse.chat.fetchRemoteImage(image.uri);
      setState({ status: 'loaded', bytes, thumb: await thumbnailOf(bytes) });
    } catch (err) {
      // telemetry-exempt: shown in place; the user can still open the link elsewhere.
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The image could not be loaded';
      setState({ status: 'error', message });
    }
  };
  if (state.status === 'loaded' && !state.thumb) return <ViewChip onOpen={() => onOpen(state.bytes)} />;
  if (state.status === 'loaded' && state.thumb) {
    return (
      <button type="button" className={`${THUMB_FRAME} hover:border-surface-2 cursor-zoom-in`} onClick={() => onOpen(state.bytes)} aria-label="Open image" data-testid="chat-image-thumb">
        <img src={state.thumb} alt="" draggable={false} decoding="async" className="block object-contain" style={{ maxWidth: THUMB_MAX, maxHeight: THUMB_MAX }} />
      </button>
    );
  }
  return (
    <span className="flex flex-col gap-0.5" data-testid="chat-image-remote">
      <button
        type="button"
        className={CHIP}
        onClick={() => void load()}
        disabled={state.status === 'loading'}
        title={image.uri}
      >
        <ImageIcon size={13} className="text-ctp-overlay1 flex-shrink-0" />
        <span className="flex-shrink-0">{state.status === 'loading' ? 'Loading image…' : 'Load image'}</span>
        <span className="truncate min-w-0 text-ctp-overlay1">{hostOf(image.uri)}</span>
      </button>
      {state.status === 'error' && <span className="text-[11.5px] text-ctp-error">{state.message}</span>}
    </span>
  );
}

type ViewerTarget = { kind: 'stored'; mediaRef: string; mimeType: string } | { kind: 'remote'; bytes: MediaBytes };

/** The image viewer: fit or actual size, copy, and reveal the stored file. */
export function ImageLightbox({ agentId, target, onClose }: { agentId: string; target: ViewerTarget; onClose: () => void }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [actual, setActual] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const loading = target.kind === 'stored' ? loadFullImage(agentId, target.mediaRef) : dataUrlOf(target.bytes);
    // telemetry-exempt: a failed load shows "unavailable" in the viewer.
    loading.then((v) => { if (!cancelled) setSrc(v); }, () => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
  }, [agentId, target]);
  const act = async (action: 'copy' | 'reveal') => {
    if (target.kind !== 'stored') return;
    try {
      await window.clubhouse.chat.mediaAction(agentId, target.mediaRef, action);
      if (action === 'copy') setNote('Copied');
    } catch {
      // telemetry-exempt: shown in the viewer.
      setNote(action === 'copy' ? "Couldn't copy the image" : "Couldn't show the file");
    }
  };
  const stored = target.kind === 'stored';
  const canCopy = stored && target.mimeType !== 'image/svg+xml';
  return (
    <Modal
      open
      onClose={onClose}
      aria-label="Image"
      width="w-[min(92vw,1200px)]"
      backdrop="heavy"
      padding="none"
      testId="chat-image-viewer"
      footer={(
        <>
          {note && <span className="mr-auto text-[12px] text-ctp-subtext0" role="status">{note}</span>}
          <Button kind="ghost" onClick={() => setActual((a) => !a)} disabled={!src}>{actual ? 'Fit to window' : 'Actual size'}</Button>
          {canCopy && <Button kind="ghost" onClick={() => void act('copy')}>Copy</Button>}
          {stored && <Button kind="ghost" onClick={() => void act('reveal')}>{revealLabel()}</Button>}
          <Button kind="primary" onClick={onClose}>Close</Button>
        </>
      )}
    >
      <div className={`flex bg-ctp-crust max-h-[75vh] min-h-[200px] ${actual ? 'overflow-auto items-start justify-start' : 'overflow-hidden items-center justify-center'}`}>
        {src === null
          ? <span className="m-auto text-[12.5px] text-ctp-overlay1">Image unavailable</span>
          : src && (
            <img
              src={src}
              alt=""
              draggable={false}
              decoding="async"
              className={actual ? 'block max-w-none cursor-zoom-out' : 'block max-w-full max-h-[75vh] object-contain cursor-zoom-in'}
              onClick={() => setActual((a) => !a)}
              data-testid="chat-image-full"
            />
          )}
      </div>
    </Modal>
  );
}

/** A tool call's images, when rich chat content is on (ChatMediaContext set). */
export function ToolImages({ media, className = '' }: { media: ChatImage[] | undefined; className?: string }) {
  const agentId = useContext(ChatMediaContext);
  const [viewing, setViewing] = useState<ViewerTarget | null>(null);
  if (!agentId || !media?.length) return null;
  return (
    <div className={`flex flex-wrap gap-2 py-1.5 ${className}`} data-testid="chat-tool-images">
      {media.map((image, i) => {
        if (image.mediaRef) {
          const ref = image.mediaRef;
          return <StoredThumb key={ref} agentId={agentId} image={{ ...image, mediaRef: ref }} onOpen={() => setViewing({ kind: 'stored', mediaRef: ref, mimeType: image.mimeType })} />;
        }
        if (image.uri) {
          const uri = image.uri;
          return <RemoteThumb key={`${uri}:${i}`} image={{ ...image, uri }} onOpen={(bytes) => setViewing({ kind: 'remote', bytes })} />;
        }
        return null;
      })}
      {viewing && <ImageLightbox agentId={agentId} target={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
