/**
 * Attachments on a sent message (#3222). With rich chat content on, an image
 * is a thumbnail that opens the image viewer, audio and video are the inline
 * cards agent messages use, and other files are chips that open the file
 * preview. Off, or when the file can't be found, each is the name chip it
 * always was.
 *
 * An image loads by the stored copy main made when it was sent (`mediaRef`);
 * an older message without one imports its path the way local images in
 * agent markdown do. Both go through main and wait until near the viewport.
 */

import { useContext, useEffect, useState } from 'react';
import type { ChatFileInfo, ContentBlock } from '../../../../shared/chat';
import { attachmentName } from './attachments';
import { FileIcon, ImageIcon } from './icons';
import { ChatMediaContext, ImageLightbox, useNearViewport, type ViewerTarget } from './rich/ChatImages';
import { statChatFile, useFileChips, useOpenFilePreview } from './rich/FileChips';
import { MediaCard } from './rich/MediaCards';
import { installSinglePlayback } from './rich/media-cards';
import { importLocal } from './rich/markdown-images';
import { loadThumbnail } from './rich/media';

type ImageBlock = Extract<ContentBlock, { type: 'image' }>;
type FileBlock = Extract<ContentBlock, { type: 'file' }>;

/** Largest thumbnail edge in CSS pixels: smaller than tool images, as a message can carry ten. */
const THUMB_MAX = 160;

const CHIP = 'h-7 max-w-[220px] flex items-center gap-1.5 px-2 rounded-md bg-surface-0 text-[12px] text-ctp-subtext1';

function chipTitle(block: ContentBlock, name: string): string {
  return block.type === 'file' ? block.path : block.type === 'image' ? block.path ?? name : name;
}

/** The name chip. Given `onOpen`, it's a button (a file with a preview, an image with no thumbnail). */
function NameChip({ block, name, onOpen }: { block: ContentBlock; name: string; onOpen?: (anchor: HTMLElement) => void }) {
  const icon = block.type === 'image'
    ? <ImageIcon size={13} className="text-ctp-overlay1 flex-shrink-0" />
    : <FileIcon size={13} className="text-ctp-overlay1 flex-shrink-0" />;
  if (onOpen) {
    return (
      <button
        type="button"
        className={`${CHIP} hover:bg-surface-1 hover:text-ctp-text`}
        title={chipTitle(block, name)}
        aria-haspopup="dialog"
        onClick={(e) => onOpen(e.currentTarget)}
        data-testid="chat-attachment-chip"
      >
        {icon}
        <span className="truncate min-w-0">{name}</span>
      </button>
    );
  }
  return (
    <span className={CHIP} title={chipTitle(block, name)} data-testid="chat-attachment-chip">
      {icon}
      <span className="truncate min-w-0">{name}</span>
    </span>
  );
}

interface ShownImage { mediaRef: string; mimeType: string; width?: number; height?: number; thumb: string | null }

/** The stored copy first; failing that (none, or it's gone), the attached file's path. */
async function loadAttachedImage(agentId: string, block: ImageBlock): Promise<ShownImage | null> {
  if (block.mediaRef) {
    const loaded = await loadThumbnail(agentId, block.mediaRef);
    if (loaded) return { mediaRef: block.mediaRef, mimeType: block.mimeType, width: block.width, height: block.height, thumb: loaded.thumb };
  }
  if (!block.path) return null;
  const imported = await importLocal(agentId, block.path);
  if (!imported.ok) return null;
  const loaded = await loadThumbnail(agentId, imported.mediaRef);
  return loaded && { mediaRef: imported.mediaRef, mimeType: imported.mimeType, width: imported.width, height: imported.height, thumb: loaded.thumb };
}

function boxFor(width: number | undefined, height: number | undefined): { width: number; height: number } | undefined {
  if (!width || !height) return undefined;
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  return { width: Math.max(16, Math.round(width * scale)), height: Math.max(16, Math.round(height * scale)) };
}

function AttachedImage({ agentId, block, name, onOpen }: { agentId: string; block: ImageBlock; name: string; onOpen: (target: ViewerTarget) => void }) {
  const [shown, setShown] = useState<ShownImage | null | undefined>(undefined);
  const [ref, near] = useNearViewport();
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    // telemetry-exempt: an image that won't load shows as its name chip.
    loadAttachedImage(agentId, block).then((v) => { if (!cancelled) setShown(v); }, () => { if (!cancelled) setShown(null); });
    return () => { cancelled = true; };
  }, [near, agentId, block]);
  if (shown === null) return <NameChip block={block} name={name} />;
  const open = shown ? () => onOpen({ kind: 'stored', mediaRef: shown.mediaRef, mimeType: shown.mimeType }) : undefined;
  if (shown && !shown.thumb) return <NameChip block={block} name={name} onOpen={open} />;
  const box = boxFor(shown?.width ?? block.width, shown?.height ?? block.height);
  return (
    <button
      ref={ref}
      type="button"
      className="flex items-center justify-center rounded-md border border-surface-0 bg-ctp-mantle overflow-hidden hover:border-surface-2 cursor-zoom-in"
      style={box ? { width: box.width, height: box.height } : { minWidth: 64, minHeight: 48, maxWidth: THUMB_MAX, maxHeight: THUMB_MAX }}
      onClick={open}
      aria-label={`Open image: ${name}`}
      aria-busy={!shown}
      title={name}
      data-testid="chat-attachment-thumb"
    >
      {shown?.thumb && <img src={shown.thumb} alt={name} draggable={false} decoding="async" className="block max-w-full max-h-full object-contain" style={{ maxWidth: THUMB_MAX, maxHeight: THUMB_MAX }} />}
    </button>
  );
}

function AttachedFile({ agentId, block, name }: { agentId: string; block: FileBlock; name: string }) {
  const [info, setInfo] = useState<ChatFileInfo | undefined>(undefined);
  const openPreview = useOpenFilePreview();
  useEffect(() => {
    let cancelled = false;
    void statChatFile(agentId, block.path).then((v) => { if (!cancelled) setInfo(v); });
    return () => { cancelled = true; };
  }, [agentId, block.path]);
  const kind = info?.exists ? info.kind : undefined;
  useEffect(() => { if (kind === 'audio' || kind === 'video') installSinglePlayback(); }, [kind]);
  if (kind === 'audio' || kind === 'video') {
    return <MediaCard card={{ path: block.path, kind, name, ...(info?.size !== undefined && { size: info.size }) }} agentId={agentId} />;
  }
  return <NameChip block={block} name={name} onOpen={kind && openPreview ? (anchor) => openPreview(block.path, kind, anchor) : undefined} />;
}

export function MessageAttachments({ content, align }: { content: ContentBlock[]; align: 'start' | 'end' }) {
  // Set while rich chat content is on, as for every other image in the transcript.
  const mediaAgent = useContext(ChatMediaContext);
  const fileAgent = useFileChips();
  const [viewing, setViewing] = useState<ViewerTarget | null>(null);
  const attached = content
    .map((block) => ({ block, name: attachmentName(block) }))
    .filter((a): a is { block: ContentBlock; name: string } => a.name !== null);
  if (attached.length === 0) return null;
  return (
    <div className={`max-w-full flex flex-wrap items-end gap-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`} data-testid="chat-user-attachments">
      {attached.map(({ block, name }, i) => {
        if (block.type === 'image' && mediaAgent && (block.mediaRef || block.path)) {
          return <AttachedImage key={i} agentId={mediaAgent} block={block} name={name} onOpen={setViewing} />;
        }
        if (block.type === 'file' && fileAgent) return <AttachedFile key={i} agentId={fileAgent} block={block} name={name} />;
        return <NameChip key={i} block={block} name={name} />;
      })}
      {viewing && mediaAgent && <ImageLightbox agentId={mediaAgent} target={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
