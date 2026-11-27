import type { CSSProperties, ReactNode } from 'react';

/**
 * Pieces the scenes are drawn with, on a fixed 740 by 300 stage (the comps'
 * coordinates), scaled down to fit a narrow pane. Everything here is a
 * picture: it is hidden from screen readers, which get the step's heading and
 * text instead.
 */

/** Avatar letters and their colors, as in the comps. */
const AVATAR: Record<string, string> = {
  D: 'var(--wt-mauve)', R: 'var(--wt-peach)', A: 'var(--wt-green)', W: 'var(--wt-teal)',
  O: 'var(--wt-mauve)', H: 'var(--wt-s2)', B: 'var(--wt-teal)', G: 'var(--wt-red)',
};

export function pos(x: number, y: number, w?: number, extra?: CSSProperties): CSSProperties {
  return { left: x, top: y, ...(w !== undefined && { width: w }), ...extra };
}

export function Av({ ch, color }: { ch: string; color?: string }) {
  return <span className="av" style={{ background: color ?? AVATAR[ch] ?? 'var(--wt-s2)' }}>{ch}</span>;
}

/** The SVG layer the connections and moving dots are drawn on. */
export function Ov({ children }: { children: ReactNode }) {
  return <svg className="ov" viewBox="0 0 740 300" aria-hidden="true">{children}</svg>;
}

/** A connection line, drawn in when it gets `in`. */
export function Wire({ n, d, cls = '' }: { n: string; d: string; cls?: string }) {
  return <path className={`w ${cls} n-${n}`} pathLength={1} d={d} />;
}

/** A part card: an instruction block (b), skill (s) or MCP server (m). */
export function Part({ n, x, y, w, kind, name, sub, cls = '' }: { n: string; x: number; y: number; w: number; kind: 'b' | 's' | 'm'; name: string; sub?: string; cls?: string }) {
  return (
    <div className={`pc rv ${cls} n-${n}`} style={pos(x, y, w)}>
      <i className={`kq ${kind}`} />
      <b>{name}</b>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/** An agent row with a status on the right. */
export function AgentNode({ n, x, y, w, ch, name, status, color, cls = '' }: { n: string; x: number; y: number; w: number; ch: string; name: string; status?: string; color?: string; cls?: string }) {
  return (
    <div className={`an rv ${cls} n-${n}`} style={pos(x, y, w)}>
      <Av ch={ch} color={color} />
      <span>{name}</span>
      {status !== undefined && <span className="st">{status}</span>}
    </div>
  );
}

/** An agent with its name over its status. */
export function AgentStack({ n, x, y, w, ch, name, status, color, cls = '' }: { n: string; x: number; y: number; w: number; ch: string; name: string; status: string; color?: string; cls?: string }) {
  return (
    <div className={`an rv ${cls} n-${n}`} style={pos(x, y, w)}>
      <Av ch={ch} color={color} />
      <span className="an2"><span>{name}</span><span className="st">{status}</span></span>
    </div>
  );
}

export function Label({ x, y, children, cls = '', style }: { x: number; y: number; children?: ReactNode; cls?: string; style?: CSSProperties }) {
  return <div className={`lab ${cls}`} style={pos(x, y, undefined, style)}>{children}</div>;
}

/** A text link that does something in the app (opens Help, say), in the app's link style. */
export function TourLink({ onClick, children, label }: { onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="text-ctp-accent hover:underline cursor-pointer focus-ring rounded text-left">
      {children}
    </button>
  );
}
