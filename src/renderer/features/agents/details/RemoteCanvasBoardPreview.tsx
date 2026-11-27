/** Read-only preview of one omitted saved board. Never navigation, hydration, a store write or a canvas mutation. */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { ControllerReadResult } from '../../../../shared/controller-chat';
import { REMOTE_CANVAS_BOARD_SOURCE, type RemoteCanvasBoardContext, type RemoteCanvasBoardPage, type RemoteCanvasBoardQuery, type RemoteCanvasBoardView } from '../../../../shared/remote-canvas-board-page';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { remoteCanvasJumpUnavailable, type CanvasHit } from './agent-canvases';
import { CardNote } from './DetailsCard';

/** Adapter over the existing authorized Details GET. It binds the page to the context the caller captured, never the response. */
export type ReadCanvasBoardPage = (satelliteId: string, agentId: string, query: RemoteCanvasBoardQuery, context: RemoteCanvasBoardContext) => Promise<ControllerReadResult<RemoteCanvasBoardPage>>;
type Open = { generation: number; fence: object; status: 'loading' | 'error' | 'unavailable' | 'forbidden' | 'discarded'; page?: undefined }
  | { generation: number; fence: object; status: 'ok'; page: Extract<RemoteCanvasBoardPage, { state: 'recorded' }> | Extract<RemoteCanvasBoardPage, { state: 'unavailable' }> };
const typeLabel: Record<RemoteCanvasBoardView['type'], string> = { agent: 'Agent', anchor: 'Anchor', plugin: 'Plugin widget', 'sticky-note': 'Sticky note', zone: 'Zone' };

export function RemoteCanvasBoardPreview({ agent, satelliteId, hostAgentId, context, hit, fence, readBoard, onRefused }: {
  agent: Agent; satelliteId: string; hostAgentId: string; context: Required<RemoteCanvasBoardContext>; hit: CanvasHit; fence: object; readBoard: ReadCanvasBoardPage; onRefused?(): void;
}) {
  // Offered only for an omission or absence refusal: a navigable row opens normally; a host/identity refusal offers neither.
  const previewable = () => {
    const host = useAnnexClientStore.getState().satellites.find((s) => s.id === satelliteId);
    return !!host && host.state === 'connected' && !host.snapshotUnavailable && remoteCanvasJumpUnavailable(agent, hit) !== null;
  };
  const latest = useRef(previewable); latest.current = previewable;
  const generation = useRef({ previewable: previewable(), value: 0 });
  const fenceRef = useRef(fence); fenceRef.current = fence;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [open, setOpen] = useState<Open | null>(null);
  // Explicit subscription: every notification rechecks navigability, whether or not the snapshot object changed.
  // Any transition permanently retires reads begun before it (omitted -> navigable -> omitted cannot revive one).
  useEffect(() => useAnnexClientStore.subscribe(() => {
    const now = latest.current();
    if (now !== generation.current.previewable) {
      generation.current = { previewable: now, value: generation.current.value + 1 };
      setOpen((o) => !o ? o : now ? { generation: o.generation, fence: o.fence, status: 'discarded' } : null);
    }
    rerender();
  }), []);
  const current = open && open.fence === fence ? open : open ? { generation: open.generation, fence: open.fence, status: 'discarded' as const } : null;
  const read = async () => {
    if (!previewable()) return;
    const started = { generation: generation.current.value, fence };
    setOpen({ ...started, status: 'loading' });
    // Settlement recheck: same generation and fence, still refused for omission, and the captured context matches.
    const settled = () => generation.current.value === started.generation && fenceRef.current === started.fence && previewable();
    try {
      const result = await readBoard(satelliteId, hostAgentId, { card: 'canvases', source: REMOTE_CANVAS_BOARD_SOURCE, member: context.member, selection: context.selection }, context);
      if (!settled()) { if (generation.current.value === started.generation && fenceRef.current === started.fence) setOpen(null); return; }
      if (result.status === 'forbidden') onRefused?.();
      setOpen(result.status === 'ok' ? { ...started, status: 'ok', page: result.value as Extract<Open, { status: 'ok' }>['page'] }
        : { ...started, status: result.status === 'forbidden' ? 'forbidden' : result.status === 'unavailable' ? 'unavailable' : 'error' });
    } catch { // telemetry-exempt: safe preview status only; no host errors enter the view
      if (settled()) setOpen({ ...started, status: 'error' });
    }
  };
  if (!previewable()) return null;
  if (!current) return <button type="button" className="pl-[33px] text-xs underline" onClick={() => void read()}>Preview board (read-only)</button>;
  if (current.status === 'loading') return <CardNote>Reading this saved board from the host…</CardNote>;
  const again = <button type="button" className="pl-[33px] text-xs underline" onClick={() => void read()}>Read the board again</button>;
  if (current.status === 'discarded') return <><CardNote>The host’s snapshot or this board’s availability changed, so the preview was discarded. Nothing older is shown.</CardNote>{again}</>;
  if (current.status !== 'ok') return <><CardNote>{current.status === 'unavailable' ? 'This host does not share board previews.' : current.status === 'forbidden' ? 'The host does not allow this board preview.' : 'Couldn’t read this board preview.'}</CardNote>{again}</>;
  const page = current.page;
  if (page.state === 'unavailable') return <><CardNote>{page.reason === 'limit' ? 'This board is too large to preview here.' : page.reason === 'changed' ? 'The saved board changed. Read it again.' : 'This saved board is unavailable to preview.'}</CardNote>{again}</>;
  return <BoardLayout page={page} host={useAnnexClientStore.getState().satellites.find((s) => s.id === satelliteId)?.alias || 'that computer'} />;
}

function BoardLayout({ page, host }: { page: Extract<RemoteCanvasBoardPage, { state: 'recorded' }>; host: string }) {
  const memberRef = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => { memberRef.current?.focus(); memberRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [page]);
  const minX = Math.min(...page.views.map((v) => v.x)), minY = Math.min(...page.views.map((v) => v.y));
  const width = Math.max(1, ...page.views.map((v) => v.x + v.w - minX)), height = Math.max(1, ...page.views.map((v) => v.y + v.h - minY));
  const scale = 280 / width;
  return <section aria-label={`Read-only preview of ${page.name}`} data-testid="remote-canvas-board-preview" className="pl-[33px] pr-3.5 text-xs">
    <p><strong>{page.name}</strong></p>
    <p>Read from {host} at {new Date(page.observedAt).toLocaleTimeString()}. A separate host observation, not the live canvas. Not editable here.</p>
    <div aria-hidden="true" className="relative my-1 border border-surface-0" style={{ width: 280, height: Math.max(40, height * scale) }}>
      {[...page.views].sort((a, b) => a.z - b.z).map((v) => <div key={v.key} data-member={v.member || undefined}
        className={`absolute overflow-hidden border ${v.member ? 'border-ctp-accent' : 'border-surface-1'}`}
        style={{ left: (v.x - minX) * scale, top: (v.y - minY) * scale, width: Math.max(2, v.w * scale), height: Math.max(2, v.h * scale) }}>{v.label}</div>)}
    </div>
    <ul aria-label="Board views">
      {page.views.map((v) => <li key={v.key} ref={v.member ? memberRef : undefined} tabIndex={v.member ? -1 : undefined} data-testid={v.member ? 'board-member-view' : 'board-view'}>
        {v.label} · {typeLabel[v.type]}{v.member ? ' · this agent' : ''}
      </li>)}
    </ul>
    {page.notes.map((note, index) => <p key={index}>{note}</p>)}
  </section>;
}
