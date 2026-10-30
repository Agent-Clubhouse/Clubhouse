/**
 * File chips in chat (experimental rich chat content, #2350). Paths in agent
 * messages and tool output are matched in the shared text pass (before URLs),
 * and an inline code span that is just a path counts too. Each is only a
 * candidate until main confirms the file exists, wherever it is (#2478); then
 * it becomes a chip. One clearly meant as a file (a whole code span, or an
 * absolute, `~/` or `./` path with an extension) that main can't show
 * becomes a muted chip that says why;
 * a loose match in prose goes back to plain text. A chip opens a preview:
 * read-only Monaco for text, the image, a player for video and audio, pdf.js
 * pages for a PDF, and Open in Files / Show in Finder for everything.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChatFileInfo, ChatFilePreview, ChatFileUnavailable } from '../../../../../shared/chat';
import { LAYER_PORTAL_ATTR } from '../../../../components/layers';
import { Button } from '../../../../components/Button';
import { ReadOnlyMonacoEditor } from '../../../../plugins/builtin/canvas/ReadOnlyMonacoEditor';
import { findFilePaths, namesFileClearly, wholeFilePath, type FilePathMatch } from './file-paths';
import { dataUrlOf } from './media';
import { PdfPreview } from './PdfPreview';
import type { TextMatcher } from './text-enrich';

const PATH_ATTR = 'data-chat-path';
const LINE_ATTR = 'data-chat-line';
const COL_ATTR = 'data-chat-col';
/** Set once main confirmed the file: its kind. */
const FILE_ATTR = 'data-chat-file';
/** Set on a muted chip: why main can't show it. */
const UNAVAILABLE_ATTR = 'data-chat-file-unavailable';
const MUTED_CLASS = 'chat-file-chip-muted';

const UNAVAILABLE_TEXT: Record<Exclude<ChatFileUnavailable, 'folder'>, string> = {
  missing: 'File not found',
  'not-a-file': 'Not a regular file',
  unreadable: "Can't read this file",
};

// ── Candidates ────────────────────────────────────────────────────────────

function markCandidate(el: Element, m: FilePathMatch): void {
  el.setAttribute(PATH_ATTR, m.path);
  if (m.line !== undefined) el.setAttribute(LINE_ATTR, String(m.line));
  if (m.line !== undefined && m.col !== undefined) el.setAttribute(COL_ATTR, String(m.col));
}

/** The text-pass matcher: each path becomes a candidate span holding the text as written. */
export const fileMatcher: TextMatcher = (text) => findFilePaths(text).map((m) => ({
  start: m.start,
  end: m.end,
  make: (doc: Document) => {
    const span = doc.createElement('span');
    markCandidate(span, m);
    span.textContent = text.slice(m.start, m.end);
    return span;
  },
}));

/** Inline code spans (not code blocks) that hold just a path become candidates too. */
export function markCodePaths(root: Element): void {
  for (const code of Array.from(root.querySelectorAll('code'))) {
    // Not in code blocks, and not inside a link: the link already goes somewhere.
    if (code.closest('pre, a') || code.hasAttribute(PATH_ATTR) || code.children.length) continue;
    const match = wholeFilePath(code.textContent ?? '');
    if (match) markCandidate(code, match);
  }
}

// ── Confirming with main ──────────────────────────────────────────────────

const STAT_CACHE_MAX = 2000;
/** A path with no file is asked again after this long (the agent may be about to create it). */
const MISS_TTL_MS = 10_000;
const statCache = new Map<string, Promise<ChatFileInfo>>();

/** Ask main about paths not asked before (one request), cached per agent for the app session. */
function statPaths(agentId: string, paths: string[]): Map<string, Promise<ChatFileInfo>> {
  const out = new Map<string, Promise<ChatFileInfo>>();
  const fresh: string[] = [];
  for (const p of paths) {
    const hit = statCache.get(`${agentId}\0${p}`);
    if (hit) out.set(p, hit); else if (!fresh.includes(p)) fresh.push(p);
  }
  if (fresh.length) {
    const batch = window.clubhouse.chat.statPaths(agentId, fresh.slice(0, 200))
      // telemetry-exempt: an unconfirmed path stays plain text.
      .catch((): ChatFileInfo[] => []);
    fresh.forEach((p, i) => {
      const one = batch.then((infos) => infos[i] ?? { path: p, exists: false });
      void one.then((info) => {
        if (info.exists) return;
        const key = `${agentId}\0${p}`;
        setTimeout(() => { if (statCache.get(key) === one) statCache.delete(key); }, MISS_TTL_MS);
      });
      statCache.set(`${agentId}\0${p}`, one);
      out.set(p, one);
    });
    while (statCache.size > STAT_CACHE_MAX) statCache.delete(statCache.keys().next().value as string);
  }
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function demote(el: Element): void {
  if (el.tagName === 'SPAN') el.replaceWith(el.ownerDocument.createTextNode(el.textContent ?? ''));
  else { el.removeAttribute(PATH_ATTR); el.removeAttribute(LINE_ATTR); el.removeAttribute(COL_ATTR); }
  el.removeAttribute(UNAVAILABLE_ATTR);
  el.classList.remove(MUTED_CLASS);
  el.removeAttribute('title');
}

/** A path main can't show, kept visible with why. It stays a candidate: asked again later, it may be there. */
function mute(el: Element, reason: Exclude<ChatFileUnavailable, 'folder'>): void {
  el.setAttribute(UNAVAILABLE_ATTR, reason);
  el.classList.add(MUTED_CLASS);
  el.setAttribute('title', UNAVAILABLE_TEXT[reason]);
}

/**
 * Turn the candidates under `root` into chips once main confirms them. One
 * main can't show becomes a muted chip with its reason when it's clearly a
 * path, and plain text otherwise. Safe to call again on the same root.
 */
export async function hydrateFileChips(root: Element, agentId: string): Promise<void> {
  const candidates = Array.from(root.querySelectorAll(`[${PATH_ATTR}]:not([${FILE_ATTR}])`));
  if (!candidates.length) return;
  const answers = statPaths(agentId, candidates.map((el) => el.getAttribute(PATH_ATTR) ?? ''));
  await Promise.all(candidates.map(async (el) => {
    const info = await answers.get(el.getAttribute(PATH_ATTR) ?? '');
    if (!el.isConnected) return;
    if (!info?.exists || !info.kind) {
      const path = el.getAttribute(PATH_ATTR) ?? '';
      // A folder is no file to show, and a loose prose match may not be a path at all.
      if (info?.reason && info.reason !== 'folder' && (el.tagName === 'CODE' || namesFileClearly(path))) mute(el, info.reason);
      else demote(el);
      return;
    }
    el.removeAttribute(UNAVAILABLE_ATTR);
    el.classList.remove(MUTED_CLASS);
    el.setAttribute(FILE_ATTR, info.kind);
    el.classList.add('chat-file-chip');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('tabindex', '0');
    el.setAttribute('title', [info.name, info.size !== undefined ? formatSize(info.size) : null, info.tooLarge ? 'Too large to preview' : null].filter(Boolean).join(' · '));
  }));
}

/** For tests. */
export function clearFileChipCache(): void {
  statCache.clear();
}

// ── Preview ───────────────────────────────────────────────────────────────

interface Target { path: string; line?: number; col?: number; kind: string; anchor: DOMRect }

/** `:line` or `:line:col`, as the chip wrote it. */
function locationSuffix(target: Target): string {
  if (target.line === undefined) return '';
  return target.col !== undefined ? `:${target.line}:${target.col}` : `:${target.line}`;
}

const FileChipContext = createContext<string | null>(null);
/** Opens a file's preview popover by a given element (media cards use it as their fallback). */
const FilePreviewContext = createContext<((path: string, kind: string, anchor: Element) => void) | null>(null);

/** The agent whose file chips this transcript shows, or null when they're off. */
export function useFileChips(): string | null {
  return useContext(FileChipContext);
}

/** Opens the preview popover for a confirmed file, placed by `anchor`; null outside a FileChipProvider. */
export function useOpenFilePreview(): ((path: string, kind: string, anchor: Element) => void) | null {
  return useContext(FilePreviewContext);
}

function revealLabel(): string {
  return window.clubhouse?.platform === 'darwin' ? 'Show in Finder' : window.clubhouse?.platform === 'win32' ? 'Show in Explorer' : 'Show in folder';
}

const POPOVER_W = 560;
const POPOVER_H = 420;

function PreviewBody({ preview, target }: { preview: ChatFilePreview; target: Target }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    // A PDF's bytes go to pdf.js, not a data: URL.
    if (!preview.data || !preview.mimeType || preview.kind === 'pdf') return;
    let cancelled = false;
    // telemetry-exempt: a preview that won't encode shows the fallback text.
    void dataUrlOf({ mimeType: preview.mimeType, data: preview.data }).then((v) => { if (!cancelled) setSrc(v); }, (): undefined => undefined);
    return () => { cancelled = true; };
  }, [preview]);
  if (preview.kind === 'text' && preview.text !== undefined) {
    const lines = preview.text.split('\n').length;
    // Past the end of what's shown: the editor stops at its last line, and this says why.
    const past = target.line !== undefined && target.line > lines;
    const note = past && preview.truncated
      ? `Line ${target.line} is past the first ${formatSize(preview.text.length)} shown here. Open it in Files to go there.`
      : past ? `Line ${target.line} is past the end of this file, which has ${lines} lines.`
        : preview.truncated ? `Showing the first ${formatSize(preview.text.length)}. Open it in Files to see the rest.` : null;
    return (
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex-1 min-h-[200px]" data-testid="chat-file-preview-text">
          <ReadOnlyMonacoEditor value={preview.text} filePath={target.path} {...(target.line !== undefined && { reveal: { line: target.line, ...(target.col !== undefined && { column: target.col }) } })} />
        </div>
        {note && <div className="px-3 py-1 text-[11.5px] text-ctp-overlay1 border-t border-surface-0" data-testid="chat-file-preview-note">{note}</div>}
      </div>
    );
  }
  if (src && preview.kind === 'image') {
    return <div className="flex-1 min-h-0 flex items-center justify-center bg-ctp-crust p-2"><img src={src} alt="" className="max-w-full max-h-[340px] object-contain" data-testid="chat-file-preview-image" /></div>;
  }
  if (src && preview.kind === 'video') {
    return <div className="flex-1 min-h-0 flex items-center justify-center bg-ctp-crust"><video src={src} controls className="max-w-full max-h-[340px]" data-testid="chat-file-preview-video" /></div>;
  }
  if (preview.kind === 'pdf' && preview.data) return <PdfPreview data={preview.data} />;
  if (src && preview.kind === 'audio') {
    return <div className="p-4"><audio src={src} controls className="w-full" data-testid="chat-file-preview-audio" /></div>;
  }
  if (preview.data) return <div className="p-4 text-[12.5px] text-ctp-overlay1">Loading…</div>;
  return (
    <div className="p-4 text-[12.5px] text-ctp-subtext0" data-testid="chat-file-preview-none">
      {preview.tooLarge ? 'This file is too large to preview here.' : 'No preview for this kind of file.'}
    </div>
  );
}

function FilePreviewPopover({ agentId, target, onClose }: { agentId: string; target: Target; onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  // Focus moves into the preview and back to the chip when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    el.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const [preview, setPreview] = useState<ChatFilePreview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.clubhouse.chat.readFilePreview(agentId, target.path).then(
      (p) => { if (!cancelled) setPreview(p); },
      // telemetry-exempt: shown in the popover.
      () => { if (!cancelled) setPreview(null); },
    );
    return () => { cancelled = true; };
  }, [agentId, target.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (el.current && !el.current.contains(e.target as Node)) onClose(); };
    // It's placed by the chip: once the transcript scrolls it would point at the wrong line.
    const onScroll = (e: Event) => { if (el.current && !el.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);
  const act = async (action: 'open' | 'reveal') => {
    try {
      const result = await window.clubhouse.chat.fileAction(agentId, target.path, action);
      if (action === 'open' && result) {
        if (result.kind === 'open-file-not-found') { setError('That file is not in an open project'); return; }
        // Loaded on use: the bridge pulls in most of the app's stores.
        const { handleProtocolAction } = await import('../../../../app-event-bridge');
        // The location stays here: main only resolves which project holds the file.
        handleProtocolAction(result.kind === 'open-file' && target.line !== undefined
          ? { ...result, line: target.line, ...(target.col !== undefined && { column: target.col }) }
          : result);
        onClose();
      }
    } catch {
      // telemetry-exempt: shown in the popover.
      setError(action === 'open' ? "Couldn't open the file" : "Couldn't show the file");
    }
  };
  const width = Math.min(POPOVER_W, window.innerWidth - 24);
  const left = Math.max(12, Math.min(target.anchor.left, window.innerWidth - width - 12));
  const below = target.anchor.bottom + 6 + POPOVER_H <= window.innerHeight;
  const top = below ? target.anchor.bottom + 6 : Math.max(12, target.anchor.top - 6 - POPOVER_H);
  const name = preview?.name ?? target.path.split(/[\\/]/).pop() ?? target.path;
  return createPortal(
    <div
      ref={el}
      role="dialog"
      tabIndex={-1}
      aria-label={`Preview of ${name}`}
      data-testid="chat-file-preview"
      {...{ [LAYER_PORTAL_ATTR]: '' }}
      style={{ left, top, width, height: POPOVER_H }}
      className="fixed z-dropdown flex flex-col rounded-lg border border-surface-1 bg-ctp-mantle shadow-lg overflow-hidden outline-none"
    >
      <div className="flex items-center gap-2 h-9 px-3 border-b border-surface-0 text-[12.5px] min-w-0">
        <span className="font-medium text-ctp-text flex-shrink-0">{name}</span>
        <span className="font-mono text-[11px] text-ctp-overlay1 truncate min-w-0" title={target.path}>{target.path}{locationSuffix(target)}</span>
        {preview && <span className="ml-auto text-[11.5px] text-ctp-overlay0 flex-shrink-0">{formatSize(preview.size)}</span>}
      </div>
      {preview === undefined && <div className="p-4 text-[12.5px] text-ctp-overlay1 flex-1">Loading…</div>}
      {preview === null && <div className="p-4 text-[12.5px] text-ctp-subtext0 flex-1">This file is no longer available.</div>}
      {preview && <PreviewBody preview={preview} target={target} />}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-surface-0">
        {error && <span className="mr-auto text-[12px] text-ctp-error" role="status">{error}</span>}
        <span className="ml-auto" />
        <Button kind="ghost" onClick={() => void act('open')}>Open in Files</Button>
        <Button kind="ghost" onClick={() => void act('reveal')}>{revealLabel()}</Button>
      </div>
    </div>,
    document.body,
  );
}

function chipOf(target: EventTarget | null): Element | null {
  const chip = target instanceof Element ? target.closest(`[${FILE_ATTR}]`) : null;
  // A chip inside a link is the link's: it doesn't open a preview as well.
  return chip && !chip.closest('a') ? chip : null;
}

/**
 * File chips for a transcript: provides the agent to the text pass and opens
 * a chip's preview on click or Enter. Without `agentId` (rich content off) it
 * renders its children and nothing else.
 */
export function FileChipProvider({ agentId, children }: { agentId: string | null; children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const close = useCallback(() => setTarget(null), []);
  const openPath = useCallback((path: string, kind: string, anchor: Element) => {
    setTarget({ path, kind, anchor: anchor.getBoundingClientRect() });
  }, []);
  if (!agentId) return <>{children}</>;
  const open = (chip: Element) => {
    const path = chip.getAttribute(PATH_ATTR);
    if (!path) return;
    const line = Number(chip.getAttribute(LINE_ATTR));
    const col = Number(chip.getAttribute(COL_ATTR));
    setTarget({
      path,
      kind: chip.getAttribute(FILE_ATTR) ?? 'other',
      anchor: chip.getBoundingClientRect(),
      ...(line >= 1 && { line, ...(col >= 1 && { col }) }),
    });
  };
  return (
    <FileChipContext.Provider value={agentId}>
    <FilePreviewContext.Provider value={openPath}>
      <div
        className="contents"
        onClick={(e) => { const chip = chipOf(e.target); if (chip) { e.preventDefault(); open(chip); } }}
        onKeyDown={(e) => { const chip = chipOf(e.target); if (chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(chip); } }}
      >
        {children}
      </div>
      {target && <FilePreviewPopover agentId={agentId} target={target} onClose={close} />}
    </FilePreviewContext.Provider>
    </FileChipContext.Provider>
  );
}
