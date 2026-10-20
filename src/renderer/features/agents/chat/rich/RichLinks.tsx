import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { GithubRefDetails, GithubRefResult, GithubRefState } from '../../../../../shared/github-ref';
import { useAgentStore } from '../../../../stores/agentStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { useUIStore } from '../../../../stores/uiStore';
import { usePluginStore } from '../../../../plugins/plugin-store';
import { LAYER_PORTAL_ATTR } from '../../../../components/layers';
import { formatAgo } from '../../states/format';
import { fetchGithubRef, peekGithubRef, resolveGithubRepo } from './github-ref-client';
import { findLinkTokens, githubLabel, parseGithubUrl, type GithubRef, type LinkToken } from './link-tokens';
import { useRichChatContent } from './rich-flag';
import { enrichTextNodes, type TextMatcher } from './text-enrich';

/**
 * Link tokens in chat (#2351), behind experimental.richChatContent. A
 * RichLinkProvider around a transcript turns them on; without one (or with the
 * flag off) Markdown and tool output render exactly as before.
 *
 * Nothing is fetched until a GitHub token is hovered or focused, and then only
 * from GitHub through main's gh lookup. Other URLs are plain links.
 */

const GITHUB_ISSUES_PLUGIN = 'github-issues';
const HOVER_DELAY_MS = 350;

interface RichLinkContextValue {
  projectId: string | null;
  /** The project's GitHub repo ("owner/repo"), once resolved. */
  repo: string | null;
  showCard: (anchor: HTMLAnchorElement) => void;
  hideCard: () => void;
}

const RichLinkContext = createContext<RichLinkContextValue | null>(null);

/** The rich link context, or null when rich content is off here. */
export function useRichLinks(): RichLinkContextValue | null {
  return useContext(RichLinkContext);
}

// ── Token DOM ─────────────────────────────────────────────────────────────

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** 12px outline icons drawn with DOM APIs (no markup strings). */
function tokenIcon(doc: Document, kind: GithubRef['kind']): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = doc.createElementNS(SVG_NAMESPACE, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  };
  if (kind === 'commit') {
    add('circle', { cx: '8', cy: '8', r: '2.6' });
    add('path', { d: 'M1 8h4.4M10.6 8H15' });
  } else if (kind === 'pull') {
    add('circle', { cx: '4', cy: '3.5', r: '1.8' });
    add('circle', { cx: '4', cy: '12.5', r: '1.8' });
    add('circle', { cx: '12', cy: '12.5', r: '1.8' });
    add('path', { d: 'M4 5.3v5.4M12 10.7V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6' });
  } else {
    add('circle', { cx: '8', cy: '8', r: '6.2' });
    add('circle', { cx: '8', cy: '8', r: '1.2', fill: 'currentColor', stroke: 'none' });
  }
  return svg;
}

function applyKnown(anchor: HTMLAnchorElement, result: GithubRefResult | undefined): void {
  if (!result?.ok) return;
  const { details } = result;
  if (details.state) anchor.dataset.ghState = details.state;
  // A pull request named by number gets the pull request icon once that's known.
  if (anchor.dataset.ghKind !== details.kind) {
    anchor.dataset.ghKind = details.kind;
    anchor.querySelector('svg')?.replaceWith(tokenIcon(anchor.ownerDocument, details.kind));
  }
  // A token that replaced a bare URL has only its number to go on, so it gains the title.
  if (anchor.dataset.ghFromUrl === 'true' && !anchor.querySelector('.chat-gh-title')) {
    const title = anchor.ownerDocument.createElement('span');
    title.className = 'chat-gh-title';
    title.textContent = details.title;
    anchor.appendChild(title);
  }
}

/** Mark a link as a GitHub token: the icon, the compact label when its text was the URL, any known state. */
function decorateGithubAnchor(anchor: HTMLAnchorElement, ref: GithubRef, repo: string | null, opts: { relabel: boolean; ambiguous: boolean }): void {
  const doc = anchor.ownerDocument;
  anchor.classList.add('chat-gh-token');
  anchor.dataset.ghToken = 'true';
  anchor.dataset.ghKind = ref.kind === 'ref' ? 'issue' : ref.kind;
  if (opts.ambiguous) anchor.dataset.ghAmbiguous = 'true';
  if (opts.relabel) {
    anchor.dataset.ghFromUrl = 'true';
    anchor.textContent = githubLabel(ref, repo);
  }
  anchor.insertBefore(tokenIcon(doc, ref.kind === 'ref' ? 'issue' : ref.kind), anchor.firstChild);
  applyKnown(anchor, peekGithubRef(ref));
}

function makeTokenNode(doc: Document, token: LinkToken, text: string, repo: string | null, relabel: boolean): Node {
  const a = doc.createElement('a');
  const fromUrl = /^https?:/i.test(text);
  // A written URL keeps its own target (a PR's files tab, a comment anchor); shorthand gets the canonical page.
  a.setAttribute('href', token.type === 'url' ? token.href : fromUrl ? text : token.ref.href);
  a.textContent = text;
  if (token.type === 'url') {
    a.className = 'chat-rich-link';
    return a;
  }
  decorateGithubAnchor(a, token.ref, repo, { relabel: relabel && fromUrl, ambiguous: token.ref.kind === 'ref' });
  return a;
}

/** `relabel`: show a GitHub URL as its compact label; off for tool output, which stays as printed. */
export function linkMatcher(repo: string | null, shorthand: boolean, relabel = shorthand): TextMatcher {
  return (text) => findLinkTokens(text, { repo, shorthand }).map((t) => ({
    start: t.start,
    end: t.end,
    make: (doc: Document) => makeTokenNode(doc, t, text.slice(t.start, t.end), repo, relabel),
  }));
}

/**
 * Enrich rendered markdown in place: existing GitHub links become tokens,
 * and plain-text references outside code become links and tokens.
 */
export function enrichMarkdownLinks(root: HTMLElement, repo: string | null): void {
  for (const a of Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
    if (a.dataset.ghToken || a.closest('pre, code')) continue;
    const href = a.getAttribute('href') ?? '';
    const ref = parseGithubUrl(href);
    if (!ref) continue;
    // An autolinked URL reads as the URL itself; a written link keeps its own words.
    const text = (a.textContent ?? '').trim();
    decorateGithubAnchor(a, ref, repo, { relabel: text === href || text === href.replace(/^https?:\/\//, ''), ambiguous: false });
  }
  enrichTextNodes(root, [linkMatcher(repo, true)]);
}

// ── Plain text (tool output) ──────────────────────────────────────────────

/**
 * Tool output with URLs as links, for a <pre>. Outside a RichLinkProvider it's
 * the text itself. `#123` and `owner/repo#123` aren't matched here: in output
 * they're as often colors or code.
 */
export function RichText({ text }: { text: string }) {
  const rich = useRichLinks();
  const ref = useRef<HTMLSpanElement>(null);
  const has = useMemo(() => !!rich && /https?:\/\//i.test(text), [rich, text]);
  // The span's children are built here, never by React, so React has nothing of its own to reconcile.
  useLayoutEffect(() => {
    if (!has || !ref.current) return;
    ref.current.textContent = text;
    enrichTextNodes(ref.current, [linkMatcher(rich!.repo, false)]);
  }, [has, text, rich]);
  const handlers = useTokenHandlers(rich);
  if (!has) return <>{text}</>;
  return <span ref={ref} {...handlers} />;
}

// ── Events ────────────────────────────────────────────────────────────────

function tokenAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target.closest('a[data-gh-token]') : null;
  return el instanceof HTMLAnchorElement ? el : null;
}

/** Hover and focus handlers for an element holding tokens; empty when rich content is off. */
export function useTokenHandlers(rich: RichLinkContextValue | null) {
  const onClick = useRichLinkClick(rich);
  return useMemo(() => {
    if (!rich) return {};
    return {
      onClick,
      // Middle-click would otherwise ask the window to open the link itself.
      onAuxClick: (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest('a')) e.preventDefault(); },
      onMouseOver: (e: React.MouseEvent) => { const a = tokenAnchor(e.target); if (a) rich.showCard(a); },
      onMouseOut: (e: React.MouseEvent) => { if (tokenAnchor(e.target) && tokenAnchor(e.target) !== tokenAnchor(e.relatedTarget)) rich.hideCard(); },
      onFocus: (e: React.FocusEvent) => { const a = tokenAnchor(e.target); if (a) rich.showCard(a); },
      onBlur: (e: React.FocusEvent) => { if (tokenAnchor(e.target)) rich.hideCard(); },
    };
  }, [rich, onClick]);
}

/** Open a link: the project's own issues in the Issues view when it's installed there, else the browser. */
export function openLink(href: string, rich: Pick<RichLinkContextValue, 'projectId' | 'repo'> | null, ambiguous = false): void {
  if (!/^https?:\/\//i.test(href) && !href.startsWith('mailto:')) return;
  const ref = parseGithubUrl(href);
  if (ref && rich?.projectId && rich.repo && ref.repo.toLowerCase() === rich.repo.toLowerCase() && !window.clubhouse.window?.isPopout?.()) {
    const known = peekGithubRef(ref);
    const kind = known?.ok ? known.details.kind : ambiguous ? null : ref.kind;
    const enabled = usePluginStore.getState().projectEnabled[rich.projectId]?.includes(GITHUB_ISSUES_PLUGIN);
    if (kind === 'issue' && enabled) {
      useProjectStore.getState().setActiveProject(rich.projectId);
      useUIStore.getState().setExplorerTab(`plugin:${GITHUB_ISSUES_PLUGIN}`, rich.projectId);
      return;
    }
  }
  window.clubhouse.app.openExternalUrl(href);
}

function useRichLinkClick(rich: RichLinkContextValue | null) {
  return useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (!href) return;
    rich?.hideCard();
    openLink(href, rich, a.dataset.ghAmbiguous === 'true');
  }, [rich]);
}

// ── Hover card ────────────────────────────────────────────────────────────

const STATE_LABEL: Record<GithubRefState, string> = { draft: 'Draft', open: 'Open', merged: 'Merged', closed: 'Closed' };
const STATE_TONE: Record<GithubRefState, string> = {
  draft: 'text-ctp-overlay1', open: 'text-ctp-success', merged: 'text-ctp-mauve', closed: 'text-ctp-error',
};
const CHECKS_LABEL = { passing: 'Checks passing', failing: 'Checks failing', pending: 'Checks running' } as const;
const CHECKS_TONE = { passing: 'text-ctp-success', failing: 'text-ctp-error', pending: 'text-ctp-warning' } as const;

export function GithubRefCardBody({ refLabel, details }: { refLabel: string; details: GithubRefDetails | null }) {
  const meta: ReactNode[] = [];
  if (details?.author) meta.push(<span key="a">{details.author}</span>);
  if (details?.updatedAt) {
    const at = Date.parse(details.updatedAt);
    if (!Number.isNaN(at)) meta.push(<span key="u">{details.kind === 'commit' ? 'committed' : 'updated'} {formatAgo(at)}</span>);
  }
  if (details?.checks) meta.push(<span key="c" className={CHECKS_TONE[details.checks]}>{CHECKS_LABEL[details.checks]}</span>);
  return (
    <>
      <div className="flex items-baseline gap-2 text-[11.5px] text-ctp-overlay1">
        <span className="font-mono truncate min-w-0">{refLabel}</span>
        {details?.state && <span className={STATE_TONE[details.state]} data-testid="gh-card-state">{STATE_LABEL[details.state]}</span>}
      </div>
      {details
        ? <div className="text-[12.5px] font-medium text-ctp-text line-clamp-2 break-words" data-testid="gh-card-title">{details.title}</div>
        : <div className="text-[12px] text-ctp-overlay0">Loading…</div>}
      {meta.length > 0 && (
        <div className="flex flex-wrap gap-x-1.5 text-[11.5px] text-ctp-subtext0">
          {meta.flatMap((m, i) => (i === 0 ? [m] : [<span key={`s${i}`} aria-hidden="true">·</span>, m]))}
        </div>
      )}
    </>
  );
}

interface CardState { anchor: HTMLAnchorElement; ref: GithubRef; result: GithubRefResult | null }

function placeCard(anchor: DOMRect, card: { width: number; height: number }) {
  const margin = 8;
  const below = anchor.bottom + 6 + card.height <= window.innerHeight - margin;
  return {
    left: Math.max(margin, Math.min(anchor.left, window.innerWidth - card.width - margin)),
    top: below ? anchor.bottom + 6 : Math.max(margin, anchor.top - 6 - card.height),
  };
}

function GithubRefCard({ state, repo }: { state: CardState; repo: string | null }) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!el.current) return;
    const r = el.current.getBoundingClientRect();
    setPos(placeCard(state.anchor.getBoundingClientRect(), { width: r.width, height: r.height }));
  }, [state]);
  const details = state.result?.ok ? state.result.details : null;
  return createPortal(
    <div
      ref={el}
      role="tooltip"
      data-testid="gh-ref-card"
      {...{ [LAYER_PORTAL_ATTR]: '' }}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-tooltip pointer-events-none flex flex-col gap-1 w-72 px-3 py-2 rounded-md border border-surface-1 bg-ctp-mantle shadow-lg"
    >
      <GithubRefCardBody refLabel={githubLabel(state.ref, repo)} details={details} />
    </div>,
    document.body,
  );
}

/**
 * Turns rich links on for a transcript when the experimental flag is on, and
 * hosts its one hover card. `agentId` picks the project, its GitHub remote and
 * whether the Issues view can open its issues.
 */
export function RichLinkProvider({ agentId, children }: { agentId: string; children: ReactNode }) {
  const enabled = useRichChatContent();
  const projectId = useAgentStore((s) => s.agents[agentId]?.projectId ?? null);
  const worktree = useAgentStore((s) => s.agents[agentId]?.worktreePath);
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.path);
  const dir = worktree ?? projectPath;
  const [repo, setRepo] = useState<string | null>(null);
  const [card, setCard] = useState<CardState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (!enabled || !dir) { setRepo(null); return; }
    let cancelled = false;
    void resolveGithubRepo(dir).then((r) => { if (!cancelled) setRepo(r); });
    return () => { cancelled = true; };
  }, [enabled, dir]);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const hideCard = useCallback(() => {
    clear();
    hovered.current = null;
    setCard(null);
  }, []);

  const showCard = useCallback((anchor: HTMLAnchorElement) => {
    if (hovered.current === anchor) return;
    const ref = parseGithubUrl(anchor.getAttribute('href') ?? '');
    if (!ref) return;
    clear();
    hovered.current = anchor;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (hovered.current !== anchor) return;
      const known = peekGithubRef(ref);
      // Known to fail: the token stays a plain link with no card.
      if (known && !known.ok) return;
      setCard({ anchor, ref, result: known ?? null });
      if (known) return;
      void fetchGithubRef(ref).then((result) => {
        applyKnown(anchor, result);
        if (hovered.current !== anchor) return;
        setCard(result.ok ? { anchor, ref, result } : null);
      });
    }, HOVER_DELAY_MS);
  }, []);

  useEffect(() => {
    if (!card) return;
    window.addEventListener('scroll', hideCard, true);
    return () => window.removeEventListener('scroll', hideCard, true);
  }, [card, hideCard]);
  useEffect(() => clear, []);

  const value = useMemo<RichLinkContextValue | null>(
    () => (enabled ? { projectId, repo, showCard, hideCard } : null),
    [enabled, projectId, repo, showCard, hideCard],
  );

  return (
    <RichLinkContext.Provider value={value}>
      {children}
      {card && card.anchor.isConnected && <GithubRefCard state={card} repo={repo} />}
    </RichLinkContext.Provider>
  );
}
