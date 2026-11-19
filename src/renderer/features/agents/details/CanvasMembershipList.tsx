import type { CanvasHit } from './agent-canvases';

/** The same membership rows for local and host-read Details. Jump only changes this view. */
export function CanvasMembershipList({ hits, onJump, unavailable }: { hits: CanvasHit[]; onJump: (hit: CanvasHit) => void; unavailable?: (hit: CanvasHit) => string | null }) {
  return <ul className="flex flex-col">{hits.map((c) => {
    const reason = unavailable?.(c);
    return <li key={`${c.scope}:${c.canvasId}:${c.viewId}`}>
      <button type="button" onClick={() => onJump(c)} disabled={!!reason} title={reason ?? undefined}
        className="w-[calc(100%-28px)] ml-[22px] h-[30px] flex items-center gap-2 pl-3 pr-2.5 rounded-md text-left hover:bg-surface-0 disabled:opacity-60"
        data-testid="details-canvas-row">
        <span className="text-[12.5px] text-ctp-text truncate">{c.name}</span>
        <span className="text-xs text-ctp-overlay1 whitespace-nowrap">{c.scope === 'app' ? 'Home' : 'card'}</span>
        <span className="ml-auto text-xs text-ctp-accent">{reason ? 'Unavailable' : 'Jump'}</span>
      </button>
      {reason && <p className="pl-[33px] pr-3.5 text-xs text-ctp-overlay1">{reason}</p>}
    </li>;
  })}</ul>;
}
